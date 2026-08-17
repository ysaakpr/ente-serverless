/**
 * onVerificationSuccess (userauth.go) — shared by OTT verify-email and SRP
 * verify-session. Core scope: no 2FA / passkeys, so the response is either
 * the plaintext-token shape (no key attributes yet) or the sealed-token shape.
 */

import type { Deps } from '../deps.ts';
import { generateToken, tokenHash, encryptToken } from './tokens.ts';
import { createUser, getKeyAttributes, getUserIdByEmail, tokenRow } from './users.ts';
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
