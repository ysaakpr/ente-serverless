/**
 * Deferred S3 object deletion (decision D6) — museum enqueues object cleanup
 * instead of deleting during the request; so do we. Producers: permanent
 * delete / trash purge, and the update paths that replace an object. The
 * daily worker drains the queue.
 */

import type { Deps } from '../deps.ts';
import { padTime } from './model.ts';

const QUEUE_PK = 'PURGEQ';

export const enqueueObjectDeletion = async (deps: Deps, objectKeys: string[]): Promise<void> => {
  for (const objectKey of objectKeys) {
    if (!objectKey) continue;
    await deps.db.put({
      pk: QUEUE_PK,
      sk: `${padTime(deps.clock.nowMicros())}#${deps.rand.uuid()}`,
      objectKey,
    });
  }
};

/** Drain the queue; failures stay queued for the next run. */
export const sweepDeletedObjects = async (deps: Deps): Promise<number> => {
  const rows = await deps.db.query(QUEUE_PK, {});
  let swept = 0;
  for (const row of rows) {
    try {
      await deps.blobs.delete(row.objectKey as string);
      await deps.db.delete(row.pk, row.sk);
      swept += 1;
    } catch {
      // leave the row; retried next sweep
    }
  }
  return swept;
};
