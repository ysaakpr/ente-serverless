/**
 * POST /collections/leave/:collectionID (auth) — src: pkg/api/collection.go
 * Leave + pkg/controller/collections/share.go Leave. Sharee-only: the owner
 * gets 403 ("can not leave collection owned by self"); a non-member is a 200
 * no-op. Leaving runs museum's UnShare for the caller, which also removes the
 * LEAVER'S OWN files from the collection (UnShareContext's collection_files
 * update) — verified in source and matched via revokeShareeAccess.
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { getCollection, revokeShareeAccess } from '../../domain/collections.ts';
import { getSharee } from '../../domain/sharing.ts';
import { errBadRequestSentinel, errNotFound, errPermissionDenied } from '../../lib/errors.ts';

export const leaveCollection = (deps: Deps) => async (c: Context) => {
  const collectionId = Number.parseInt(c.req.param('collectionID') ?? '', 10);
  if (!Number.isFinite(collectionId)) throw errBadRequestSentinel();
  const { userId } = auth(c);

  // museum repo.Get: unknown -> 404; deleted collections are returned (the
  // delete cascade already removed the sharee rows, so leaving one no-ops).
  const collection = await getCollection(deps, collectionId);
  if (!collection) throw errNotFound();
  if (collection.ownerID === userId) throw errPermissionDenied(); // owner cannot leave

  // museum: not among GetCollectionIDsSharedWithUser -> nil (200 no-op).
  const share = await getSharee(deps, collectionId, userId);
  if (!share) return c.body(null, 200);

  await revokeShareeAccess(deps, collection, userId);
  return c.body(null, 200);
};
