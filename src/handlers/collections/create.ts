/**
 * POST /collections (auth) — src: pkg/controller/collections/collection.go
 * Create. Response {"collection": Collection}. Duplicate favorites /
 * uncategorized returns the existing row (200).
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import {
  collectionToJson,
  findCollectionByType,
  newCollectionRow,
  putCollection,
  VALID_COLLECTION_TYPES,
} from '../../domain/collections.ts';
import { getKeyAttributes } from '../../domain/users.ts';
import { errNotFound, SentinelError } from '../../lib/errors.ts';

const magicSchema = z.object({
  version: z.number(),
  count: z.number(),
  data: z.string(),
  header: z.string(),
});

const bodySchema = z.object({
  encryptedKey: z.string().min(1),
  keyDecryptionNonce: z.string().min(1),
  encryptedName: z.string().optional(),
  nameDecryptionNonce: z.string().optional(),
  type: z.string().min(1),
  attributes: z.record(z.unknown()).optional(),
  magicMetadata: magicSchema.optional(),
  app: z.string().optional(),
});

export const createCollection = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
  const { userId, app } = auth(c);

  if ((await getKeyAttributes(deps, userId)) === null) throw errNotFound(); // museum: keyAttributes required

  // museum patch for old mobile clients
  let type = body.type === 'CollectionType.album' ? 'album' : body.type;
  if (!VALID_COLLECTION_TYPES.includes(type)) {
    throw new SentinelError(500, `unexpected collection type ${type}`); // plain error -> 500
  }

  if (type === 'favorites' || type === 'uncategorized') {
    const existing = await findCollectionByType(deps, userId, type, app);
    if (existing) return c.json({ collection: await collectionToJson(deps, existing) });
  }

  const row = await putCollection(deps, newCollectionRow(deps, userId, app, { ...body, type }));
  return c.json({ collection: await collectionToJson(deps, row) });
};
