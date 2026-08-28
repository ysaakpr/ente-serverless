/**
 * POST /public-collection/verify-password (link auth; password-whitelisted in
 * the middleware, obviously) — src: pkg/api/public_collection.go
 * VerifyPassword + pkg/controller/public/link_common.go verifyPassword.
 *
 * The password NEVER travels: the client derives passHash from the password
 * with the link's stored argon2id params (nonce/memLimit/opsLimit from /info)
 * and sends the HASH; the server compares it against the stored passHash —
 * constant-time here — and on match issues a 30-day HS256 JWT
 * (LinkPasswordClaim {passKey, expiryTime}) the middleware later checks in
 * X-Auth-Access-Token-JWT. Shapes: body {passHash} (binding:required -> bare
 * 400 when missing), password not configured -> bare 400, wrong hash -> bare
 * 401 (ErrInvalidPassword), match -> {"jwtToken": s}.
 *
 * Divergence (plan §4.1c, D51): a per-(link, ip) wrong-attempt cap in the OTT
 * style — 20 wrong hashes per sliding hour -> 429 {} — where museum leans on
 * its per-IP edge rate limiter this stack does not have.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { publicAccess } from '../../middleware/publicAccess.ts';
import {
  assertPasswordAttempts,
  issuePasswordJwt,
  passHashEquals,
  recordPasswordAttempt,
} from '../../domain/publicLinks.ts';
import { errBadRequestSentinel, errInvalidPassword } from '../../lib/errors.ts';

const bodySchema = z.object({ passHash: z.string().min(1) });

export const publicVerifyPassword = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
  const { link, ip } = publicAccess(c);
  if (!link.passHash) throw errBadRequestSentinel(); // password not configured

  await assertPasswordAttempts(deps, link.tokenHash, ip); // cheap-fail at the cap
  if (!passHashEquals(body.passHash, link.passHash)) {
    await recordPasswordAttempt(deps, link.tokenHash, ip); // throws 429 past the cap
    throw errInvalidPassword();
  }
  return c.json({ jwtToken: issuePasswordJwt(deps, link.passHash) });
};
