/**
 * Sharing + public-link rows — Phase A of PENDING-FEATURES-PLAN.md (§2
 * Option 2, D48). Data layer only: no HTTP handlers, no wire shapes yet
 * (Phases B–D wire this to museum's routes).
 *
 * Participant rows are dual-written under both key shapes (collection side +
 * user side) inside one transactWrite, so the reverse lookup can never drift
 * from the forward one — no handler may write one side directly; every
 * mutation goes through this file. Link tokens are stored HASHED (sha256,
 * same discipline as session tokens in tokens.ts); the plaintext never lands
 * in the table. None of these rows set gsi attributes — see the rollback
 * rule in model.ts.
 */

import type { Deps } from '../deps.ts';
import { keys, skPrefixes } from './model.ts';
import { tokenHash } from './tokens.ts';

/** museum ente.ShareeRole (VIEWER can read; COLLABORATOR can also add files). */
export type ShareeRole = 'VIEWER' | 'COLLABORATOR';

export interface ShareeRow {
  pk: string;
  sk: string;
  collectionID: number;
  userID: number;
  role: ShareeRole;
  /** Collection key wrapped to the sharee's public key (crypto_box_seal). */
  encryptedKey: string;
  /** Who shared it (museum collection_shares.from_user_id). */
  sharedBy: number;
  updationTime: number;
  /** museum collection_shares.shared_at: stamped on first share, kept across a
   * role/key re-share, re-stamped when resurrecting a removed share (the
   * ON CONFLICT CASE in repo/collection.go Share). Optional because Phase A
   * rows predate the field. */
  sharedAt?: number;
  [attr: string]: unknown;
}

/** Per-user unshare tombstone (plan §3 caveat 4): surfaces the removal in the
 * SHAREE's /collections/v2 feed only — the collection row itself is never
 * touched. Museum's equivalent is the collection_shares row flipping
 * is_deleted=TRUE while keeping its updation_time (repo UnShareContext). */
export interface SharedTombstoneRow {
  pk: string;
  sk: string;
  collectionID: number;
  userID: number;
  updationTime: number;
  [attr: string]: unknown;
}

const tombstoneRow = (userID: number, collectionID: number, updationTime: number): SharedTombstoneRow => ({
  ...keys.sharedTombstone(userID, collectionID),
  collectionID,
  userID,
  updationTime,
});

/** Pointer from a collection to its ACTIVE link; the data lives on PUBTOKEN#. */
export interface CollectionLinkPointerRow {
  pk: string;
  sk: string;
  collectionID: number;
  tokenHash: string;
  createdAt: number;
  [attr: string]: unknown;
}

/** museum ente.PublicCollectionToken, keyed by token hash. */
export interface PublicLinkRow {
  pk: string;
  sk: string;
  collectionID: number;
  tokenHash: string;
  /** Epoch micros; 0 = never expires (museum semantics). */
  validTill: number;
  /** 0 = unlimited devices. */
  deviceLimit: number;
  /** Password gate: client-side argon2id params + the derived hash. */
  passHash?: string;
  nonce?: string;
  opsLimit?: number;
  memLimit?: number;
  enableDownload: boolean;
  enableCollect: boolean;
  enableJoin: boolean;
  isDisabled: boolean;
  createdBy: number;
  createdAt: number;
  [attr: string]: unknown;
}

/**
 * Upsert a participant, both sides in one transaction. A plain (unconditioned)
 * put on purpose: re-sharing overwrites role + wrapped key on both rows
 * together, which is museum's ON CONFLICT UPDATE behaviour
 * (repo/collection.go Share). The same transaction deletes any unshare
 * tombstone for the pair, so a re-share resurrects the collection in the
 * sharee's feed (museum: ON CONFLICT ... is_deleted = FALSE). sharedAt is
 * kept across a live re-share and re-stamped on a resurrection, matching the
 * ON CONFLICT CASE on shared_at.
 */
export const addSharee = async (
  deps: Deps,
  params: {
    collectionID: number;
    userID: number;
    role: ShareeRole;
    encryptedKey: string;
    sharedBy: number;
  },
): Promise<ShareeRow> => {
  const { collectionID, userID } = params;
  const existing = await getSharee(deps, collectionID, userID);
  const updationTime = deps.ids.nextUpdationTime();
  const body = { ...params, updationTime, sharedAt: existing?.sharedAt ?? updationTime };
  const collectionSide: ShareeRow = { ...keys.collectionSharee(collectionID, userID), ...body };
  const userSide: ShareeRow = { ...keys.userSharedCollection(userID, collectionID), ...body };
  await deps.db.transactWrite([
    { kind: 'put', item: collectionSide },
    { kind: 'put', item: userSide },
    { kind: 'delete', key: keys.sharedTombstone(userID, collectionID) },
  ]);
  return collectionSide;
};

/** Delete both participant rows AND write the per-user unshare tombstone,
 * atomically. Idempotent (deletes are no-ops on missing keys, matching
 * DynamoDB; a repeated remove re-stamps the tombstone, which museum also does
 * — UnShareContext bumps updation_time on every call). */
export const removeSharee = async (
  deps: Deps,
  collectionID: number,
  userID: number,
): Promise<void> => {
  await deps.db.transactWrite([
    { kind: 'delete', key: keys.collectionSharee(collectionID, userID) },
    { kind: 'delete', key: keys.userSharedCollection(userID, collectionID) },
    { kind: 'put', item: tombstoneRow(userID, collectionID, deps.ids.nextUpdationTime()) },
  ]);
};

/**
 * Collection-delete cascade: remove every participant pair and tombstone each
 * sharee's feed — museum ScheduleDelete's `UPDATE collection_shares SET
 * is_deleted = TRUE` (repo/collection.go). Chunked at 33 sharees per
 * transaction (3 ops each, under MAX_TRANSACT_OPS); each sharee's three ops
 * always land in the same chunk, so no participant is ever half-removed —
 * only the batch as a whole is non-atomic past 33 sharees.
 */
export const removeAllSharees = async (deps: Deps, collectionID: number): Promise<void> => {
  const sharees = await listSharees(deps, collectionID);
  if (sharees.length === 0) return;
  const updationTime = deps.ids.nextUpdationTime();
  const ops = sharees.flatMap((s) => [
    { kind: 'delete' as const, key: keys.collectionSharee(collectionID, s.userID) },
    { kind: 'delete' as const, key: keys.userSharedCollection(s.userID, collectionID) },
    { kind: 'put' as const, item: tombstoneRow(s.userID, collectionID, updationTime) },
  ]);
  for (let i = 0; i < ops.length; i += 99) {
    await deps.db.transactWrite(ops.slice(i, i + 99));
  }
};

export const listSharees = async (deps: Deps, collectionID: number): Promise<ShareeRow[]> =>
  deps.db.query<ShareeRow>(keys.collectionSharee(collectionID, 0).pk, {
    skPrefix: skPrefixes.sharee,
  });

/** Full user-side participant rows — the sharee feed needs role + wrapped
 * key + updationTime, not just the ids. */
export const listUserShareRows = async (deps: Deps, userID: number): Promise<ShareeRow[]> =>
  deps.db.query<ShareeRow>(keys.userSharedCollection(userID, 0).pk, {
    skPrefix: skPrefixes.sharedWithUser,
  });

export const listSharedCollectionIds = async (deps: Deps, userID: number): Promise<number[]> => {
  const rows = await listUserShareRows(deps, userID);
  return rows.map((r) => r.collectionID);
};

/** The user's unshare tombstones with updationTime > sinceTime (the sk is the
 * collectionID, not a timestamp, so the range filter runs in code — sharee
 * counts are small; museum caps participants anyway). */
export const listSharedTombstones = async (
  deps: Deps,
  userID: number,
  sinceTime: number,
): Promise<SharedTombstoneRow[]> => {
  const rows = await deps.db.query<SharedTombstoneRow>(keys.sharedTombstone(userID, 0).pk, {
    skPrefix: skPrefixes.sharedTombstone,
  });
  return rows.filter((r) => r.updationTime > sinceTime);
};

export const getSharee = async (
  deps: Deps,
  collectionID: number,
  userID: number,
): Promise<ShareeRow | null> => {
  const { pk, sk } = keys.collectionSharee(collectionID, userID);
  return deps.db.get<ShareeRow>(pk, sk);
};

/**
 * Mint a link: PUBTOKEN row + the collection's pointer, both conditioned on
 * not-exists — one active link per collection, and a second create throws
 * ConditionFailedError for the caller to map. Only the token HASH is stored;
 * the caller keeps the plaintext for the response and it is unrecoverable
 * afterwards. Flag defaults are museum's (download/join on, collect off).
 */
export const createPublicLink = async (
  deps: Deps,
  params: {
    collectionID: number;
    token: string;
    createdBy: number;
    validTill?: number;
    deviceLimit?: number;
    passHash?: string;
    nonce?: string;
    opsLimit?: number;
    memLimit?: number;
    enableDownload?: boolean;
    enableCollect?: boolean;
    enableJoin?: boolean;
  },
): Promise<PublicLinkRow> => {
  const hash = tokenHash(params.token);
  const createdAt = deps.ids.nextUpdationTime();
  const link: PublicLinkRow = {
    ...keys.publicLinkToken(hash),
    collectionID: params.collectionID,
    tokenHash: hash,
    validTill: params.validTill ?? 0,
    deviceLimit: params.deviceLimit ?? 0,
    ...(params.passHash !== undefined ? { passHash: params.passHash } : {}),
    ...(params.nonce !== undefined ? { nonce: params.nonce } : {}),
    ...(params.opsLimit !== undefined ? { opsLimit: params.opsLimit } : {}),
    ...(params.memLimit !== undefined ? { memLimit: params.memLimit } : {}),
    enableDownload: params.enableDownload ?? true,
    enableCollect: params.enableCollect ?? false,
    enableJoin: params.enableJoin ?? true,
    isDisabled: false,
    createdBy: params.createdBy,
    createdAt,
  };
  const pointer: CollectionLinkPointerRow = {
    ...keys.collectionLink(params.collectionID),
    collectionID: params.collectionID,
    tokenHash: hash,
    createdAt,
  };
  await deps.db.transactWrite([
    { kind: 'put', item: link, ifNotExists: true },
    { kind: 'put', item: pointer, ifNotExists: true },
  ]);
  return link;
};

/** Token → link, the public middleware's first (and cheapest) read. */
export const getLinkByTokenHash = async (
  deps: Deps,
  hash: string,
): Promise<PublicLinkRow | null> => {
  const { pk, sk } = keys.publicLinkToken(hash);
  return deps.db.get<PublicLinkRow>(pk, sk);
};

/** The collection's ACTIVE link (via the pointer); null once disabled. */
export const getLinkForCollection = async (
  deps: Deps,
  collectionID: number,
): Promise<PublicLinkRow | null> => {
  const { pk, sk } = keys.collectionLink(collectionID);
  const pointer = await deps.db.get<CollectionLinkPointerRow>(pk, sk);
  if (!pointer) return null;
  return getLinkByTokenHash(deps, pointer.tokenHash);
};

/**
 * Disable the collection's active link: flag the PUBTOKEN row disabled (dead
 * tokens stay dead at rest — the middleware's isDisabled check) and drop the
 * pointer, atomically. Re-enabling always mints a NEW token via
 * createPublicLink — an old token is never resurrected (plan §4.3). Returns
 * the disabled row, or null when no active link existed.
 */
export const disableLink = async (
  deps: Deps,
  collectionID: number,
): Promise<PublicLinkRow | null> => {
  const link = await getLinkForCollection(deps, collectionID);
  if (!link) return null;
  const disabled: PublicLinkRow = { ...link, isDisabled: true };
  await deps.db.transactWrite([
    { kind: 'put', item: disabled },
    { kind: 'delete', key: keys.collectionLink(collectionID) },
  ]);
  return disabled;
};
