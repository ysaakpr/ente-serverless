/**
 * Collections — port of pkg/controller/collections. One favorites +
 * uncategorized per user per app (duplicate create returns the existing one);
 * server-side updationTime; tombstones kept for the /collections/v2 feed.
 */

import type { Deps } from '../deps.ts';
import { keys, gsi, padTime } from './model.ts';
import { getUser } from './users.ts';
import { getSharee, type ShareeRole } from './sharing.ts';
import { ConditionFailedError } from '../ports/db.ts';
import {
  errBadRequestSentinel,
  errBatchSizeTooLarge,
  errNotFound,
  errPermissionDenied,
} from '../lib/errors.ts';
import type { MagicMetadata } from './files.ts';

export const VALID_COLLECTION_TYPES = ['album', 'folder', 'favorites', 'uncategorized'];
export const COLLECTION_DIFF_LIMIT = 2500;
export const DEFAULT_MAX_BATCH_SIZE = 1000;

export interface CollectionRow {
  pk: string;
  sk: string;
  collectionId: number;
  ownerID: number;
  encryptedKey: string;
  keyDecryptionNonce: string;
  encryptedName: string;
  nameDecryptionNonce: string;
  type: string;
  attributes: Record<string, unknown>;
  magicMetadata?: MagicMetadata;
  pubMagicMetadata?: MagicMetadata;
  app: string;
  isDeleted: boolean;
  updationTime: number;
  gsi2pk: string;
  gsi2sk: string;
  [attr: string]: unknown;
}

const restampCollection = (deps: Deps, row: CollectionRow): CollectionRow => {
  const updationTime = deps.ids.nextUpdationTime();
  return {
    ...row,
    updationTime,
    gsi2sk: `${padTime(updationTime)}#${row.collectionId}`,
  };
};

export const putCollection = async (deps: Deps, row: CollectionRow): Promise<CollectionRow> => {
  // SECURITY-REVIEW-2 F3: guard the create against an id collision. Server IDs
  // are epoch-derived and only monotonic PER PROCESS, so two Lambda instances
  // minting in the same millisecond can produce the same collectionId; an
  // unconditioned put would let the second silently overwrite the first —
  // possibly another user's collection. ifNotExists + re-mint makes the loser
  // take a fresh id rather than clobber the winner.
  for (let attempt = 0; ; attempt++) {
    const stamped = restampCollection(deps, row);
    try {
      await deps.db.put(stamped, { ifNotExists: true });
      return stamped;
    } catch (err) {
      if (!(err instanceof ConditionFailedError) || attempt >= 5) throw err;
      const collectionId = deps.ids.next();
      row = { ...row, collectionId, ...keys.collection(collectionId) };
    }
  }
};

export const getCollection = async (deps: Deps, collectionId: number): Promise<CollectionRow | null> =>
  deps.db.get<CollectionRow>(keys.collection(collectionId).pk, 'META');

/** museum ente.CollectionParticipantRole (ente/access.go), minus ADMIN —
 * nothing in this repo can mint an ADMIN row yet (D49). */
export type CollectionRole = 'OWNER' | ShareeRole;

export interface CollectionAccess {
  collection: CollectionRow;
  role: CollectionRole;
}

/**
 * Role-aware access resolver — port of museum's access controller
 * (pkg/controller/access/collection.go GetCollection), same check order:
 * 404 unknown; `verifyOwner` short-circuits with 403 BEFORE the sharee
 * lookup (museum's VerifyOwner branch — a sharee still reads 403 on
 * owner-only routes); owner -> OWNER, else the sharee row's role (a single
 * GetItem, never a listing), else denied; deleted reads as 404 unless
 * `includeDeleted`. One divergence, deliberate: museum surfaces
 * non-membership as 404 (sql.ErrNoRows from GetCollectionShareeRole through
 * handler.go) — this throws 403 instead, matching the task contract and the
 * pre-sharing owner-only behaviour; capture-gated, D49.
 */
export const resolveCollectionAccess = async (
  deps: Deps,
  userId: number,
  collectionId: number,
  opts: { includeDeleted?: boolean; verifyOwner?: boolean } = {},
): Promise<CollectionAccess> => {
  const collection = await getCollection(deps, collectionId);
  if (!collection) throw errNotFound();
  if (opts.verifyOwner && collection.ownerID !== userId) throw errPermissionDenied();
  let role: CollectionRole;
  if (collection.ownerID === userId) {
    role = 'OWNER';
  } else {
    const sharee = await getSharee(deps, collectionId, userId);
    if (!sharee) throw errPermissionDenied(); // museum: 404 via sql.ErrNoRows (D49)
    role = sharee.role;
  }
  if (collection.isDeleted && !opts.includeDeleted) throw errNotFound();
  return { collection, role };
};

/** Owner-verified fetch; 404 unknown, 403 foreign (museum VerifyOwner /
 * verifyOwnership) — the thin wrapper owner-only handlers keep using. */
export const getOwnedCollection = async (
  deps: Deps,
  userId: number,
  collectionId: number,
  opts: { includeDeleted?: boolean } = {},
): Promise<CollectionRow> =>
  (await resolveCollectionAccess(deps, userId, collectionId, { ...opts, verifyOwner: true }))
    .collection;

export const newCollectionRow = (
  deps: Deps,
  userId: number,
  app: string,
  body: {
    encryptedKey: string;
    keyDecryptionNonce: string;
    encryptedName?: string;
    nameDecryptionNonce?: string;
    type: string;
    attributes?: Record<string, unknown>;
    magicMetadata?: MagicMetadata;
  },
): CollectionRow => {
  const collectionId = deps.ids.next();
  return {
    ...keys.collection(collectionId),
    collectionId,
    ownerID: userId,
    encryptedKey: body.encryptedKey,
    keyDecryptionNonce: body.keyDecryptionNonce,
    encryptedName: body.encryptedName ?? '',
    nameDecryptionNonce: body.nameDecryptionNonce ?? '',
    type: body.type,
    attributes: body.attributes ?? { version: 0 },
    ...(body.magicMetadata ? { magicMetadata: body.magicMetadata } : {}),
    app,
    isDeleted: false,
    updationTime: 0, // stamped by putCollection
    gsi2pk: gsi.userCollections(userId),
    gsi2sk: '',
  };
};

/** museum Collection JSON (ente/collection.go). */
export const collectionToJson = async (deps: Deps, row: CollectionRow): Promise<Record<string, unknown>> => {
  const owner = await getUser(deps, row.ownerID);
  if (row.isDeleted) {
    // Tombstone: id + isDeleted + updationTime; key material blanked.
    return {
      id: row.collectionId,
      owner: { id: row.ownerID, email: '', name: '', role: '' },
      encryptedKey: '',
      name: '',
      encryptedName: '',
      nameDecryptionNonce: '',
      type: row.type,
      attributes: {},
      sharees: null,
      publicURLs: null,
      updationTime: row.updationTime,
      isDeleted: true,
      app: row.app,
    };
  }
  return {
    id: row.collectionId,
    owner: { id: row.ownerID, email: owner?.email ?? '', name: '', role: '' },
    encryptedKey: row.encryptedKey,
    keyDecryptionNonce: row.keyDecryptionNonce,
    name: '',
    encryptedName: row.encryptedName,
    nameDecryptionNonce: row.nameDecryptionNonce,
    type: row.type,
    attributes: row.attributes,
    sharees: null,
    publicURLs: null,
    updationTime: row.updationTime,
    ...(row.magicMetadata ? { magicMetadata: row.magicMetadata } : {}),
    ...(row.pubMagicMetadata ? { pubMagicMetadata: row.pubMagicMetadata } : {}),
    app: row.app,
  };
};

/** Find the user's special collection (favorites/uncategorized) for an app. */
export const findCollectionByType = async (
  deps: Deps,
  userId: number,
  type: string,
  app: string,
): Promise<CollectionRow | null> => {
  const rows = await deps.db.query<CollectionRow>(gsi.userCollections(userId), { index: 'gsi2' });
  return rows.find((r) => r.type === type && r.app === app && !r.isDeleted) ?? null;
};

export const listUserCollections = async (
  deps: Deps,
  userId: number,
  sinceTime: number,
): Promise<CollectionRow[]> => {
  const rows = await deps.db.query<CollectionRow>(gsi.userCollections(userId), {
    index: 'gsi2',
    skFrom: padTime(sinceTime + 1),
  });
  return rows;
};

export const bumpCollection = async (deps: Deps, row: CollectionRow, patch: Record<string, unknown>): Promise<void> => {
  const next = restampCollection(deps, { ...row, ...patch } as CollectionRow);
  await deps.db.put(next);
};

export const assertBatchSize = (n: number): void => {
  if (n > DEFAULT_MAX_BATCH_SIZE) throw errBatchSizeTooLarge(); // museum -> 413
};

export { errBadRequestSentinel };
