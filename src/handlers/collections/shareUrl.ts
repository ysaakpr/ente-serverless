/**
 * POST /collections/share-url (auth) — src: pkg/api/collection.go ShareURL +
 * pkg/controller/collections/share.go ShareURL + pkg/controller/public/
 * collection_link.go CreateLink. Body ente.CreatePublicAccessTokenRequest;
 * response {"result": PublicURL}. Check order is museum's: validate (device
 * limit 0-50), collection lookup (404 unknown), AllowSharing (uncategorized ->
 * bare 400 — a DIFFERENT predicate from participant sharing: favorites ARE
 * linkable, and there is no VIEWER carve-out), owner-only (403). Token: 10
 * uppercase-alphanumeric chars (museum shortuuid[0:10] uppercased), stored
 * with its hash key by the Phase A layer. A collection that already has an
 * active link gets THAT link back, 200 — museum's ErrActiveLinkAlreadyExists
 * path returns the existing PublicURL, not an error. validTill is NOT
 * validated against the clock on create (only update checks it) — upstream
 * quirk, kept.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { bumpCollectionForward, getCollection } from '../../domain/collections.ts';
import { createPublicLink, getLinkForCollection } from '../../domain/sharing.ts';
import { generateAccessToken, publicUrlJson } from '../../domain/publicLinks.ts';
import { ConditionFailedError } from '../../ports/db.ts';
import {
  ApiError,
  errBadRequestSentinel,
  errNotFound,
  errPermissionDenied,
} from '../../lib/errors.ts';

const bodySchema = z.object({
  collectionID: z.number().refine((v) => v !== 0), // gin binding:"required"
  enableCollect: z.boolean().optional().default(false),
  enableComment: z.boolean().optional().default(false),
  // *bool upstream: absent defaults true (ShareURL sets valTrue).
  enableJoin: z.boolean().nullish(),
  validTill: z.number().optional().default(0),
  deviceLimit: z.number().int().optional().default(0),
});

/** museum validatePublicLinkDeviceLimit -> 400 {"code":"BAD_REQUEST",message}. */
export const assertDeviceLimit = (deviceLimit: number): void => {
  if (deviceLimit < 0 || deviceLimit > 50) {
    throw new ApiError('BAD_REQUEST', 400, `device limit: ${deviceLimit} out of range [0-50]`);
  }
};

export const shareUrl = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
  const { userId } = auth(c);
  assertDeviceLimit(body.deviceLimit);

  // museum's exact order: repo.Get (404 unknown; upstream has no deleted
  // filter — ours 404s deleted, the D50 call for /collections/share applied
  // uniformly), then AllowSharing (400), THEN the owner gate (403) — so any
  // caller probing an uncategorized album reads 400 before 403, as upstream.
  const collection = await getCollection(deps, body.collectionID);
  if (!collection || collection.isDeleted) throw errNotFound();
  if (collection.type === 'uncategorized') throw errBadRequestSentinel(); // AllowSharing()
  if (collection.ownerID !== userId) throw errPermissionDenied();

  try {
    const link = await createPublicLink(deps, {
      collectionID: body.collectionID,
      token: generateAccessToken(deps),
      createdBy: userId,
      validTill: body.validTill,
      deviceLimit: body.deviceLimit,
      enableCollect: body.enableCollect,
      enableComment: body.enableComment,
      enableJoin: body.enableJoin ?? true,
    });
    // Museum restamps the collection on every public_collection_tokens INSERT
    // (the fn_update_collections_updation_time trigger) — the owner's other
    // devices learn about the link through the re-emitted feed entry (D62).
    // The return-existing path below inserts nothing, so it does not bump.
    await bumpCollectionForward(deps, body.collectionID, deps.ids.nextUpdationTime());
    return c.json({ result: publicUrlJson(deps, link) });
  } catch (err) {
    if (!(err instanceof ConditionFailedError)) throw err;
    // Active link already exists -> return it (museum ErrActiveLinkAlreadyExists).
    const existing = await getLinkForCollection(deps, body.collectionID);
    if (!existing) throw err; // truly unexpected state (museum 500s too)
    return c.json({ result: publicUrlJson(deps, existing) });
  }
};
