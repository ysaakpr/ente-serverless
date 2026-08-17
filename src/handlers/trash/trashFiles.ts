/**
 * POST /files/trash (auth) — src: ente/trash.go TrashRequest +
 * pkg/controller/file.go Trash: no duplicate fileIDs, files + collections
 * owned by caller; file leaves collections into trash (deleteBy = +30d).
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { verifyFileOwnership } from '../../domain/files.ts';
import { getCollection, trashFile } from '../../domain/trash.ts';
import { DEFAULT_MAX_BATCH_SIZE } from '../../domain/collections.ts';
import { errBadRequestSentinel, errBatchSizeTooLarge, errPermissionDenied } from '../../lib/errors.ts';

const bodySchema = z.object({
  items: z.array(z.object({ fileID: z.number(), collectionID: z.number() })),
});

export const trashFiles = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
  if (body.items.length > DEFAULT_MAX_BATCH_SIZE) throw errBatchSizeTooLarge();
  const { userId } = auth(c);

  const fileIds = body.items.map((i) => i.fileID);
  if (new Set(fileIds).size !== fileIds.length) throw errBadRequestSentinel(); // duplicate fileIDs

  const files = await verifyFileOwnership(deps, userId, fileIds);

  for (const collectionId of new Set(body.items.map((i) => i.collectionID))) {
    const collection = await getCollection(deps, collectionId);
    if (!collection) throw errBadRequestSentinel();
    if (collection.ownerID !== userId) throw errPermissionDenied();
  }

  const originByFile = new Map(body.items.map((i) => [i.fileID, i.collectionID]));
  for (const file of files) {
    await trashFile(deps, userId, file, originByFile.get(file.fileId)!);
  }
  return c.body(null, 200);
};
