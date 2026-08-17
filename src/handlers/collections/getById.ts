/**
 * GET /collections/:collectionID (auth) — src: pkg/api/collection.go
 * GetCollectionByID: {"collection": Collection}, deleted collections
 * included (museum passes IncludeDeleted: true). The app resolves trash-diff
 * collectionIDs through this (gate finding D28).
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { collectionToJson, getOwnedCollection } from '../../domain/collections.ts';
import { errBadRequestSentinel } from '../../lib/errors.ts';

export const getCollectionById = (deps: Deps) => async (c: Context) => {
  const collectionId = Number.parseInt(c.req.param('collectionID') ?? '', 10);
  if (!Number.isFinite(collectionId)) throw errBadRequestSentinel();
  const { userId } = auth(c);

  const row = await getOwnedCollection(deps, userId, collectionId, { includeDeleted: true });
  return c.json({ collection: await collectionToJson(deps, row) });
};
