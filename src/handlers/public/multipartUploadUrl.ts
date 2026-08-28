/**
 * POST /public-collection/multipart-upload-url (link auth) — src:
 * pkg/api/public_collection.go GetMultipartUploadURLV2. Same collect gates and
 * owner attribution as uploadUrl.ts; partMd5s are REQUIRED here — museum
 * bare-400s an empty list on the public route ("Remove once deferred multipart
 * checksums are enabled for public uploads") where the authed route tolerates
 * their absence. Response: bare {objectKey, partURLs, completeURL}.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { publicAccess } from '../../middleware/publicAccess.ts';
import { assertQuota, MAX_MULTIPART_PART_COUNT } from '../../domain/files.ts';
import { recordTempObjects } from '../../domain/staleObjects.ts';
import { blobsForPool } from '../../domain/storagePools.ts';
import {
  assertCollectEnabled,
  bumpDailyCeiling,
  getPublicCollectionRow,
} from '../../domain/publicLinks.ts';
import { errBadRequestSentinel } from '../../lib/errors.ts';

const MIN_PART_SIZE = 5 * 1024 * 1024;
const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024;

const bodySchema = z.object({
  contentLength: z.number(),
  partLength: z.number(),
  partMd5s: z.array(z.string()).nullish(),
});

export const publicMultipartUploadUrl = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
  if (!body.partMd5s || body.partMd5s.length === 0) throw errBadRequestSentinel(); // public route requires checksums
  const { link } = publicAccess(c);
  const collection = await getPublicCollectionRow(deps, link);
  assertCollectEnabled(link);

  if (body.contentLength <= 0) throw errBadRequestSentinel();
  if (body.contentLength > deps.config.maxFileSizeBytes) throw errBadRequestSentinel();
  if (body.partLength < MIN_PART_SIZE || body.partLength > MAX_PART_SIZE) {
    throw errBadRequestSentinel();
  }
  const partCount = Math.ceil(body.contentLength / body.partLength);
  if (partCount > MAX_MULTIPART_PART_COUNT) throw errBadRequestSentinel();
  if (body.partMd5s.length !== partCount) throw errBadRequestSentinel();
  // Collect mints presign into the LINK OWNER's current pool (H2, D55).
  const ctx = await assertQuota(deps, collection.ownerID, null);
  const blobs = await blobsForPool(deps, ctx.pool);
  await bumpDailyCeiling(deps, link.tokenHash, 'uploads', deps.config.publicLinkDailyUploadLimit);

  const objectKey = `${collection.ownerID}/${deps.rand.uuid()}`;
  const multipart = await blobs.createMultipart(
    objectKey,
    partCount,
    deps.config.presignPutExpirySeconds,
    body.partMd5s,
  );
  // museum AddMultipartTempObjectKey — the stale sweep aborts + deletes (D65)
  await recordTempObjects(deps, ctx.pool?.poolId, [{ objectKey, uploadID: multipart.uploadID }]);
  return c.json({
    objectKey,
    partURLs: multipart.partUrls,
    completeURL: multipart.completeUrl,
  });
};
