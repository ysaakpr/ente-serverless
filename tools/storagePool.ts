/**
 * Operator CLI for BYO storage pools (Phase H2, D55). NEVER a client surface —
 * pool rows are provisioned here or not at all. A pool is ONE bucket shared by
 * MANY users (a household); object keys stay `<userID>/<uuid>` so members keep
 * their own prefixes, and pool membership never grants data access.
 *
 *   node --experimental-transform-types tools/storagePool.ts \
 *     create <poolId> --bucket B --region R \
 *       (--role-arn ARN --external-id ID | --access-key K --secret-key S) \
 *       [--endpoint URL] [--storage-gb N] [--skip-validation]
 *   node --experimental-transform-types tools/storagePool.ts attach <email> <poolId>
 *   node --experimental-transform-types tools/storagePool.ts detach <email>
 *   node --experimental-transform-types tools/storagePool.ts list
 *   node --experimental-transform-types tools/storagePool.ts set-quota <poolId> <gb|unlimited>
 *   node --experimental-transform-types tools/storagePool.ts disable <poolId>
 *   node --experimental-transform-types tools/storagePool.ts enable <poolId>
 *
 * Env-driven like tools/invite.ts: TABLE_NAME, AWS_REGION (+ credentials/
 * profile for prod), AWS_ENDPOINT_URL for LocalStack. HASHING_KEY is required
 * by `create` in keys mode (credentials are secretbox-encrypted at rest with a
 * key derived from it) and by attach/detach (user lookup goes through the
 * hashed EMAIL# guard). Secrets are never printed and never stored plaintext.
 *
 * `create` runs the VALIDATION CHECKLIST against the pool bucket first and
 * REFUSES to write the row on any hard failure:
 *   hard: credentials resolve (AssumeRole w/ ExternalId, or static keys),
 *         HeadBucket, PUT+GET+DELETE round-trip on a probe key,
 *         PutObjectTagging, multipart create+abort,
 *         GetPublicAccessBlock present but OPEN (public bucket).
 *   warn: GetPublicAccessBlock unsupported/absent (S3-compatibles),
 *         CORS missing browser-PUT headers, no abort-MPU lifecycle rule.
 * Role-mode note: the CLI assumes the pool role with YOUR ambient credentials,
 * so the pool role's trust policy must admit the operator as well as the
 * Lambda execution role (both with the same ExternalId).
 */

import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  PutObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { configFromEnv } from '../src/config.ts';
import { DynamoDb } from '../src/adapters/aws/db.dynamo.ts';
import { getDocClient } from '../src/adapters/aws/clients.ts';
import { SystemClock } from '../src/adapters/memory/system.memory.ts';
import { sodiumReady } from '../src/domain/tokens.ts';
import { setInvitePool, getInvite } from '../src/domain/invites.ts';
import {
  getPool,
  getPoolUsage,
  isValidPoolId,
  putPool,
  setPoolDisabled,
  setPoolQuota,
  setUserPool,
  type PoolInput,
  type PoolRow,
} from '../src/domain/storagePools.ts';

const GIB = 1024 ** 3;

const usage = (): never => {
  console.error(
    [
      'usage:',
      '  create <poolId> --bucket B --region R (--role-arn ARN --external-id ID | --access-key K --secret-key S) [--endpoint URL] [--storage-gb N] [--skip-validation]',
      '  attach <email> <poolId>   (works on user rows AND unconsumed invite rows)',
      '  detach <email>',
      '  list',
      '  set-quota <poolId> <gb|unlimited>',
      '  disable <poolId> | enable <poolId>',
    ].join('\n'),
  );
  process.exit(2);
};

const config = configFromEnv();
const db = new DynamoDb(config);
const clock = new SystemClock();

const hashingKey = (why: string): Uint8Array => {
  const b64 = process.env.HASHING_KEY;
  if (!b64) {
    console.error(`${why} needs HASHING_KEY (the same value the Lambda uses)`);
    process.exit(2);
  }
  const key = new Uint8Array(Buffer.from(b64, 'base64'));
  if (key.length !== 32) {
    console.error(`HASHING_KEY must decode to 32 bytes (got ${key.length})`);
    process.exit(2);
  }
  return key;
};

// --- validation checklist -----------------------------------------------------

interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'FAIL';
  detail?: string;
}

const errMsg = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);

const buildPoolClient = async (input: PoolInput): Promise<{ client: S3Client; note?: string }> => {
  const base = {
    region: input.region,
    ...(input.endpoint ? { endpoint: input.endpoint, forcePathStyle: true } : {}),
    requestChecksumCalculation: 'WHEN_REQUIRED' as const,
    responseChecksumValidation: 'WHEN_REQUIRED' as const,
  };
  if (input.mode === 'keys') {
    return {
      client: new S3Client({
        ...base,
        credentials: { accessKeyId: input.accessKey!, secretAccessKey: input.secretKey! },
      }),
    };
  }
  const sts = new STSClient({
    region: config.region,
    ...(config.awsEndpoint
      ? { endpoint: config.awsEndpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } }
      : {}),
  });
  const res = await sts.send(
    new AssumeRoleCommand({
      RoleArn: input.roleArn!,
      ExternalId: input.externalId!,
      RoleSessionName: `ente-pool-validate-${input.poolId}`.slice(0, 64),
      DurationSeconds: 900,
    }),
  );
  const creds = res.Credentials!;
  return {
    client: new S3Client({
      ...base,
      credentials: {
        accessKeyId: creds.AccessKeyId!,
        secretAccessKey: creds.SecretAccessKey!,
        sessionToken: creds.SessionToken,
      },
    }),
    note: `assumed ${input.roleArn}`,
  };
};

/** The onboarding checklist; hard failures refuse the row write. */
const validatePool = async (input: PoolInput): Promise<CheckResult[]> => {
  const results: CheckResult[] = [];
  const bucket = input.bucket;
  let client: S3Client;
  try {
    const built = await buildPoolClient(input);
    client = built.client;
    results.push({ name: 'credentials', status: 'ok', detail: built.note });
  } catch (err) {
    results.push({
      name: 'credentials',
      status: 'FAIL',
      detail:
        `${errMsg(err)}` +
        (input.mode === 'role'
          ? ' (role mode: the trust policy must admit YOUR credentials too, with this ExternalId)'
          : ''),
    });
    return results; // nothing else can run
  }

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    results.push({ name: 'HeadBucket', status: 'ok' });
  } catch (err) {
    results.push({ name: 'HeadBucket', status: 'FAIL', detail: errMsg(err) });
    return results;
  }

  const probeKey = `_ente-pool-probe/${randomUUID()}`;
  const probeBody = Buffer.from('ente-serverless pool probe');
  try {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: probeKey, Body: probeBody }));
    const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: probeKey }));
    const gotBody = Buffer.from(await got.Body!.transformToByteArray());
    if (!gotBody.equals(probeBody)) throw new Error('GET returned different bytes');
    results.push({ name: 'PUT+GET round-trip', status: 'ok', detail: probeKey });
  } catch (err) {
    results.push({ name: 'PUT+GET round-trip', status: 'FAIL', detail: errMsg(err) });
  }
  try {
    await client.send(
      new PutObjectTaggingCommand({
        Bucket: bucket,
        Key: probeKey,
        Tagging: { TagSet: [{ Key: 'tier', Value: 'original' }] },
      }),
    );
    results.push({ name: 'PutObjectTagging', status: 'ok' });
  } catch (err) {
    results.push({ name: 'PutObjectTagging', status: 'FAIL', detail: errMsg(err) });
  }
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: probeKey }));
    results.push({ name: 'DELETE probe', status: 'ok' });
  } catch (err) {
    results.push({ name: 'DELETE probe', status: 'FAIL', detail: errMsg(err) });
  }

  try {
    const created = await client.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: `${probeKey}-mpu` }),
    );
    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: `${probeKey}-mpu`,
        UploadId: created.UploadId!,
      }),
    );
    results.push({ name: 'multipart create+abort', status: 'ok' });
  } catch (err) {
    results.push({ name: 'multipart create+abort', status: 'FAIL', detail: errMsg(err) });
  }

  try {
    const pab = await client.send(new GetPublicAccessBlockCommand({ Bucket: bucket }));
    const c = pab.PublicAccessBlockConfiguration;
    const allOn = c?.BlockPublicAcls && c?.IgnorePublicAcls && c?.BlockPublicPolicy && c?.RestrictPublicBuckets;
    results.push(
      allOn
        ? { name: 'public access block', status: 'ok' }
        : {
            name: 'public access block',
            status: 'FAIL',
            detail: 'bucket admits public access — every photo byte would be one guessed key away from public',
          },
    );
  } catch (err) {
    results.push({
      name: 'public access block',
      status: 'warn',
      detail: `not readable (${errMsg(err)}) — fine on S3-compatibles; on real AWS verify the account-level block`,
    });
  }

  try {
    const cors = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
    const ok = (cors.CORSRules ?? []).some(
      (r) =>
        (r.AllowedMethods ?? []).includes('PUT') &&
        (r.ExposeHeaders ?? []).includes('ETag'),
    );
    results.push(
      ok
        ? { name: 'bucket CORS', status: 'ok' }
        : {
            name: 'bucket CORS',
            status: 'warn',
            detail: 'no rule with PUT + ExposeHeaders ETag — web/browser uploads will fail (D33); mirror the central bucket rule',
          },
    );
  } catch (err) {
    results.push({
      name: 'bucket CORS',
      status: 'warn',
      detail: `no CORS configuration (${errMsg(err)}) — web/browser uploads will fail (D33)`,
    });
  }

  try {
    const lc = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
    const hasAbort = (lc.Rules ?? []).some(
      (r) => r.Status === 'Enabled' && r.AbortIncompleteMultipartUpload?.DaysAfterInitiation,
    );
    results.push(
      hasAbort
        ? { name: 'abort-MPU lifecycle rule', status: 'ok' }
        : {
            name: 'abort-MPU lifecycle rule',
            status: 'warn',
            detail: 'abandoned multipart uploads will bill forever — add an AbortIncompleteMultipartUpload rule',
          },
    );
  } catch (err) {
    results.push({
      name: 'abort-MPU lifecycle rule',
      status: 'warn',
      detail: `no lifecycle configuration (${errMsg(err)}) — abandoned multipart uploads will bill forever`,
    });
  }

  return results;
};

const printChecklist = (results: CheckResult[]): boolean => {
  let hardFail = false;
  for (const r of results) {
    const mark = r.status === 'ok' ? ' ok ' : r.status === 'warn' ? 'WARN' : 'FAIL';
    console.log(`  [${mark}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    if (r.status === 'FAIL') hardFail = true;
  }
  return hardFail;
};

// --- listing -------------------------------------------------------------------

const listPools = async (): Promise<PoolRow[]> => {
  const doc = getDocClient(config);
  const rows: PoolRow[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: config.tableName,
        FilterExpression: 'begins_with(pk, :p) AND sk = :s',
        ExpressionAttributeValues: { ':p': 'POOL#', ':s': 'META' },
        ExclusiveStartKey: startKey,
      }),
    );
    rows.push(...((page.Items ?? []) as PoolRow[]));
    startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return rows.sort((a, b) => (a.poolId < b.poolId ? -1 : 1));
};

/** Member counts: one paged Scan over user rows carrying storagePoolId — the
 * operator-only full listing, same D48 no-index discipline as `make invites`. */
const memberCounts = async (): Promise<Map<string, number>> => {
  const doc = getDocClient(config);
  const counts = new Map<string, number>();
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: config.tableName,
        FilterExpression: 'begins_with(pk, :u) AND sk = :s AND attribute_exists(storagePoolId)',
        ExpressionAttributeValues: { ':u': 'USER#', ':s': 'META' },
        ProjectionExpression: 'storagePoolId',
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const id = item.storagePoolId as string;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return counts;
};

const fmtBytes = (n: number): string =>
  n >= GIB ? `${(n / GIB).toFixed(2)} GiB` : `${n} B`;

// --- commands -------------------------------------------------------------------

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'create': {
    const poolId = args[0];
    if (!poolId || poolId.startsWith('--')) usage();
    if (!isValidPoolId(poolId!)) {
      console.error(`invalid pool id ${JSON.stringify(poolId)} (want [a-z0-9-], <= 64 chars)`);
      process.exit(2);
    }
    const flags = new Map<string, string>();
    let skipValidation = false;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--skip-validation') {
        skipValidation = true;
        continue;
      }
      if (!args[i]!.startsWith('--') || i + 1 >= args.length) usage();
      flags.set(args[i]!.slice(2), args[++i]!);
    }
    const bucket = flags.get('bucket');
    const region = flags.get('region');
    if (!bucket || !region) usage();
    const roleArn = flags.get('role-arn');
    const externalId = flags.get('external-id');
    const accessKey = flags.get('access-key');
    const secretKey = flags.get('secret-key');
    const mode: 'role' | 'keys' = roleArn ? 'role' : accessKey ? 'keys' : usage();
    if (mode === 'role' && !externalId) {
      console.error('role mode REQUIRES --external-id — it is the confused-deputy guard (D55), not an option');
      process.exit(2);
    }
    if (mode === 'keys' && !secretKey) usage();
    const storageGb = flags.get('storage-gb');
    const poolStorageLimitBytes =
      storageGb !== undefined ? Math.round(Number(storageGb) * GIB) : undefined;
    if (storageGb !== undefined && (!Number.isFinite(Number(storageGb)) || Number(storageGb) < 0)) usage();

    const input: PoolInput = {
      poolId: poolId!,
      mode,
      bucket: bucket!,
      region: region!,
      endpoint: flags.get('endpoint'),
      roleArn,
      externalId,
      accessKey,
      secretKey,
      poolStorageLimitBytes,
    };

    if (skipValidation) {
      console.log('validation SKIPPED (--skip-validation)');
    } else {
      console.log(`validating pool '${poolId}' against s3://${bucket} (${region}) ...`);
      const results = await validatePool(input);
      const hardFail = printChecklist(results);
      if (hardFail) {
        console.error('REFUSING to onboard: fix the FAILed checks and re-run.');
        process.exit(1);
      }
    }

    await sodiumReady(); // credential encryption is keyed via libsodium
    const key = mode === 'keys' ? hashingKey('create (keys mode)') : new Uint8Array(32);
    const row = await putPool({ db, clock, hashingKey: key }, input);
    console.log(
      `pool '${row.poolId}' onboarded: mode=${row.mode} bucket=${row.bucket} region=${row.region}` +
        `${row.endpoint ? ` endpoint=${row.endpoint}` : ''}` +
        ` quota=${row.poolStorageLimitBytes !== undefined ? fmtBytes(row.poolStorageLimitBytes) : 'unlimited'}`,
    );
    console.log('attach members with: make pool-attach EMAIL=... POOL=' + row.poolId);
    break;
  }
  case 'attach': {
    const [email, poolId] = args;
    if (!email || !poolId) usage();
    const pool = await getPool({ db }, poolId!);
    if (!pool) {
      console.error(`no pool '${poolId}' — run make pool-create first`);
      process.exit(1);
    }
    await sodiumReady();
    const result = await setUserPool({ db, hashingKey: hashingKey('attach') }, email!, poolId!);
    if (result) {
      console.log(`user ${result.userId} (${email}) attached to pool '${poolId}' — NEW uploads land there; existing files stay pinned where they are`);
      break;
    }
    // Pre-signup: park the assignment on the invite row (H1 seam).
    const invite = await setInvitePool({ db, clock }, email!, poolId!);
    if (!invite) {
      console.error(`no account and no invite for ${email} — run make invite EMAIL=${email} first`);
      process.exit(1);
    }
    console.log(`invite for ${email} now carries pool '${poolId}' — signup will land the user in it`);
    break;
  }
  case 'detach': {
    const email = args[0];
    if (!email) usage();
    await sodiumReady();
    const result = await setUserPool({ db, hashingKey: hashingKey('detach') }, email!, null);
    if (result) {
      console.log(`user ${result.userId} (${email}) detached — NEW uploads land in the central bucket; pinned files stay in their pools`);
      break;
    }
    const invite = await getInvite({ db, clock }, email!);
    if (invite?.storagePoolId) {
      await setInvitePool({ db, clock }, email!, null);
      console.log(`invite for ${email}: pool assignment cleared`);
      break;
    }
    console.error(`no account and no pool-carrying invite for ${email}`);
    process.exit(1);
    break;
  }
  case 'list': {
    const pools = await listPools();
    if (pools.length === 0) {
      console.log('no storage pools');
      break;
    }
    const counts = await memberCounts();
    for (const pool of pools) {
      const usageRow = await getPoolUsage({ db }, pool.poolId);
      console.log(
        `${pool.poolId}  mode=${pool.mode}  bucket=${pool.bucket}  region=${pool.region}` +
          `${pool.endpoint ? `  endpoint=${pool.endpoint}` : ''}` +
          `  members=${counts.get(pool.poolId) ?? 0}` +
          `  usage=${fmtBytes(usageRow.bytes)} (${usageRow.fileCount} files)` +
          `  quota=${pool.poolStorageLimitBytes !== undefined ? fmtBytes(pool.poolStorageLimitBytes) : 'unlimited'}` +
          `${pool.disabled ? '  DISABLED' : ''}`,
      );
    }
    break;
  }
  case 'set-quota': {
    const [poolId, gbArg] = args;
    if (!poolId || !gbArg) usage();
    let bytes: number | null;
    if (gbArg === 'unlimited') bytes = null;
    else {
      const gb = Number(gbArg);
      if (!Number.isFinite(gb) || gb < 0) usage();
      bytes = Math.round(gb * GIB);
    }
    const pool = await setPoolQuota({ db }, poolId!, bytes);
    if (!pool) {
      console.error(`no pool '${poolId}'`);
      process.exit(1);
    }
    console.log(
      bytes === null
        ? `pool '${poolId}': quota cleared — unlimited`
        : `pool '${poolId}': quota set to ${fmtBytes(bytes)}`,
    );
    break;
  }
  case 'disable':
  case 'enable': {
    const poolId = args[0];
    if (!poolId) usage();
    const pool = await setPoolDisabled({ db }, poolId!, command === 'disable');
    if (!pool) {
      console.error(`no pool '${poolId}'`);
      process.exit(1);
    }
    console.log(
      command === 'disable'
        ? `pool '${poolId}' disabled — NEW uploads refuse with the storage-limit 426; downloads and purges still work`
        : `pool '${poolId}' enabled`,
    );
    break;
  }
  default:
    usage();
}
