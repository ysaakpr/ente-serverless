/**
 * POST /users/srp/verify-session — src: VerifySRPSessionRequest ->
 * EmailAuthorizationResponse + srpM2.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { appFromClientPackage } from '../../domain/apps.ts';
import { keys } from '../../domain/model.ts';
import { verifySrpSession } from '../../domain/srpSessions.ts';
import { FAKE_VERIFIER_B64 } from '../../domain/srp.ts';
import { onVerificationSuccess } from '../../domain/verification.ts';
import { getUser } from '../../domain/users.ts';
import { clientIp } from '../../lib/ip.ts';
import { errInvalidPassword } from '../../lib/errors.ts';

const bodySchema = z.object({
  sessionID: z.string().uuid(),
  srpUserID: z.string().uuid(),
  srpM1: z.string(),
});

export const verifySrpSessionHandler = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());

  const guard = await deps.db.get(keys.srpUserGuard(body.srpUserID).pk, 'META');
  if (!guard) {
    // Unknown srpUserID: run the fake handshake so timing/shape match, then fail.
    await verifySrpSession(deps, FAKE_VERIFIER_B64, body.sessionID, body.srpM1);
    throw errInvalidPassword();
  }

  const userId = guard.userId as number;
  const srp = await deps.db.get(keys.userSrp(userId).pk, 'SRP');
  if (!srp) throw errInvalidPassword();

  const srpM2 = await verifySrpSession(deps, srp.verifier as string, body.sessionID, body.srpM1);

  const user = await getUser(deps, userId);
  if (!user) throw errInvalidPassword();

  const response = await onVerificationSuccess(deps, user.email, {
    app: appFromClientPackage(c.req.header('X-Client-Package')),
    ip: clientIp(c),
    ua: c.req.header('user-agent') ?? '',
  });
  return c.json({ ...response, srpM2 });
};
