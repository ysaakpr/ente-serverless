/**
 * Deferred S3 object deletion (decision D6) — museum enqueues object cleanup
 * instead of deleting during the request; so do we. Producers: permanent
 * delete / trash purge, account deletion, and the update paths that replace
 * an object. The daily worker drains the queue.
 *
 * Pool-aware since H2 (D55): each queue row carries the POOL PIN of the
 * object it deletes (absent = central bucket), and the sweep deletes from
 * that pool's bucket. A pool that cannot be resolved or whose credentials
 * fail QUARANTINES the rest of its rows for that run — logged and counted,
 * rows left intact for the next sweep — so one household's broken bucket can
 * never stall everyone else's GC.
 */

import type { Deps } from '../deps.ts';
import type { Blobs } from '../ports/blobs.ts';
import { padTime } from './model.ts';
import { blobsForPoolId } from './storagePools.ts';

const QUEUE_PK = 'PURGEQ';

export interface PurgeEntry {
  objectKey: string;
  /** The object's pool pin; absent = the central default bucket. */
  poolId?: string;
}

export const enqueueObjectDeletion = async (deps: Deps, entries: PurgeEntry[]): Promise<void> => {
  for (const { objectKey, poolId } of entries) {
    if (!objectKey) continue;
    await deps.db.put({
      pk: QUEUE_PK,
      sk: `${padTime(deps.clock.nowMicros())}#${deps.rand.uuid()}`,
      objectKey,
      ...(poolId ? { poolId } : {}),
    });
  }
};

/** Drain the queue; failures stay queued for the next run. */
export const sweepDeletedObjects = async (deps: Deps): Promise<number> => {
  const rows = await deps.db.query(QUEUE_PK, {});
  const blobsByPool = new Map<string, Blobs>();
  const quarantined = new Map<string, number>();
  let swept = 0;
  for (const row of rows) {
    const poolId = row.poolId as string | undefined;
    const poolKey = poolId ?? '';
    if (quarantined.has(poolKey)) {
      quarantined.set(poolKey, quarantined.get(poolKey)! + 1);
      continue;
    }
    let blobs = blobsByPool.get(poolKey);
    if (!blobs) {
      try {
        blobs = await blobsForPoolId(deps, poolId);
        blobsByPool.set(poolKey, blobs);
      } catch (err) {
        // Unresolvable pool (row deleted, bad credentials at build time):
        // quarantine its batch — rows stay for retry, other pools continue.
        console.error(`object sweep: pool ${poolId} unresolvable, quarantining its rows this run`, err);
        quarantined.set(poolKey, 1);
        continue;
      }
    }
    try {
      await blobs.delete(row.objectKey as string);
      await deps.db.delete(row.pk, row.sk);
      swept += 1;
    } catch (err) {
      if (poolId) {
        // A pool delete failing is most likely credentials/permissions — the
        // same failure would hit every row of the pool, so quarantine it.
        console.error(`object sweep: pool ${poolId} delete failed, quarantining its rows this run`, err);
        quarantined.set(poolKey, 1);
      }
      // Default-bucket rows keep the old behaviour: leave THIS row, continue.
    }
  }
  for (const [poolKey, count] of quarantined) {
    console.error(`object sweep: quarantined ${count} rows for pool ${poolKey || '(default)'} — retried next run`);
  }
  return swept;
};
