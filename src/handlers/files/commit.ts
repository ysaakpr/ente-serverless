/**
 * POST /files (auth) — the commit. src: pkg/api/file.go CreateOrUpdate +
 * pkg/controller/file.go Create/Update. id==0 creates (returns the stored
 * File); id!=0 updates attributes (returns {id, updationTime}).
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { keys, gsi, padTime } from '../../domain/model.ts';
import {
  assertQuota,
  assertSizesMatch,
  filePoolPin,
  getFile,
  linkRow,
  loadQuotaContext,
  objectGuardKey,
  resolveDuplicateCommit,
  thumbPoolPin,
  validateCommitShape,
  verifyObjects,
  type FileAttributes,
  type FileRow,
  type MagicMetadata,
} from '../../domain/files.ts';
import { blobsForPool, blobsForPoolId } from '../../domain/storagePools.ts';
import { getOwnedCollection } from '../../domain/collections.ts';
import { enqueueObjectDeletion } from '../../domain/objectSweep.ts';
import { ConditionFailedError } from '../../ports/db.ts';
import { errBadRequestSentinel, errPermissionDenied } from '../../lib/errors.ts';

const attrsSchema = z.object({
  objectKey: z.string().optional(),
  encryptedData: z.string().optional(),
  decryptionHeader: z.string().optional().default(''),
  size: z.number().optional(),
});

const magicSchema = z.object({
  version: z.number(),
  count: z.number(),
  data: z.string(),
  header: z.string(),
});

export const commitSchema = z.object({
  id: z.number().optional().default(0),
  ownerID: z.number().optional(),
  collectionID: z.number(),
  encryptedKey: z.string().optional().default(''),
  keyDecryptionNonce: z.string().optional().default(''),
  file: attrsSchema,
  thumbnail: attrsSchema,
  metadata: attrsSchema,
  magicMetadata: magicSchema.optional(),
  pubMagicMetadata: magicSchema.optional(),
  updationTime: z.number().optional().default(0),
});

type CommitBody = z.infer<typeof commitSchema>;

export const createFile = async (deps: Deps, userId: number, body: CommitBody) => {
  // Commit stays OWNER-ONLY even under sharing — museum file.go
  // validateFileCreateOrUpdateReq: "Creating a file requires collection
  // ownership, not shared access". A collaborator commits into a collection
  // they own, then /collections/add-files it into the shared album (D49).
  const collection = await getOwnedCollection(deps, userId, body.collectionID);

  // New bytes land in the uploader's CURRENT pool (the mint presigned there);
  // the commit stamps that pool as the file's PIN (H2, D55).
  const ctx = await loadQuotaContext(deps, userId);
  const blobs = await blobsForPool(deps, ctx.pool);
  const sizes = await verifyObjects(blobs, blobs, body.file.objectKey!, body.thumbnail.objectKey!);
  assertSizesMatch(
    { file: body.file.size, thumb: body.thumbnail.size },
    sizes,
    deps.config.maxFileSizeBytes,
  );
  const totalBytes = sizes.fileSize + sizes.thumbSize;
  await assertQuota(deps, userId, totalBytes, ctx);
  const poolId = ctx.pool?.poolId;

  const now = deps.clock.nowMicros();
  // SECURITY-REVIEW-2 F3: mint-then-commit in a bounded retry. Server fileIDs
  // are epoch-derived and only monotonic per process, so two instances minting
  // in the same millisecond can collide; an unconditioned file-row put would
  // let one commit overwrite another user's file. The file row is now written
  // ifNotExists, and a collision (as opposed to a genuine duplicate object)
  // re-mints and retries.
  for (let attempt = 0; ; attempt++) {
    const fileId = deps.ids.next();
    const fileRowItem: FileRow = {
      ...keys.file(fileId),
      fileId,
      ownerID: userId,
      encryptedKey: body.encryptedKey,
      keyDecryptionNonce: body.keyDecryptionNonce,
      file: { objectKey: body.file.objectKey!, decryptionHeader: body.file.decryptionHeader },
      thumbnail: { objectKey: body.thumbnail.objectKey!, decryptionHeader: body.thumbnail.decryptionHeader },
      metadata: {
        encryptedData: body.metadata.encryptedData,
        decryptionHeader: body.metadata.decryptionHeader,
      },
      ...(body.magicMetadata ? { magicMetadata: body.magicMetadata as MagicMetadata } : {}),
      ...(body.pubMagicMetadata ? { pubMagicMetadata: body.pubMagicMetadata as MagicMetadata } : {}),
      ...(poolId ? { storagePoolId: poolId } : {}),
      info: { fileSize: sizes.fileSize, thumbSize: sizes.thumbSize },
      updationTime: 0,
    };
    const link = linkRow(deps, body.collectionID, fileId, body.encryptedKey, body.keyDecryptionNonce, now);
    fileRowItem.updationTime = link.updationTime;

    try {
      await deps.db.transactWrite([
        { kind: 'put', ifNotExists: true, item: fileRowItem },
        { kind: 'put', ifNotExists: true, item: { ...objectGuardKey(body.file.objectKey!), fileId, type: 'file' } },
        { kind: 'put', ifNotExists: true, item: { ...objectGuardKey(body.thumbnail.objectKey!), fileId, type: 'thumbnail' } },
        { kind: 'put', item: link },
        {
          kind: 'counter',
          key: { pk: keys.userUsage(userId).pk, sk: 'USAGE' },
          deltas: { bytes: totalBytes, fileCount: 1 },
        },
        // Pool usage mirrors the per-user counter atomically (H2, D55).
        ...(poolId
          ? [
              {
                kind: 'counter' as const,
                key: { pk: keys.poolUsage(poolId).pk, sk: 'USAGE' },
                deltas: { bytes: totalBytes, fileCount: 1 },
              },
            ]
          : []),
      ]);
    } catch (err) {
      if (!(err instanceof ConditionFailedError)) throw err;
      // A pre-existing OBJECT guard for our keys => genuine duplicate object
      // (museum onDuplicateObjectDetected). None => the fileId itself collided
      // (F3): re-mint and retry.
      const dupe =
        (await deps.db.get(objectGuardKey(body.file.objectKey!).pk, 'META')) ??
        (await deps.db.get(objectGuardKey(body.thumbnail.objectKey!).pk, 'META'));
      if (dupe) {
        const existing = await resolveDuplicateCommit(deps, userId, body as never, sizes);
        return echoFile(deps, { ...fileRowItem, fileId: existing.fileId }, body, collection.ownerID, now);
      }
      if (attempt >= 5) throw err;
      continue;
    }
    // Tag the original so the GLACIER_IR lifecycle rule (tier=original) picks it
    // up; a tagging failure only costs storage class, never the commit.
    await blobs.setTags(body.file.objectKey!, { tier: 'original' }).catch(() => {});
    return echoFile(deps, fileRowItem, body, collection.ownerID, now);
  }
};

const echoFile = (
  deps: Deps,
  row: FileRow,
  body: CommitBody,
  collectionOwnerID: number,
  addedAt: number,
) => ({
  id: row.fileId,
  ownerID: row.ownerID,
  collectionID: body.collectionID,
  collectionOwnerID,
  collectionAddedAt: addedAt,
  encryptedKey: body.encryptedKey,
  keyDecryptionNonce: body.keyDecryptionNonce,
  file: { ...row.file, size: row.info.fileSize },
  thumbnail: { ...row.thumbnail, size: row.info.thumbSize },
  metadata: { size: 0, ...row.metadata },
  isDeleted: false,
  updationTime: row.updationTime,
  ...(row.magicMetadata ? { magicMetadata: row.magicMetadata } : {}),
  ...(row.pubMagicMetadata ? { pubMagicMetadata: row.pubMagicMetadata } : {}),
  info: { fileSize: row.info.fileSize, thumbSize: row.info.thumbSize },
});

export const updateFileAttributes = async (deps: Deps, userId: number, body: CommitBody) => {
  const existing = await getFile(deps, body.id);
  if (!existing) throw errBadRequestSentinel();
  if (existing.ownerID !== userId) throw errPermissionDenied();

  // Pool pins (H2, D55): a REPLACED object's new bytes were presigned into the
  // owner's CURRENT pool, so its pin moves there; an UNCHANGED key keeps its
  // old pin (its bytes never moved). Heads go to wherever each object lives.
  const ctx = await loadQuotaContext(deps, userId);
  const currentPoolId = ctx.pool?.poolId;
  const oldFilePin = filePoolPin(existing);
  const oldThumbPin = thumbPoolPin(existing);
  const fileKeyChanged = existing.file.objectKey !== body.file.objectKey;
  const thumbKeyChanged = existing.thumbnail.objectKey !== body.thumbnail.objectKey;
  const newFilePin = fileKeyChanged ? currentPoolId : oldFilePin;
  const newThumbPin = thumbKeyChanged ? currentPoolId : oldThumbPin;

  const sizes = await verifyObjects(
    await blobsForPoolId(deps, newFilePin),
    await blobsForPoolId(deps, newThumbPin),
    body.file.objectKey!,
    body.thumbnail.objectKey!,
  );
  assertSizesMatch(
    { file: body.file.size, thumb: body.thumbnail.size },
    sizes,
    deps.config.maxFileSizeBytes,
  );
  const oldBytes = existing.info.fileSize + existing.info.thumbSize;
  const diff = sizes.fileSize + sizes.thumbSize - oldBytes;

  // Per-pool byte deltas: old bytes leave their pinned pools, new bytes land
  // in theirs; the pool cap is charged only the CURRENT pool's net delta.
  const poolDeltas = new Map<string, { bytes: number; fileCount: number }>();
  const addPool = (pin: string | undefined, bytes: number, fileCount = 0) => {
    if (!pin || (bytes === 0 && fileCount === 0)) return;
    const cur = poolDeltas.get(pin) ?? { bytes: 0, fileCount: 0 };
    poolDeltas.set(pin, { bytes: cur.bytes + bytes, fileCount: cur.fileCount + fileCount });
  };
  addPool(oldFilePin, -existing.info.fileSize, -1);
  addPool(newFilePin, sizes.fileSize, 1);
  addPool(oldThumbPin, -existing.info.thumbSize);
  addPool(newThumbPin, sizes.thumbSize);
  await assertQuota(deps, userId, diff, ctx, currentPoolId ? (poolDeltas.get(currentPoolId)?.bytes ?? 0) : diff);

  const updationTime = deps.ids.nextUpdationTime();
  const ops: Parameters<Deps['db']['transactWrite']>[0] = [];

  // Replaced objects go to the deletion queue (sweep cron drains it — D6),
  // each tagged with the pool its bytes are pinned to.
  const replacedKeys: Array<{ objectKey: string; poolId?: string }> = [];
  for (const [attr, next, pin] of [
    [existing.file.objectKey, body.file.objectKey, oldFilePin],
    [existing.thumbnail.objectKey, body.thumbnail.objectKey, oldThumbPin],
  ] as const) {
    if (attr && attr !== next) {
      ops.push({ kind: 'delete', key: { pk: `OBJ#${attr}`, sk: 'META' } });
      replacedKeys.push({ objectKey: attr, poolId: pin });
    }
  }
  const updatedItem: FileRow = {
    ...existing,
    file: { objectKey: body.file.objectKey!, decryptionHeader: body.file.decryptionHeader },
    thumbnail: { objectKey: body.thumbnail.objectKey!, decryptionHeader: body.thumbnail.decryptionHeader },
    metadata: body.metadata.encryptedData
      ? { encryptedData: body.metadata.encryptedData, decryptionHeader: body.metadata.decryptionHeader }
      : existing.metadata,
    info: { fileSize: sizes.fileSize, thumbSize: sizes.thumbSize },
    updationTime,
  };
  // Re-stamp the pins; delete rather than write undefined (put replaces whole items).
  delete updatedItem.storagePoolId;
  delete updatedItem.thumbPoolId;
  if (newFilePin) updatedItem.storagePoolId = newFilePin;
  if (newThumbPin && newThumbPin !== newFilePin) updatedItem.thumbPoolId = newThumbPin;
  ops.push(
    { kind: 'put', item: updatedItem },
    { kind: 'put', item: { ...objectGuardKey(body.file.objectKey!), fileId: body.id, type: 'file' } },
    { kind: 'put', item: { ...objectGuardKey(body.thumbnail.objectKey!), fileId: body.id, type: 'thumbnail' } },
    {
      kind: 'counter',
      key: { pk: keys.userUsage(userId).pk, sk: 'USAGE' },
      deltas: { bytes: diff },
    },
  );
  for (const [pin, deltas] of poolDeltas) {
    if (deltas.bytes === 0 && deltas.fileCount === 0) continue;
    ops.push({
      kind: 'counter',
      key: { pk: keys.poolUsage(pin).pk, sk: 'USAGE' },
      deltas: { bytes: deltas.bytes, ...(deltas.fileCount ? { fileCount: deltas.fileCount } : {}) },
    });
  }
  await deps.db.transactWrite(ops);
  await enqueueObjectDeletion(deps, replacedKeys);

  // Re-emit in every live collection diff.
  const links = await deps.db.query(`FILE-LINKS#${body.id}`, { index: 'gsi3' });
  for (const link of links) {
    if (link.isDeleted) continue;
    const stamped = deps.ids.nextUpdationTime();
    await deps.db.put({
      ...link,
      updationTime: stamped,
      gsi1sk: `${padTime(stamped)}#${body.id}`,
    });
  }
  return { id: body.id, updationTime };
};

export const commitFile = (deps: Deps) => async (c: Context) => {
  const body = commitSchema.parse(await c.req.json());
  const { userId } = auth(c);
  validateCommitShape(userId, body);

  if (body.id !== 0) {
    return c.json(await updateFileAttributes(deps, userId, body));
  }
  return c.json(await createFile(deps, userId, body));
};

export { gsi };
