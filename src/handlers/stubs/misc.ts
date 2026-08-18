/**
 * [BONUS-STUB] GET /storage-bonus/details — zeros.
 * [PUSH-STUB] POST /push/token — store-and-ignore.
 * [CONFIG-STUB] POST /users/event — accept-and-drop.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { keys } from '../../domain/model.ts';

export const storageBonusDetails = (_deps: Deps) => async (c: Context) =>
  c.json({
    storageBonuses: [],
    refStats: null,
    hasAppliedCode: false,
  });

// SECURITY-REVIEW-2 F1: the body is whitelisted through a strict zod object
// (unknown keys are stripped) and the key is built server-side, so a client
// can no longer smuggle `pk`/`sk` (or any other attribute) into the write and
// overwrite an arbitrary row. Museum's push registration carries only these
// device-token fields, and the row is never read back, so stripping the rest
// is behaviour-neutral. NEVER spread raw `c.req.json()` into a `db.put`.
const pushSchema = z.object({
  fcmToken: z.string().optional(),
  apnsToken: z.string().optional(),
  pushToken: z.string().optional(),
});

export const pushToken = (deps: Deps) => async (c: Context) => {
  const { userId } = auth(c);
  const body = pushSchema.parse(await c.req.json().catch(() => ({})));
  await deps.db.put({ ...keys.pushToken(userId), ...body });
  return c.json({});
};

export const reportEvent = (_deps: Deps) => async (c: Context) => {
  await c.req.json().catch(() => ({}));
  return c.body(null, 200);
};
