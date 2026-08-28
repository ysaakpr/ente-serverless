/**
 * File commit/update/read logic — port of pkg/controller/file.go. All byte
 * verification is HeadObject against the blobs port; the commit is a single
 * transaction (file row + object guards + collection link + usage counters).
 */

import type { Deps } from '../deps.ts';
import type { Blobs } from '../ports/blobs.ts';
import type { UserRow } from './users.ts';
import { keys, gsi, padTime } from './model.ts';
import { getPool, getPoolUsage, type PoolRow } from './storagePools.ts';
import { getSharee } from './sharing.ts';
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
  /**
   * Pool PIN (H2, D55): which pool the FILE object's bytes live in, stamped
   * at commit time; absent = the central default bucket. Reads/purges resolve
   * the bucket from the pin, never from the owner's current pool — so pool
   * reassignment affects only NEW uploads. Top-level attributes never reach
   * the wire (fileToDiffJson/echoFile pick fields explicitly).
   */
  storagePoolId?: string;
  /** Thumbnail's pin, ONLY when it diverges from storagePoolId (a thumbnail
   * replaced after the owner moved pools lands wherever the owner's CURRENT
   * pool is while the original stays pinned). '' is the CENTRAL_THUMB_PIN
   * sentinel — "the central bucket" — needed because plain absence means
   * "same as storagePoolId", which cannot express a detached owner's
   * replacement thumb landing central while the original stays pooled (D56).
   * Resolve with thumbPoolPin(); re-stamp with restampThumbPin(). */
  thumbPoolId?: string;
  [attr: string]: unknown;
}

/** thumbPoolId sentinel: the thumb diverged from the file pin INTO the
 * central bucket (D56). Absent still means "follows storagePoolId". */
export const CENTRAL_THUMB_PIN = '';

/** Pin resolution: which pool each object's bytes actually live in. */
export const filePoolPin = (file: FileRow): string | undefined => file.storagePoolId;
export const thumbPoolPin = (file: FileRow): string | undefined => {
  if (file.thumbPoolId === undefined) return file.storagePoolId;
  return file.thumbPoolId === CENTRAL_THUMB_PIN ? undefined : file.thumbPoolId;
};

/**
 * Re-stamp a row's thumb pin from the RESOLVED pins (undefined = central):
 * absent when thumb and file agree (thumbPoolPin falls back), the pool id when
 * the thumb diverged into a pool, and the CENTRAL_THUMB_PIN sentinel when it
 * diverged into the central bucket. Shared by BOTH re-stamp sites
 * (updateThumbnail / updateFileAttributes) so they cannot drift (D56).
 */
export const restampThumbPin = (
  row: FileRow,
  filePin: string | undefined,
  thumbPin: string | undefined,
): void => {
  delete row.thumbPoolId;
  if ((thumbPin ?? CENTRAL_THUMB_PIN) !== (filePin ?? CENTRAL_THUMB_PIN)) {
    row.thumbPoolId = thumbPin ?? CENTRAL_THUMB_PIN;
  }
};

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

/**
 * The user row + its pool row, loaded once per quota check (H1's seam, now
 * carrying the H2 pool too). Callers that also mint or verify objects reuse
 * this context to pick the right blobs client — no second GetItem. A user
 * whose storagePoolId points at a MISSING pool row fails closed (5xx) rather
 * than silently routing to the central bucket.
 */
export interface QuotaContext {
  user: UserRow | null;
  pool: PoolRow | null;
}

export const loadQuotaContext = async (deps: Deps, userId: number): Promise<QuotaContext> => {
  const user = await deps.db.get<UserRow>(keys.user(userId).pk, 'META');
  const poolId = user?.storagePoolId as string | undefined;
  if (!poolId) return { user, pool: null };
  const pool = await getPool(deps, poolId);
  if (!pool) throw new Error(`user ${userId} is attached to unknown storage pool ${poolId}`);
  return { user, pool };
};

/**
 * museum UsageCtrl.CanUploadFile: 426 when usage (+ size) exceeds the plan.
 * The limit is per-user since D54 — the user row's storageLimitBytes when set
 * (0 means ZERO: no uploads at all, deliberately unlike the 0-disables-it
 * ceiling knobs), falling back to config.freePlanStorageBytes. Viewer
 * accounts are refused outright with the same 426 — self-consistent with a
 * 0-byte plan, and the stock client already renders it ("storage limit
 * exceeded"). One extra GetItem per quota check, shared by every upload-url
 * mint and commit; the public collect path passes the LINK OWNER's id here,
 * so a viewer's or 0-byte owner's links can't collect either.
 *
 * Pool quota (H2, D55) — precedence, all surfacing as the SAME museum-shaped
 * 426: viewer blocks first, then the per-user limit (a 0 override blocks
 * before any pool math), then the pool's shared cap checked against the
 * POOL#/USAGE counter (absent cap = unlimited pool). A DISABLED pool refuses
 * new uploads here too; reads and purges still resolve through the pin.
 * `poolAddBytes` lets update paths charge the pool only its NET delta when
 * old and new bytes live in different pools; it defaults to `addBytes`.
 */
export const assertQuota = async (
  deps: Deps,
  userId: number,
  addBytes: number | null,
  ctx?: QuotaContext,
  poolAddBytes?: number | null,
): Promise<QuotaContext> => {
  ctx ??= await loadQuotaContext(deps, userId);
  const { user, pool } = ctx;
  if (user?.viewer) throw errStorageLimitExceeded();
  const over = (used: number, add: number | null, cap: number): boolean =>
    add === null ? used >= cap : used + add > cap;
  const { bytes } = await getUsage(deps, userId);
  const limit = user?.storageLimitBytes ?? deps.config.freePlanStorageBytes;
  if (over(bytes, addBytes, limit)) throw errStorageLimitExceeded();
  if (pool) {
    if (pool.disabled) throw errStorageLimitExceeded();
    if (pool.poolStorageLimitBytes !== undefined) {
      const poolBytes = (await getPoolUsage(deps, pool.poolId)).bytes;
      if (over(poolBytes, poolAddBytes === undefined ? addBytes : poolAddBytes, pool.poolStorageLimitBytes)) {
        throw errStorageLimitExceeded();
      }
    }
  }
  return ctx;
};

/** HeadObject both objects in parallel; 503 OBJECT_SIZE_FETCH_FAILED when
 * missing. Since H2 the two objects can live in different buckets (update
 * paths after a pool move), so each head rides its own Blobs client. */
export const verifyObjects = async (
  fileBlobs: Blobs,
  thumbBlobs: Blobs,
  fileKey: string,
  thumbKey: string,
): Promise<{ fileSize: number; thumbSize: number }> => {
  const [fileHead, thumbHead] = await Promise.all([
    fileBlobs.head(fileKey),
    thumbBlobs.head(thumbKey),
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

/** The stored File row projected into museum's File JSON for one collection
 * link. Tombstones (link.isDeleted) are NOT blanked: museum's diff SELECT
 * reads the stored collection_files + files columns for deleted links exactly
 * like live ones (repo/collection.go GetDiff) — only the isDeleted flag
 * distinguishes them (D61; the old blanked tombstone was this repo's
 * invention). Clients guard on isDeleted before decrypting diff entries, but
 * the wire shape matches museum field for field either way. */
export const fileToDiffJson = (file: FileRow, link: LinkRow, collectionOwnerID: number): Record<string, unknown> => ({
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
  isDeleted: link.isDeleted,
  updationTime: link.updationTime,
  ...(file.magicMetadata ? { magicMetadata: file.magicMetadata } : {}),
  ...(file.pubMagicMetadata ? { pubMagicMetadata: file.pubMagicMetadata } : {}),
  info: { fileSize: file.info.fileSize, thumbSize: file.info.thumbSize },
});

/** One page of a collection's diff feed — the shared spine of
 * GET /collections/v2/diff and GET /public-collection/diff (museum
 * collections/files_diff.go getDiff, CollectionDiffLimit): page limit 2500,
 * and a same-updationTime cluster is never split across pages. */
export const collectionDiffPage = async (
  deps: Deps,
  collectionId: number,
  sinceTime: number,
  limit: number,
): Promise<{ links: LinkRow[]; hasMore: boolean }> => {
  const page = await deps.db.query<LinkRow>(gsi.collectionDiff(collectionId), {
    index: 'gsi1',
    skFrom: padTime(sinceTime + 1),
    limit: limit + 1,
  });
  let links = page;
  let hasMore = false;
  if (page.length > limit) {
    hasMore = true;
    const boundary = page[limit]!.updationTime;
    links = page.filter((l) => l.updationTime !== boundary);
    if (links.length === 0) {
      // Whole page shares one version: return the entire cluster (never split).
      links = await deps.db.query<LinkRow>(gsi.collectionDiff(collectionId), {
        index: 'gsi1',
        skFrom: padTime(boundary),
        skTo: `${padTime(boundary)}#\u{ffff}`,
      });
    }
  }
  return { links, hasMore };
};

/** Link -> museum File JSON, with the permanently-deleted-file fallback: the
 * file row is gone but the link still tombstones in the feed (museum's
 * stale-entry isDeleted patch in files_diff.go; there the files row survives
 * with metadata "-", here it is deleted outright, so the file-side fields of
 * this one tombstone flavour are blank — unrecoverable, and clients never
 * read past isDeleted on it). The link-side fields (encryptedKey,
 * keyDecryptionNonce, collectionAddedAt) are stored and emit real values. */
export const diffJsonForLink = async (
  deps: Deps,
  link: LinkRow,
  collectionOwnerID: number,
): Promise<Record<string, unknown>> => {
  const file = await getFile(deps, link.fileID);
  if (!file) {
    return fileToDiffJson(
      {
        fileId: link.fileID,
        ownerID: collectionOwnerID,
        info: { fileSize: 0, thumbSize: 0 },
        file: { decryptionHeader: '' },
        thumbnail: { decryptionHeader: '' },
        metadata: { decryptionHeader: '' },
      } as never,
      { ...link, isDeleted: true },
      collectionOwnerID,
    );
  }
  return fileToDiffJson(file, link, collectionOwnerID);
};

/**
 * Download/preview authz (ObjectRepo.GetAccessibleObjectWithDCs,
 * pkg/repo/object.go): accessible to the file's owner, or to anyone who is
 * owner or sharee of a collection that still LINKS the file (museum's SQL:
 * live collection_files row joined to a live collection_shares row). Trashed
 * files remain readable by the owner — their links are tombstoned, but the
 * owner branch never consults links. Non-members and unknown ids both read
 * as 404 (the sql.ErrNoRows path) — membership is never disclosed as 403.
 */
export const getAccessibleFile = async (deps: Deps, userId: number, fileId: number): Promise<FileRow> => {
  const file = await getFile(deps, fileId);
  if (!file) throw errNotFound();
  if (file.ownerID === userId) return file;
  // Sharee branch: the gsi3 FILE-LINKS reverse index lists every collection
  // linking this file. Grant on the first live link whose collection the
  // caller can see — sharee row first (the common case, one GetItem), then
  // collection owner (a collaborator-owned file inside the owner's album).
  const links = await deps.db.query<LinkRow>(`FILE-LINKS#${fileId}`, { index: 'gsi3' });
  for (const link of links) {
    if (link.isDeleted) continue;
    if (await getSharee(deps, link.collectionID, userId)) return file;
    const collection = await deps.db.get(keys.collection(link.collectionID).pk, 'META');
    if (collection?.ownerID === userId) return file;
  }
  throw errNotFound();
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
