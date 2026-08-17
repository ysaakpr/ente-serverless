/**
 * GET /files/upload-urls?count=N (auth) — src: pkg/controller/file.go
 * GetUploadURLs: quota precheck, cap 50, key = userID/uuid, no DB writes.
 * Response: {"urls":[{objectKey,url}]}.
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { assertQuota, MAX_UPLOAD_URLS } from '../../domain/files.ts';

export const getUploadUrls = (deps: Deps) => async (c: Context) => {
  const { userId } = auth(c);
  await assertQuota(deps, userId, null);
  let count = Number.parseInt(c.req.query('count') ?? '0', 10) || 0;
  if (count > MAX_UPLOAD_URLS) count = MAX_UPLOAD_URLS;

  const urls = await Promise.all(
    Array.from({ length: count }, async () => {
      const objectKey = `${userId}/${deps.rand.uuid()}`;
      return {
        objectKey,
        url: await deps.blobs.presignPut(objectKey, deps.config.presignPutExpirySeconds),
      };
    }),
  );
  return c.json({ urls });
};
