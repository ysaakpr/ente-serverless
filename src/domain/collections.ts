/**
 * Collections — port of pkg/controller/collections. One favorites +
 * uncategorized per user per app (duplicate create returns the existing one);
 * server-side updationTime; tombstones kept for the /collections/v2 feed.
 */

import type { Deps } from '../deps.ts';
import { keys, gsi, padTime } from './model.ts';
import { getUser } from './users.ts';
import { getSharee, listSharees, removeSharee, type ShareeRole, type ShareeRow } from './sharing.ts';
import { getFile, restampLink, type LinkRow } from './files.ts';
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

/** museum ente.CollectionUser JSON ({id,email,name,role}; name deprecated,
 * always empty from GetSharees — repo/collection.go). */
export interface CollectionUserJson {
  id: number;
  email: string;
  name: string;
  role: string;
}

/** The sharee list of one collection, as museum GetSharees emits it
 * (repo/collection.go: live shares only, one CollectionUser per sharee).
 * Museum skips users whose encrypted_email is NULLed (deleted accounts);
 * the account-deletion cascade removes our rows instead, so the isDeleted
 * filter here is defensive. Always an array, [] when unshared. */
export const shareesJson = async (deps: Deps, collectionId: number): Promise<CollectionUserJson[]> => {
  const rows = await listSharees(deps, collectionId);
  const out: CollectionUserJson[] = [];
  for (const r of rows) {
    const user = await getUser(deps, r.userID);
    if (!user || user.isDeleted) continue;
    out.push({ id: r.userID, email: user.email, name: '', role: r.role });
  }
  return out;
};

/** museum Collection JSON (ente/collection.go). `opts.sharees` is the
 * caller-resolved sharee list (getById + the /collections/v2 feed populate it,
 * matching museum's GetWithSharingDetailsForUser / GetCollectionsOwnedByUserV2);
 * left undefined it stays null, which is museum's create-response shape (a
 * fresh Collection struct never sets Sharees). */
export const collectionToJson = async (
  deps: Deps,
  row: CollectionRow,
  opts: { sharees?: CollectionUserJson[] } = {},
): Promise<Record<string, unknown>> => {
  const owner = await getUser(deps, row.ownerID);
  if (row.isDeleted) {
    // Tombstone: id + isDeleted + updationTime; key material blanked. Serves
    // both the owner's global tombstone and the sharee's per-user unshare
    // tombstone (museum keeps the share row's encryptedKey and emits
    // sharees/publicURLs as [] there — this blanked shape is the pre-sharing
    // behaviour, kept consistent; capture-gated, D50).
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
    sharees: opts.sharees ?? null,
    // Phase D seam: once share links exist, populate PublicURL objects here and
    // filter them for non-owner roles (museum FilterPublicURLsForRole — a
    // sharee never sees the link token). Museum emits [] on the v2 feeds and
    // null only on a link-less getById; null everywhere is the pre-sharing
    // behaviour, kept until Phase D captures pin it (D50).
    publicURLs: null,
    updationTime: row.updationTime,
    ...(row.magicMetadata ? { magicMetadata: row.magicMetadata } : {}),
    ...(row.pubMagicMetadata ? { pubMagicMetadata: row.pubMagicMetadata } : {}),
    app: row.app,
  };
};

/**
 * A shared collection as the SHAREE's /collections/v2 feed emits it — museum
 * GetCollectionsSharedWithUser (repo/collection.go), field for field:
 *  - encryptedKey is the sharee's own wrapped key (collection_shares.
 *    encrypted_key), and keyDecryptionNonce is ABSENT (the SELECT never reads
 *    it; sealed boxes need no nonce; the JSON tag is omitempty);
 *  - owner carries the real owner's email;
 *  - attributes is the zero struct {"version":0} (not selected there);
 *  - the owner's private magicMetadata is never exposed, pubMagicMetadata is;
 *  - sharees is the full live list, the caller included.
 */
export const sharedCollectionToJson = async (
  deps: Deps,
  row: CollectionRow,
  share: ShareeRow,
): Promise<Record<string, unknown>> => {
  const owner = await getUser(deps, row.ownerID);
  return {
    id: row.collectionId,
    owner: { id: row.ownerID, email: owner?.email ?? '', name: '', role: '' },
    encryptedKey: share.encryptedKey,
    name: '',
    encryptedName: row.encryptedName,
    nameDecryptionNonce: row.nameDecryptionNonce,
    type: row.type,
    attributes: { version: 0 },
    sharees: await shareesJson(deps, row.collectionId),
    publicURLs: null, // Phase D (museum: FilterPublicURLsForRole over the active link)
    updationTime: row.updationTime,
    ...(share.sharedAt ? { sharedAt: share.sharedAt } : {}),
    ...(row.pubMagicMetadata ? { pubMagicMetadata: row.pubMagicMetadata } : {}),
    app: row.app,
  };
};

/**
 * Revoke one sharee's access — museum UnShareContext (repo/collection.go),
 * shared by unshare, leave and the account-deletion cascade:
 *  1. drop both participant rows + write the per-user feed tombstone (one
 *     transaction, removeSharee);
 *  2. tombstone the SHAREE'S OWN file links in the collection (museum:
 *     `UPDATE collection_files SET is_deleted = TRUE ... AND f_owner_id =
 *     $sharee`) so their contributions leave everyone's diff;
 *  3. restamp the collection so the owner's (and remaining sharees') next
 *     /collections/v2 refreshes the sharee list.
 */
export const revokeShareeAccess = async (
  deps: Deps,
  collection: CollectionRow,
  shareeUserID: number,
): Promise<void> => {
  await removeSharee(deps, collection.collectionId, shareeUserID);
  const links = await deps.db.query<LinkRow>(gsi.collectionDiff(collection.collectionId), {
    index: 'gsi1',
  });
  for (const link of links) {
    if (link.isDeleted) continue;
    const file = await getFile(deps, link.fileID);
    if (file && file.ownerID === shareeUserID) {
      await deps.db.put(restampLink(deps, link, true));
    }
  }
  await bumpCollection(deps, collection, {});
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
