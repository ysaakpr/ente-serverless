/**
 * POST /users/srp/create-session — src: CreateSRPSessionRequest.
 * Unknown srpUserID gets a persisted FAKE session (anti-enumeration,
 * pkg/controller/user/srp.go fCreateSession).
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { keys } from '../../domain/model.ts';
import { createAndInsertSrpSession } from '../../domain/srpSessions.ts';
import { ApiError } from '../../lib/errors.ts';

const bodySchema = z.object({
  srpUserID: z.string().uuid(),
  srpA: z.string().min(1),
});

export const createSrpSession = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());

  const guard = await deps.db.get(keys.srpUserGuard(body.srpUserID).pk, 'META');
  if (!guard) {
    const fake = await createAndInsertSrpSession(deps, body.srpUserID, '', body.srpA, true);
    return c.json({ sessionID: fake.sessionID, srpB: fake.srpB });
  }

  const srp = await deps.db.get(keys.userSrp(guard.userId as number).pk, 'SRP');
  if (!srp) {
    const fake = await createAndInsertSrpSession(deps, body.srpUserID, '', body.srpA, true);
    return c.json({ sessionID: fake.sessionID, srpB: fake.srpB });
  }

  // Email MFA forces the OTT path (srp.go CreateSrpSession).
  const user = await deps.db.get(keys.user(guard.userId as number).pk, 'META');
  if (user?.isEmailMFAEnabled === true) {
    throw new ApiError('EMAIL_MFA_ENABLED', 409, 'Email MFA is enabled');
  }

  const { sessionID, srpB } = await createAndInsertSrpSession(
    deps,
    body.srpUserID,
    srp.verifier as string,
    body.srpA,
  );
  return c.json({ sessionID, srpB });
};
