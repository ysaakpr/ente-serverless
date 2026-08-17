/**
 * POST /collections/rename + PUT /collections/magic-metadata (+ public) —
 * opaque ciphertext updates, owner-only, updationTime bump into
 * /collections/v2. Museum currently skips the version check on collection
 * magic metadata (noted "todo" in collection.go) — mirrored.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { bumpCollection, getOwnedCollection } from '../../domain/collections.ts';

const renameSchema = z.object({
  collectionID: z.number(),
  encryptedName: z.string().min(1),
  nameDecryptionNonce: z.string().min(1),
});

export const renameCollection = (deps: Deps) => async (c: Context) => {
  const body = renameSchema.parse(await c.req.json());
  const { userId } = auth(c);
  const row = await getOwnedCollection(deps, userId, body.collectionID, { includeDeleted: true });
  await bumpCollection(deps, row, {
    encryptedName: body.encryptedName,
    nameDecryptionNonce: body.nameDecryptionNonce,
  });
  return c.body(null, 200);
};

const magicSchema = z.object({
  id: z.number(),
  magicMetadata: z.object({
    version: z.number(),
    count: z.number(),
    data: z.string(),
    header: z.string(),
  }),
});

export const updateCollectionMagicMetadata = (deps: Deps, isPublic: boolean) => async (c: Context) => {
  const body = magicSchema.parse(await c.req.json());
  const { userId } = auth(c);
  const row = await getOwnedCollection(deps, userId, body.id, { includeDeleted: true });
  const attr = isPublic ? 'pubMagicMetadata' : 'magicMetadata';
  await bumpCollection(deps, row, {
    [attr]: { ...body.magicMetadata, version: body.magicMetadata.version + 1 },
  });
  return c.body(null, 200);
};
