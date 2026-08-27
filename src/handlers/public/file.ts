/**
 * POST /public-collection/file (link auth) — the anonymous collect COMMIT.
 * src: pkg/api/public_collection.go CreateFile + pkg/controller/public/
 * collection_link.go CreateFile. Museum forces file.ID = 0 ("Don't allow
 * public links to update files") and file.OwnerID = the COLLECTION OWNER,
 * then runs the normal FileController.Create as the owner — so the file row,
 * the object-key namespace check (`<ownerID>/...`) and the quota charge all
 * land on the link owner, never on the anonymous uploader. Gates:
 * body.collectionID must equal the link's collection -> 400
 * {"code":"BAD_REQUEST","message":"can only update to associated collection"};
 * enableCollect=false -> 405 PUBLIC_COLLECT_DISABLED; deleted collection ->
 * 404; plus the per-link daily upload ceiling -> 429 {} (plan §4.1d, D51).
 * Response: the full committed File JSON, exactly like the authed commit.
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { publicAccess } from '../../middleware/publicAccess.ts';
import { commitSchema, createFile } from '../files/commit.ts';
import { validateCommitShape } from '../../domain/files.ts';
import {
  assertCollectEnabled,
  bumpDailyCeiling,
  getPublicCollectionRow,
} from '../../domain/publicLinks.ts';
import { badRequest } from '../../lib/errors.ts';

export const publicCreateFile = (deps: Deps) => async (c: Context) => {
  const body = commitSchema.parse(await c.req.json());
  const { link } = publicAccess(c);
  if (body.collectionID !== link.collectionID) {
    throw badRequest('can only update to associated collection');
  }
  const collection = await getPublicCollectionRow(deps, link);
  assertCollectEnabled(link);

  // Museum: file.ID = 0, file.OwnerID = collection owner — updates are
  // impossible through a link, and attribution is flipped to the owner.
  const asOwner = { ...body, id: 0, ownerID: collection.ownerID };
  validateCommitShape(collection.ownerID, asOwner);
  await bumpDailyCeiling(deps, link.tokenHash, 'uploads', deps.config.publicLinkDailyUploadLimit);
  return c.json(await createFile(deps, collection.ownerID, asOwner));
};
