/**
 * Operator CLI: every account on the deployment with email, usage and limits.
 * NEVER a client surface — it Scans the table, which only the operator role
 * may do (D64; the API execution role deliberately lacks dynamodb:Scan).
 *
 *   node --experimental-transform-types tools/users.ts list [--json]
 *
 * Env-driven like the other tools: TABLE_NAME, AWS_REGION (+ credentials),
 * AWS_ENDPOINT_URL for LocalStack — `make users` wires all of it through
 * tools/with-operator-role.sh. No HASHING_KEY needed: user rows carry the
 * plaintext email; the hashed EMAIL# guard is only for lookups by email.
 *
 * One paged Scan picks up both USER#<id>/META (identity, limits, pool,
 * viewer/deleted flags — domain/users.ts UserRow) and USER#<id>/USAGE (the
 * transactional bytes/fileCount counters the commit/delete paths maintain),
 * joined here by pk. The LIMIT column resolves like the quota check does
 * (storageLimitBytes ?? FREE_PLAN_STORAGE_BYTES, D54): explicit overrides in
 * GiB — 0 rendered as ZERO, it really means no uploads — and 'default' for
 * the config fallback, whose value is the DEPLOYMENT's env, not this shell's;
 * the footer prints what this shell resolves so a mismatch is visible.
 */

import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { configFromEnv } from '../src/config.ts';
import { getDocClient } from '../src/adapters/aws/clients.ts';

const GIB = 1024 ** 3;

const usage = (): never => {
  console.error('usage: users list [--json]');
  process.exit(2);
};

const config = configFromEnv();

interface UserDetails {
  userId: number;
  email: string;
  state: string;
  usageBytes: number;
  fileCount: number;
  limitBytes: number | null; // null = deployment default
  pool: string;
  creationTime: number;
}

const fmtBytes = (n: number): string => {
  if (n >= GIB) return `${(n / GIB).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
};

const listUsers = async (): Promise<UserDetails[]> => {
  const doc = getDocClient(config);
  const meta = new Map<string, Record<string, unknown>>();
  const usageRows = new Map<string, { bytes?: number; fileCount?: number }>();
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: config.tableName,
        FilterExpression: 'begins_with(pk, :p) AND (sk = :meta OR sk = :usage)',
        ExpressionAttributeValues: { ':p': 'USER#', ':meta': 'META', ':usage': 'USAGE' },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of (page.Items ?? []) as Record<string, unknown>[]) {
      if (item.sk === 'META') meta.set(item.pk as string, item);
      else usageRows.set(item.pk as string, item as { bytes?: number; fileCount?: number });
    }
    startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);

  const out: UserDetails[] = [];
  for (const [pk, row] of meta) {
    const used = usageRows.get(pk);
    const state = row.isDeleted ? 'DELETED' : row.viewer ? 'viewer' : 'active';
    out.push({
      userId: row.userId as number,
      email: (row.email as string) ?? '',
      state,
      usageBytes: used?.bytes ?? 0,
      fileCount: used?.fileCount ?? 0,
      limitBytes: (row.storageLimitBytes as number | undefined) ?? null,
      pool: (row.storagePoolId as string | undefined) ?? '-',
      creationTime: (row.creationTime as number) ?? 0,
    });
  }
  return out.sort((a, b) => a.creationTime - b.creationTime);
};

const fmtLimit = (limitBytes: number | null): string => {
  if (limitBytes === null) return 'default';
  if (limitBytes === 0) return 'ZERO (no uploads)';
  return fmtBytes(limitBytes);
};

const render = (users: UserDetails[]): void => {
  if (users.length === 0) {
    console.log('no users');
    return;
  }
  const rows = users.map((u) => {
    const limit = u.limitBytes ?? config.freePlanStorageBytes;
    const pct = limit > 0 ? `${((u.usageBytes / limit) * 100).toFixed(1)}%` : '-';
    return [
      String(u.userId),
      u.email,
      u.state,
      fmtBytes(u.usageBytes),
      String(u.fileCount),
      fmtLimit(u.limitBytes),
      pct,
      u.pool,
      u.creationTime ? new Date(u.creationTime / 1000).toISOString().slice(0, 10) : '-',
    ];
  });
  const header = ['USER-ID', 'EMAIL', 'STATE', 'USAGE', 'FILES', 'LIMIT', 'USED%', 'POOL', 'CREATED'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));

  const live = users.filter((u) => u.state !== 'DELETED');
  const totalBytes = live.reduce((s, u) => s + u.usageBytes, 0);
  const totalFiles = live.reduce((s, u) => s + u.fileCount, 0);
  console.log('');
  console.log(
    `${users.length} user(s) (${live.length} live) — ${fmtBytes(totalBytes)} across ${totalFiles} file(s)`,
  );
  console.log(
    `'default' limit = the deployment's FREE_PLAN_STORAGE_BYTES; this shell resolves it to ` +
      `${fmtBytes(config.freePlanStorageBytes)} (export FREE_PLAN_STORAGE_BYTES to match the Lambda if it differs).`,
  );
};

const [command = 'list', ...args] = process.argv.slice(2);
if (command !== 'list' || args.some((a) => a !== '--json')) usage();

const users = await listUsers();
if (args.includes('--json')) console.log(JSON.stringify(users, null, 2));
else render(users);
