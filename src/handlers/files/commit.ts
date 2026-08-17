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
  getFile,
  linkRow,
  objectGuardKey,
  resolveDuplicateCommit,
  validateCommitShape,
  verifyObjects,
  type FileAttributes,
  type FileRow,
  type MagicMetadata,
} from '../../domain/files.ts';
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
  const collection = await getOwnedCollection(deps, userId, body.collectionID);

  const sizes = await verifyObjects(deps, body.file.objectKey!, body.thumbnail.objectKey!);
  assertSizesMatch(
    { file: body.file.size, thumb: body.thumbnail.size },
    sizes,
    deps.config.maxFileSizeBytes,
  );
  const totalBytes = sizes.fileSize + sizes.thumbSize;
  await assertQuota(deps, userId, totalBytes);

  const fileId = deps.ids.next();
  const now = deps.clock.nowMicros();
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
    info: { fileSize: sizes.fileSize, thumbSize: sizes.thumbSize },
    updationTime: 0,
  };
  const link = linkRow(deps, body.collectionID, fileId, body.encryptedKey, body.keyDecryptionNonce, now);
  fileRowItem.updationTime = link.updationTime;

  try {
    await deps.db.transactWrite([
      { kind: 'put', item: fileRowItem },
      { kind: 'put', ifNotExists: true, item: { ...objectGuardKey(body.file.objectKey!), fileId, type: 'file' } },
      { kind: 'put', ifNotExists: true, item: { ...objectGuardKey(body.thumbnail.objectKey!), fileId, type: 'thumbnail' } },
      { kind: 'put', item: link },
      {
        kind: 'counter',
        key: { pk: keys.userUsage(userId).pk, sk: 'USAGE' },
        deltas: { bytes: totalBytes, fileCount: 1 },
      },
    ]);
  } catch (err) {
    if (!(err instanceof ConditionFailedError)) throw err;
    // objectKey already committed — museum onDuplicateObjectDetected
    const existing = await resolveDuplicateCommit(deps, userId, body as never, sizes);
    return echoFile(deps, { ...fileRowItem, fileId: existing.fileId }, body, collection.ownerID, now);
  }
  // Tag the original so the GLACIER_IR lifecycle rule (tier=original) picks it
  // up; a tagging failure only costs storage class, never the commit.
  await deps.blobs.setTags(body.file.objectKey!, { tier: 'original' }).catch(() => {});
  return echoFile(deps, fileRowItem, body, collection.ownerID, now);
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

  const sizes = await verifyObjects(deps, body.file.objectKey!, body.thumbnail.objectKey!);
  assertSizesMatch(
    { file: body.file.size, thumb: body.thumbnail.size },
    sizes,
    deps.config.maxFileSizeBytes,
  );
  const oldBytes = existing.info.fileSize + existing.info.thumbSize;
  const diff = sizes.fileSize + sizes.thumbSize - oldBytes;
  await assertQuota(deps, userId, diff);

  const updationTime = deps.ids.nextUpdationTime();
  const ops: Parameters<Deps['db']['transactWrite']>[0] = [];

  // Replaced objects go to the deletion queue (sweep cron drains it — D6).
  const replacedKeys: string[] = [];
  for (const [attr, next] of [
    [existing.file.objectKey, body.file.objectKey],
    [existing.thumbnail.objectKey, body.thumbnail.objectKey],
  ] as const) {
    if (attr && attr !== next) {
      ops.push({ kind: 'delete', key: { pk: `OBJ#${attr}`, sk: 'META' } });
      replacedKeys.push(attr);
    }
  }
  ops.push(
    {
      kind: 'put',
      item: {
        ...existing,
        file: { objectKey: body.file.objectKey!, decryptionHeader: body.file.decryptionHeader },
        thumbnail: { objectKey: body.thumbnail.objectKey!, decryptionHeader: body.thumbnail.decryptionHeader },
        metadata: body.metadata.encryptedData
          ? { encryptedData: body.metadata.encryptedData, decryptionHeader: body.metadata.decryptionHeader }
          : existing.metadata,
        info: { fileSize: sizes.fileSize, thumbSize: sizes.thumbSize },
        updationTime,
      },
    },
    { kind: 'put', item: { ...objectGuardKey(body.file.objectKey!), fileId: body.id, type: 'file' } },
    { kind: 'put', item: { ...objectGuardKey(body.thumbnail.objectKey!), fileId: body.id, type: 'thumbnail' } },
    {
      kind: 'counter',
      key: { pk: keys.userUsage(userId).pk, sk: 'USAGE' },
      deltas: { bytes: diff },
    },
  );
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
