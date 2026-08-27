/**
 * PUT /files/data (mldata only — type gate from putfiledata.go Validate) and
 * PUT /files/video-data (vid_preview commit: verify uploaded object, store
 * encrypted playlist metadata).
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import {
  chargeFileDataPool,
  fileDataBlobsForWrite,
  getFdRow,
  getOwnedFile,
  isValidObjectId,
  metadataKey,
  objectKey,
  upsertFdRow,
  writeMetadataObject,
} from '../../domain/fileData.ts';
import { badRequest, errBadRequestSentinel } from '../../lib/errors.ts';
import { ApiError } from '../../lib/errors.ts';

const putSchema = z.object({
  fileID: z.number(),
  type: z.string(),
  encryptedData: z.string().nullish(),
  decryptionHeader: z.string().nullish(),
  version: z.number().nullish(),
  lastUpdatedAt: z.number().nullish(),
});

export const putFileData = (deps: Deps) => async (c: Context) => {
  const body = putSchema.parse(await c.req.json());
  if (body.type !== 'mldata') throw badRequest(`invalid object type ${body.type}`);
  if (!body.encryptedData || !body.decryptionHeader) {
    throw badRequest('encryptedData and decryptionHeader (only) are required for derived meta');
  }
  const { userId } = auth(c);
  const file = await getOwnedFile(deps, userId, body.fileID);
  // Server-side write into the pinned pool: disabled pool -> 426 (D56).
  const blobs = await fileDataBlobsForWrite(deps, file);

  const key = metadataKey(body.fileID, userId, 'mldata');
  const existing = await getFdRow(deps, body.fileID, 'mldata');
  const size = await writeMetadataObject(blobs, key, {
    v: body.version ?? 1,
    encryptedData: body.encryptedData,
    header: body.decryptionHeader,
    client: c.req.header('X-Client-Package') ?? '',
  });
  await upsertFdRow(deps, userId, body.fileID, 'mldata', { size });
  // Pool cap accounting (D56): the metadata object at this key was REPLACED,
  // so the pool is charged the net delta against the previous row size.
  await chargeFileDataPool(deps, file, size - (existing && !existing.isDeleted ? existing.size : 0));
  return c.json({});
};

const videoSchema = z.object({
  fileID: z.number(),
  objectID: z.string().min(1),
  objectSize: z.number(),
  playlist: z.string().min(1),
  playlistHeader: z.string().min(1),
  version: z.number().nullish(),
});

export const putVideoData = (deps: Deps) => async (c: Context) => {
  const body = videoSchema.parse(await c.req.json());
  // objectID is client-supplied and lands in an S3 key; check it BEFORE anything
  // else touches it. 400 {} is the shape museum answers on this route for every
  // malformed objectID we probed (D41).
  if (!isValidObjectId(body.objectID)) throw errBadRequestSentinel();
  const { userId } = auth(c);
  const file = await getOwnedFile(deps, userId, body.fileID);
  // The vid_preview COMMIT step: writes the playlist into the pinned pool, so
  // a disabled pool 426s here too (D56).
  const blobs = await fileDataBlobsForWrite(deps, file);

  // The client uploaded the encrypted HLS video via preview-upload-url; verify it.
  const videoKey = objectKey(body.fileID, userId, 'vid_preview', body.objectID);
  const head = await blobs.head(videoKey);
  if (!head) throw new ApiError('OBJECT_SIZE_FETCH_FAILED', 503);
  if (head.contentLength !== body.objectSize) throw badRequest('mismatch in object size');

  const existing = await getFdRow(deps, body.fileID, 'vid_preview');
  const playlistSize = await writeMetadataObject(
    blobs,
    metadataKey(body.fileID, userId, 'vid_preview', body.objectID),
    {
      v: body.version ?? 1,
      encryptedData: body.playlist,
      header: body.playlistHeader,
      client: c.req.header('X-Client-Package') ?? '',
    },
  );
  const size = body.objectSize + playlistSize;
  await upsertFdRow(deps, userId, body.fileID, 'vid_preview', {
    objectID: body.objectID,
    objectSize: body.objectSize,
    size,
  });
  // Pool cap accounting (D56): this is where a vid_preview's size becomes
  // known (the HeadObject above verified it), so the pool is charged here —
  // net of the previous row size when a preview is regenerated.
  await chargeFileDataPool(deps, file, size - (existing && !existing.isDeleted ? existing.size : 0));
  return c.json({});
};
