/**
 * Collections — port of pkg/controller/collections. One favorites +
 * uncategorized per user per app (duplicate create returns the existing one);
 * server-side updationTime; tombstones kept for the /collections/v2 feed.
 */

import type { Deps } from '../deps.ts';
import { keys, gsi, padTime } from './model.ts';
import { getUser } from './users.ts';
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
  const stamped = restampCollection(deps, row);
  await deps.db.put(stamped);
  return stamped;
};

export const getCollection = async (deps: Deps, collectionId: number): Promise<CollectionRow | null> =>
  deps.db.get<CollectionRow>(keys.collection(collectionId).pk, 'META');

/** Owner-verified fetch; 404 unknown, 403 foreign (museum verifyOwnership). */
export const getOwnedCollection = async (
  deps: Deps,
  userId: number,
  collectionId: number,
  opts: { includeDeleted?: boolean } = {},
): Promise<CollectionRow> => {
  const row = await getCollection(deps, collectionId);
  if (!row) throw errNotFound();
  if (row.ownerID !== userId) throw errPermissionDenied();
  if (row.isDeleted && !opts.includeDeleted) throw errNotFound();
  return row;
};

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
