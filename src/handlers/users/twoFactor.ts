/**
 * [AUTH-2FA] TOTP two-factor — src: pkg/api/user.go + controller/user/
 * two_factor.go. Every shape below is from the 2026-08-17 oracle capture
 * (D36); nothing here is guessed:
 *
 *   POST /users/two-factor/setup     auth  -> {secretCode, qrCode}
 *   POST /users/two-factor/enable    auth  -> 200, EMPTY body (401 {} on a
 *                                              wrong code)
 *   POST /users/two-factor/verify    public {sessionID, code}
 *                                    -> {id, keyAttributes, encryptedToken}
 *                                       (401 {} on a wrong code)
 *   GET  /users/two-factor/recover   public ?sessionID=
 *                                    -> {encryptedSecret, secretDecryptionNonce}
 *   POST /users/two-factor/remove    public {sessionID, secret}
 *                                    -> {id, keyAttributes, encryptedToken}
 *                                       (403 {} on a wrong secret)
 *   POST /users/two-factor/disable   auth  -> 200, EMPTY body
 *
 * Note the three login-shaped responses carry ONLY id/keyAttributes/
 * encryptedToken — none of the passkeySessionID/accountsUrl padding that
 * verify-email and verify-session emit.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import QRCode from 'qrcode';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { appFromClientPackage } from '../../domain/apps.ts';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../../domain/totp.ts';
import {
  consumeTwoFactorSession,
  disableTwoFactor as clearTwoFactor,
  enableTwoFactor as storeTwoFactor,
  getPendingSecret,
  getTwoFactor,
  putPendingSecret,
  resolveTwoFactorSession,
} from '../../domain/twoFactor.ts';
import { getKeyAttributes, getUser, tokenRow } from '../../domain/users.ts';
import { encryptToken, generateToken, tokenHash } from '../../domain/tokens.ts';
import {
  errBadRequestSentinel,
  errInvalidPassword,
  errNotFound,
  errPermissionDenied,
} from '../../lib/errors.ts';

/** 200 with a zero-length body — museum returns no JSON here. */
const emptyOk = (c: Context) => c.body(null, 200);

export const setupTwoFactor = (deps: Deps) => async (c: Context) => {
  const { userId } = auth(c);
  const user = await getUser(deps, userId);
  if (!user) throw errNotFound();

  const secretCode = generateTotpSecret(deps.rand);
  await putPendingSecret(deps, userId, secretCode);

  // 200x200 PNG, matching the capture's dimensions.
  const png = await QRCode.toBuffer(otpauthUri(user.email, secretCode), {
    type: 'png',
    width: 200,
    margin: 4,
  });
  return c.json({ secretCode, qrCode: png.toString('base64') });
};

const enableSchema = z.object({
  code: z.string(),
  encryptedTwoFactorSecret: z.string(),
  twoFactorSecretDecryptionNonce: z.string(),
});

export const enableTwoFactor = (deps: Deps) => async (c: Context) => {
  const { userId } = auth(c);
  const body = enableSchema.parse(await c.req.json());

  const pending = await getPendingSecret(deps, userId);
  // No pending secret is indistinguishable from a bad code, on purpose.
  if (!pending || !verifyTotp(pending, body.code, deps.clock.nowMicros())) {
    throw errInvalidPassword();
  }

  await storeTwoFactor(
    deps,
    userId,
    pending,
    body.encryptedTwoFactorSecret,
    body.twoFactorSecretDecryptionNonce,
  );
  return emptyOk(c);
};

export const disableTwoFactor = (deps: Deps) => async (c: Context) => {
  await clearTwoFactor(deps, auth(c).userId);
  return emptyOk(c);
};

/** The {id, keyAttributes, encryptedToken} response shared by verify+remove. */
const issueLogin = async (deps: Deps, c: Context, userId: number) => {
  const keyAttributes = await getKeyAttributes(deps, userId);
  if (!keyAttributes) throw errNotFound();

  const token = generateToken(deps.rand);
  await deps.db.put(
    tokenRow(
      deps,
      userId,
      tokenHash(token),
      token,
      appFromClientPackage(c.req.header('X-Client-Package')),
      c.req.header('x-forwarded-for') ?? '',
      c.req.header('user-agent') ?? '',
    ),
  );
  return c.json({
    id: userId,
    keyAttributes,
    encryptedToken: encryptToken(token, keyAttributes.publicKey),
  });
};

const verifySchema = z.object({ sessionID: z.string(), code: z.string() });

export const verifyTwoFactor = (deps: Deps) => async (c: Context) => {
  const body = verifySchema.parse(await c.req.json());

  const userId = await resolveTwoFactorSession(deps, body.sessionID);
  if (userId === null) throw errInvalidPassword();

  const row = await getTwoFactor(deps, userId);
  if (!row || !verifyTotp(row.secret, body.code, deps.clock.nowMicros())) {
    throw errInvalidPassword();
  }

  await consumeTwoFactorSession(deps, body.sessionID);
  return issueLogin(deps, c, userId);
};

export const recoverTwoFactor = (deps: Deps) => async (c: Context) => {
  const sessionID = c.req.query('sessionID');
  if (!sessionID) throw errBadRequestSentinel();

  const userId = await resolveTwoFactorSession(deps, sessionID);
  if (userId === null) throw errNotFound();

  const row = await getTwoFactor(deps, userId);
  if (!row) throw errNotFound();
  return c.json({
    encryptedSecret: row.encryptedTwoFactorSecret,
    secretDecryptionNonce: row.twoFactorSecretDecryptionNonce,
  });
};

const removeSchema = z.object({ sessionID: z.string(), secret: z.string() });

/**
 * Recovery path: the client decrypts the stored secret with the recovery key
 * and proves it here. A wrong secret is 403 (not the 401 a wrong CODE gets) —
 * captured.
 */
export const removeTwoFactor = (deps: Deps) => async (c: Context) => {
  const body = removeSchema.parse(await c.req.json());

  const userId = await resolveTwoFactorSession(deps, body.sessionID);
  if (userId === null) throw errPermissionDenied();

  const row = await getTwoFactor(deps, userId);
  if (!row || !secretsMatch(row.secret, body.secret)) throw errPermissionDenied();

  await clearTwoFactor(deps, userId);
  await consumeTwoFactorSession(deps, body.sessionID);
  return issueLogin(deps, c, userId);
};

/** Length-independent constant-time-ish compare for the recovery secret. */
const secretsMatch = (expected: string, given: string): boolean => {
  if (expected.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
};
