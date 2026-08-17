/**
 * POST /files/info (auth) — src: pkg/controller/file.go GetFileInfo:
 * strict ownership (400 unknown ids / 403 foreign), -1 sizes for gone files.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { getFile, verifyFileOwnership } from '../../domain/files.ts';

const bodySchema = z.object({ fileIDs: z.array(z.number()) });

export const filesInfo = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
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
