/**
 * GET /collections/v2/diff?collectionID=C&sinceTime=T (auth) — the file sync
 * spine. {"diff":[File...],"hasMore":bool}; page 2500; a same-updationTime
 * cluster is never split across pages (collections/files_diff.go). The
 * pagination core lives in domain/files.ts collectionDiffPage since Phase D —
 * /public-collection/diff rides the same spine.
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { COLLECTION_DIFF_LIMIT, resolveCollectionAccess } from '../../domain/collections.ts';
import { collectionDiffPage, diffJsonForLink } from '../../domain/files.ts';

export const collectionDiffV2 = (deps: Deps) => async (c: Context) => {
  const { userId } = auth(c);
  const collectionId = Number.parseInt(c.req.query('collectionID') ?? '0', 10) || 0;
  const sinceTime = Number.parseInt(c.req.query('sinceTime') ?? '0', 10) || 0;

  // Any member may read: OWNER, COLLABORATOR or VIEWER (museum GetDiffV2,
  // collections/files_diff.go, resolves access with no VerifyOwner). Museum
  // passes IncludeDeleted:false so a deleted collection's diff 404s there;
  // we keep serving tombstones to owners of deleted collections (the trash
  // replay gate leans on it) — pre-existing behaviour, capture-gated (D49).
  const { collection } = await resolveCollectionAccess(deps, userId, collectionId, {
    includeDeleted: true,
  });

  const { links, hasMore } = await collectionDiffPage(deps, collectionId, sinceTime, COLLECTION_DIFF_LIMIT);
  const diff = await Promise.all(links.map((link) => diffJsonForLink(deps, link, collection.ownerID)));
  return c.json({ diff, hasMore });
};
