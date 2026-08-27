/**
 * GET /collections/sharees?collectionID= (auth) — src: pkg/api/collection.go
 * GetSharees + pkg/controller/collections/share.go GetSharees. Any member may
 * list (museum resolves access with no VerifyOwner); response
 * {"sharees": [CollectionUser...]}. Museum ignores the parse error (a bad id
 * becomes 0), so the access check turns garbage input into 404.
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { resolveCollectionAccess, shareesJson } from '../../domain/collections.ts';

export const getCollectionSharees = (deps: Deps) => async (c: Context) => {
  const collectionId = Number.parseInt(c.req.query('collectionID') ?? '0', 10) || 0;
  const { userId } = auth(c);
  await resolveCollectionAccess(deps, userId, collectionId);
  return c.json({ sharees: await shareesJson(deps, collectionId) });
};
