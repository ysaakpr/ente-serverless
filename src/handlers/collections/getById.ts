/**
 * GET /collections/:collectionID (auth) — src: pkg/api/collection.go
 * GetCollectionByID: {"collection": Collection}, deleted collections
 * included (museum passes IncludeDeleted: true). The app resolves trash-diff
 * collectionIDs through this (gate finding D28). Sharees receive THEIR
 * wrapped key in encryptedKey (museum GetWithSharingDetailsForUser swaps in
 * collection_shares.encrypted_key; the collection's own keyDecryptionNonce
 * rides along unchanged — a sealed box needs no nonce), and everyone gets the
 * full sharee list.
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { collectionToJson, resolveCollectionAccess, shareesJson } from '../../domain/collections.ts';
import { getSharee } from '../../domain/sharing.ts';
import { errBadRequestSentinel, errNotFound } from '../../lib/errors.ts';

export const getCollectionById = (deps: Deps) => async (c: Context) => {
  const collectionId = Number.parseInt(c.req.param('collectionID') ?? '', 10);
  if (!Number.isFinite(collectionId)) throw errBadRequestSentinel();
  const { userId } = auth(c);

  // Any member may read — museum GetCollection (collections/collection.go)
  // resolves access for OWNER, COLLABORATOR and VIEWER alike, deleted included.
  const { collection, role } = await resolveCollectionAccess(deps, userId, collectionId, {
    includeDeleted: true,
  });

  let row = collection;
  if (role !== 'OWNER') {
    const share = await getSharee(deps, collectionId, userId);
    if (!share) throw errNotFound(); // race: unshared between the two reads
    row = { ...collection, encryptedKey: share.encryptedKey };
  }
  return c.json({
    collection: await collectionToJson(deps, row, {
      sharees: await shareesJson(deps, collectionId),
    }),
  });
};
