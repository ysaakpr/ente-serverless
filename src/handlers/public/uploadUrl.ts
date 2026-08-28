/**
 * POST /public-collection/upload-url (link auth) — the COLLECT flow's presign
 * mint. src: pkg/api/public_collection.go GetUploadURLV2 (the public surface
 * has only the V2 POST routes — no GET /upload-urls fan-out) + controller
 * GetPublicCollection(mustAllowCollect) + file.go GetUploadURLWithMetadata.
 *
 * Attribution is the whole point (plan §2.D.3): the object key lands under
 * the LINK OWNER's namespace (`<ownerID>/<uuid>`) and quota is asserted
 * against the owner — the anonymous uploader has no identity. Gates:
 * enableCollect=false -> 405 PUBLIC_COLLECT_DISABLED; deleted collection ->
 * 404; contentLength <= 0 or > max -> bare 400; plus the per-link daily
 * upload ceiling -> 429 {} (plan §4.1d, D51 — no museum equivalent).
 * Response: bare {objectKey, url}, same as the authed POST /files/upload-url.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { publicAccess } from '../../middleware/publicAccess.ts';
import { assertQuota } from '../../domain/files.ts';
import { recordTempObjects } from '../../domain/staleObjects.ts';
import { blobsForPool } from '../../domain/storagePools.ts';
import {
  assertCollectEnabled,
  bumpDailyCeiling,
  getPublicCollectionRow,
} from '../../domain/publicLinks.ts';
import { errBadRequestSentinel } from '../../lib/errors.ts';

const bodySchema = z.object({
  contentLength: z.number(),
  contentMD5: z.string().min(1),
});

export const publicUploadUrl = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
  const { link } = publicAccess(c);
  const collection = await getPublicCollectionRow(deps, link);
  assertCollectEnabled(link);

  if (body.contentLength <= 0) throw errBadRequestSentinel();
  if (body.contentLength > deps.config.maxFileSizeBytes) throw errBadRequestSentinel();
  // Collected bytes land in the LINK OWNER's current pool, like any other
  // owner-attributed upload (H2, D55); the commit stamps the pin as usual.
  const ctx = await assertQuota(deps, collection.ownerID, body.contentLength);
  const blobs = await blobsForPool(deps, ctx.pool);
  await bumpDailyCeiling(deps, link.tokenHash, 'uploads', deps.config.publicLinkDailyUploadLimit);

  const objectKey = `${collection.ownerID}/${deps.rand.uuid()}`;
  const url = await blobs.presignPut(
    objectKey,
    deps.config.presignPutExpirySeconds,
    body.contentMD5,
  );
  await recordTempObjects(deps, ctx.pool?.poolId, [{ objectKey }]); // museum AddTempObjectKey (D65)
  return c.json({ objectKey, url });
};
