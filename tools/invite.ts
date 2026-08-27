/**
 * Operator CLI for invite-gated signup + per-user storage (Phase H1, D54).
 * NEVER a client surface — these rows are provisioned here or not at all.
 *
 *   node --experimental-transform-types tools/invite.ts invite <email> [--storage-gb N] [--viewer]
 *   node --experimental-transform-types tools/invite.ts list
 *   node --experimental-transform-types tools/invite.ts revoke <email>
 *   node --experimental-transform-types tools/invite.ts set-storage <email> <gb|default>
 *
 * Env-driven like every other script: the SAME variables the Lambda uses —
 * TABLE_NAME, AWS_REGION (+ AWS credentials/profile for prod), AWS_ENDPOINT_URL
 * for LocalStack. HASHING_KEY is needed ONLY by set-storage (user lookup goes
 * through the hashed EMAIL# guard); invite rows are keyed by plaintext
 * lowercased email precisely so invite management works without the key.
 * Make targets: `make invite EMAIL=... [STORAGE_GB=...] [VIEWER=1]`,
 * `make invites`, `make revoke-invite EMAIL=...`,
 * `make set-storage EMAIL=... STORAGE_GB=<n|default>`.
 */

import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { configFromEnv } from '../src/config.ts';
import { DynamoDb } from '../src/adapters/aws/db.dynamo.ts';
import { getDocClient } from '../src/adapters/aws/clients.ts';
import { SystemClock } from '../src/adapters/memory/system.memory.ts';
import { sodiumReady } from '../src/domain/tokens.ts';
import { revokeInvite, setUserStorage, upsertInvite, type InviteRow } from '../src/domain/invites.ts';

const GIB = 1024 ** 3;

const usage = (): never => {
  console.error(
    'usage: invite <email> [--storage-gb N] [--viewer] | list | revoke <email> | set-storage <email> <gb|default>',
  );
  process.exit(2);
};

const config = configFromEnv();
const db = new DynamoDb(config);
const clock = new SystemClock();
const deps = { db, clock };

const hashingKey = (): Uint8Array => {
  const b64 = process.env.HASHING_KEY;
  if (!b64) {
    console.error('set-storage needs HASHING_KEY (the same value the Lambda uses)');
    process.exit(2);
  }
  const key = new Uint8Array(Buffer.from(b64, 'base64'));
  if (key.length !== 32) {
    console.error(`HASHING_KEY must decode to 32 bytes (got ${key.length})`);
    process.exit(2);
  }
  return key;
};

const fmt = (row: InviteRow): string => {
  const storage =
    row.storageLimitBytes === undefined
      ? 'default'
      : `${row.storageLimitBytes / GIB} GiB${row.storageLimitBytes === 0 ? ' (ZERO — no uploads)' : ''}`;
  const state = row.consumedAt !== undefined ? `consumed ${new Date(row.consumedAt / 1000).toISOString()}` : 'open';
  return `${row.email}  storage=${storage}  viewer=${row.viewer}  home=${row.home}  ${state}`;
};

/** All INVITE# rows — a paged Scan; invites are keyed per email (D54), and an
 * operator listing is the one consumer that genuinely wants "all of them". */
const listInvites = async (): Promise<InviteRow[]> => {
  const doc = getDocClient(config);
  const rows: InviteRow[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: config.tableName,
        FilterExpression: 'begins_with(pk, :p) AND sk = :s',
        ExpressionAttributeValues: { ':p': 'INVITE#', ':s': 'META' },
        ExclusiveStartKey: startKey,
      }),
    );
    rows.push(...((page.Items ?? []) as InviteRow[]));
    startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return rows.sort((a, b) => (a.email < b.email ? -1 : 1));
};

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'invite': {
    const email = args[0];
    if (!email || email.startsWith('--')) usage();
    let storageLimitBytes: number | undefined;
    let viewer = false;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--viewer') viewer = true;
      else if (args[i] === '--storage-gb') {
        const gb = Number(args[++i]);
        if (!Number.isFinite(gb) || gb < 0) usage();
        storageLimitBytes = Math.round(gb * GIB);
      } else usage();
    }
    const row = await upsertInvite(deps, email!, { storageLimitBytes, viewer });
    console.log(`invited: ${fmt(row)}`);
    break;
  }
  case 'list': {
    const rows = await listInvites();
    if (rows.length === 0) console.log('no invites');
    for (const row of rows) console.log(fmt(row));
    break;
  }
  case 'revoke': {
    if (!args[0]) usage();
    const outcome = await revokeInvite(deps, args[0]!);
    if (outcome === 'revoked') console.log(`revoked invite for ${args[0]}`);
    else if (outcome === 'not-found') {
      console.error(`no invite for ${args[0]}`);
      process.exit(1);
    } else {
      console.error(
        `invite for ${args[0]} is already consumed (audit row kept). ` +
          'To restrict the account, use set-storage; to re-admit later, re-run make invite.',
      );
      process.exit(1);
    }
    break;
  }
  case 'set-storage': {
    await sodiumReady(); // emailHash is keyed blake2b via libsodium
    const [email, gbArg] = args;
    if (!email || !gbArg) usage();
    let bytes: number | null;
    if (gbArg === 'default') bytes = null;
    else {
      const gb = Number(gbArg);
      if (!Number.isFinite(gb) || gb < 0) usage();
      bytes = Math.round(gb * GIB);
    }
    const result = await setUserStorage({ db, hashingKey: hashingKey() }, email!, bytes);
    if (!result) {
      console.error(`no account for ${email} — set-storage adjusts EXISTING users; use make invite for new ones`);
      process.exit(1);
    }
    console.log(
      bytes === null
        ? `user ${result.userId} (${email}): storage limit cleared — config free-plan default applies`
        : `user ${result.userId} (${email}): storage limit set to ${bytes} bytes (${gbArg} GiB)${bytes === 0 ? ' — ZERO: uploads blocked' : ''}`,
    );
    break;
  }
  default:
    usage();
}
