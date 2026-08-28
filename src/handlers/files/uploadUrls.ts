/**
 * GET /files/upload-urls?count=N (auth) — src: pkg/controller/file.go
 * GetUploadURLs: quota precheck, cap 50, key = userID/uuid; each mint is
 * recorded as a temp object (getObjectURL → AddTempObjectKey) so the stale
 * sweep can reclaim never-committed keys (D65).
 * Response: {"urls":[{objectKey,url}]}.
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { assertQuota, MAX_UPLOAD_URLS } from '../../domain/files.ts';
import { recordTempObjects } from '../../domain/staleObjects.ts';
import { blobsForPool } from '../../domain/storagePools.ts';

export const getUploadUrls = (deps: Deps) => async (c: Context) => {
  const { userId } = auth(c);
  // Mints presign into the uploader's CURRENT pool (H2, D55) — the quota
  // check already loaded the user+pool rows, so this costs no extra read.
  const ctx = await assertQuota(deps, userId, null);
  const blobs = await blobsForPool(deps, ctx.pool);
  let count = Number.parseInt(c.req.query('count') ?? '0', 10) || 0;
  if (count > MAX_UPLOAD_URLS) count = MAX_UPLOAD_URLS;

  const urls = await Promise.all(
    Array.from({ length: count }, async () => {
      const objectKey = `${userId}/${deps.rand.uuid()}`;
      return {
        objectKey,
        url: await blobs.presignPut(objectKey, deps.config.presignPutExpirySeconds),
      };
    }),
  );
  await recordTempObjects(deps, ctx.pool?.poolId, urls.map((u) => ({ objectKey: u.objectKey })));
  return c.json({ urls });
};
