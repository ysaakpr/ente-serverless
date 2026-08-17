/**
 * File commit/update/read logic — port of pkg/controller/file.go. All byte
 * verification is HeadObject against the blobs port; the commit is a single
 * transaction (file row + object guards + collection link + usage counters).
 */

import type { Deps } from '../deps.ts';
import { keys, gsi, padTime } from './model.ts';
import { ConditionFailedError } from '../ports/db.ts';
import {
  badRequest,
  errBadRequestSentinel,
  errFileTooLarge,
  errNotFound,
  errPermissionDenied,
  errStorageLimitExceeded,
} from '../lib/errors.ts';
import { ApiError } from '../lib/errors.ts';

export const MAX_UPLOAD_URLS = 50;
/**
 * S3's hard ceiling on parts in one multipart upload. Shared by BOTH multipart
 * routes on purpose: this lived as a private constant in the V2 handler, the V1
 * handler was written without it, and the gap was a presign-fan-out DoS — one
 * authenticated GET could mint arbitrarily many signed URLs. Keep it here so
 * the two routes cannot drift apart again.
 */
export const MAX_MULTIPART_PART_COUNT = 10_000;

export interface FileAttributes {
  objectKey?: string;
  encryptedData?: string;
  decryptionHeader: string;
  size?: number;
}

export interface MagicMetadata {
  version: number;
  count: number;
  data: string;
  header: string;
}

export interface FileRow {
  pk: string;
  sk: string;
  fileId: number;
  ownerID: number;
  file: FileAttributes;
  thumbnail: FileAttributes;
  metadata: FileAttributes;
  magicMetadata?: MagicMetadata;
  pubMagicMetadata?: MagicMetadata;
  info: { fileSize: number; thumbSize: number };
  updationTime: number;
  [attr: string]: unknown;
}

export interface LinkRow {
  pk: string;
  sk: string;
  collectionID: number;
  fileID: number;
  encryptedKey: string;
  keyDecryptionNonce: string;
  createdAt: number;
  updationTime: number;
  isDeleted: boolean;
  gsi1pk: string;
  gsi1sk: string;
  /** Reverse index: all links for one file (trash needs it). */
  gsi3pk: string;
  gsi3sk: string;
  [attr: string]: unknown;
}

export const objectGuardKey = (objectKey: string) => ({ pk: `OBJ#${objectKey}`, sk: 'META' });

export const linkRow = (
  deps: Deps,
  collectionID: number,
  fileID: number,
  encryptedKey: string,
  keyDecryptionNonce: string,
  createdAt: number,
): LinkRow => {
  const updationTime = deps.ids.nextUpdationTime();
  return {
    ...keys.collectionFile(collectionID, fileID),
    collectionID,
    fileID,
    encryptedKey,
    keyDecryptionNonce,
    createdAt,
    updationTime,
    isDeleted: false,
    gsi1pk: gsi.collectionDiff(collectionID),
    gsi1sk: `${padTime(updationTime)}#${fileID}`,
    gsi3pk: `FILE-LINKS#${fileID}`,
    gsi3sk: `COL#${collectionID}`,
  };
};

/** Re-stamp a link (add/remove/restore) so it re-emits in the diff feed. */
export const restampLink = (deps: Deps, row: LinkRow, isDeleted: boolean): LinkRow => {
  const updationTime = deps.ids.nextUpdationTime();
  return {
    ...row,
    isDeleted,
    updationTime,
    gsi1sk: `${padTime(updationTime)}#${row.fileID}`,
  };
};

export const getFile = async (deps: Deps, fileId: number): Promise<FileRow | null> =>
  deps.db.get<FileRow>(keys.file(fileId).pk, 'META');

export const getUsage = async (deps: Deps, userId: number): Promise<{ bytes: number; fileCount: number }> => {
  const row = await deps.db.get(keys.userUsage(userId).pk, 'USAGE');
  return { bytes: (row?.bytes as number) ?? 0, fileCount: (row?.fileCount as number) ?? 0 };
};

/** museum UsageCtrl.CanUploadFile: 426 when usage (+ size) exceeds the plan. */
export const assertQuota = async (deps: Deps, userId: number, addBytes: number | null): Promise<void> => {
  const { bytes } = await getUsage(deps, userId);
  const limit = deps.config.freePlanStorageBytes;
  if (addBytes === null) {
    if (bytes >= limit) throw errStorageLimitExceeded();
    return;
  }
  if (bytes + addBytes > limit) throw errStorageLimitExceeded();
};

/** HeadObject both objects in parallel; 503 OBJECT_SIZE_FETCH_FAILED when missing. */
export const verifyObjects = async (
  deps: Deps,
  fileKey: string,
  thumbKey: string,
): Promise<{ fileSize: number; thumbSize: number }> => {
  const [fileHead, thumbHead] = await Promise.all([
    deps.blobs.head(fileKey),
    deps.blobs.head(thumbKey),
  ]);
  if (!fileHead || !thumbHead) {
    throw new ApiError('OBJECT_SIZE_FETCH_FAILED', 503);
  }
  return { fileSize: fileHead.contentLength, thumbSize: thumbHead.contentLength };
};

export const validateCommitShape = (
  userId: number,
  body: {
    id?: number;
    ownerID?: number;
    encryptedKey?: string;
    keyDecryptionNonce?: string;
    file: FileAttributes;
    thumbnail: FileAttributes;
  },
): void => {
  const prefix = `${userId}/`;
  if (!body.file.objectKey?.startsWith(prefix) || !body.thumbnail.objectKey?.startsWith(prefix)) {
    throw errBadRequestSentinel(); // Incorrect object key reported
  }
  if (body.file.objectKey === body.thumbnail.objectKey) throw errBadRequestSentinel();
  const isCreate = !body.id;
  if (isCreate && (!body.encryptedKey || !body.keyDecryptionNonce)) throw errBadRequestSentinel();
  if (!body.file.decryptionHeader || !body.thumbnail.decryptionHeader) throw errBadRequestSentinel();
  // No updationTime presence check: museum's API layer overwrites it with
  // time.Microseconds() BEFORE validation (pkg/api/file.go CreateOrUpdate),
  // so the controller's "required" check is unreachable — clients may omit it.
  if (isCreate && body.ownerID !== undefined && body.ownerID !== userId) throw errPermissionDenied();
};

export const assertSizesMatch = (
  claimed: { file?: number; thumb?: number },
  actual: { fileSize: number; thumbSize: number },
  maxFileSize: number,
): void => {
  if (actual.fileSize > maxFileSize) throw errFileTooLarge();
  if (claimed.file && claimed.file !== actual.fileSize) throw errBadRequestSentinel();
  if (claimed.thumb && claimed.thumb !== actual.thumbSize) throw errBadRequestSentinel();
};

/** The stored File row projected into museum's File JSON for one collection link. */
export const fileToDiffJson = (file: FileRow, link: LinkRow, collectionOwnerID: number): Record<string, unknown> => {
  if (link.isDeleted) {
    // Tombstone: museum diff emits the id + isDeleted with empty attributes.
    return {
      id: file.fileId,
      ownerID: file.ownerID,
      collectionID: link.collectionID,
      collectionOwnerID,
      encryptedKey: '',
      keyDecryptionNonce: '',
      file: { decryptionHeader: '', size: 0 },
      thumbnail: { decryptionHeader: '', size: 0 },
      metadata: { decryptionHeader: '', size: 0 },
      isDeleted: true,
      updationTime: link.updationTime,
    };
  }
  return {
    id: file.fileId,
    ownerID: file.ownerID,
    collectionID: link.collectionID,
    collectionOwnerID,
    collectionAddedAt: link.createdAt,
    encryptedKey: link.encryptedKey,
    keyDecryptionNonce: link.keyDecryptionNonce,
    file: { ...file.file, size: file.info.fileSize },
    thumbnail: { ...file.thumbnail, size: file.info.thumbSize },
    metadata: { size: 0, ...file.metadata },
    isDeleted: false,
    updationTime: link.updationTime,
    ...(file.magicMetadata ? { magicMetadata: file.magicMetadata } : {}),
    ...(file.pubMagicMetadata ? { pubMagicMetadata: file.pubMagicMetadata } : {}),
    info: { fileSize: file.info.fileSize, thumbSize: file.info.thumbSize },
  };
};

/**
 * Download/preview authz (ObjectRepo.GetAccessibleObject): the caller owns
 * the file, or shares a collection with it. Trashed files remain readable by
 * the owner. 404 (sql.ErrNoRows path) when neither holds or the file is gone.
 */
export const getAccessibleFile = async (deps: Deps, userId: number, fileId: number): Promise<FileRow> => {
  const file = await getFile(deps, fileId);
  if (!file) throw errNotFound();
  if (file.ownerID === userId) return file;
  throw errNotFound(); // sharing lands post-core; non-members read as not-found
};

/** museum VerifyFileOwnership: 400 when ids are unknown, 403 on foreign files. */
export const verifyFileOwnership = async (deps: Deps, userId: number, fileIds: number[]): Promise<FileRow[]> => {
  const files = await Promise.all(fileIds.map((id) => getFile(deps, id)));
  const found = files.filter((f): f is FileRow => f !== null);
  if (found.length === 0) throw errBadRequestSentinel();
  if (found.some((f) => f.ownerID !== userId)) throw errPermissionDenied();
  if (found.length !== fileIds.length) throw errBadRequestSentinel();
  return found;
};

/** Duplicate-commit equality (onDuplicateObjectDetected): equal -> existing id, else 400. */
export const resolveDuplicateCommit = async (
  deps: Deps,
  userId: number,
  body: {
    file: FileAttributes;
    thumbnail: FileAttributes;
    metadata: FileAttributes;
  },
  sizes: { fileSize: number; thumbSize: number },
): Promise<FileRow> => {
  const guard =
    (await deps.db.get(objectGuardKey(body.file.objectKey!).pk, 'META')) ??
    (await deps.db.get(objectGuardKey(body.thumbnail.objectKey!).pk, 'META'));
  if (!guard) throw errBadRequestSentinel();
  const existing = await getFile(deps, guard.fileId as number);
  if (!existing) throw errBadRequestSentinel();
  const equal =
    existing.thumbnail.objectKey === body.thumbnail.objectKey &&
    existing.info.thumbSize === sizes.thumbSize &&
    existing.thumbnail.decryptionHeader === body.thumbnail.decryptionHeader &&
    existing.file.objectKey === body.file.objectKey &&
    existing.info.fileSize === sizes.fileSize &&
    existing.file.decryptionHeader === body.file.decryptionHeader &&
    existing.metadata.encryptedData === body.metadata.encryptedData &&
    existing.metadata.decryptionHeader === body.metadata.decryptionHeader &&
    existing.ownerID === userId;
  if (!equal) throw errBadRequestSentinel();
  return existing;
};

export { ConditionFailedError, badRequest };
