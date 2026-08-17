/**
 * Derived file data (mldata, vid_preview, img_preview) — src:
 * ente/filedata/*.go. Metadata payloads (S3FileMetadata) live in S3 under
 * museum's exact key layout; the DB row tracks status/size for status-diff.
 */

import type { Deps } from '../deps.ts';
import { keys, padTime } from './model.ts';
import { getFile, type FileRow } from './files.ts';
import { errNotFound, errPermissionDenied } from '../lib/errors.ts';

export type FdType = 'mldata' | 'vid_preview' | 'img_preview';

export interface FdRow {
  pk: string;
  sk: string;
  fileID: number;
  userID: number;
  type: FdType;
  size: number;
  objectID: string | null;
  objectNonce: string | null;
  objectSize: number | null;
  isDeleted: boolean;
  createdAt: number;
  updatedAt: number;
  gsi3pk: string;
  gsi3sk: string;
  [attr: string]: unknown;
}

// ente/filedata/path.go
export const basePrefix = (fileId: number, ownerId: number) => `${ownerId}/file-data/${fileId}/`;
export const objectKey = (fileId: number, ownerId: number, type: FdType, objectId: string) =>
  `${basePrefix(fileId, ownerId)}${type}/${objectId}`;
export const metadataKey = (fileId: number, ownerId: number, type: FdType, objectId?: string | null) =>
  type === 'vid_preview'
    ? `${objectKey(fileId, ownerId, type, objectId!)}_playlist`
    : `${basePrefix(fileId, ownerId)}${type}`;

export const fdStatusPartition = (userId: number) => `USER#${userId}#FD`;

export const getFdRow = async (deps: Deps, fileId: number, type: FdType): Promise<FdRow | null> =>
  deps.db.get<FdRow>(keys.fileData(fileId, type).pk, `FD#${type}`);

export const upsertFdRow = async (
  deps: Deps,
  userId: number,
  fileId: number,
  type: FdType,
  patch: Partial<FdRow>,
): Promise<FdRow> => {
  const existing = await getFdRow(deps, fileId, type);
  const now = deps.clock.nowMicros();
  const updatedAt = deps.ids.nextUpdationTime();
  const row: FdRow = {
    ...keys.fileData(fileId, type),
    fileID: fileId,
    userID: userId,
    type,
    size: 0,
    objectID: null,
    objectNonce: null,
    objectSize: null,
    isDeleted: false,
    createdAt: existing?.createdAt ?? now,
    ...(existing ?? {}),
    ...patch,
    updatedAt,
    gsi3pk: fdStatusPartition(userId),
    gsi3sk: `${padTime(updatedAt)}#${fileId}#${type}`,
  } as FdRow;
  await deps.db.put(row);
  return row;
};

/** Owner-verified file lookup for all file-data operations. */
export const getOwnedFile = async (deps: Deps, userId: number, fileId: number): Promise<FileRow> => {
  const file = await getFile(deps, fileId);
  if (!file) throw errNotFound();
  if (file.ownerID !== userId) throw errPermissionDenied();
  return file;
};

export interface S3FileMetadata {
  v: number;
  encryptedData: string;
  header: string;
  client: string;
}

export const writeMetadataObject = async (
  deps: Deps,
  key: string,
  metadata: S3FileMetadata,
): Promise<number> => {
  const body = Buffer.from(JSON.stringify(metadata));
  await deps.blobs.put(key, body);
  return body.length;
};

export const readMetadataObject = async (deps: Deps, key: string): Promise<S3FileMetadata | null> => {
  try {
    return JSON.parse((await deps.blobs.get(key)).toString()) as S3FileMetadata;
  } catch {
    return null;
  }
};
