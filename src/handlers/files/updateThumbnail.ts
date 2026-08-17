/**
 * PUT /files/thumbnail (auth) — src: pkg/controller/file.go UpdateThumbnail.
 * New thumbnail must not be larger than the old one; usage adjusted by diff.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { keys, padTime } from '../../domain/model.ts';
import { getFile, objectGuardKey } from '../../domain/files.ts';
import { enqueueObjectDeletion } from '../../domain/objectSweep.ts';
import { errBadRequestSentinel, errNotFound, errPermissionDenied } from '../../lib/errors.ts';
import { ApiError } from '../../lib/errors.ts';

const bodySchema = z.object({
  fileID: z.number(),
  thumbnail: z.object({
    objectKey: z.string(),
    decryptionHeader: z.string(),
    size: z.number().optional(),
  }),
});

export const updateThumbnail = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
  const { userId } = auth(c);

  if (!body.thumbnail.objectKey.startsWith(`${userId}/`)) throw errBadRequestSentinel();

  const file = await getFile(deps, body.fileID);
  if (!file) throw errNotFound();
  if (file.ownerID !== userId) throw errPermissionDenied();

  const head = await deps.blobs.head(body.thumbnail.objectKey);
  if (!head) throw new ApiError('OBJECT_SIZE_FETCH_FAILED', 503);
  const diff = head.contentLength - file.info.thumbSize;
  if (diff > 0) return c.json({}, 500); // museum: plain error -> 500

  const updationTime = deps.ids.nextUpdationTime();
  const oldKey = file.thumbnail.objectKey;
  const ops: Parameters<Deps['db']['transactWrite']>[0] = [
    {
      kind: 'put',
      item: {
        ...file,
        thumbnail: { objectKey: body.thumbnail.objectKey, decryptionHeader: body.thumbnail.decryptionHeader },
        info: { ...file.info, thumbSize: head.contentLength },
        updationTime,
      },
    },
    { kind: 'put', item: { ...objectGuardKey(body.thumbnail.objectKey), fileId: body.fileID, type: 'thumbnail' } },
    { kind: 'counter', key: { pk: keys.userUsage(userId).pk, sk: 'USAGE' }, deltas: { bytes: diff } },
  ];
  if (oldKey && oldKey !== body.thumbnail.objectKey) {
    ops.push({ kind: 'delete', key: { pk: `OBJ#${oldKey}`, sk: 'META' } });
  }
  await deps.db.transactWrite(ops);
  if (oldKey && oldKey !== body.thumbnail.objectKey) {
    await enqueueObjectDeletion(deps, [oldKey]); // sweep cron drains it (D6)
  }

  const links = await deps.db.query(`FILE-LINKS#${body.fileID}`, { index: 'gsi3' });
  for (const link of links) {
    if (link.isDeleted) continue;
    const stamped = deps.ids.nextUpdationTime();
    await deps.db.put({ ...link, updationTime: stamped, gsi1sk: `${padTime(stamped)}#${body.fileID}` });
  }
  return c.body(null, 200);
};
