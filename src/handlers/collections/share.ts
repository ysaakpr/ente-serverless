/**
 * POST /collections/share (auth) — src: pkg/api/collection.go Share +
 * pkg/controller/collections/share.go Share. Body ente.AlterShareRequest
 * {collectionID, email, encryptedKey, role?}; role defaults VIEWER. Response
 * {"sharees": [CollectionUser...]} — the full post-share list. Check order is
 * museum's: sealed-key shape, collection access, AllowParticipantSharing,
 * email -> user, self/owner guards, then the upsert + collection restamp
 * (repo Share bumps collections.updation_time so both feeds see the change).
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import {
  bumpCollection,
  resolveCollectionAccess,
  shareesJson,
} from '../../domain/collections.ts';
import { addSharee, assertSealedCollectionKey } from '../../domain/sharing.ts';
import { getUserIdByEmail } from '../../domain/users.ts';
import { errBadRequestSentinel, errNotFound, errPermissionDenied } from '../../lib/errors.ts';

const bodySchema = z.object({
  collectionID: z.number().refine((v) => v !== 0), // gin binding:"required" fails on zero
  email: z.string().min(1),
  // Not binding-required in museum; a missing/short key fails the length
  // validation below instead.
  encryptedKey: z.string().default(''),
  // The full sharee role set (D63) — role changes ride this same endpoint
  // (the app re-shares with the new role; museum upserts). A truly unknown
  // string 500s in museum (Postgres enum reject); zod's 400 here is the
  // deliberate divergence D50 recorded.
  role: z.enum(['VIEWER', 'COLLABORATOR', 'ADMIN']).optional(),
});

export const shareCollection = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
  const { userId } = auth(c);
  // museum validateSealedCollectionKey — moved to domain/sharing.ts in Phase D
  // (join-link validates the same shape).
  assertSealedCollectionKey(body.encryptedKey);
  const role = body.role ?? 'VIEWER';

  // museum collectionForShareMutation: the OWNER or an ADMIN sharee may
  // share/unshare/change roles (share.go; oracle-verified D63) — unknown
  // collection 404, every other member and non-member 403. Museum's repo.Get
  // does not filter deleted collections; ours 404s them — a share onto a
  // deleted album is nonsense anyway (capture-gated, D50).
  const { collection, role: actorRole } = await resolveCollectionAccess(deps, userId, body.collectionID);
  if (actorRole !== 'OWNER' && actorRole !== 'ADMIN') throw errPermissionDenied();

  // museum AllowParticipantSharing (ente/collection.go): uncategorized may
  // only be shared as VIEWER; every other type (favorites included) is open.
  if (collection.type === 'uncategorized' && role !== 'VIEWER') {
    throw errBadRequestSentinel(); // "sharing uncategorized is not allowed"
  }

  const toUserID = await getUserIdByEmail(deps, body.email);
  if (toUserID === null) throw errNotFound(); // museum UserLookup: sql.ErrNoRows -> 404

  // museum validateShareRecipient: sharing with self / the owner is 400.
  if (toUserID === userId || toUserID === collection.ownerID) {
    throw errBadRequestSentinel(); // "Can not share collection with self"
  }

  await addSharee(deps, {
    collectionID: body.collectionID,
    userID: toUserID,
    role,
    encryptedKey: body.encryptedKey,
    sharedBy: userId,
  });
  // museum repo.Share: UPDATE collections SET updation_time — the sharee's
  // feed picks the collection up, the owner's re-syncs the sharee list.
  await bumpCollection(deps, collection, {});

  return c.json({ sharees: await shareesJson(deps, body.collectionID) });
};
