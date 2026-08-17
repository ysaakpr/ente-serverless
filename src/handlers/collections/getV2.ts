/**
 * GET /collections/v2?sinceTime=T (auth) — {"collections":[...]} — owned (+
 * shared post-core), changed strictly after T, tombstones included.
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { collectionToJson, listUserCollections } from '../../domain/collections.ts';

export const getCollectionsV2 = (deps: Deps) => async (c: Context) => {
  const { userId, app } = auth(c);
  const sinceTime = Number.parseInt(c.req.query('sinceTime') ?? '0', 10) || 0;

  const rows = (await listUserCollections(deps, userId, sinceTime)).filter((r) => r.app === app);
  const collections = await Promise.all(rows.map((r) => collectionToJson(deps, r)));
  return c.json({ collections });
};
