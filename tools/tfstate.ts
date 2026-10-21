/**
 * Remote tofu state + private tfvars, both in one S3 bucket (D67).
 *
 *   node --experimental-transform-types tools/tfstate.ts <command> [args]
 *
 *   bucket-name                 print the state bucket name for these credentials
 *                               (fails, naming the account, if it does not exist)
 *   bootstrap                   create/harden the state bucket (idempotent;
 *                               creating it needs CONFIRM_ACCOUNT=<account>)
 *   split <in> <config> <secrets>
 *                               split a legacy ente-sl.tfvars into the committed
 *                               config.tfvars and the private secrets.tfvars
 *   check <config.tfvars>       fail if a committed tfvars holds private values
 *   secrets-push <env> <file>   upload <file> as the env's secrets (refuses to
 *                               change hashing_key unless FORCE=1)
 *   secrets-pull <env> <out>    download the env's secrets to <out> (mode 0600)
 *   secrets-status <env>        say whether the env's secrets exist, without
 *                               printing any value
 *
 * Bucket layout (STATE_BUCKET, default ente-sl-tfstate-<account>, in
 * STATE_REGION, default ap-south-1):
 *   state/<env>/terraform.tfstate         tofu S3 backend, use_lockfile
 *   state/<env>/terraform.tfstate.tflock  the lock tofu writes during runs
 *   secrets/<env>.tfvars                  the PRIVATE_KEYS lines below
 *
 * The bucket is not managed by tofu on purpose: it holds the state, so a root
 * that owns it would have to keep its own state somewhere else again. This
 * script re-applies the same settings on every run instead.
 *
 * AWS_ENDPOINT_URL (LocalStack) is honored with path-style addressing, the
 * same convention as tools/storagePool.ts.
 */

import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  CreateBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketOwnershipControlsCommand,
  PutBucketPolicyCommand,
  PutBucketTaggingCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  type BucketLocationConstraint,
} from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

/**
 * Variables that never go into a committed tfvars. hashing_key is the only
 * secret proper (losing or leaking it breaks every email->user mapping, D4a);
 * the rest are personal or account-identifying, and the repo is public.
 */
export const PRIVATE_KEYS = ['hashing_key', 'mail_from', 'alarm_email', 'operator_principal_arns'] as const;

const ENVS = ['dev', 'test'];
const STATE_REGION = process.env.STATE_REGION ?? 'ap-south-1';

// ---------------------------------------------------------------- tfvars ----

export interface TfvarsBlock {
  /** Comment/blank lines directly above the assignment. */
  leading: string[];
  key: string | null;
  /** The assignment's own lines (empty for a trailing comment-only block). */
  body: string[];
}

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=/;

/** Bracket depth change of one line, ignoring brackets inside strings and comments. */
const depthDelta = (line: string): number => {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '#' || (ch === '/' && line[i + 1] === '/')) break;
    else if ('[{('.includes(ch)) depth++;
    else if (']})'.includes(ch)) depth--;
  }
  return depth;
};

/**
 * Splits a tfvars file into top-level assignments, each carrying the comment
 * lines right above it. Handles strings, lists and maps across lines; refuses
 * heredocs, which no variable here needs and which would hide a value from the
 * line scanner.
 */
export const parseTfvars = (text: string): TfvarsBlock[] => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const blocks: TfvarsBlock[] = [];
  let leading: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = ASSIGN.exec(line);
    if (!m) {
      if (line.trim() !== '' && !/^\s*(#|\/\/)/.test(line)) {
        throw new Error(`line ${i + 1}: expected an assignment or a comment, got: ${line}`);
      }
      leading.push(line);
      continue;
    }
    if (line.includes('<<')) throw new Error(`line ${i + 1}: heredoc values are not supported (${m[1]})`);
    const body = [line];
    let depth = depthDelta(line);
    while (depth > 0) {
      i++;
      if (i >= lines.length) throw new Error(`unterminated value for ${m[1]}`);
      body.push(lines[i]!);
      depth += depthDelta(lines[i]!);
    }
    blocks.push({ leading, key: m[1]!, body });
    leading = [];
  }
  if (leading.length) blocks.push({ leading, key: null, body: [] });
  const seen = new Set<string>();
  for (const b of blocks) {
    if (!b.key) continue;
    if (seen.has(b.key)) throw new Error(`duplicate assignment: ${b.key}`);
    seen.add(b.key);
  }
  return blocks;
};

const isPrivate = (key: string | null): boolean => key !== null && (PRIVATE_KEYS as readonly string[]).includes(key);

/**
 * Committed config keeps every comment and every non-private assignment, and
 * leaves a pointer where a private one was. Secrets keep only the private
 * assignments (no comments — explanations live in the committed file).
 */
export const splitTfvars = (text: string): { config: string; secrets: string; privateKeys: string[] } => {
  const blocks = parseTfvars(text);
  const config: string[] = [];
  const secrets: string[] = [];
  const privateKeys: string[] = [];
  for (const b of blocks) {
    config.push(...b.leading);
    if (isPrivate(b.key)) {
      privateKeys.push(b.key!);
      config.push(`# ${b.key} = <private: secrets/<env>.tfvars in the state bucket — make secrets-pull>`);
      secrets.push(...b.body);
    } else {
      config.push(...b.body);
    }
  }
  return {
    config: config.join('\n') + '\n',
    secrets: secrets.length ? secrets.join('\n') + '\n' : '',
    privateKeys,
  };
};

/** Why a committed tfvars must not be committed, or [] when it is clean. */
export const checkCommittedTfvars = (text: string): string[] => {
  const problems: string[] = [];
  for (const b of parseTfvars(text)) {
    if (isPrivate(b.key)) problems.push(`assigns private variable ${b.key}`);
  }
  // Assignments only — comments may mention addresses in prose.
  const values = parseTfvars(text)
    .flatMap((b) => b.body)
    .join('\n');
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(values)) problems.push('contains an email address');
  if (/\b\d{12}\b/.test(values)) problems.push('contains a 12-digit AWS account id');
  if (/arn:aws:iam::/.test(values)) problems.push('contains an IAM ARN');
  return problems;
};

const hashingKeyOf = (text: string): string | null => {
  const block = parseTfvars(text).find((b) => b.key === 'hashing_key');
  if (!block) return null;
  return /=\s*"([^"]*)"/.exec(block.body.join('\n'))?.[1] ?? null;
};

// -------------------------------------------------------------------- S3 ----

const endpoint = process.env.AWS_ENDPOINT_URL;
const s3 = () =>
  new S3Client({ region: STATE_REGION, ...(endpoint ? { endpoint, forcePathStyle: true } : {}) });

export interface StateTarget {
  bucket: string;
  /** null when STATE_BUCKET named the bucket (LocalStack rehearsals). */
  account: string | null;
}

export const resolveTarget = async (): Promise<StateTarget> => {
  if (process.env.STATE_BUCKET) return { bucket: process.env.STATE_BUCKET, account: null };
  const sts = new STSClient({ region: STATE_REGION, ...(endpoint ? { endpoint } : {}) });
  const { Account } = await sts.send(new GetCallerIdentityCommand({}));
  if (!Account) throw new Error('could not resolve the AWS account id');
  return { bucket: `ente-sl-tfstate-${Account}`, account: Account };
};

/** Which credentials a run uses, in words — the account is what picks the bucket. */
export const describeCaller = (t: StateTarget, env: NodeJS.ProcessEnv = process.env): string => {
  const via = env.AWS_PROFILE
    ? `AWS_PROFILE=${env.AWS_PROFILE}`
    : env.AWS_ACCESS_KEY_ID
      ? 'AWS_ACCESS_KEY_ID from the environment'
      : 'the default credentials (AWS_PROFILE is not set)';
  const who = t.account ? `account ${t.account} via ${via}` : `STATE_BUCKET=${t.bucket} via ${via}`;
  return env.AWS_ENDPOINT_URL ? `${who}, endpoint ${env.AWS_ENDPOINT_URL}` : who;
};

/**
 * The bucket name is derived from the caller's account, so a missing bucket
 * almost always means credentials for the wrong account — never a cue to
 * bootstrap one there.
 */
export const missingBucketMessage = (t: StateTarget, env: NodeJS.ProcessEnv = process.env): string =>
  [
    `state bucket s3://${t.bucket} does not exist (running as ${describeCaller(t, env)}).`,
    t.account
      ? "  The bucket name comes from the account. If this is not the deployment's account, select its\n" +
        '  credentials and re-run, e.g.  AWS_PROFILE=ente-sl make <target>'
      : '  STATE_BUCKET names a bucket that is not there.',
    '  Only for a brand-new account: make state-bootstrap (it asks you to confirm the account).',
  ].join('\n');

/** Creating the bucket picks the account that will hold every state and secret. */
export const bootstrapRefusal = (
  t: StateTarget,
  confirm: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null =>
  t.account && confirm !== t.account
    ? `s3://${t.bucket} does not exist yet. Creating it makes account ${t.account} the home of this\n` +
      `project's state and secrets (running as ${describeCaller(t, env)}).\n` +
      `  Right account:  make state-bootstrap CONFIRM_ACCOUNT=${t.account}\n` +
      "  Wrong account:  select the deployment's credentials (e.g. AWS_PROFILE=ente-sl) and re-run."
    : null;

const requireBucket = async (t: StateTarget): Promise<void> => {
  try {
    await s3().send(new HeadBucketCommand({ Bucket: t.bucket }));
  } catch (e) {
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || ['NotFound', 'NoSuchBucket'].includes(errName(e) ?? '')) {
      throw new Error(missingBucketMessage(t));
    }
    if (status === 403) {
      throw new Error(
        `s3://${t.bucket} exists but ${describeCaller(t)} may not read it — another account owns ` +
          'that name, or the credentials lack s3:ListBucket on it.',
      );
    }
    throw e;
  }
};

const secretsKey = (env: string): string => {
  if (!ENVS.includes(env)) throw new Error(`unknown env '${env}' (expected ${ENVS.join(' | ')})`);
  return `secrets/${env}.tfvars`;
};

const errName = (e: unknown): string | undefined =>
  (e as { name?: string; Code?: string }).name ?? (e as { Code?: string }).Code;

const readObject = async (bucket: string, key: string): Promise<string | null> => {
  try {
    const res = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return await res.Body!.transformToString();
  } catch (e) {
    if (['NoSuchKey', 'NotFound'].includes(errName(e) ?? '')) return null;
    throw e;
  }
};

export const bootstrap = async (): Promise<string> => {
  const target = await resolveTarget();
  const Bucket = target.bucket;
  const client = s3();
  let exists = true;
  try {
    await client.send(new HeadBucketCommand({ Bucket }));
  } catch (e) {
    if (!['NotFound', 'NoSuchBucket'].includes(errName(e) ?? '')) throw e;
    exists = false;
  }
  if (!exists) {
    const refusal = bootstrapRefusal(target, process.env.CONFIRM_ACCOUNT);
    if (refusal) throw new Error(refusal);
    await client.send(
      new CreateBucketCommand({
        Bucket,
        ...(STATE_REGION === 'us-east-1'
          ? {}
          : { CreateBucketConfiguration: { LocationConstraint: STATE_REGION as BucketLocationConstraint } }),
      }),
    );
    console.log(`created s3://${Bucket} (${STATE_REGION})`);
  } else {
    console.log(`s3://${Bucket} exists — re-applying settings (${describeCaller(target)})`);
  }
  await client.send(
    new PutBucketOwnershipControlsCommand({
      Bucket,
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    }),
  );
  await client.send(
    new PutPublicAccessBlockCommand({
      Bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
  // State history is the rollback path; versioning must never be off here.
  await client.send(new PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: 'Enabled' } }));
  await client.send(
    new PutBucketEncryptionCommand({
      Bucket,
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }, BucketKeyEnabled: true }],
      },
    }),
  );
  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket,
      LifecycleConfiguration: {
        Rules: [
          {
            // Every apply writes a new state version; keep a year of them and
            // never fewer than the 50 newest. Each run also creates and deletes
            // the .tflock object, leaving delete markers — clear those once
            // nothing sits under them.
            ID: 'state-history',
            Status: 'Enabled',
            Filter: { Prefix: 'state/' },
            NoncurrentVersionExpiration: { NoncurrentDays: 365, NewerNoncurrentVersions: 50 },
            Expiration: { ExpiredObjectDeleteMarker: true },
          },
          {
            ID: 'abort-incomplete-multipart',
            Status: 'Enabled',
            Filter: { Prefix: '' },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          },
        ],
      },
    }),
  );
  // Plain deletes only add a delete marker (recoverable). Removing a version
  // is permanent, so nobody gets to do it by hand; the lifecycle rule above
  // still expires old state versions.
  await client.send(
    new PutBucketPolicyCommand({
      Bucket,
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'DenyInsecureTransport',
            Effect: 'Deny',
            Principal: '*',
            Action: 's3:*',
            Resource: [`arn:aws:s3:::${Bucket}`, `arn:aws:s3:::${Bucket}/*`],
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          },
          {
            Sid: 'DenyPermanentDeletes',
            Effect: 'Deny',
            Principal: '*',
            Action: ['s3:DeleteObjectVersion', 's3:DeleteBucket'],
            Resource: [`arn:aws:s3:::${Bucket}`, `arn:aws:s3:::${Bucket}/*`],
          },
        ],
      }),
    }),
  );
  await client.send(
    new PutBucketTaggingCommand({
      Bucket,
      Tagging: { TagSet: [{ Key: 'Project', Value: 'ente-serverless' }, { Key: 'Purpose', Value: 'tofu-state' }] },
    }),
  );
  console.log('versioning on, SSE-S3, public access blocked, TLS-only, version deletes denied');
  return Bucket;
};

export const secretsPush = async (env: string, file: string): Promise<void> => {
  const Key = secretsKey(env);
  const target = await resolveTarget();
  await requireBucket(target);
  const Bucket = target.bucket;
  const next = readFileSync(file, 'utf8');
  for (const b of parseTfvars(next)) {
    if (b.key && !isPrivate(b.key)) {
      throw new Error(`${file} assigns ${b.key}, which belongs in the committed config.tfvars`);
    }
  }
  const nextKey = hashingKeyOf(next);
  if (!nextKey) throw new Error(`${file} has no hashing_key — refusing to store secrets without it`);
  const current = await readObject(Bucket, Key);
  if (current !== null) {
    const currentKey = hashingKeyOf(current);
    if (currentKey && currentKey !== nextKey && process.env.FORCE !== '1') {
      throw new Error(
        `s3://${Bucket}/${Key} holds a DIFFERENT hashing_key. Changing it orphans every ` +
          'email->user mapping (D4a). Re-run with FORCE=1 only if that is really intended; ' +
          'the old value stays recoverable as a previous object version.',
      );
    }
    if (current === next) {
      console.log(`s3://${Bucket}/${Key} already up to date`);
      return;
    }
  }
  await s3().send(
    new PutObjectCommand({ Bucket, Key, Body: next, ContentType: 'text/plain', ServerSideEncryption: 'AES256' }),
  );
  console.log(`${current === null ? 'stored' : 'updated'} s3://${Bucket}/${Key}`);
};

export const secretsPull = async (env: string, out: string): Promise<void> => {
  const Key = secretsKey(env);
  const target = await resolveTarget();
  await requireBucket(target);
  const Bucket = target.bucket;
  const text = await readObject(Bucket, Key);
  if (text === null) {
    throw new Error(`no secrets at s3://${Bucket}/${Key} — run make tfvars-split + make secrets-push first`);
  }
  writeFileSync(out, text, { mode: 0o600 });
  chmodSync(out, 0o600);
};

export const secretsStatus = async (env: string): Promise<boolean> => {
  const Key = secretsKey(env);
  const target = await resolveTarget();
  await requireBucket(target);
  const Bucket = target.bucket;
  try {
    const head = await s3().send(new HeadObjectCommand({ Bucket, Key }));
    console.log(`s3://${Bucket}/${Key}: present (version ${head.VersionId ?? '-'}, ${head.LastModified?.toISOString()})`);
    return true;
  } catch (e) {
    if (!['NotFound', 'NoSuchKey'].includes(errName(e) ?? '')) throw e;
    console.log(`s3://${Bucket}/${Key}: MISSING`);
    return false;
  }
};

// ------------------------------------------------------------------- CLI ----

const main = async (argv: string[]): Promise<number> => {
  const [cmd, ...args] = argv;
  const need = (n: number, usage: string) => {
    if (args.length !== n) throw new Error(`usage: tfstate.ts ${cmd} ${usage}`);
  };
  switch (cmd) {
    case 'bucket-name': {
      // infra-init and state-migrate need the bucket; say why when it is missing.
      const target = await resolveTarget();
      await requireBucket(target);
      console.log(target.bucket);
      return 0;
    }
    case 'bootstrap':
      await bootstrap();
      return 0;
    case 'split': {
      need(3, '<in> <config.tfvars> <secrets.tfvars>');
      const { config, secrets, privateKeys } = splitTfvars(readFileSync(args[0]!, 'utf8'));
      const problems = checkCommittedTfvars(config);
      if (problems.length) throw new Error(`split output still not committable: ${problems.join('; ')}`);
      writeFileSync(args[1]!, config);
      writeFileSync(args[2]!, secrets, { mode: 0o600 });
      console.log(`wrote ${args[1]} (commit it) and ${args[2]} (private: ${privateKeys.join(', ') || 'none'})`);
      return 0;
    }
    case 'check': {
      need(1, '<config.tfvars>');
      const problems = checkCommittedTfvars(readFileSync(args[0]!, 'utf8'));
      for (const p of problems) console.error(`${args[0]}: ${p}`);
      return problems.length ? 1 : 0;
    }
    case 'secrets-push':
      need(2, '<env> <file>');
      await secretsPush(args[0]!, args[1]!);
      return 0;
    case 'secrets-pull':
      need(2, '<env> <out>');
      await secretsPull(args[0]!, args[1]!);
      return 0;
    case 'secrets-status':
      need(1, '<env>');
      return (await secretsStatus(args[0]!)) ? 0 : 1;
    default:
      console.error('commands: bucket-name | bootstrap | split | check | secrets-push | secrets-pull | secrets-status');
      return 2;
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: Error) => {
      console.error(`tfstate: ${e.message}`);
      process.exit(1);
    },
  );
}
