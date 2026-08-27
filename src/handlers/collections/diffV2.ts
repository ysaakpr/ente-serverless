/**
 * GET /collections/v2/diff?collectionID=C&sinceTime=T (auth) — the file sync
 * spine. {"diff":[File...],"hasMore":bool}; page 2500; a same-updationTime
 * cluster is never split across pages (collections/files_diff.go).
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { gsi, padTime } from '../../domain/model.ts';
import { COLLECTION_DIFF_LIMIT, resolveCollectionAccess } from '../../domain/collections.ts';
import { fileToDiffJson, getFile, type LinkRow } from '../../domain/files.ts';

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

  const page = await deps.db.query<LinkRow>(gsi.collectionDiff(collectionId), {
    index: 'gsi1',
    skFrom: padTime(sinceTime + 1),
    limit: COLLECTION_DIFF_LIMIT + 1,
  });

  let links = page;
  let hasMore = false;
  if (page.length > COLLECTION_DIFF_LIMIT) {
    hasMore = true;
    const boundary = page[COLLECTION_DIFF_LIMIT]!.updationTime;
    links = page.filter((l) => l.updationTime !== boundary);
    if (links.length === 0) {
      // Whole page shares one version: return the entire cluster (never split).
      links = await deps.db.query<LinkRow>(gsi.collectionDiff(collectionId), {
        index: 'gsi1',
        skFrom: padTime(boundary),
        skTo: `${padTime(boundary)}#￿`,
      });
    }
  }

  const diff = await Promise.all(
    links.map(async (link) => {
      const file = await getFile(deps, link.fileID);
      if (!file) {
        // File row is gone (permanent delete). Museum still emits the link as
        // a deletion tombstone (the stale-entry isDeleted patch in files_diff.go).
        return fileToDiffJson(
          {
            fileId: link.fileID,
            ownerID: collection.ownerID,
            info: { fileSize: 0, thumbSize: 0 },
            file: { decryptionHeader: '' },
            thumbnail: { decryptionHeader: '' },
            metadata: { decryptionHeader: '' },
          } as never,
          { ...link, isDeleted: true },
          collection.ownerID,
        );
      }
      return fileToDiffJson(file, link, collection.ownerID);
    }),
  );
  return c.json({ diff, hasMore });
};
