/**
 * POST /collections/unshare (auth) — src: pkg/api/collection.go UnShare +
 * pkg/controller/collections/share.go UnShare. Body {collectionID, email};
 * response {"sharees": [...]} — the pre-fetched list minus the removed user.
 * Museum's UnShareContext (repo/collection.go) flips the share row's
 * is_deleted (our tombstone row), tombstones the SHAREE'S OWN files in the
 * collection, and bumps collections.updation_time — revokeShareeAccess does
 * all three.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { resolveCollectionAccess, revokeShareeAccess, shareesJson } from '../../domain/collections.ts';
import { normalizeEmail } from '../../domain/tokens.ts';
import { errNotFound, errPermissionDenied } from '../../lib/errors.ts';

const bodySchema = z.object({
  collectionID: z.number().refine((v) => v !== 0),
  email: z.string().min(1),
});

export const unshareCollection = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
  const { userId } = auth(c);

  // museum collectionForShareMutation: the OWNER or an ADMIN sharee
  // (share.go; oracle-verified D63) — other members and non-members 403.
  const { collection, role: actorRole } = await resolveCollectionAccess(deps, userId, body.collectionID);
  if (actorRole !== 'OWNER' && actorRole !== 'ADMIN') throw errPermissionDenied();

  // museum shareeIndexForEmail over GetSharees: not a sharee -> 404.
  const sharees = await shareesJson(deps, body.collectionID);
  const target = normalizeEmail(body.email);
  const index = sharees.findIndex((s) => normalizeEmail(s.email) === target);
  if (index === -1) throw errNotFound();
  const toUserID = sharees[index]!.id;
  // museum: removing yourself or the owner via unshare is 403 (an owner can
  // never be a sharee, so this only fires for a hypothetical self-remove).
  if (toUserID === userId || toUserID === collection.ownerID) throw errPermissionDenied();

  await revokeShareeAccess(deps, collection, toUserID);

  return c.json({ sharees: sharees.filter((_, i) => i !== index) });
};
