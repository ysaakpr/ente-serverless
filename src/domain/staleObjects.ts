/**
 * Stale-object GC (D65) — museum's temp_objects machinery, ported. Every
 * upload-URL mint records the minted key as a TEMP OBJECT (museum
 * controller/file.go getObjectURL → AddTempObjectKey, and the multipart mints
 * → AddMultipartTempObjectKey with the upload id); a cron sweep deletes keys
 * whose row expired WITHOUT the object ever being committed. Without this, a
 * client that PUTs bytes but never commits (quota 426, validation failure,
 * crash) leaves unreferenced encrypted blobs in the bucket forever —
 * reproduced live 2026-08-28 during the BYO pool E2E.
 *
 * Semantics, museum-faithful (pkg/controller/object_cleanup.go +
 * pkg/repo/object_cleanup.go):
 *  - expiry = mint time + 2× the presigned-PUT validity (museum:
 *    2 × PreSignedRequestValidityDuration) — a commit can only race the sweep
 *    if the client sat on uploaded-but-uncommitted bytes for twice the URL
 *    lifetime; museum accepts the same window;
 *  - the COMMIT path never touches these rows (museum removes nothing at
 *    commit); instead the sweeper checks whether the key was claimed —
 *    museum's ObjectRepo.DoesObjectExist, our OBJ#<key> guard row, written in
 *    the commit transaction — and skips deletion when it was;
 *  - a claimed key's row is DELETED here rather than museum's
 *    "bump expiry +1 day and re-check tomorrow" loop — deliberate deviation:
 *    a committed object's later deletion already flows through PURGEQ, so the
 *    temp row has no further job (documented in D65);
 *  - multipart rows carry the upload id, and the sweep ABORTS the upload
 *    before deleting the key (a completed-but-uncommitted MPU leaves an
 *    object; an abandoned one leaves billed parts — abort covers both,
 *    tolerating NoSuchUpload like museum);
 *  - batch cap 1000 per run (museum's LIMIT 1000), leftovers wait for the
 *    next cron;
 *  - pool-aware like PURGEQ (D55/D56): rows carry the pool the mint presigned
 *    into, deletes go through that pool's credentials, and an unresolvable
 *    pool quarantines only its own rows for the run.
 *
 * Same single-partition, time-ordered queue shape as PURGEQ; no gsi
 * attributes (the D48 rollback rule holds).
 */

import type { Deps } from '../deps.ts';
import type { Blobs } from '../ports/blobs.ts';
import { padTime } from './model.ts';
import { objectGuardKey } from './files.ts';
import { blobsForPoolId } from './storagePools.ts';

const STALE_PK = 'STALEQ';
/** museum object_cleanup.go: `LIMIT 1000` per cleanup pass. */
const STALE_SWEEP_BATCH = 1000;

export interface TempObjectEntry {
  objectKey: string;
  /** Set on multipart mints — the sweep aborts the upload before deleting. */
  uploadID?: string;
}

/**
 * Record freshly minted upload keys. Called by every mint handler AFTER the
 * presign succeeds; a write failure fails the mint (museum propagates
 * AddTempObjectKey errors the same way — an untracked key must never be
 * handed out).
 */
export const recordTempObjects = async (
  deps: Deps,
  poolId: string | undefined,
  entries: TempObjectEntry[],
): Promise<void> => {
  const expiresAt = deps.clock.nowMicros() + 2 * deps.config.presignPutExpirySeconds * 1_000_000;
  for (const entry of entries) {
    await deps.db.put({
      pk: STALE_PK,
      sk: `${padTime(expiresAt)}#${deps.rand.uuid()}`,
      objectKey: entry.objectKey,
      expiresAt,
      ...(entry.uploadID ? { uploadID: entry.uploadID } : {}),
      ...(poolId ? { poolId } : {}),
    });
  }
};

/**
 * Cron half: delete expired, never-claimed keys from their bucket. Returns
 * the number of ROWS resolved (claimed rows count — they cost a delete too).
 */
export const sweepStaleObjects = async (deps: Deps): Promise<number> => {
  const now = deps.clock.nowMicros();
  // sk sorts by expiry (padTime prefix), so expired rows are the head of the
  // partition; the in-memory filter is belt and braces.
  const rows = (await deps.db.query(STALE_PK, {}))
    .filter((r) => (r.expiresAt as number) <= now)
    .slice(0, STALE_SWEEP_BATCH);

  const blobsByPool = new Map<string, Blobs>();
  const quarantined = new Map<string, number>();
  let resolved = 0;
  for (const row of rows) {
    const objectKey = row.objectKey as string;

    // Claimed = the commit transaction wrote the OBJ# guard (museum
    // DoesObjectExist). The object is live data — drop only the temp row.
    const guard = await deps.db.get(objectGuardKey(objectKey).pk, 'META');
    if (guard) {
      await deps.db.delete(row.pk as string, row.sk as string);
      resolved += 1;
      continue;
    }

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
        console.error(`stale sweep: pool ${poolId} unresolvable, quarantining its rows this run`, err);
        quarantined.set(poolKey, 1);
        continue;
      }
    }
    try {
      if (row.uploadID) {
        await blobs.abortMultipart(objectKey, row.uploadID as string);
      }
      await blobs.delete(objectKey); // idempotent — missing keys are fine
      await deps.db.delete(row.pk as string, row.sk as string);
      resolved += 1;
    } catch (err) {
      if (poolId) {
        console.error(`stale sweep: pool ${poolId} delete failed, quarantining its rows this run`, err);
        quarantined.set(poolKey, 1);
      } else {
        console.error(`stale sweep: default-bucket delete failed for ${objectKey}, leaving for next run`, err);
      }
    }
  }
  for (const [poolKey, count] of quarantined) {
    console.error(`stale sweep: quarantined ${count} row(s) for pool '${poolKey || 'central'}'`);
  }
  return resolved;
};
