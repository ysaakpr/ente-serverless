/**
 * GET /files/multipart-upload-urls?count=N (auth) — count is the number of
 * PARTS the client needs. Response: {"urls":{objectKey,partURLs,completeURL}}
 * (src: ente/file.go MultipartUploadURLs, pkg/api/file.go).
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { assertQuota } from '../../domain/files.ts';

export const getMultipartUploadUrls = (deps: Deps) => async (c: Context) => {
  const { userId } = auth(c);
  await assertQuota(deps, userId, null);
  const count = Number.parseInt(c.req.query('count') ?? '0', 10) || 0;

  const objectKey = `${userId}/${deps.rand.uuid()}`;
  const multipart = await deps.blobs.createMultipart(objectKey, count, deps.config.presignExpirySeconds);
  return c.json({
    urls: {
      objectKey,
      partURLs: multipart.partUrls,
      completeURL: multipart.completeUrl,
    },
  });
};
