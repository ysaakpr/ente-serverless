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
import { getKeyAttributes, getUser } from '../../domain/users.ts';
import { errNotFound, errPermissionDenied, SentinelError } from '../../lib/errors.ts';

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
  } else {
    // Viewer gate (D54, off-parity): viewer accounts don't create albums or
    // folders — 403 {} (errPermissionDenied), museum's family for a role that
    // may not act (a VIEWER sharee renaming gets the same). The SPECIAL types
    // above are deliberately exempt: the stock apps auto-create favorites on
    // the first favorite tap and uncategorized when a file leaves its last
    // album — both metadata-only rows costing zero storage — and blocking
    // them breaks a viewer's legitimate consume-a-share loop (favoriting a
    // shared photo). Their duplicate-create path returns the existing row
    // before this gate on purpose.
    const user = await getUser(deps, userId);
    if (user?.viewer) throw errPermissionDenied();
  }

  const row = await putCollection(deps, newCollectionRow(deps, userId, app, { ...body, type }));
  return c.json({ collection: await collectionToJson(deps, row) });
};
