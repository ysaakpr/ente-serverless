/**
 * [CONFIG-STUB] GET /remote-store · POST /remote-store/update ·
 * GET /remote-store/feature-flags — real per-user KV (it's trivial), flag
 * shape from ente/remotestore.go FeatureFlagResponse. Defaults are
 * capture-gated (DECISIONS.md D2) but shaped from source.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { keys } from '../../domain/model.ts';
import { badRequest, errNotFound } from '../../lib/errors.ts';

const boolFlag = async (deps: Deps, userId: number, key: string): Promise<boolean> => {
  const row = await deps.db.get(keys.remoteStore(userId, key).pk, `STORE#${key}`);
  return row?.value === 'true';
};

export const getRemoteStoreValue = (deps: Deps) => async (c: Context) => {
  const key = c.req.query('key');
  const defaultValue = c.req.query('defaultValue');
  if (!key) throw badRequest('key required');
  const { userId } = auth(c);

  const row = await deps.db.get(keys.remoteStore(userId, key).pk, `STORE#${key}`);
  if (!row) {
    if (defaultValue !== undefined) return c.json({ value: defaultValue });
    throw errNotFound();
  }
  return c.json({ value: row.value });
};

const updateSchema = z.object({ key: z.string().min(1), value: z.string() });

export const updateRemoteStoreValue = (deps: Deps) => async (c: Context) => {
  const body = updateSchema.parse(await c.req.json());
  const { userId } = auth(c);
  await deps.db.put({ ...keys.remoteStore(userId, body.key), value: body.value });
  return c.body(null, 200);
};

export const SERVER_API_FLAG = (1 << 0) | (1 << 2) | (1 << 3);

export const getFeatureFlags = (deps: Deps) => async (c: Context) => {
  const { userId } = auth(c);
  return c.json({
    enableStripe: false,
    disableCFWorker: true,
    mapEnabled: await boolFlag(deps, userId, 'mapEnabled'),
    faceSearchEnabled: await boolFlag(deps, userId, 'faceSearchEnabled'),
    passKeyEnabled: false,
    recoveryKeyVerified: await boolFlag(deps, userId, 'recoveryKeyVerified'),
    internalUser: false,
    betaUser: false,
    enableMobMultiPart: true,
    // Only the bits this server can honour (D66): UploadV2 (1<<0, unread by
    // current clients), BackupOptions (1<<2, unread by Photos), and
    // VideoStreaming (1<<3 — mobile streams videos by default; the
    // vid_preview path is implemented). Comments, CastSessionsV2,
    // LibrarySharing and PreviewUploadV2 stay off: their routes are stubs or
    // absent. Museum main sends 239 (+256 for internal users).
    serverApiFlag: SERVER_API_FLAG,
    castUrl: '',
    embedUrl: '',
  });
};
