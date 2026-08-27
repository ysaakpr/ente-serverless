/**
 * Collections — port of pkg/controller/collections. One favorites +
 * uncategorized per user per app (duplicate create returns the existing one);
 * server-side updationTime; tombstones kept for the /collections/v2 feed.
 */

import type { Deps } from '../deps.ts';
import { keys, gsi, padTime } from './model.ts';
import { getUser } from './users.ts';
import {
  getSharee,
  listSharees,
  removeSharee,
  type SharedTombstoneRow,
  type ShareeRole,
  type ShareeRow,
} from './sharing.ts';
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
 * fresh Collection struct never sets Sharees). `opts.publicURLs` is the same
 * seam for share links (Phase D): the owned feed and getById pass the active
 * link's PublicURL array (possibly empty — museum emits [] there, null only on
 * a create response), filtered per role by the caller for non-owners
 * (museum FilterPublicURLsForRole). */
export const collectionToJson = async (
  deps: Deps,
  row: CollectionRow,
  opts: { sharees?: CollectionUserJson[]; publicURLs?: Record<string, unknown>[] } = {},
): Promise<Record<string, unknown>> => {
  const owner = await getUser(deps, row.ownerID);
  // Deleted rows are NOT blanked: museum's owned feed and getById read the
  // stored row unconditionally (repo/collection.go Get and
  // GetCollectionsOwnedByUserV2 — no is_deleted filter, no field scrub), so a
  // tombstone differs from a live entry only by isDeleted:true (omitempty —
  // live rows carry no flag) and by sharees/publicURLs defaulting to [] (the
  // joins come back empty once the delete cascade ran). Clients DECRYPT the
  // key material of deleted collections — web pullTrash resolves trashed
  // files' collections via getCollectionByID and calls decryptCollectionKey
  // with no isDeleted guard — so blanking it wedged the remote pull with
  // "ciphertext is too short" (D61; the old blanked shape was D50's
  // capture-gated guess).
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
    sharees: opts.sharees ?? (row.isDeleted ? [] : null),
    // Phase D: [] or the active link's PublicURL on feeds/getById (filtered
    // per role by the caller — museum FilterPublicURLsForRole); null only on
    // the create response, museum's fresh-struct shape (D50 seam closed, D51).
    publicURLs: opts.publicURLs ?? (row.isDeleted ? [] : null),
    updationTime: row.updationTime,
    ...(row.isDeleted ? { isDeleted: true } : {}),
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
  opts: { publicURLs?: Record<string, unknown>[] } = {},
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
    // Phase D: the sharee-visible slice of the active link (caller filters via
    // FilterPublicURLsForRole — museum GetCollectionsSharedWithUser). Yes, a
    // sharee whose role satisfies minRole sees the full URL, token included —
    // museum behaviour, reproduced. [] when link-less.
    publicURLs: opts.publicURLs ?? [],
    updationTime: row.updationTime,
    ...(share.sharedAt ? { sharedAt: share.sharedAt } : {}),
    ...(row.pubMagicMetadata ? { pubMagicMetadata: row.pubMagicMetadata } : {}),
    app: row.app,
  };
};

/**
 * The SHAREE's unshare/delete tombstone as their /collections/v2 feed emits
 * it — museum GetCollectionsSharedWithUser scans flipped (is_deleted=TRUE)
 * collection_shares rows exactly like live ones: the collection's stored name
 * fields/type/app/pubMagicMetadata ride along, encryptedKey is the share
 * row's own wrapped key (UnShareContext only flips the flag — the key stays),
 * and only the former owner's email, sharees and publicURLs are emptied
 * (repo/collection.go). keyDecryptionNonce stays ABSENT, as on live sharee
 * entries (sealed boxes need no nonce), and attributes is the zero struct.
 * Pre-D61 SHAREDTOMB rows never stored the wrapped key — those emit
 * encryptedKey:'' (clients act on id+isDeleted before touching tombstone key
 * material; backfill gap noted in D61).
 */
export const unsharedTombstoneToJson = (
  row: CollectionRow,
  tomb: SharedTombstoneRow,
): Record<string, unknown> => ({
  id: row.collectionId,
  owner: { id: row.ownerID, email: '', name: '', role: '' },
  encryptedKey: tomb.encryptedKey ?? '',
  name: '',
  encryptedName: row.encryptedName,
  nameDecryptionNonce: row.nameDecryptionNonce,
  type: row.type,
  attributes: { version: 0 },
  sharees: [],
  publicURLs: [],
  updationTime: tomb.updationTime,
  isDeleted: true,
  ...(tomb.sharedAt ? { sharedAt: tomb.sharedAt } : {}),
  ...(row.pubMagicMetadata ? { pubMagicMetadata: row.pubMagicMetadata } : {}),
  app: row.app,
});

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

/**
 * Museum bumps collections.updation_time on EVERY collection_files mutation
 * (repo/file.go Create/Update/UpdateMagicAttributes/UpdateThumbnail,
 * repo/collection.go AddFiles/MoveFiles/RestoreFiles/RemoveFilesV3,
 * repo/trash.go TrashFiles — all end in `UPDATE collections SET
 * updation_time`) and on every public_collection_tokens INSERT/UPDATE (the
 * fn_update_collections_updation_time_using_update_at trigger). Without the
 * bump the collection never re-emits in /collections/v2, and the stock
 * clients — which only re-diff collections whose updationTime advanced —
 * never pull the change (the collect-upload-invisible bug, D62).
 *
 * `stamp` is the mutation's own updationTime (museum sets equality — the
 * oracle shows collection stamp == the new file link's stamp). Forward-only,
 * like the trigger's `updation_time < NEW.updated_at` guard; re-reads the row
 * to narrow the read-modify-write window. Deleted collections bump too
 * (museum's SQL has no is_deleted filter).
 */
export const bumpCollectionForward = async (
  deps: Deps,
  collectionId: number,
  stamp: number,
): Promise<void> => {
  const row = await getCollection(deps, collectionId);
  if (!row || row.updationTime >= stamp) return;
  await deps.db.put({ ...row, updationTime: stamp, gsi2sk: `${padTime(stamp)}#${row.collectionId}` });
};

export const assertBatchSize = (n: number): void => {
  if (n > DEFAULT_MAX_BATCH_SIZE) throw errBatchSizeTooLarge(); // museum -> 413
};

export { errBadRequestSentinel };
