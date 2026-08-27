/**
 * GET /public-collection/diff?sinceTime=T (link auth) — src: pkg/api/
 * public_collection.go GetDiff + pkg/controller/collections/share.go
 * GetPublicDiff. Same pagination spine as /collections/v2/diff (2500, cluster
 * never split); response {"diff":[File...],"hasMore":bool}.
 *
 * The public scrub, per GetPublicDiff: the owner's private magicMetadata is
 * stripped from every entry (pubMagicMetadata passes). Museum additionally
 * converts its collection-action markers (remove/delete-suggested) and the
 * `metadata.encryptedData == "-"` stale-row marker into isDeleted — this repo
 * has neither marker (links tombstone via isDeleted directly), so those
 * branches have no equivalent here. A missing sinceTime is a 400
 * {"code":"BAD_REQUEST",...} (museum ParseInt failure), unlike the authed
 * diff's default-to-0 — upstream difference, reproduced.
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { publicAccess } from '../../middleware/publicAccess.ts';
import { COLLECTION_DIFF_LIMIT } from '../../domain/collections.ts';
import { collectionDiffPage, diffJsonForLink } from '../../domain/files.ts';
import { getPublicCollectionRow } from '../../domain/publicLinks.ts';
import { ApiError } from '../../lib/errors.ts';

export const publicCollectionDiff = (deps: Deps) => async (c: Context) => {
  const raw = c.req.query('sinceTime') ?? '';
  const sinceTime = Number.parseInt(raw, 10);
  if (!/^-?\d+$/.test(raw) || !Number.isFinite(sinceTime)) {
    throw new ApiError('BAD_REQUEST', 400, `invalid sinceTime val: ${raw}`);
  }
  const { link } = publicAccess(c);
  const collection = await getPublicCollectionRow(deps, link);

  const { links, hasMore } = await collectionDiffPage(
    deps,
    link.collectionID,
    sinceTime,
    COLLECTION_DIFF_LIMIT,
  );
  const diff = await Promise.all(
    links.map(async (l) => {
      const entry = await diffJsonForLink(deps, l, collection.ownerID);
      delete entry.magicMetadata; // never expose private metadata publicly
      return entry;
    }),
  );
  return c.json({ diff, hasMore });
};
