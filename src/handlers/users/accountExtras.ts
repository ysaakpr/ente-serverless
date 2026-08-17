/**
 * The smaller [ACCOUNT] routes:
 *  - PUT /users/email-mfa — flag store; disabling requires SRP (409 CONFLICT)
 *  - GET /users/two-factor/status — real TOTP state since D36
 *  - GET /users/two-factor/recovery-status — allowAdminReset true (captured)
 *  - PUT /users/recovery-key — write-once recovery fields into key attributes
 *  - GET /users/public-key?email= — {"publicKey"}
 *  - GET /users/accounts-token — stub (no accounts.ente.io here; capture-gated)
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { keys } from '../../domain/model.ts';
import { getKeyAttributes, getUserIdByEmail, putKeyAttributes } from '../../domain/users.ts';
import { generateToken } from '../../domain/tokens.ts';
import { isTwoFactorEnabled } from '../../domain/twoFactor.ts';
import { conflictError, errNotFound, SentinelError } from '../../lib/errors.ts';

export const updateEmailMfa = (deps: Deps) => async (c: Context) => {
  const body = z.object({ isEnabled: z.boolean() }).parse(await c.req.json());
  const { userId } = auth(c);
  if (!body.isEnabled) {
    const srp = await deps.db.get(keys.userSrp(userId).pk, 'SRP');
    if (!srp) throw conflictError('SRP setup incomplete');
  }
  await deps.db.update(keys.user(userId).pk, 'META', { isEmailMFAEnabled: body.isEnabled });
  return c.body(null, 200);
};

export const twoFactorStatus = (deps: Deps) => async (c: Context) =>
  c.json({ status: await isTwoFactorEnabled(deps, auth(c).userId) });

// Capture 2026-08-17: museum answers allowAdminReset TRUE for a fresh account
// (we had invented false). 2FA itself is still unimplemented — see D35.
export const twoFactorRecoveryStatus = (_deps: Deps) => async (c: Context) =>
  c.json({ allowAdminReset: true, isPasskeyRecoveryEnabled: false });

const recoverySchema = z.object({
  masterKeyEncryptedWithRecoveryKey: z.string(),
  masterKeyDecryptionNonce: z.string(),
  recoveryKeyEncryptedWithMasterKey: z.string(),
  recoveryKeyDecryptionNonce: z.string(),
});

export const setRecoveryKey = (deps: Deps) => async (c: Context) => {
  const body = recoverySchema.parse(await c.req.json());
  const { userId } = auth(c);
  const attrs = await getKeyAttributes(deps, userId);
  if (!attrs) throw errNotFound(); // museum: "User keys setup is not completed"
  if (attrs.recoveryKeyEncryptedWithMasterKey) {
    throw new SentinelError(500, 'recovery key is already set'); // museum: plain error
  }
  await putKeyAttributes(deps, userId, { ...attrs, ...body });
  return c.body(null, 200);
};

export const getPublicKey = (deps: Deps) => async (c: Context) => {
  const email = c.req.query('email');
  if (!email) throw errNotFound();
  const targetId = await getUserIdByEmail(deps, email);
  if (targetId === null) throw errNotFound();
  const attrs = await getKeyAttributes(deps, targetId);
  if (!attrs) throw errNotFound();
  return c.json({ publicKey: attrs.publicKey });
};

export const getAccountsToken = (deps: Deps) => async (c: Context) => {
  auth(c);
  // No accounts.ente.io equivalent in this stack — opaque token + empty URL
  // keeps the client's happy path shaped (capture-gated, DECISIONS.md D10).
  return c.json({ accountsToken: generateToken(deps.rand), accountsUrl: '' });
};
