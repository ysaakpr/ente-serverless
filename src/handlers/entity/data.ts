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
import { assertEntityType, RESTORABLE_ENTITY_TYPES } from './key.ts';
import { ApiError, badRequest, errBadRequestSentinel, errNotFound, SentinelError } from '../../lib/errors.ts';

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

/** museum EntityDataRequest.IsValid for LibraryShare: `ls_<owner>_<recipient>`
 * where owner is the caller, recipient a positive id other than the caller,
 * and the string is canonical (no sign, no leading zeros). */
const assertLibraryShareId = (id: string | null | undefined, userId: number): void => {
  if (!id) throw badRequest('ID is required for LibraryShare entity type');
  const m = /^ls_(\d+)_(\d+)$/.exec(id);
  const owner = m ? Number(m[1]) : NaN;
  const recipient = m ? Number(m[2]) : NaN;
  if (
    !m ||
    owner !== userId ||
    !(recipient > 0) ||
    recipient === userId ||
    id !== `ls_${owner}_${recipient}`
  ) {
    throw badRequest(`ID ${id} is not valid for LibraryShare entity type`);
  }
};

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
  if (body.type === 'library_share') assertLibraryShareId(body.id, userId);
  const id = body.id ?? `${body.type}_${deps.rand.uuid()}`;
  const key = keys.entity(userId, body.type, id);

  // museum repo createOrRestoreDeleted (restorable types): a tombstoned id is
  // revived in place — createdAt kept — and a LIVE one is 409 ALREADY_EXISTS.
  let createdAt = deps.clock.nowMicros();
  if (RESTORABLE_ENTITY_TYPES.includes(body.type)) {
    const existing = await deps.db.get<EntityRow>(key.pk, key.sk);
    if (existing && !existing.isDeleted) {
      throw new ApiError('ALREADY_EXISTS', 409, 'Entity already exists');
    }
    if (existing) createdAt = existing.createdAt;
  }
  const row = stamp(deps, userId, {
    ...key,
    id,
    type: body.type,
    encryptedData: body.encryptedData,
    header: body.header,
    isDeleted: false,
    createdAt,
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
  // museum UpdateEntityDataRequest.ExpectedUpdatedAt (upstream e77dbe548b):
  // optimistic concurrency, mandatory for library_share.
  expectedUpdatedAt: z.number().nullish(),
});

export const updateEntity = (deps: Deps) => async (c: Context) => {
  const body = updateSchema.parse(await c.req.json());
  assertEntityType(body.type);
  if (body.type === 'library_share' && !(body.expectedUpdatedAt && body.expectedUpdatedAt > 0)) {
    throw badRequest('expectedUpdatedAt is required for LibraryShare entity type');
  }
  const { userId } = auth(c);

  const key = keys.entity(userId, body.type, body.id);
  const existing = await deps.db.get<EntityRow>(key.pk, key.sk);
  if (!existing) throw errNotFound();
  if (existing.isDeleted) throw badRequest('entity is already deleted');
  const expected = body.expectedUpdatedAt;
  if (expected != null && existing.updatedAt !== expected) {
    // museum repo Update: a no-op retry of the same write still succeeds;
    // any other stale write is ErrVersionMismatch (bare 409).
    if (existing.encryptedData === body.encryptedData && existing.header === body.header) {
      return c.json(entityJson(userId, existing));
    }
    throw new SentinelError(409, 'client version is out of sync');
  }

  const row = stamp(deps, userId, {
    ...existing,
    encryptedData: body.encryptedData,
    header: body.header,
  });
  // Read-then-write, not a conditional put: two writers racing on the same
  // version inside one round-trip can both land (museum's `AND updated_at =
  // $6` cannot). The Db port has no conditional put; the window is one
  // request wide on a per-user row (D66).
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
  // SECURITY-REVIEW-2 F5: reject a non-finite limit. `?limit=abc` parses to
  // NaN, and both `NaN <= 0` and `NaN > 5000` are false, so without this the
  // guard is skipped and NaN flows into query(), disabling the page Limit and
  // draining the whole USER#<id>#ENT#<type> partition.
  if (!Number.isFinite(limit) || limit <= 0 || limit > 5000) {
    throw errBadRequest(); // museum: ShouldBindQuery failure -> bare-{} ErrBadRequest
  }
  const { userId } = auth(c);
  const sinceTime = Number.parseInt(sinceTimeRaw, 10) || 0;

  const rows = await deps.db.query<EntityRow>(gsi.entityDiff(userId, type), {
    index: 'gsi3',
    skFrom: padTime(sinceTime + 1),
    limit,
  });
  return c.json({ diff: rows.map((r) => entityJson(userId, r)) });
};

const errBadRequest = () => errBadRequestSentinel();
