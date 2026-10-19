/**
 * POST /collections/share/batch (auth) — src: pkg/api/collection.go
 * BatchShare + pkg/controller/collections/share.go BatchShare (upstream
 * 63d1083e43/799c0e2847, museum main 2026-10). Body {shares:
 * [AlterShareRequest]} — every entry for the SAME collection, at most 10;
 * response {"sharees": [...]}, the full post-share list, like /share.
 *
 * Check order is museum's: batch shape (empty 400, >10 413, mixed collection
 * 400, blank/duplicate email 400 — all bare {}), share-mutation access on the
 * collection (unknown 404, non-owner non-ADMIN 403), then per entry: sealed
 * key and role (400 ApiErrors WITH messages — the batch wraps what single
 * /share leaves a bare 500), AllowParticipantSharing, email lookup (404),
 * self/owner guard (400). Every entry resolves before anything is written,
 * so a bad entry anywhere leaves no partial share. The writes themselves are
 * one transaction per sharee, not one for the batch (museum's repo
 * BatchShare is a single SQL transaction) — an infrastructure failure
 * mid-batch can leave a prefix applied; a client retry converges (D66).
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { bumpCollection, resolveCollectionAccess, shareesJson } from '../../domain/collections.ts';
import { addSharee, assertSealedCollectionKey, type ShareeRow } from '../../domain/sharing.ts';
import { normalizeEmail } from '../../domain/tokens.ts';
import { getUserIdByEmail } from '../../domain/users.ts';
import {
  badRequest,
  errBadRequestSentinel,
  errBatchSizeTooLarge,
  errNotFound,
  errPermissionDenied,
  SentinelError,
} from '../../lib/errors.ts';

/** ente.MaxBatchShareSize */
export const MAX_BATCH_SHARE_SIZE = 10;

const bodySchema = z.object({
  shares: z.array(
    z.object({
      collectionID: z.number().refine((v) => v !== 0),
      email: z.string(),
      encryptedKey: z.string().default(''),
      role: z.string().optional(),
    }),
  ),
});

const ROLES: ShareeRow['role'][] = ['VIEWER', 'COLLABORATOR', 'ADMIN'];

export const shareCollectionBatch = (deps: Deps) => async (c: Context) => {
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw errBadRequestSentinel();
  const { shares } = parsed.data;
  const { userId } = auth(c);

  // museum validateBatchShares
  if (shares.length === 0) throw errBadRequestSentinel();
  if (shares.length > MAX_BATCH_SHARE_SIZE) throw errBatchSizeTooLarge();
  const collectionID = shares[0]!.collectionID;
  const seen = new Set<string>();
  for (const share of shares) {
    if (share.collectionID !== collectionID) throw errBadRequestSentinel();
    const email = normalizeEmail(share.email);
    if (!email || seen.has(email)) throw errBadRequestSentinel();
    seen.add(email);
  }

  // museum collectionForShareMutation — OWNER or ADMIN sharee (D63).
  const { collection, role: actorRole } = await resolveCollectionAccess(deps, userId, collectionID, {
    nonMemberForbidden: true,
  });
  if (actorRole !== 'OWNER' && actorRole !== 'ADMIN') throw errPermissionDenied();

  const resolved: { userID: number; role: ShareeRow['role']; encryptedKey: string }[] = [];
  for (const share of shares) {
    try {
      assertSealedCollectionKey(share.encryptedKey);
    } catch (err) {
      if (err instanceof SentinelError) throw badRequest(err.message);
      throw err;
    }
    const role = (share.role ?? 'VIEWER') as ShareeRow['role'];
    if (!ROLES.includes(role)) throw badRequest(`invalid role ${share.role}`);
    // museum AllowParticipantSharing: uncategorized only as VIEWER.
    if (collection.type === 'uncategorized' && role !== 'VIEWER') throw errBadRequestSentinel();
    const toUserID = await getUserIdByEmail(deps, share.email);
    if (toUserID === null) throw errNotFound();
    if (toUserID === userId || toUserID === collection.ownerID) throw errBadRequestSentinel();
    resolved.push({ userID: toUserID, role, encryptedKey: share.encryptedKey });
  }

  for (const r of resolved) {
    await addSharee(deps, { collectionID, ...r, sharedBy: userId });
  }
  await bumpCollection(deps, collection, {});
  return c.json({ sharees: await shareesJson(deps, collectionID) });
};
