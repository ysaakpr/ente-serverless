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
import type { Item } from '../ports/db.ts';
import { padTime } from './model.ts';
import { blobsForPoolId } from './storagePools.ts';

const QUEUE_PK = 'PURGEQ';

export interface PurgeEntry {
  objectKey: string;
  /** The object's pool pin; absent = the central default bucket. */
  poolId?: string;
}

/** One queue row, exposed so delete paths can fold the enqueue into the SAME
 * transactWrite as their counter decrements and row deletes (D56). */
export const purgeQueueRow = (deps: Pick<Deps, 'clock' | 'rand'>, entry: PurgeEntry): Item => ({
  pk: QUEUE_PK,
  sk: `${padTime(deps.clock.nowMicros())}#${deps.rand.uuid()}`,
  objectKey: entry.objectKey,
  ...(entry.poolId ? { poolId: entry.poolId } : {}),
});

export const enqueueObjectDeletion = async (deps: Deps, entries: PurgeEntry[]): Promise<void> => {
  for (const entry of entries) {
    if (!entry.objectKey) continue;
    await deps.db.put(purgeQueueRow(deps, entry));
  }
};

/**
 * Operator drain for quarantined rows (D56): re-pin every queue row of one
 * pool onto another pool (or the central bucket, toPoolId null) so the sweep
 * can delete them. The operator is ASSERTING where the bytes actually live —
 * the next sweep issues deletes against the TARGET bucket, and a wrong
 * assertion leaves the real bytes orphaned in the old bucket. Surfaced as
 * `make pool-requeue POOL=... [TO=...]` (tools/storagePool.ts).
 */
export const requeuePoolRows = async (
  deps: Pick<Deps, 'db'>,
  fromPoolId: string,
  toPoolId: string | null,
): Promise<number> => {
  const rows = await deps.db.query(QUEUE_PK, {});
  let moved = 0;
  for (const row of rows) {
    if ((row.poolId as string | undefined) !== fromPoolId) continue;
    await deps.db.update(row.pk, row.sk, { poolId: toPoolId ?? undefined });
    moved += 1;
  }
  return moved;
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
      } else {
        // Default-bucket rows: leave THIS row for retry, keep sweeping — but
        // LOUDLY (D56): these failures used to be swallowed, so a permanently
        // stuck row was invisible in the worker's logs.
        console.error(
          `object sweep: default-bucket delete failed for ${row.objectKey as string}, leaving for next run`,
          err,
        );
      }
    }
  }
  for (const [poolKey, count] of quarantined) {
    console.error(`object sweep: quarantined ${count} rows for pool ${poolKey || '(default)'} — retried next run`);
  }
  return swept;
};
