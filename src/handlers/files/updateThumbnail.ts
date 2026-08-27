/**
 * PUT /files/thumbnail (auth) — src: pkg/controller/file.go UpdateThumbnail.
 * New thumbnail must not be larger than the old one; usage adjusted by diff.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { keys, padTime } from '../../domain/model.ts';
import {
  filePoolPin,
  getFile,
  loadQuotaContext,
  objectGuardKey,
  restampThumbPin,
  thumbPoolPin,
  type FileRow,
} from '../../domain/files.ts';
import { blobsForPoolId } from '../../domain/storagePools.ts';
import { bumpCollectionForward } from '../../domain/collections.ts';
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

  // Pool pins (H2, D55): a REPLACED thumbnail's bytes were presigned into the
  // owner's CURRENT pool; an unchanged key keeps the old pin.
  const oldKey = file.thumbnail.objectKey;
  const oldThumbPin = thumbPoolPin(file);
  const keyChanged = oldKey !== body.thumbnail.objectKey;
  const newThumbPin = keyChanged
    ? (await loadQuotaContext(deps, userId)).pool?.poolId
    : oldThumbPin;

  const head = await (await blobsForPoolId(deps, newThumbPin)).head(body.thumbnail.objectKey);
  if (!head) throw new ApiError('OBJECT_SIZE_FETCH_FAILED', 503);
  const diff = head.contentLength - file.info.thumbSize;
  if (diff > 0) return c.json({}, 500); // museum: plain error -> 500

  const updationTime = deps.ids.nextUpdationTime();
  const updatedItem: FileRow = {
    ...file,
    thumbnail: { objectKey: body.thumbnail.objectKey, decryptionHeader: body.thumbnail.decryptionHeader },
    info: { ...file.info, thumbSize: head.contentLength },
    updationTime,
  };
  // A replacement landing CENTRAL while the original stays pooled needs the
  // explicit sentinel — absence would fall back to storagePoolId (D56).
  restampThumbPin(updatedItem, filePoolPin(file), newThumbPin);
  const ops: Parameters<Deps['db']['transactWrite']>[0] = [
    { kind: 'put', item: updatedItem },
    { kind: 'put', item: { ...objectGuardKey(body.thumbnail.objectKey), fileId: body.fileID, type: 'thumbnail' } },
    { kind: 'counter', key: { pk: keys.userUsage(userId).pk, sk: 'USAGE' }, deltas: { bytes: diff } },
  ];
  // Mirror the byte deltas onto the pool counters (H2, D55).
  if (oldThumbPin === newThumbPin) {
    if (newThumbPin && diff !== 0) {
      ops.push({ kind: 'counter', key: { pk: keys.poolUsage(newThumbPin).pk, sk: 'USAGE' }, deltas: { bytes: diff } });
    }
  } else {
    if (oldThumbPin) {
      ops.push({ kind: 'counter', key: { pk: keys.poolUsage(oldThumbPin).pk, sk: 'USAGE' }, deltas: { bytes: -file.info.thumbSize } });
    }
    if (newThumbPin) {
      ops.push({ kind: 'counter', key: { pk: keys.poolUsage(newThumbPin).pk, sk: 'USAGE' }, deltas: { bytes: head.contentLength } });
    }
  }
  if (keyChanged && oldKey) {
    ops.push({ kind: 'delete', key: { pk: `OBJ#${oldKey}`, sk: 'META' } });
  }
  await deps.db.transactWrite(ops);
  if (keyChanged && oldKey) {
    // sweep cron drains it (D6); deletes go to the OLD pin's bucket (H2).
    await enqueueObjectDeletion(deps, [{ objectKey: oldKey, poolId: oldThumbPin }]);
  }

  const links = await deps.db.query(`FILE-LINKS#${body.fileID}`, { index: 'gsi3' });
  for (const link of links) {
    if (link.isDeleted) continue;
    const stamped = deps.ids.nextUpdationTime();
    await deps.db.put({ ...link, updationTime: stamped, gsi1sk: `${padTime(stamped)}#${body.fileID}` });
    // museum UpdateThumbnail bumps every containing collection (D62)
    await bumpCollectionForward(deps, link.collectionID as number, stamped);
  }
  return c.body(null, 200);
};
