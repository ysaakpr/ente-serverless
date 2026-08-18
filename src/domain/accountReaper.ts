/**
 * Account data reaper (SECURITY-REVIEW-2 F7). deleteAccount tombstones the user
 * and revokes tokens, but the daily cron only drains the object-deletion queue
 * and never reaped a deleted user's data — so their encrypted S3 objects and
 * key material persisted indefinitely (a privacy and storage-cost gap, and the
 * "sweep cron's concern" comment was untrue).
 *
 * This enqueues the user's file/thumbnail objects onto the EXISTING sweep queue
 * (drained by workers/trashPurge) and removes their sensitive key-material rows.
 * Object enumeration is best-effort: a partial failure must never block the
 * account deletion itself (tokens are already revoked and the email freed), so
 * the caller runs this after the tombstone commits.
 */

import type { Deps } from '../deps.ts';
import { keys, gsi } from './model.ts';
import { getFile, type LinkRow } from './files.ts';
import type { CollectionRow } from './collections.ts';
import { enqueueObjectDeletion } from './objectSweep.ts';

/** SKs under USER#<id> that hold key material or auth secrets. */
const SENSITIVE_USER_SKS = ['KEYS', 'SRP', '2FA', '2FASETUP'] as const;

export const reapUserData = async (deps: Deps, userId: number): Promise<void> => {
  // 1) Enqueue every file/thumbnail object the user owns, discovered through
  //    their collections -> links -> files, for the sweep to reclaim.
  try {
    const collections = await deps.db.query<CollectionRow>(gsi.userCollections(userId), {
      index: 'gsi2',
    });
    const objectKeys: string[] = [];
    const seen = new Set<number>();
    for (const col of collections) {
      const links = await deps.db.query<LinkRow>(gsi.collectionDiff(col.collectionId), {
        index: 'gsi1',
      });
      for (const link of links) {
        const fileId = link.fileID;
        if (typeof fileId !== 'number' || seen.has(fileId)) continue;
        seen.add(fileId);
        const file = await getFile(deps, fileId);
        if (!file || file.ownerID !== userId) continue;
        for (const key of [file.file?.objectKey, file.thumbnail?.objectKey]) {
          if (key) objectKeys.push(key);
        }
      }
    }
    await enqueueObjectDeletion(deps, objectKeys);
  } catch (err) {
    // Leave the objects; a failed enumeration must not fail the deletion. The
    // tombstone stands, so nothing is reachable meanwhile.
    console.error('account reaper: object enumeration failed', userId, err);
  }

  // 2) Remove key material so it does not survive the tombstone.
  for (const sk of SENSITIVE_USER_SKS) {
    await deps.db.delete(keys.user(userId).pk, sk).catch(() => {});
  }
};
