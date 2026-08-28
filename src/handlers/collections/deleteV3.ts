/**
 * DELETE /collections/v3/:collectionID?collectionID=&keepFiles= (auth) —
 * src: collections/collection.go TrashV3 (query-bound request):
 *  - favorites/uncategorized undeletable (400)
 *  - keepFiles=true requires an EMPTY collection (409 COLLECTION_NOT_EMPTY)
 *  - keepFiles=false trashes the OWNER's remaining files; sharee-owned files
 *    are only unlinked (museum TrashV3 trashes GetCollectionFileIDs(cID,
 *    ownerID) then removeAllFilesAddedByOthers — repo/collection.go)
 *  - every sharee is removed + feed-tombstoned (museum ScheduleDelete's
 *    `UPDATE collection_shares SET is_deleted = TRUE`)
 *  - already-deleted -> 200 no-op; tombstone feeds /collections/v2
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { bumpCollection, getOwnedCollection } from '../../domain/collections.ts';
import { getFile, restampLink, type LinkRow } from '../../domain/files.ts';
import { disableLink, removeAllSharees } from '../../domain/sharing.ts';
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

  // museum TrashV3: CollectionLinkCtrl.Disable BEFORE ScheduleDelete — the
  // public link dies (410, and its device/attempt/ceiling rows are purged)
  // ahead of the tombstone, so no anonymous viewer outlives the album.
  await disableLink(deps, collectionId);

  if (!keepFiles) {
    for (const link of live) {
      const file = await getFile(deps, link.fileID);
      if (!file) continue;
      if (file.ownerID === userId) {
        await trashFile(deps, userId, file, collectionId); // tombstones every live link
      } else {
        // Sharee-owned file: never trashed into the owner's trash — just
        // unlinked (museum removeAllFilesAddedByOthers -> RemoveFilesV3).
        await deps.db.put(restampLink(deps, link, true));
      }
    }
  }
  // museum ScheduleDelete tombstones every share row in the same transaction
  // as the collection tombstone; here it's chunked right before the bump.
  await removeAllSharees(deps, collectionId);
  await bumpCollection(deps, collection, { isDeleted: true });
  return c.body(null, 200);
};
