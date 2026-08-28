/**
 * BYO storage pools (Phase H2, D55). A pool is ONE S3 bucket — typically
 * owned and paid for by a household — shared by MULTIPLE users (many-to-one).
 * Object keys stay `<userID>/<uuid>`, so each member has their own prefix
 * inside the shared bucket. The pool is purely a storage/billing grouping:
 * it is INVISIBLE to authorization (getAccessibleFile /
 * resolveCollectionAccess never consult it — locked by test), and clients only
 * ever see presigned URLs, so nothing here is client-visible.
 *
 * Pinning: every file records at COMMIT time which pool its bytes landed in
 * (`storagePoolId` on the file row; `thumbPoolId` only when a later
 * thumbnail-replacement lands the thumb in a different pool). Reads, purges
 * and account-deletion cleanup resolve the bucket from the PIN, never from
 * the owner's current pool — so reassigning a user affects only NEW uploads
 * and never strands old bytes.
 *
 * Rows are ops-provisioned (tools/storagePool.ts) and never written by a
 * client route. Static credentials are secretbox-encrypted at rest with a key
 * derived from HASHING_KEY (same derive-don't-reuse discipline as the D51 JWT
 * secret); plaintext secrets never land in the table and are never logged.
 */

import sodium from '../lib/sodium.ts';
import type { Deps } from '../deps.ts';
import type { Blobs, PoolDescriptor } from '../ports/blobs.ts';
import { keys } from './model.ts';
import { emailHash, normalizeEmail } from './tokens.ts';
import { b64, fromB64 } from '../lib/b64.ts';

export interface PoolRow {
  pk: string;
  sk: string;
  /** Short operator-chosen slug (e.g. 'smith'). */
  poolId: string;
  mode: 'role' | 'keys';
  bucket: string;
  region: string;
  /** S3-compatible endpoint; unset = real AWS S3. */
  endpoint?: string;
  /** mode 'role': the bucket-access role this deployment assumes. */
  roleArn?: string;
  /** mode 'role': REQUIRED — the confused-deputy guard on the trust policy. */
  externalId?: string;
  /** mode 'keys': secretbox(nonce ‖ cipher), base64 — never plaintext. */
  encryptedAccessKey?: string;
  encryptedSecretKey?: string;
  /** Shared cap across ALL members' pinned bytes; absent = unlimited pool. */
  poolStorageLimitBytes?: number;
  createdAt: number;
  /** Blocks NEW uploads into the pool (426); reads and purges still resolve. */
  disabled?: boolean;
  [attr: string]: unknown;
}

/** What the pool functions actually need — full Deps satisfies these, and
 * tools/storagePool.ts wires a Db + clock + hashingKey without mail/blobs. */
export type PoolDeps = Pick<Deps, 'db' | 'clock' | 'hashingKey'>;
export type PoolReadDeps = Pick<Deps, 'db'>;
export type PoolBlobsDeps = Pick<Deps, 'db' | 'blobs' | 'blobsResolver' | 'hashingKey'>;

// --- credential encryption ---------------------------------------------------

/**
 * Key for the pool-credential secretbox, derived from HASHING_KEY with a fixed
 * context — the same derive-don't-reuse pattern as the D51 public-link JWT
 * secret, keeping the email-hash, JWT and credential domains cryptographically
 * separate. KMS was the alternative; a derived key was chosen because the
 * deployment already treats HASHING_KEY as its root secret (losing it already
 * orphans every account) and adds no per-request cost or new IAM surface. D55.
 */
export const poolCredentialKey = (hashingKey: Uint8Array): Uint8Array =>
  sodium.crypto_generichash(32, 'ente-serverless:storage-pool-credentials:v1', hashingKey);

export const encryptPoolSecret = (hashingKey: Uint8Array, plaintext: string): string => {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const cipher = sodium.crypto_secretbox_easy(
    new TextEncoder().encode(plaintext),
    nonce,
    poolCredentialKey(hashingKey),
  );
  const out = new Uint8Array(nonce.length + cipher.length);
  out.set(nonce);
  out.set(cipher, nonce.length);
  return b64(out);
};

export const decryptPoolSecret = (hashingKey: Uint8Array, encrypted: string): string => {
  const raw = fromB64(encrypted);
  const nonce = raw.slice(0, sodium.crypto_secretbox_NONCEBYTES);
  const cipher = raw.slice(sodium.crypto_secretbox_NONCEBYTES);
  return new TextDecoder().decode(
    sodium.crypto_secretbox_open_easy(cipher, nonce, poolCredentialKey(hashingKey)),
  );
};

// --- rows ---------------------------------------------------------------------

const POOL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const isValidPoolId = (poolId: string): boolean => POOL_ID_RE.test(poolId);

export const getPool = async (deps: PoolReadDeps, poolId: string): Promise<PoolRow | null> =>
  deps.db.get<PoolRow>(keys.storagePool(poolId).pk, 'META');

export interface PoolInput {
  poolId: string;
  mode: 'role' | 'keys';
  bucket: string;
  region: string;
  endpoint?: string;
  roleArn?: string;
  externalId?: string;
  /** Plaintext here; encrypted before the row is written. */
  accessKey?: string;
  secretKey?: string;
  poolStorageLimitBytes?: number;
}

/** Build + write the POOL row (upsert — re-onboarding rotates credentials). */
export const putPool = async (deps: PoolDeps, input: PoolInput): Promise<PoolRow> => {
  if (!isValidPoolId(input.poolId)) {
    throw new Error(`invalid pool id ${JSON.stringify(input.poolId)} (want [a-z0-9-], <= 64 chars)`);
  }
  if (input.mode === 'role' && (!input.roleArn || !input.externalId)) {
    throw new Error('mode role requires roleArn AND externalId (the confused-deputy guard)');
  }
  if (input.mode === 'keys' && (!input.accessKey || !input.secretKey)) {
    throw new Error('mode keys requires accessKey and secretKey');
  }
  const existing = await getPool(deps, input.poolId);
  const row: PoolRow = {
    ...keys.storagePool(input.poolId),
    poolId: input.poolId,
    mode: input.mode,
    bucket: input.bucket,
    region: input.region,
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    ...(input.mode === 'role'
      ? { roleArn: input.roleArn, externalId: input.externalId }
      : {
          encryptedAccessKey: encryptPoolSecret(deps.hashingKey, input.accessKey!),
          encryptedSecretKey: encryptPoolSecret(deps.hashingKey, input.secretKey!),
        }),
    ...(input.poolStorageLimitBytes !== undefined
      ? { poolStorageLimitBytes: input.poolStorageLimitBytes }
      : {}),
    createdAt: existing?.createdAt ?? deps.clock.nowMicros(),
  };
  await deps.db.put(row);
  return row;
};

export const setPoolQuota = async (
  deps: PoolReadDeps,
  poolId: string,
  bytes: number | null,
): Promise<PoolRow | null> => {
  const pool = await getPool(deps, poolId);
  if (!pool) return null;
  await deps.db.update(pool.pk, pool.sk, { poolStorageLimitBytes: bytes ?? undefined });
  return pool;
};

export const setPoolDisabled = async (
  deps: PoolReadDeps,
  poolId: string,
  disabled: boolean,
): Promise<PoolRow | null> => {
  const pool = await getPool(deps, poolId);
  if (!pool) return null;
  await deps.db.update(pool.pk, pool.sk, { disabled: disabled || undefined });
  return pool;
};

export const getPoolUsage = async (
  deps: PoolReadDeps,
  poolId: string,
): Promise<{ bytes: number; fileCount: number }> => {
  const row = await deps.db.get(keys.poolUsage(poolId).pk, 'USAGE');
  return { bytes: (row?.bytes as number) ?? 0, fileCount: (row?.fileCount as number) ?? 0 };
};

/**
 * Attach/detach a user (post-signup) to a pool: the routing seam is the
 * `storagePoolId` attribute on the user row, read by loadQuotaContext on every
 * mint/commit. Affects NEW uploads only — existing files stay pinned.
 */
export const setUserPool = async (
  deps: Pick<Deps, 'db' | 'hashingKey'>,
  email: string,
  poolId: string | null,
): Promise<{ userId: number } | null> => {
  const hash = emailHash(normalizeEmail(email), deps.hashingKey);
  const guard = await deps.db.get(keys.emailGuard(hash).pk, 'META');
  if (!guard) return null;
  const userId = guard.userId as number;
  const key = keys.user(userId);
  await deps.db.update(key.pk, key.sk, { storagePoolId: poolId ?? undefined });
  return { userId };
};

// --- resolution ---------------------------------------------------------------

/** POOL row -> adapter descriptor; decrypts static credentials in memory only. */
export const poolDescriptor = (
  deps: Pick<Deps, 'hashingKey'>,
  pool: PoolRow,
): PoolDescriptor => ({
  poolId: pool.poolId,
  mode: pool.mode,
  bucket: pool.bucket,
  region: pool.region,
  ...(pool.endpoint ? { endpoint: pool.endpoint } : {}),
  ...(pool.mode === 'role'
    ? { roleArn: pool.roleArn, externalId: pool.externalId }
    : {
        accessKey: decryptPoolSecret(deps.hashingKey, pool.encryptedAccessKey!),
        secretKey: decryptPoolSecret(deps.hashingKey, pool.encryptedSecretKey!),
      }),
});

/** Blobs client for a resolved pool row; null = the central default bucket. */
export const blobsForPool = async (deps: PoolBlobsDeps, pool: PoolRow | null): Promise<Blobs> =>
  deps.blobsResolver.forPool(pool ? poolDescriptor(deps, pool) : null);

/**
 * Blobs client for a PIN (file-row poolId). A pin pointing at a missing pool
 * row is an operator error (pool deleted while files still reference it) —
 * fail closed with a 5xx rather than silently reading the wrong bucket.
 */
export const blobsForPoolId = async (
  deps: PoolBlobsDeps,
  poolId: string | undefined,
): Promise<Blobs> => {
  if (!poolId) return deps.blobs;
  const pool = await getPool(deps, poolId);
  if (!pool) throw new Error(`storage pool ${poolId} is not onboarded (dangling pin)`);
  return blobsForPool(deps, pool);
};
