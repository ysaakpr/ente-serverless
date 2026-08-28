/**
 * POST /collections/add-files · /collections/move-files ·
 * /collections/restore-files · /collections/v3/remove-files (auth) —
 * src: pkg/controller/collections/file_action.go, semantics preserved:
 *  - add: OWNER, COLLABORATOR or ADMIN (museum Role.CanAdd()) + files the
 *    CALLER owns, untrashed (FILE_IN_TRASH 409)
 *  - move: both collections owned (VerifyOwner), to != from, files owned
 *  - restore: owned collection (VerifyOwner); tombstone flips isRestored
 *  - remove v3: any member resolves, then isRemoveAllowed — the owner and an
 *    ADMIN remove any sharee-owned files; a COLLABORATOR/VIEWER removes only
 *    files they own (403 otherwise); owner-owned files are never removed
 *    here (400 — clients move or trash instead), except that an ADMIN's
 *    request for them is museum's remove-SUGGESTION branch: 200 with links
 *    untouched (suggestion store stubbed empty, D63).
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import {
  assertBatchSize,
  bumpCollectionForward,
  getOwnedCollection,
  resolveCollectionAccess,
} from '../../domain/collections.ts';
import { getFile, linkRow, restampLink, verifyFileOwnership, type FileRow, type LinkRow } from '../../domain/files.ts';
import { getTrashRow, markRestored } from '../../domain/trash.ts';
import { keys } from '../../domain/model.ts';
import { ApiError, badRequest, errBadRequestSentinel, errPermissionDenied } from '../../lib/errors.ts';

const fileItemSchema = z.object({
  id: z.number(),
  encryptedKey: z.string(),
  keyDecryptionNonce: z.string(),
});

const addSchema = z.object({ collectionID: z.number(), files: z.array(fileItemSchema) });
const moveSchema = z.object({
  fromCollectionID: z.number(),
  toCollectionID: z.number(),
  files: z.array(fileItemSchema),
});
const removeSchema = z.object({ collectionID: z.number(), fileIDs: z.array(z.number()) });

const getLink = async (deps: Deps, collectionId: number, fileId: number) =>
  deps.db.get<LinkRow>(keys.collectionFile(collectionId, fileId).pk, `FILE#${fileId}`);

/** Returns the written link's updationTime, or null when the re-add was an
 * idempotent no-op (nothing to re-emit, no collection bump). */
const upsertLink = async (
  deps: Deps,
  collectionId: number,
  item: z.infer<typeof fileItemSchema>,
): Promise<number | null> => {
  const existing = await getLink(deps, collectionId, item.id);
  if (existing && !existing.isDeleted) return null; // re-add is idempotent
  if (existing) {
    const restamped = restampLink(
      deps,
      { ...existing, encryptedKey: item.encryptedKey, keyDecryptionNonce: item.keyDecryptionNonce },
      false,
    );
    await deps.db.put(restamped);
    return restamped.updationTime;
  }
  const row = linkRow(deps, collectionId, item.id, item.encryptedKey, item.keyDecryptionNonce, deps.clock.nowMicros());
  await deps.db.put(row);
  return row.updationTime;
};

const assertNotTrashed = async (deps: Deps, userId: number, fileIds: number[]): Promise<void> => {
  for (const id of fileIds) {
    const trash = await getTrashRow(deps, userId, id);
    if (trash && !trash.isDeleted && !trash.isRestored) {
      // museum ErrFileInTrash (ente/errors.go)
      throw new ApiError(
        'FILE_IN_TRASH',
        409,
        'One or more files are in trash or have been deleted, please restore them first',
      );
    }
  }
};

export const addFiles = (deps: Deps) => async (c: Context) => {
  const body = addSchema.parse(await c.req.json());
  assertBatchSize(body.files.length);
  const { userId } = auth(c);
  // museum AddFiles: any member resolves, then Role.CanAdd() — OWNER,
  // COLLABORATOR or ADMIN (ente/access.go); the sharee adds files THEY OWN
  // into the shared album.
  const { role } = await resolveCollectionAccess(deps, userId, body.collectionID);
  if (role !== 'OWNER' && role !== 'COLLABORATOR' && role !== 'ADMIN') throw errPermissionDenied();
  await verifyFileOwnership(deps, userId, body.files.map((f) => f.id));
  await assertNotTrashed(deps, userId, body.files.map((f) => f.id));
  let latest = 0;
  for (const item of body.files) {
    const stamp = await upsertLink(deps, body.collectionID, item);
    if (stamp) latest = Math.max(latest, stamp);
  }
  // museum AddFiles restamps the collection in the same transaction (D62)
  if (latest) await bumpCollectionForward(deps, body.collectionID, latest);
  return c.body(null, 200);
};

export const moveFiles = (deps: Deps) => async (c: Context) => {
  const body = moveSchema.parse(await c.req.json());
  assertBatchSize(body.files.length);
  if (body.toCollectionID === body.fromCollectionID) throw errBadRequestSentinel();
  const { userId } = auth(c);
  await getOwnedCollection(deps, userId, body.fromCollectionID);
  await getOwnedCollection(deps, userId, body.toCollectionID);
  await verifyFileOwnership(deps, userId, body.files.map((f) => f.id));
  await assertNotTrashed(deps, userId, body.files.map((f) => f.id));

  let latestTo = 0;
  let latestFrom = 0;
  for (const item of body.files) {
    const toStamp = await upsertLink(deps, body.toCollectionID, item);
    if (toStamp) latestTo = Math.max(latestTo, toStamp);
    const fromLink = await getLink(deps, body.fromCollectionID, item.id);
    if (fromLink && !fromLink.isDeleted) {
      const tombstoned = restampLink(deps, fromLink, true);
      await deps.db.put(tombstoned);
      latestFrom = Math.max(latestFrom, tombstoned.updationTime);
    }
  }
  // museum MoveFiles restamps BOTH collections (D62)
  if (latestTo) await bumpCollectionForward(deps, body.toCollectionID, latestTo);
  if (latestFrom) await bumpCollectionForward(deps, body.fromCollectionID, latestFrom);
  return c.body(null, 200);
};

export const restoreFiles = (deps: Deps) => async (c: Context) => {
  const body = addSchema.parse(await c.req.json());
  assertBatchSize(body.files.length);
  const { userId } = auth(c);
  await getOwnedCollection(deps, userId, body.collectionID);

  let latestRestore = 0;
  for (const item of body.files) {
    const file = await getFile(deps, item.id);
    if (!file || file.ownerID !== userId) throw badRequest('file not owned');
    const trash = await getTrashRow(deps, userId, item.id);
    if (trash && !trash.isDeleted && !trash.isRestored) {
      await markRestored(deps, trash);
    }
    const stamp = await upsertLink(deps, body.collectionID, item);
    if (stamp) latestRestore = Math.max(latestRestore, stamp);
  }
  // museum RestoreFiles restamps the collection (D62)
  if (latestRestore) await bumpCollectionForward(deps, body.collectionID, latestRestore);
  return c.body(null, 200);
};

export const removeFilesV3 = (deps: Deps) => async (c: Context) => {
  const body = removeSchema.parse(await c.req.json());
  assertBatchSize(body.fileIDs.length);
  const { userId } = auth(c);
  const { collection, role } = await resolveCollectionAccess(deps, userId, body.collectionID);

  // Filter to files actively in the collection (museum FilterActiveFileIDs).
  const active: number[] = [];
  for (const id of body.fileIDs) {
    const link = await getLink(deps, body.collectionID, id);
    if (link && !link.isDeleted) active.push(id);
  }
  if (active.length === 0) return c.body(null, 200);

  // museum isRemoveAllowed (file_action.go), oracle-verified D63:
  //  - owner-owned files are never removed via this endpoint: the owner (and
  //    any non-ADMIN sharee) reads 400; an ADMIN sharee gets museum's
  //    remove-SUGGESTION branch — 200, links untouched, a suggestion queued
  //    for the owner. Our suggestion store is the empty stub (social.ts), so
  //    the ADMIN case is a 200 no-op here: wire-identical for the remove call
  //    and the (empty) suggestions inbox; only the diff's delete-suggested
  //    marker is missing (D63).
  //  - past that gate the owner and an ADMIN remove any sharee-owned file; a
  //    COLLABORATOR/VIEWER removes only files they own.
  const files = (await Promise.all(active.map((id) => getFile(deps, id)))).filter(
    (f): f is FileRow => f !== null,
  );
  const isOwner = userId === collection.ownerID;
  const ownerOwned = new Set(files.filter((f) => f.ownerID === collection.ownerID).map((f) => f.fileId));
  if (ownerOwned.size > 0 && role !== 'ADMIN') {
    throw isOwner
      ? badRequest('can not remove files owned collection owner, admins can perform remove suggestion')
      : badRequest('can not remove files owned by album owner');
  }
  if (!isOwner && role !== 'ADMIN' && files.some((f) => f.ownerID !== userId)) {
    throw errPermissionDenied(); // 'can not remove files owned by others'
  }
  let latestRemove = 0;
  for (const id of active) {
    if (ownerOwned.has(id)) continue; // ADMIN suggestion branch: no removal
    const link = await getLink(deps, body.collectionID, id);
    if (link) {
      const tombstoned = restampLink(deps, link, true);
      await deps.db.put(tombstoned);
      latestRemove = Math.max(latestRemove, tombstoned.updationTime);
    }
  }
  // museum RemoveFilesV3 restamps the collection (D62)
  if (latestRemove) await bumpCollectionForward(deps, body.collectionID, latestRemove);
  return c.body(null, 200);
};
