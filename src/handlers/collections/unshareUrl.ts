/**
 * DELETE /collections/share-url/:collectionID (auth) — src: pkg/api/
 * collection.go UnShareURL + pkg/controller/collections/share.go
 * DisableSharedURL + pkg/controller/public/collection_link.go Disable.
 * Owner-only; disables every active link for the collection (this schema
 * holds at most one); response is a BARE 200 with an empty body (museum
 * c.Status(http.StatusOK) — NOT the collection JSON), including when no
 * active link existed (upstream's UPDATE just matches zero rows). The
 * disabled token row stays dead at rest forever; a later share-url mints a
 * NEW token (plan §4.3).
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { bumpCollectionForward, resolveCollectionAccess } from '../../domain/collections.ts';
import { disableLink } from '../../domain/sharing.ts';
import { errBadRequestSentinel } from '../../lib/errors.ts';

export const unshareUrl = (deps: Deps) => async (c: Context) => {
  const collectionId = Number.parseInt(c.req.param('collectionID') ?? '', 10);
  if (!Number.isFinite(collectionId)) throw errBadRequestSentinel();
  const { userId } = auth(c);
  await resolveCollectionAccess(deps, userId, collectionId, {
    verifyOwner: true,
    includeDeleted: true, // museum verifyOwnership has no deleted filter
  });
  const disabled = await disableLink(deps, collectionId);
  // Museum's disable is an UPDATE on public_collection_tokens, so the
  // collection-restamp trigger fires — the feed re-emits with publicURLs []
  // and synced devices drop the link (D62). No active link -> nothing fired.
  if (disabled) await bumpCollectionForward(deps, collectionId, deps.ids.nextUpdationTime());
  return c.body(null, 200);
};
