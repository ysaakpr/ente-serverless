/**
 * onVerificationSuccess (userauth.go) — shared by OTT verify-email and SRP
 * verify-session. The response is one of three shapes: the plaintext-token
 * shape (no key attributes yet), the sealed-token shape, or — when 2FA is on
 * — the twoFactorSessionID shape carrying NO credential at all.
 *
 * Oracle capture 2026-08-17 confirmed BOTH login routes switch to the
 * twoFactorSessionID shape, which is why the branch lives here rather than in
 * either handler (D36).
 */

import type { Deps } from '../deps.ts';
import { generateToken, tokenHash, encryptToken } from './tokens.ts';
import { createUser, getKeyAttributes, getUserIdByEmail, tokenRow } from './users.ts';
import { createTwoFactorSession, isTwoFactorEnabled } from './twoFactor.ts';
import type { App } from './apps.ts';

export interface VerificationContext {
  app: App;
  ip: string;
  ua: string;
}

export const onVerificationSuccess = async (
  deps: Deps,
  email: string,
  ctx: VerificationContext,
): Promise<Record<string, unknown>> => {
  let userId = await getUserIdByEmail(deps, email);
  if (userId === null) {
    userId = await createUser(deps, email);
  }

  // 2FA short-circuits BEFORE any token is minted — the caller has proved the
  // password but not the second factor, so there is nothing to hand back but
  // the session id. /users/two-factor/verify issues the real token later.
  if (await isTwoFactorEnabled(deps, userId)) {
    return {
      id: userId,
      passkeySessionID: '',
      accountsUrl: '',
      twoFactorSessionID: await createTwoFactorSession(deps, userId),
      twoFactorSessionIDV2: '',
    };
  }

  const token = generateToken(deps.rand);
  const keyAttributes = await getKeyAttributes(deps, userId);

  await deps.db.put(tokenRow(deps, userId, tokenHash(token), token, ctx.app, ctx.ip, ctx.ua));

  // Field presence mirrors EmailAuthorizationResponse's Go json tags:
  // keyAttributes/encryptedToken/token are omitempty; the rest always render.
  const base = {
    id: userId,
    passkeySessionID: '',
    accountsUrl: '',
    twoFactorSessionID: '',
    twoFactorSessionIDV2: '',
  };
  if (!keyAttributes) {
    return { ...base, token };
  }
  return {
    ...base,
    keyAttributes,
    encryptedToken: encryptToken(token, keyAttributes.publicKey),
  };
};
