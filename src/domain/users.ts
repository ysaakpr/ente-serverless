/** User rows: create-or-get by email, key attributes, usage. */

import type { Deps } from '../deps.ts';
import { keys, gsi, padTime } from './model.ts';
import { emailHash, normalizeEmail } from './tokens.ts';
import { getInvite, inviteConsumption } from './invites.ts';
import { ConditionFailedError } from '../ports/db.ts';
import { errPermissionDenied } from '../lib/errors.ts';

export interface UserRow {
  pk: string;
  sk: string;
  userId: number;
  email: string;
  emailHash: string;
  creationTime: number;
  /**
   * Per-user storage cap, bytes (D54). Absent = config.freePlanStorageBytes.
   * 0 means ZERO — no uploads at all — unlike the 0-disables-it ceilings
   * elsewhere in config; the explicit contrast is deliberate and tested.
   * Copied from the invite row at signup; adjusted via `make set-storage`.
   */
  storageLimitBytes?: number;
  /** Viewer account (D54): consumes shares only — uploads, upload-url mints,
   * and non-special collection creation are refused server-side. */
  viewer?: boolean;
  /** Federation seam, copied from the invite row ('local' today, D54). */
  home?: string;
  /**
   * BYO storage pool membership (H2, D55): NEW uploads mint/commit into this
   * pool's bucket. Absent = the central default bucket. Purely a
   * storage/billing routing attribute — NEVER consulted by authorization.
   * Set via `make pool-attach` (or copied from the invite row at signup);
   * existing files keep their pins when this changes.
   */
  storagePoolId?: string;
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

  // Invite-gated signup (D54). The sendOtt gate already refused the OTT, so
  // this belt-and-braces check only fires in the revoked-between-OTT-and-verify
  // window (or a mode flip mid-flow). Overrides apply whenever a usable invite
  // exists, invite mode or not — an operator who pre-provisioned limits and
  // later opened signup keeps them.
  const invite = await getInvite(deps, normalized);
  const usableInvite = invite && invite.consumedAt === undefined ? invite : null;
  if (deps.config.signupMode === 'invite' && !usableInvite) throw errPermissionDenied();

  const userId = deps.ids.next();
  const now = deps.clock.nowMicros();
  const consumption = usableInvite ? inviteConsumption(deps, usableInvite) : null;
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
          ...(consumption?.userAttrs ?? {}),
        },
      },
      // Single-use for signup, kept as audit trail: consumedAt lands in the
      // same transaction that creates the account.
      ...(consumption ? [{ kind: 'put' as const, item: consumption.consumedRow }] : []),
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
