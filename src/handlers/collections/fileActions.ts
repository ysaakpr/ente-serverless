/**
 * POST /collections/add-files · /collections/move-files ·
 * /collections/restore-files · /collections/v3/remove-files (auth) —
 * src: pkg/controller/collections/file_action.go, semantics preserved:
 *  - add: owned collection + owned, untrashed files (FILE_IN_TRASH 409)
 *  - move: both collections owned, to != from, files owned, untrashed
 *  - restore: trash tombstone flips isRestored, link recreated with new keys
 *  - remove v3: removing files YOU own from YOUR collection is a 400
 *    ("can not remove files owned collection owner") — clients move instead.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { assertBatchSize, getOwnedCollection } from '../../domain/collections.ts';
import { getFile, linkRow, restampLink, verifyFileOwnership, type LinkRow } from '../../domain/files.ts';
import { getTrashRow, markRestored } from '../../domain/trash.ts';
import { keys } from '../../domain/model.ts';
import { ApiError, badRequest, errBadRequestSentinel } from '../../lib/errors.ts';

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

const upsertLink = async (
  deps: Deps,
  collectionId: number,
  item: z.infer<typeof fileItemSchema>,
): Promise<void> => {
  const existing = await getLink(deps, collectionId, item.id);
  if (existing && !existing.isDeleted) return; // re-add is idempotent
  if (existing) {
    await deps.db.put(
      restampLink(deps, { ...existing, encryptedKey: item.encryptedKey, keyDecryptionNonce: item.keyDecryptionNonce }, false),
    );
    return;
  }
  await deps.db.put(
    linkRow(deps, collectionId, item.id, item.encryptedKey, item.keyDecryptionNonce, deps.clock.nowMicros()),
  );
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
  await getOwnedCollection(deps, userId, body.collectionID);
  await verifyFileOwnership(deps, userId, body.files.map((f) => f.id));
  await assertNotTrashed(deps, userId, body.files.map((f) => f.id));
  for (const item of body.files) await upsertLink(deps, body.collectionID, item);
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

  for (const item of body.files) {
    await upsertLink(deps, body.toCollectionID, item);
    const fromLink = await getLink(deps, body.fromCollectionID, item.id);
    if (fromLink && !fromLink.isDeleted) {
      await deps.db.put(restampLink(deps, fromLink, true));
    }
  }
  return c.body(null, 200);
};

export const restoreFiles = (deps: Deps) => async (c: Context) => {
  const body = addSchema.parse(await c.req.json());
  assertBatchSize(body.files.length);
  const { userId } = auth(c);
  await getOwnedCollection(deps, userId, body.collectionID);

  for (const item of body.files) {
    const file = await getFile(deps, item.id);
    if (!file || file.ownerID !== userId) throw badRequest('file not owned');
    const trash = await getTrashRow(deps, userId, item.id);
    if (trash && !trash.isDeleted && !trash.isRestored) {
      await markRestored(deps, trash);
    }
    await upsertLink(deps, body.collectionID, item);
  }
  return c.body(null, 200);
};

export const removeFilesV3 = (deps: Deps) => async (c: Context) => {
  const body = removeSchema.parse(await c.req.json());
  assertBatchSize(body.fileIDs.length);
  const { userId } = auth(c);
  const collection = await getOwnedCollection(deps, userId, body.collectionID);

  // Filter to files actively in the collection (museum FilterActiveFileIDs).
  const active: number[] = [];
  for (const id of body.fileIDs) {
    const link = await getLink(deps, body.collectionID, id);
    if (link && !link.isDeleted) active.push(id);
  }
  if (active.length === 0) return c.body(null, 200);

  // Core scope = every file is owned by the collection owner, and museum
  // rejects that case outright (clients must move or trash instead).
  const owned = await Promise.all(active.map((id) => getFile(deps, id)));
  if (owned.some((f) => f && f.ownerID === collection.ownerID)) {
    throw badRequest('can not remove files owned collection owner, admins can perform remove suggestion');
  }
  for (const id of active) {
    const link = await getLink(deps, body.collectionID, id);
    if (link) await deps.db.put(restampLink(deps, link, true));
  }
  return c.body(null, 200);
};
