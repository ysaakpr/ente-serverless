/**
 * The V2 upload routes the CURRENT mobile app actually uses (found during the
 * M5 device gate — gateways/files/file_upload_gateway.dart):
 *  - GET  /files/upload-eligibility           (quota probe, 200 empty)
 *  - POST /files/upload-url                   {contentLength, contentMD5} -> bare {objectKey, url}
 *  - POST /files/multipart-upload-url         {contentLength, partLength, partMd5s}
 *                                             -> bare {objectKey, partURLs, completeURL}
 * src: pkg/controller/file.go GetUploadURLWithMetadata /
 * GetMultipartUploadURLWithMetadata. Divergence D26: we presign without
 * binding Content-MD5/Content-Length into the signature (unsigned headers are
 * ignored by SigV4 query auth, so the app's headers still pass).
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { assertQuota } from '../../domain/files.ts';
import { errBadRequestSentinel } from '../../lib/errors.ts';

const MIN_PART_SIZE = 5 * 1024 * 1024;
const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024;
const MAX_PART_COUNT = 10_000;

export const uploadEligibility = (deps: Deps) => async (c: Context) => {
  await assertQuota(deps, auth(c).userId, null);
  return c.body(null, 200);
};

const singleSchema = z.object({
  contentLength: z.number(),
  contentMD5: z.string().min(1),
});

export const getUploadUrlV2 = (deps: Deps) => async (c: Context) => {
  const body = singleSchema.parse(await c.req.json());
  const { userId } = auth(c);
  if (body.contentLength <= 0) throw errBadRequestSentinel();
  if (body.contentLength > deps.config.maxFileSizeBytes) throw errBadRequestSentinel();
  await assertQuota(deps, userId, body.contentLength);

  const objectKey = `${userId}/${deps.rand.uuid()}`;
  const url = await deps.blobs.presignPut(objectKey, deps.config.presignExpirySeconds);
  return c.json({ objectKey, url });
};

const multipartSchema = z.object({
  contentLength: z.number(),
  partLength: z.number(),
  partMd5s: z.array(z.string()).nullish(),
});

export const getMultipartUploadUrlV2 = (deps: Deps) => async (c: Context) => {
  const body = multipartSchema.parse(await c.req.json());
  const { userId } = auth(c);
  if (body.contentLength <= 0) throw errBadRequestSentinel();
  if (body.contentLength > deps.config.maxFileSizeBytes) throw errBadRequestSentinel();
  if (body.partLength < MIN_PART_SIZE || body.partLength > MAX_PART_SIZE) {
    throw errBadRequestSentinel();
  }
  const partCount = Math.ceil(body.contentLength / body.partLength);
  if (partCount > MAX_PART_COUNT) throw errBadRequestSentinel();
  if (body.partMd5s && body.partMd5s.length !== partCount) throw errBadRequestSentinel();
  await assertQuota(deps, userId, null);

  const objectKey = `${userId}/${deps.rand.uuid()}`;
  const multipart = await deps.blobs.createMultipart(
    objectKey,
    partCount,
    deps.config.presignExpirySeconds,
  );
  return c.json({
    objectKey,
    partURLs: multipart.partUrls,
    completeURL: multipart.completeUrl,
  });
};
