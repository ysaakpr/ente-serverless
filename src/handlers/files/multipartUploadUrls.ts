/**
 * GET /files/multipart-upload-urls?count=N (auth) — count is the number of
 * PARTS the client needs. Response: {"urls":{objectKey,partURLs,completeURL}}
 * (src: ente/file.go MultipartUploadURLs, pkg/api/file.go).
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { assertQuota, MAX_MULTIPART_PART_COUNT } from '../../domain/files.ts';
import { blobsForPool } from '../../domain/storagePools.ts';
import { errBadRequestSentinel } from '../../lib/errors.ts';

export const getMultipartUploadUrls = (deps: Deps) => async (c: Context) => {
  const { userId } = auth(c);
  const ctx = await assertQuota(deps, userId, null);
  const blobs = await blobsForPool(deps, ctx.pool); // current pool (H2, D55)
  const count = Number.parseInt(c.req.query('count') ?? '0', 10) || 0;
  // Reject rather than clamp, unlike /files/upload-urls. Those URLs are
  // independent, so handing back fewer is harmless; these are PARTS of one
  // object, and a client that silently got fewer would upload an incomplete
  // object and only discover it at CompleteMultipartUpload. Past 10k is
  // unsatisfiable at S3 anyway. Same 400 the V2 route gives.
  // The count >= 1 half matters too: count=0 used to reach S3 and open a real
  // multipart upload with no parts, billing until the 7-day abort rule swept it.
  if (count < 1 || count > MAX_MULTIPART_PART_COUNT) throw errBadRequestSentinel();

  const objectKey = `${userId}/${deps.rand.uuid()}`;
  const multipart = await blobs.createMultipart(objectKey, count, deps.config.presignPutExpirySeconds);
  return c.json({
    urls: {
      objectKey,
      partURLs: multipart.partUrls,
      completeURL: multipart.completeUrl,
    },
  });
};
