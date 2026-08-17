/**
 * POST /users/verify-email — src: ente/user.go EmailVerificationRequest ->
 * EmailAuthorizationResponse; pkg/controller/user/userauth.go VerifyEmail.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { appFromClientPackage } from '../../domain/apps.ts';
import { emailHash, normalizeEmail } from '../../domain/tokens.ts';
import { consumeOtt } from '../../domain/ott.ts';
import { onVerificationSuccess } from '../../domain/verification.ts';

const bodySchema = z.object({
  email: z.string().min(1),
  ott: z.string().min(1),
  source: z.string().nullish(),
});

export const verifyEmail = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
  const email = normalizeEmail(body.email);
  const app = appFromClientPackage(c.req.header('X-Client-Package'));

  await consumeOtt(deps, emailHash(email, deps.hashingKey), app, body.ott);

  const response = await onVerificationSuccess(deps, email, {
    app,
    ip: c.req.header('x-forwarded-for') ?? '',
    ua: c.req.header('user-agent') ?? '',
  });
  return c.json(response);
};
