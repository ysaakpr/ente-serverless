/**
 * DELETE /collections/v3/:collectionID?collectionID=&keepFiles= (auth) —
 * src: collections/collection.go TrashV3 (query-bound request):
 *  - favorites/uncategorized undeletable (400)
 *  - keepFiles=true requires an EMPTY collection (409 COLLECTION_NOT_EMPTY)
 *  - keepFiles=false trashes remaining files
 *  - already-deleted -> 200 no-op; tombstone feeds /collections/v2
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { bumpCollection, getOwnedCollection } from '../../domain/collections.ts';
import { getFile, type LinkRow } from '../../domain/files.ts';
import { gsi } from '../../domain/model.ts';
import { trashFile } from '../../domain/trash.ts';
import { collectionNotEmpty, errBadRequestSentinel } from '../../lib/errors.ts';

export const deleteCollectionV3 = (deps: Deps) => async (c: Context) => {
  const collectionId = Number.parseInt(
    c.req.query('collectionID') ?? c.req.param('collectionID') ?? '',
    10,
  );
  const keepFilesRaw = c.req.query('keepFiles');
  if (!Number.isFinite(collectionId) || keepFilesRaw === undefined) throw errBadRequestSentinel();
  const keepFiles = keepFilesRaw === 'true';
  const { userId } = auth(c);

  const collection = await getOwnedCollection(deps, userId, collectionId, { includeDeleted: true });
  if (collection.type === 'favorites' || collection.type === 'uncategorized') {
    throw errBadRequestSentinel(); // AllowDelete() false
  }
  if (collection.isDeleted) return c.body(null, 200);

  const links = await deps.db.query<LinkRow>(gsi.collectionDiff(collectionId), { index: 'gsi1' });
  const live = links.filter((l) => !l.isDeleted);

  if (keepFiles && live.length > 0) throw collectionNotEmpty();

  if (!keepFiles) {
    for (const link of live) {
      const file = await getFile(deps, link.fileID);
      if (file) await trashFile(deps, userId, file, collectionId); // tombstones every live link
    }
  }
  await bumpCollection(deps, collection, { isDeleted: true });
  return c.body(null, 200);
};
