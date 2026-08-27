/**
 * Derived file data (mldata, vid_preview, img_preview) — src:
 * ente/filedata/*.go. Metadata payloads (S3FileMetadata) live in S3 under
 * museum's exact key layout; the DB row tracks status/size for status-diff.
 */

import type { Deps } from '../deps.ts';
import type { Blobs } from '../ports/blobs.ts';
import { keys, padTime } from './model.ts';
import { filePoolPin, getFile, type FileRow } from './files.ts';
import { blobsForPoolId } from './storagePools.ts';
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

/**
 * Shape of every objectID this server issues: `pv_<uuid>` / `pi_<uuid>` from
 * previewUploadUrl. PUT /files/video-data takes the id back from the CLIENT and
 * interpolates it into an S3 key, so it has to be checked on the way in — an id
 * carrying `/` or `..` would otherwise be pasted straight into the object path.
 * Deliberately a little looser than a strict uuid match (any URL-safe token after
 * the prefix) so a client that decorates the id still works, while `/`, `\` and
 * `.` stay impossible. See D41.
 */
const OBJECT_ID_RE = /^p[vi]_[A-Za-z0-9_-]{1,64}$/;

export const isValidObjectId = (objectId: string): boolean => OBJECT_ID_RE.test(objectId);

// ente/filedata/path.go
export const basePrefix = (fileId: number, ownerId: number) => `${ownerId}/file-data/${fileId}/`;
export const objectKey = (fileId: number, ownerId: number, type: FdType, objectId: string) => {
  // Invariant, not input validation: the edge already rejects malformed ids with
  // a 400. This is the backstop so no future caller can build an escaping key —
  // whether S3 itself would normalise `..` is beside the point (D41).
  if (!isValidObjectId(objectId)) {
    throw new Error(`refusing to build an object key from objectID ${JSON.stringify(objectId)}`);
  }
  return `${basePrefix(fileId, ownerId)}${type}/${objectId}`;
};
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

/**
 * Derived data (mldata / previews) lives with its FILE's pinned pool (H2,
 * D55) — self-consistent under pool reassignment: the file row is already in
 * hand on every file-data route (getOwnedFile), so resolution is free.
 */
export const fileDataBlobs = async (deps: Deps, file: FileRow): Promise<Blobs> =>
  blobsForPoolId(deps, filePoolPin(file));

export const writeMetadataObject = async (
  blobs: Blobs,
  key: string,
  metadata: S3FileMetadata,
): Promise<number> => {
  const body = Buffer.from(JSON.stringify(metadata));
  await blobs.put(key, body);
  return body.length;
};

export const readMetadataObject = async (blobs: Blobs, key: string): Promise<S3FileMetadata | null> => {
  try {
    return JSON.parse((await blobs.get(key)).toString()) as S3FileMetadata;
  } catch {
    return null;
  }
};
