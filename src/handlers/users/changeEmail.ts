/**
 * POST /users/change-email (auth) — src: userauth.go ChangeEmail: verify the
 * OTT sent to the NEW address (purpose=change), then re-point the account.
 * 200 empty on success; 403 when the address already belongs to a user.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { appFromClientPackage } from '../../domain/apps.ts';
import { emailHash, normalizeEmail } from '../../domain/tokens.ts';
import { consumeOtt } from '../../domain/ott.ts';
import { getUser, getUserIdByEmail } from '../../domain/users.ts';
import { keys } from '../../domain/model.ts';
import { errNotFound, errPermissionDenied } from '../../lib/errors.ts';

const bodySchema = z.object({ email: z.string().min(1), ott: z.string().min(1) });

export const changeEmail = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
  const { userId } = auth(c);
  const email = normalizeEmail(body.email);
  const app = appFromClientPackage(c.req.header('X-Client-Package'));

  await consumeOtt(deps, emailHash(email, deps.hashingKey), app, body.ott);

  const existing = await getUserIdByEmail(deps, email);
  if (existing !== null && existing !== userId) throw errPermissionDenied();

  const user = await getUser(deps, userId);
  if (!user) throw errNotFound();

  const newHash = emailHash(email, deps.hashingKey);
  await deps.db.transactWrite([
    { kind: 'delete', key: keys.emailGuard(user.emailHash) },
    { kind: 'put', ifNotExists: true, item: { ...keys.emailGuard(newHash), userId } },
    { kind: 'put', item: { ...user, email, emailHash: newHash } },
  ]);
  return c.body(null, 200);
};
