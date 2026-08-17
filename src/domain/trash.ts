/**
 * Trash — port of pkg/controller/trash.go + repo semantics. Entries carry the
 * full File json; tombstones (isDeleted / isRestored) are kept for the diff.
 * deleteBy = trashedAt + 30 days.
 */

import type { Deps } from '../deps.ts';
import { keys, gsi, padTime } from './model.ts';
import { MICROS_PER_DAY } from '../lib/time.ts';
import { getFile, restampLink, type FileRow, type LinkRow } from './files.ts';
import { getCollection } from './collections.ts';
import { enqueueObjectDeletion } from './objectSweep.ts';

export const TRASH_DIFF_LIMIT = 2500;
export const TRASH_RETENTION_MICROS = 30 * MICROS_PER_DAY;

export interface TrashRow {
  pk: string;
  sk: string;
  fileID: number;
  userID: number;
  /** Origin collection (museum stores trash.collection_id — the app resolves
   *  the wrapped file key through it). */
  collectionID: number;
  createdAt: number;
  updatedAt: number;
  deleteBy: number;
  isDeleted: boolean;
  isRestored: boolean;
  gsi3pk: string;
  gsi3sk: string;
  [attr: string]: unknown;
}

/** Global due-date index so the purge cron can find aged entries across users. */
const TRASH_DUE_PARTITION = 'TRASH#DUE';

const stamp = (deps: Deps, row: TrashRow): TrashRow => {
  const updatedAt = deps.ids.nextUpdationTime();
  const live = !row.isDeleted && !row.isRestored && row.deleteBy > 0;
  return {
    ...row,
    updatedAt,
    gsi3sk: `${padTime(updatedAt)}#${row.fileID}`,
    ...(live
      ? { gsi1pk: TRASH_DUE_PARTITION, gsi1sk: `${padTime(row.deleteBy)}#${row.userID}#${row.fileID}` }
      : { gsi1pk: undefined, gsi1sk: undefined }),
  };
};

/** Purge cron body: permanently delete every entry past its deleteBy. */
export const purgeAgedTrash = async (deps: Deps): Promise<number> => {
  const due = await deps.db.query<TrashRow>(TRASH_DUE_PARTITION, {
    index: 'gsi1',
    skTo: `${padTime(deps.clock.nowMicros())}#￿`,
  });
  let purged = 0;
  for (const row of due) {
    await permanentlyDelete(deps, row.userID, row);
    purged += 1;
  }
  return purged;
};

export const getTrashRow = async (deps: Deps, userId: number, fileId: number): Promise<TrashRow | null> =>
  deps.db.get<TrashRow>(keys.trashEntry(userId, fileId).pk, `FILE#${fileId}`);

/**
 * Move a file into trash: tombstone every live collection link + trash row.
 * `collectionID` is the origin collection from the request (museum stores it
 * as trash.collection_id and the diff serves the wrapped key through it).
 */
export const trashFile = async (
  deps: Deps,
  userId: number,
  file: FileRow,
  collectionID: number,
): Promise<void> => {
  const links = await deps.db.query<LinkRow>(`FILE-LINKS#${file.fileId}`, { index: 'gsi3' });
  // links are indexed under the file for reverse lookup (gsi3)
  for (const link of links) {
    if (link.isDeleted) continue;
    await deps.db.put(restampLink(deps, link, true));
  }
  const existing = await getTrashRow(deps, userId, file.fileId);
  const now = deps.clock.nowMicros();
  const base: TrashRow = existing ?? {
    ...keys.trashEntry(userId, file.fileId),
    fileID: file.fileId,
    userID: userId,
    collectionID,
    createdAt: now,
    updatedAt: 0,
    deleteBy: 0,
    isDeleted: false,
    isRestored: false,
    gsi3pk: gsi.trashDiff(userId),
    gsi3sk: '',
  };
  await deps.db.put(
    stamp(deps, {
      ...base,
      collectionID,
      isDeleted: false,
      isRestored: false,
      deleteBy: now + TRASH_RETENTION_MICROS,
    }),
  );
};

/** Restore tombstone: entry leaves trash because it went back to a collection. */
export const markRestored = async (deps: Deps, row: TrashRow): Promise<void> => {
  await deps.db.put(stamp(deps, { ...row, isRestored: true, isDeleted: false, deleteBy: 0 }));
};

/**
 * Permanent-delete: tombstone + usage decrement synchronously; the S3 objects
 * are ENQUEUED for the sweep cron, like museum (decision D6).
 */
export const permanentlyDelete = async (deps: Deps, userId: number, row: TrashRow): Promise<void> => {
  if (row.isDeleted || row.isRestored) return; // idempotent
  const file = await getFile(deps, row.fileID);
  await deps.db.put(stamp(deps, { ...row, isDeleted: true }));
  if (!file) return;
  const bytes = (file.info.fileSize ?? 0) + (file.info.thumbSize ?? 0);
  await deps.db.addToCounters(keys.userUsage(userId).pk, 'USAGE', { bytes: -bytes, fileCount: -1 });
  const objectKeys = [file.file.objectKey, file.thumbnail.objectKey].filter(
    (k): k is string => !!k,
  );
  for (const key of objectKeys) {
    await deps.db.delete(`OBJ#${key}`, 'META');
  }
  await enqueueObjectDeletion(deps, objectKeys);
  await deps.db.delete(file.pk, file.sk);
};

/**
 * Trash diff item (ente/trash.go Trash). The File JSON carries the ORIGIN
 * collection's id and its wrapped key (museum joins collection_files on
 * trash.collection_id) — the app decrypts trashed files through it.
 */
export const trashToJson = async (deps: Deps, row: TrashRow): Promise<Record<string, unknown>> => {
  const file = await getFile(deps, row.fileID);
  const tombstone = row.isDeleted || row.isRestored;
  let originCollection = row.collectionID ?? 0;
  let link: LinkRow | null = originCollection
    ? await deps.db.get<LinkRow>(
        keys.collectionFile(originCollection, row.fileID).pk,
        `FILE#${row.fileID}`,
      )
    : null;
  if (!link) {
    // Legacy trash rows (pre-D28) carry no origin; recover it from the file's
    // most recent link — trashing tombstones links but never removes them.
    const links = await deps.db.query<LinkRow>(`FILE-LINKS#${row.fileID}`, { index: 'gsi3' });
    link = links.sort((a, b) => b.updationTime - a.updationTime)[0] ?? null;
    if (link) originCollection = link.collectionID;
  }
  const fileJson: Record<string, unknown> = file && !tombstone
    ? {
        id: file.fileId,
        ownerID: file.ownerID,
        collectionID: originCollection,
        collectionOwnerID: file.ownerID,
        encryptedKey: link?.encryptedKey ?? (file.encryptedKey as string) ?? '',
        keyDecryptionNonce: link?.keyDecryptionNonce ?? (file.keyDecryptionNonce as string) ?? '',
        file: { ...file.file, size: file.info.fileSize },
        thumbnail: { ...file.thumbnail, size: file.info.thumbSize },
        metadata: { size: 0, ...file.metadata },
        isDeleted: false,
        updationTime: file.updationTime,
        ...(file.magicMetadata ? { magicMetadata: file.magicMetadata } : {}),
        ...(file.pubMagicMetadata ? { pubMagicMetadata: file.pubMagicMetadata } : {}),
        info: { fileSize: file.info.fileSize, thumbSize: file.info.thumbSize },
      }
    : {
        id: row.fileID,
        ownerID: row.userID,
        collectionID: row.collectionID ?? 0,
        collectionOwnerID: null,
        encryptedKey: '',
        keyDecryptionNonce: '',
        file: { decryptionHeader: '', size: 0 },
        thumbnail: { decryptionHeader: '', size: 0 },
        metadata: { decryptionHeader: '', size: 0 },
        isDeleted: tombstone && row.isDeleted,
        updationTime: row.updatedAt,
      };
  return {
    file: fileJson,
    isDeleted: row.isDeleted,
    isRestored: row.isRestored,
    deleteBy: row.deleteBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

export { getCollection };
