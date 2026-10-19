/**
 * POST /collections/unshare/bulk (auth) — src: pkg/api/collection.go
 * BulkUnShare + pkg/controller/collections/share.go BulkUnShare /
 * unshareCollectionWithUserID + repo UnShareContext (museum main 2026-10).
 * Body {recipientUserID, source: "manual"|"automatic", collectionIDs};
 * response {"results": [{collectionID, status}]}, one per id, in order.
 *
 * Request-level failures are bare {}: bad/missing source or empty list 400,
 * more than 100 ids 413, a duplicate id 400, recipient <= 0 or self 400.
 * Per-collection failures never fail the request — they report
 * status "failed" (unknown collection, caller not OWNER/ADMIN, "automatic"
 * from a non-owner, recipient is the owner). Otherwise: "unshared" (live
 * share revoked — museum's full UnShareContext, our revokeShareeAccess),
 * "already_unshared" (only a tombstone left; museum still restamps the
 * collection), "not_shared" (never shared). Mobile's "Unshare and Hide"
 * calls this regardless of the LibrarySharing flag (D66).
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { keys } from '../../domain/model.ts';
import { bumpCollection, resolveCollectionAccess, revokeShareeAccess } from '../../domain/collections.ts';
import { getSharee } from '../../domain/sharing.ts';
import { errBadRequestSentinel, errBatchSizeTooLarge } from '../../lib/errors.ts';

/** ente.MaxCollectionShareBatchSize */
export const MAX_COLLECTION_SHARE_BATCH_SIZE = 100;

const bodySchema = z.object({
  recipientUserID: z.number().refine((v) => v !== 0), // gin binding:"required"
  source: z.string().min(1),
  collectionIDs: z.array(z.number()),
});

type Status = 'unshared' | 'already_unshared' | 'not_shared' | 'failed';

const unshareOne = async (
  deps: Deps,
  collectionID: number,
  actorID: number,
  recipientID: number,
  source: string,
): Promise<Status> => {
  const { collection, role } = await resolveCollectionAccess(deps, actorID, collectionID, {
    nonMemberForbidden: true,
  });
  if (role !== 'OWNER' && role !== 'ADMIN') return 'failed';
  if (source === 'automatic' && role !== 'OWNER') return 'failed';
  if (recipientID === collection.ownerID) return 'failed';

  if (await getSharee(deps, collectionID, recipientID)) {
    await revokeShareeAccess(deps, collection, recipientID);
    return 'unshared';
  }
  const tomb = keys.sharedTombstone(recipientID, collectionID);
  if (await deps.db.get(tomb.pk, tomb.sk)) {
    await bumpCollection(deps, collection, {});
    return 'already_unshared';
  }
  return 'not_shared';
};

export const unshareCollectionsBulk = (deps: Deps) => async (c: Context) => {
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw errBadRequestSentinel();
  const { recipientUserID, source, collectionIDs } = parsed.data;
  const { userId } = auth(c);

  // museum validateCollectionUnshareBatch + validateBulkShareRecipient
  if ((source !== 'manual' && source !== 'automatic') || collectionIDs.length === 0) {
    throw errBadRequestSentinel();
  }
  if (collectionIDs.length > MAX_COLLECTION_SHARE_BATCH_SIZE) throw errBatchSizeTooLarge();
  if (new Set(collectionIDs).size !== collectionIDs.length) throw errBadRequestSentinel();
  if (recipientUserID <= 0 || recipientUserID === userId) throw errBadRequestSentinel();

  const results: { collectionID: number; status: Status }[] = [];
  for (const collectionID of collectionIDs) {
    let status: Status;
    try {
      status = await unshareOne(deps, collectionID, userId, recipientUserID, source);
    } catch (err) {
      console.warn('bulk collection unshare failed', { collectionID, err: (err as Error).message });
      status = 'failed';
    }
    results.push({ collectionID, status });
  }
  return c.json({ results });
};
