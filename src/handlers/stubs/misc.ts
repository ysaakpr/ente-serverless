/**
 * [BONUS-STUB] GET /storage-bonus/details — zeros.
 * [PUSH-STUB] POST /push/token — store-and-ignore.
 * [CONFIG-STUB] POST /users/event — accept-and-drop.
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';

export const storageBonusDetails = (_deps: Deps) => async (c: Context) =>
  c.json({
    storageBonuses: [],
    refStats: null,
    hasAppliedCode: false,
  });

export const pushToken = (deps: Deps) => async (c: Context) => {
  const { userId } = auth(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  await deps.db.put({ pk: `USER#${userId}`, sk: 'PUSHTOKEN', ...body });
  return c.json({});
};

export const reportEvent = (_deps: Deps) => async (c: Context) => {
  await c.req.json().catch(() => ({}));
  return c.body(null, 200);
};
