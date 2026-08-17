/**
 * POST /users/ott — src: ente/user.go SendOTTRequest +
 * pkg/controller/user/userauth.go SendEmailOTT / validateSendOTT.
 *
 * Disclosure semantics (verified in source, correcting the build plan's
 * anti-enumeration guess): signup+existing -> 409 USER_ALREADY_REGISTERED,
 * login+missing -> 404 USER_NOT_REGISTERED, login+incomplete -> 404
 * USER_SIGNUP_INCOMPLETE. (Museum swallows these only past an abuse
 * rate-limit.) Success: 200 with EMPTY body (c.Status).
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { appFromClientPackage } from '../../domain/apps.ts';
import { emailHash, normalizeEmail } from '../../domain/tokens.ts';
import { getSignUpState, getUserIdByEmail } from '../../domain/users.ts';
import { generateOttCode, storeOtt } from '../../domain/ott.ts';
import {
  errPermissionDenied,
  userAlreadyRegistered,
  userNotRegistered,
  userSignupIncomplete,
} from '../../lib/errors.ts';

const bodySchema = z.object({
  email: z.string().min(1),
  purpose: z.string().optional().default(''),
  client: z.string().optional(),
  mobile: z.boolean().optional().default(false),
});

export const sendOtt = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
  const email = normalizeEmail(body.email);
  const app = appFromClientPackage(c.req.header('X-Client-Package'));

  if (body.purpose === 'change') {
    if ((await getUserIdByEmail(deps, email)) !== null) throw errPermissionDenied();
  } else {
    const state = await getSignUpState(deps, email);
    if (body.purpose === 'signup' && state === 'complete') throw userAlreadyRegistered();
    if (body.purpose === 'login' && state === 'noAccount') throw userNotRegistered();
    if (body.purpose === 'login' && state === 'incomplete') throw userSignupIncomplete();
  }

  let code = generateOttCode(deps);
  const { hardcodedOttSuffix, hardcodedOttValue } = deps.config;
  const hardcoded =
    body.purpose !== 'change' &&
    hardcodedOttSuffix &&
    hardcodedOttValue &&
    email.endsWith(hardcodedOttSuffix);
  if (hardcoded) code = hardcodedOttValue!;

  await storeOtt(deps, emailHash(email, deps.hashingKey), app, code);

  if (hardcoded) {
    console.info(`Added hard coded ott for ${email} : ${code}`);
  } else {
    await deps.mail.send({
      to: email,
      from: deps.config.mailFrom,
      fromName: deps.config.mailFromName,
      subject: `Verification code: ${code}`,
      templateName: body.purpose === 'change' ? 'ott_change_email.html' : 'ott.html',
      templateData: { VerificationCode: code },
    });
  }

  return c.body(null, 200);
};
