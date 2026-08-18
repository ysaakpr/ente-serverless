/**
 * POST /files/info (auth) — src: pkg/controller/file.go GetFileInfo:
 * strict ownership (400 unknown ids / 403 foreign), -1 sizes for gone files.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { getFile, verifyFileOwnership } from '../../domain/files.ts';
import { assertBatchSize } from '../../domain/collections.ts';

const bodySchema = z.object({ fileIDs: z.array(z.number()) });

export const filesInfo = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
  // SECURITY-REVIEW-2 F4: cap the batch BEFORE verifyFileOwnership fans out
  // Promise.all(getFile) over the array — an uncapped list is a single-request
  // amplification DoS (2N concurrent GetItem).
  assertBatchSize(body.fileIDs.length);
  const { userId } = auth(c);

  await verifyFileOwnership(deps, userId, body.fileIDs);

  const filesInfoList = await Promise.all(
    body.fileIDs.map(async (id) => {
      const file = await getFile(deps, id);
      return {
        id,
        fileInfo: file
          ? { fileSize: file.info.fileSize, thumbSize: file.info.thumbSize }
          : { fileSize: -1, thumbSize: -1 },
      };
    }),
  );
  return c.json({ filesInfo: filesInfoList });
};
