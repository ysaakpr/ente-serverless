/** User rows: create-or-get by email, key attributes, usage. */

import type { Deps } from '../deps.ts';
import { keys, gsi, padTime } from './model.ts';
import { emailHash, normalizeEmail } from './tokens.ts';
import { ConditionFailedError } from '../ports/db.ts';

export interface UserRow {
  pk: string;
  sk: string;
  userId: number;
  email: string;
  emailHash: string;
  creationTime: number;
  [attr: string]: unknown;
}

export interface KeyAttributes {
  kekSalt: string;
  kekHash: string;
  encryptedKey: string;
  keyDecryptionNonce: string;
  publicKey: string;
  encryptedSecretKey: string;
  secretKeyDecryptionNonce: string;
  memLimit: number;
  opsLimit: number;
  masterKeyEncryptedWithRecoveryKey: string;
  masterKeyDecryptionNonce: string;
  recoveryKeyEncryptedWithMasterKey: string;
  recoveryKeyDecryptionNonce: string;
}

export const getUserIdByEmail = async (deps: Deps, email: string): Promise<number | null> => {
  const hash = emailHash(email, deps.hashingKey);
  const guard = await deps.db.get(keys.emailGuard(hash).pk, 'META');
  return guard ? (guard.userId as number) : null;
};

export const getUser = async (deps: Deps, userId: number): Promise<UserRow | null> =>
  deps.db.get<UserRow>(keys.user(userId).pk, 'META');

export const createUser = async (deps: Deps, email: string): Promise<number> => {
  const normalized = normalizeEmail(email);
  const hash = emailHash(normalized, deps.hashingKey);
  const userId = deps.ids.next();
  const now = deps.clock.nowMicros();
  try {
    await deps.db.transactWrite([
      {
        kind: 'put',
        ifNotExists: true,
        item: { ...keys.emailGuard(hash), userId },
      },
      {
        kind: 'put',
        item: {
          ...keys.user(userId),
          userId,
          email: normalized,
          emailHash: hash,
          creationTime: now,
        },
      },
    ]);
  } catch (err) {
    if (err instanceof ConditionFailedError) {
      // Raced another signup for the same email — use the winner.
      const existing = await getUserIdByEmail(deps, normalized);
      if (existing !== null) return existing;
    }
    throw err;
  }
  return userId;
};

export const getKeyAttributes = async (deps: Deps, userId: number): Promise<KeyAttributes | null> => {
  const row = await deps.db.get(keys.userKeys(userId).pk, 'KEYS');
  return row ? (row.keyAttributes as KeyAttributes) : null;
};

export const putKeyAttributes = async (
  deps: Deps,
  userId: number,
  attributes: KeyAttributes,
): Promise<void> => {
  await deps.db.put({ ...keys.userKeys(userId), keyAttributes: attributes });
};

/** Signup state (userauth.go getSignUpState): account + key attributes = complete. */
export type SignUpState = 'noAccount' | 'incomplete' | 'complete';

export const getSignUpState = async (deps: Deps, email: string): Promise<SignUpState> => {
  const userId = await getUserIdByEmail(deps, email);
  if (userId === null) return 'noAccount';
  const keyAttrs = await getKeyAttributes(deps, userId);
  return keyAttrs ? 'complete' : 'incomplete';
};

export interface TokenRowShape {
  pk: string;
  sk: string;
  userId: number;
  token: string;
  app: string;
  creationTime: number;
  lastUsedTime: number;
  ip: string;
  ua: string;
  gsi3pk: string;
  gsi3sk: string;
  [attr: string]: unknown;
}

export const tokenRow = (
  deps: Deps,
  userId: number,
  hash: string,
  token: string,
  app: string,
  ip: string,
  ua: string,
): TokenRowShape => {
  const now = deps.clock.nowMicros();
  return {
    ...keys.token(hash),
    userId,
    token,
    app,
    creationTime: now,
    lastUsedTime: now,
    ip,
    ua,
    gsi3pk: gsi.userTokens(userId),
    gsi3sk: padTime(now),
  };
};
