/**
 * PUT /collections/share-url (auth) — src: pkg/api/collection.go
 * UpdateShareURL + pkg/controller/collections/share.go UpdateShareURL +
 * pkg/controller/public/collection_link.go UpdateSharedUrl. Body
 * ente.UpdatePublicAccessTokenRequest (every field a pointer upstream —
 * absent means "leave alone"); response {"result": PublicURL}.
 *
 * Validation is museum's Validate(), message for message (each a 400
 * {"code":"BAD_REQUEST", message}): at least one of deviceLimit/validTill/
 * disablePassword/nonce/passHash/enableDownload/enableCollect/enableComment/
 * enableJoin/minRole present (memLimit/opsLimit alone do NOT count — upstream
 * quirk); deviceLimit 0-50; a non-zero validTill must be in the future; the
 * four password params are all-or-nothing; the KDF params are pinned to
 * memLimit=67108864, opsLimit=2; set+disable password in one request refused;
 * minRole must be a valid share role (VIEWER/COLLABORATOR/ADMIN/OWNER —
 * IsValidShareRole allows all four; nothing here mints ADMIN rows, but the
 * link filter only compares ranks, so storing it is harmless).
 *
 * Then: owner-only (verifyOwnership: 404 unknown, 403 foreign), active link
 * required (sql.ErrNoRows -> 404), patch semantics exactly as UpdateSharedUrl:
 * password params only applied as a foursome; disablePassword clears all four;
 * enable* flags individually.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { bumpCollectionForward, resolveCollectionAccess } from '../../domain/collections.ts';
import { getLinkForCollection, updatePublicLink, type PublicLinkRow } from '../../domain/sharing.ts';
import { publicUrlJson } from '../../domain/publicLinks.ts';
import { assertDeviceLimit } from './shareUrl.ts';
import { ApiError, errNotFound } from '../../lib/errors.ts';

const bodySchema = z.object({
  collectionID: z.number().refine((v) => v !== 0),
  validTill: z.number().nullish(),
  deviceLimit: z.number().int().nullish(),
  passHash: z.string().nullish(),
  nonce: z.string().nullish(),
  memLimit: z.number().nullish(),
  opsLimit: z.number().nullish(),
  enableDownload: z.boolean().nullish(),
  enableCollect: z.boolean().nullish(),
  enableComment: z.boolean().nullish(),
  disablePassword: z.boolean().nullish(),
  enableJoin: z.boolean().nullish(),
  minRole: z.string().nullish(),
});

type Body = z.infer<typeof bodySchema>;

const bad = (message: string) => new ApiError('BAD_REQUEST', 400, message);
const present = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined;

/** ente.UpdatePublicAccessTokenRequest.Validate(), transcribed. */
const validate = (deps: Deps, b: Body): void => {
  if (
    !present(b.deviceLimit) && !present(b.validTill) && !present(b.disablePassword) &&
    !present(b.nonce) && !present(b.passHash) && !present(b.enableDownload) &&
    !present(b.enableCollect) && !present(b.enableComment) && !present(b.enableJoin) &&
    !present(b.minRole)
  ) {
    throw bad('all parameters are missing');
  }
  if (present(b.deviceLimit)) assertDeviceLimit(b.deviceLimit);
  if (present(b.validTill) && b.validTill !== 0 && b.validTill < deps.clock.nowMicros()) {
    throw bad('valid till should be greater than current timestamp');
  }
  const passParams = [b.nonce, b.passHash, b.memLimit, b.opsLimit];
  const allMissing = passParams.every((p) => !present(p));
  const allPresent = passParams.every(present);
  if (!allMissing && !allPresent) {
    throw bad('all password params should be either present or missing');
  }
  if (present(b.memLimit) || present(b.opsLimit)) {
    if (!present(b.memLimit) || !present(b.opsLimit) || b.memLimit !== 67108864 || b.opsLimit !== 2) {
      throw bad('invalid KDF parameters');
    }
  }
  if (allPresent && b.disablePassword === true) {
    throw bad('can not set and disable password in same request');
  }
  if (present(b.minRole) && !['VIEWER', 'COLLABORATOR', 'ADMIN', 'OWNER'].includes(b.minRole)) {
    throw bad(`invalid min role ${b.minRole}`);
  }
};

export const updateShareUrl = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
  const { userId } = auth(c);
  validate(deps, body);

  // museum verifyOwnership reads only owner_id (no deleted filter) — include
  // deleted so an owner can still kill/patch a lingering link.
  await resolveCollectionAccess(deps, userId, body.collectionID, {
    verifyOwner: true,
    includeDeleted: true,
  });

  const link = await getLinkForCollection(deps, body.collectionID);
  if (!link) throw errNotFound(); // museum: sql.ErrNoRows -> 404

  const next: PublicLinkRow = { ...link };
  if (present(body.validTill)) next.validTill = body.validTill;
  if (present(body.deviceLimit)) next.deviceLimit = body.deviceLimit;
  if (present(body.passHash) && present(body.nonce) && present(body.opsLimit) && present(body.memLimit)) {
    next.passHash = body.passHash;
    next.nonce = body.nonce;
    next.opsLimit = body.opsLimit;
    next.memLimit = body.memLimit;
  } else if (body.disablePassword === true) {
    delete next.passHash;
    delete next.nonce;
    delete next.opsLimit;
    delete next.memLimit;
  }
  if (present(body.enableDownload)) next.enableDownload = body.enableDownload;
  if (present(body.enableCollect)) next.enableCollect = body.enableCollect;
  if (present(body.enableComment)) next.enableComment = body.enableComment;
  if (present(body.enableJoin)) next.enableJoin = body.enableJoin;
  if (present(body.minRole)) next.minRole = body.minRole;

  await updatePublicLink(deps, next);
  // Museum restamps the collection on every public_collection_tokens UPDATE
  // (the fn_update_collections_updation_time trigger) — without it the owner's
  // synced devices keep rendering the OLD link config forever (D62).
  await bumpCollectionForward(deps, body.collectionID, deps.ids.nextUpdationTime());
  // museum's update response computes passwordEnabled from PassHash (the map
  // and feeds key on the nonce); the pair only ever moves together here, so
  // the emitted shape is identical.
  return c.json({ result: publicUrlJson(deps, next) });
};
