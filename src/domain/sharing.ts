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
  [attr: string]: unknown;
}

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
 * together, which is museum's ON CONFLICT UPDATE behaviour.
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
  const body = { ...params, updationTime: deps.ids.nextUpdationTime() };
  const collectionSide: ShareeRow = { ...keys.collectionSharee(collectionID, userID), ...body };
  const userSide: ShareeRow = { ...keys.userSharedCollection(userID, collectionID), ...body };
  await deps.db.transactWrite([
    { kind: 'put', item: collectionSide },
    { kind: 'put', item: userSide },
  ]);
  return collectionSide;
};

/** Delete both participant rows atomically. Idempotent (deletes are no-ops
 * on missing keys, matching DynamoDB). Phase C adds the per-user feed
 * tombstone (keys.sharedTombstone) to this same transaction. */
export const removeSharee = async (
  deps: Deps,
  collectionID: number,
  userID: number,
): Promise<void> => {
  await deps.db.transactWrite([
    { kind: 'delete', key: keys.collectionSharee(collectionID, userID) },
    { kind: 'delete', key: keys.userSharedCollection(userID, collectionID) },
  ]);
};

export const listSharees = async (deps: Deps, collectionID: number): Promise<ShareeRow[]> =>
  deps.db.query<ShareeRow>(keys.collectionSharee(collectionID, 0).pk, {
    skPrefix: skPrefixes.sharee,
  });

export const listSharedCollectionIds = async (deps: Deps, userID: number): Promise<number[]> => {
  const rows = await deps.db.query<ShareeRow>(keys.userSharedCollection(userID, 0).pk, {
    skPrefix: skPrefixes.sharedWithUser,
  });
  return rows.map((r) => r.collectionID);
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
