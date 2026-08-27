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
import { addSharee } from '../../domain/sharing.ts';
import { getUserIdByEmail } from '../../domain/users.ts';
import { errBadRequestSentinel, errNotFound, SentinelError } from '../../lib/errors.ts';

const bodySchema = z.object({
  collectionID: z.number().refine((v) => v !== 0), // gin binding:"required" fails on zero
  email: z.string().min(1),
  // Not binding-required in museum; a missing/short key fails the length
  // validation below instead.
  encryptedKey: z.string().default(''),
  // museum's repo also accepts ADMIN (repo/collection.go Share); nothing in
  // this repo can honour an ADMIN row (D49), so it is refused as 400 here
  // where museum would 500 on truly unknown strings — capture-gated (D50).
  role: z.enum(['VIEWER', 'COLLABORATOR']).optional(),
});

/** museum validateSealedCollectionKey (collections/key_validation.go): the
 * sealed collection key is exactly 32 (key) + 48 (crypto_box_seal overhead)
 * bytes. A plain Go error there maps to a bare 500 (handler.go). */
const assertSealedKey = (encryptedKey: string): void => {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(encryptedKey, 'base64');
  } catch {
    throw new SentinelError(500, 'encryptedKey must be valid base64');
  }
  if (decoded.length !== 80) {
    throw new SentinelError(500, 'encryptedKey must decode to 80 bytes');
  }
};

export const shareCollection = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
  const { userId } = auth(c);
  assertSealedKey(body.encryptedKey);
  const role = body.role ?? 'VIEWER';

  // museum collectionForShareMutation: owner (or an ADMIN sharee — none can
  // exist here, D49); unknown collection 404, everyone else 403. Museum's
  // repo.Get does not filter deleted collections; ours 404s them — a share
  // onto a deleted album is nonsense anyway (capture-gated, D50).
  const { collection } = await resolveCollectionAccess(deps, userId, body.collectionID, {
    verifyOwner: true,
  });

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
