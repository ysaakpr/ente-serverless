/**
 * POST/PUT/DELETE /user-entity/entity + GET /user-entity/entity/diff —
 * generic encrypted KV with per-type diff feed and tombstone discipline
 * (src: ente/userentity/entity.go, pkg/api/userentity.go).
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { keys, gsi, padTime } from '../../domain/model.ts';
import { assertEntityType } from './key.ts';
import { badRequest, errNotFound } from '../../lib/errors.ts';

interface EntityRow {
  pk: string;
  sk: string;
  id: string;
  type: string;
  encryptedData: string | null;
  header: string | null;
  isDeleted: boolean;
  createdAt: number;
  updatedAt: number;
  gsi3pk: string;
  gsi3sk: string;
  [attr: string]: unknown;
}

const entityJson = (userId: number, row: EntityRow) => ({
  id: row.id,
  userID: userId,
  type: row.type,
  encryptedData: row.encryptedData,
  header: row.header,
  isDeleted: row.isDeleted,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const stamp = (deps: Deps, userId: number, row: EntityRow): EntityRow => {
  const updatedAt = deps.ids.nextUpdationTime();
  return { ...row, updatedAt, gsi3sk: `${padTime(updatedAt)}#${row.id}` };
};

const createSchema = z.object({
  type: z.string(),
  encryptedData: z.string().min(1),
  header: z.string().min(1),
  id: z.string().nullish(),
});

export const createEntity = (deps: Deps) => async (c: Context) => {
  const body = createSchema.parse(await c.req.json());
  assertEntityType(body.type);
  const { userId } = auth(c);

  if (body.type === 'smart_album') {
    if (!body.id) throw badRequest('ID is required for SmartAlbum entity type');
    if (!body.id.startsWith(`sa_${userId}_`)) {
      throw badRequest(`ID ${body.id} is not valid for SmartAlbum entity type`);
    }
  }
  const id = body.id ?? `${body.type}_${deps.rand.uuid()}`;
  const now = deps.clock.nowMicros();
  const row = stamp(deps, userId, {
    ...keys.entity(userId, body.type, id),
    id,
    type: body.type,
    encryptedData: body.encryptedData,
    header: body.header,
    isDeleted: false,
    createdAt: now,
    updatedAt: 0,
    gsi3pk: gsi.entityDiff(userId, body.type),
    gsi3sk: '',
  });
  await deps.db.put(row);
  return c.json(entityJson(userId, row));
};

const updateSchema = z.object({
  id: z.string().min(1),
  type: z.string(),
  encryptedData: z.string().min(1),
  header: z.string().min(1),
});

export const updateEntity = (deps: Deps) => async (c: Context) => {
  const body = updateSchema.parse(await c.req.json());
  assertEntityType(body.type);
  const { userId } = auth(c);

  const key = keys.entity(userId, body.type, body.id);
  const existing = await deps.db.get<EntityRow>(key.pk, key.sk);
  if (!existing || existing.isDeleted) throw errNotFound();

  const row = stamp(deps, userId, {
    ...existing,
    encryptedData: body.encryptedData,
    header: body.header,
  });
  await deps.db.put(row);
  return c.json(entityJson(userId, row));
};

export const deleteEntity = (deps: Deps) => async (c: Context) => {
  const id = c.req.query('id');
  if (!id) throw badRequest('id required');
  const { userId } = auth(c);

  // The id embeds no type; scan the user's entity partitions (small N of types).
  const { ENTITY_TYPES } = await import('./key.ts');
  for (const type of ENTITY_TYPES) {
    const key = keys.entity(userId, type, id);
    const existing = await deps.db.get<EntityRow>(key.pk, key.sk);
    if (existing && !existing.isDeleted) {
      const row = stamp(deps, userId, { ...existing, isDeleted: true, encryptedData: null, header: null });
      await deps.db.put(row);
      break;
    }
  }
  return c.body(null, 200);
};

export const entityDiff = (deps: Deps) => async (c: Context) => {
  const type = c.req.query('type');
  const sinceTimeRaw = c.req.query('sinceTime');
  const limit = Number.parseInt(c.req.query('limit') ?? '0', 10);
  if (!type || sinceTimeRaw === undefined) throw errBadRequest();
  if (limit <= 0 || limit > 5000) throw badRequest('limit must be between 1 and 5000');
  const { userId } = auth(c);
  const sinceTime = Number.parseInt(sinceTimeRaw, 10) || 0;

  const rows = await deps.db.query<EntityRow>(gsi.entityDiff(userId, type), {
    index: 'gsi3',
    skFrom: padTime(sinceTime + 1),
    limit,
  });
  return c.json({ diff: rows.map((r) => entityJson(userId, r)) });
};

const errBadRequest = () => badRequest('Request binding failed');
