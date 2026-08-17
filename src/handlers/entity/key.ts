/**
 * POST /user-entity/key · POST /user-entity/key/ensure · GET /user-entity/key
 * — src: ente/userentity/entity.go + pkg/repo/userentity/key.go.
 * Duplicate create with the SAME material is a 200 no-op; different material
 * is 409 ALREADY_EXISTS "Key already exists".
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { keys } from '../../domain/model.ts';
import { badRequest, errNotFound, ApiError } from '../../lib/errors.ts';

export const ENTITY_TYPES = ['location', 'person', 'cgroup', 'smart_album', 'memory', 'contact', 'space'];

const keySchema = z.object({
  type: z.string(),
  encryptedKey: z.string().min(1),
  header: z.string().min(1),
});

export const assertEntityType = (type: string): void => {
  if (!ENTITY_TYPES.includes(type)) throw badRequest(`Invalid EntityType: ${type}`);
};

const keyJson = (userId: number, row: Record<string, unknown>) => ({
  userID: userId,
  type: row.type,
  encryptedKey: row.encryptedKey,
  header: row.header,
  createdAt: row.createdAt,
});

export const createEntityKey = (deps: Deps) => async (c: Context) => {
  const body = keySchema.parse(await c.req.json());
  assertEntityType(body.type);
  const { userId } = auth(c);

  const key = keys.entityKey(userId, body.type);
  const existing = await deps.db.get(key.pk, key.sk);
  if (existing) {
    if (existing.encryptedKey === body.encryptedKey && existing.header === body.header) {
      return c.body(null, 200);
    }
    throw new ApiError('ALREADY_EXISTS', 409, 'Key already exists');
  }
  await deps.db.put({
    ...key,
    type: body.type,
    encryptedKey: body.encryptedKey,
    header: body.header,
    createdAt: deps.clock.nowMicros(),
  });
  return c.body(null, 200);
};

export const ensureEntityKey = (deps: Deps) => async (c: Context) => {
  const body = keySchema.parse(await c.req.json());
  assertEntityType(body.type);
  const { userId } = auth(c);

  const key = keys.entityKey(userId, body.type);
  let row = await deps.db.get(key.pk, key.sk);
  if (!row) {
    row = {
      ...key,
      type: body.type,
      encryptedKey: body.encryptedKey,
      header: body.header,
      createdAt: deps.clock.nowMicros(),
    };
    await deps.db.put(row);
  }
  c.header('Cache-Control', 'no-store');
  return c.json(keyJson(userId, row));
};

export const getEntityKey = (deps: Deps) => async (c: Context) => {
  const type = c.req.query('type');
  if (!type) throw badRequest('type required');
  const { userId } = auth(c);
  const key = keys.entityKey(userId, type);
  const row = await deps.db.get(key.pk, key.sk);
  if (!row) throw errNotFound();
  return c.json(keyJson(userId, row));
};
