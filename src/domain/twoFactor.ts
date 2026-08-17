/**
 * Two-factor (TOTP) state — src: pkg/controller/user/two_factor.go.
 *
 * Three rows, all under the user's partition except the session:
 *   2FA        enabled secret + the client-encrypted copy used for recovery
 *   2FASETUP   secret issued by /setup, discarded unless /enable proves it
 *   2FASESSION half-authenticated login waiting on a code (hashed key, TTL)
 *
 * Shapes captured from the oracle 2026-08-17 — see D36 for the full table.
 */

import type { Deps } from '../deps.ts';
import { keys } from './model.ts';
import { generateToken, tokenHash } from './tokens.ts';
import { MICROS_PER_MINUTE, MICROS_PER_SECOND, type Micros } from '../lib/time.ts';

/**
 * How long a half-authenticated login may sit before the code must be
 * re-requested. Not observable from a capture without waiting it out, so this
 * is ours: long enough to read a code off a phone, short enough that a leaked
 * session ID is near-useless. Divergence noted in D36.
 */
export const TWO_FACTOR_SESSION_VALIDITY_MICROS = 10 * MICROS_PER_MINUTE;

/**
 * Wrong-code cap per two-factor session (security review 2026-08-17,
 * finding 1; divergence logged in D42). Museum's capture recorded no cap —
 * uncapped, a 10-minute session absorbs ~600k guesses at 1000 req/s against
 * 3-of-10⁶ acceptable codes, which reduces 2FA to a delay. 5 matches
 * SRP_ATTEMPT_CAP (the closest "prove a secret for this session" analogue)
 * and comfortably absorbs clock-drift retries at skew ±1. The counter lives
 * on the SESSION row — 10-minute TTL, attacker can only burn the session
 * they created — never on the user, where it would be a lockout weapon.
 */
export const TWO_FACTOR_ATTEMPT_LIMIT = 5;

export interface TwoFactorRow {
  pk: string;
  sk: string;
  secret: string;
  encryptedTwoFactorSecret: string;
  twoFactorSecretDecryptionNonce: string;
  enabledAt: number;
  [attr: string]: unknown;
}

export interface TwoFactorSessionRow {
  pk: string;
  sk: string;
  userId: number;
  createdAt: number;
  ttl: number;
  /** Bumped atomically per proof attempt; absent until the first wrong code. */
  attemptCount?: number;
  [attr: string]: unknown;
}

export const getTwoFactor = async (deps: Deps, userId: number): Promise<TwoFactorRow | null> =>
  deps.db.get<TwoFactorRow>(keys.userTwoFactor(userId).pk, '2FA');

export const isTwoFactorEnabled = async (deps: Deps, userId: number): Promise<boolean> =>
  (await getTwoFactor(deps, userId)) !== null;

/** Stash the secret /setup handed out; a later /setup simply replaces it. */
export const putPendingSecret = async (deps: Deps, userId: number, secret: string): Promise<void> => {
  const now = deps.clock.nowMicros();
  await deps.db.put({
    ...keys.twoFactorSetup(userId),
    secret,
    createdAt: now,
    ttl: Math.ceil((now + TWO_FACTOR_SESSION_VALIDITY_MICROS) / MICROS_PER_SECOND),
  });
};

export const getPendingSecret = async (deps: Deps, userId: number): Promise<string | null> => {
  const row = await deps.db.get(keys.twoFactorSetup(userId).pk, '2FASETUP');
  return row ? (row.secret as string) : null;
};

export const enableTwoFactor = async (
  deps: Deps,
  userId: number,
  secret: string,
  encryptedTwoFactorSecret: string,
  twoFactorSecretDecryptionNonce: string,
): Promise<void> => {
  await deps.db.put({
    ...keys.userTwoFactor(userId),
    secret,
    encryptedTwoFactorSecret,
    twoFactorSecretDecryptionNonce,
    enabledAt: deps.clock.nowMicros(),
  });
  await deps.db.delete(keys.twoFactorSetup(userId).pk, '2FASETUP');
};

export const disableTwoFactor = async (deps: Deps, userId: number): Promise<void> => {
  await deps.db.delete(keys.userTwoFactor(userId).pk, '2FA');
  await deps.db.delete(keys.twoFactorSetup(userId).pk, '2FASETUP');
};

/**
 * Mint the twoFactorSessionID the login routes hand back instead of a token.
 * Same generator as auth tokens (b64url of 32 bytes) and, like them, only the
 * hash is stored.
 */
export const createTwoFactorSession = async (deps: Deps, userId: number): Promise<string> => {
  const sessionID = generateToken(deps.rand);
  const now = deps.clock.nowMicros();
  await deps.db.put({
    ...keys.twoFactorSession(tokenHash(sessionID)),
    userId,
    createdAt: now,
    ttl: Math.ceil((now + TWO_FACTOR_SESSION_VALIDITY_MICROS) / MICROS_PER_SECOND),
  } satisfies TwoFactorSessionRow);
  return sessionID;
};

/**
 * Resolve a session ID to its row, or null when unknown/expired. The TTL is
 * enforced here as well as by DynamoDB, whose deletion is only eventual.
 */
export const resolveTwoFactorSessionRow = async (
  deps: Deps,
  sessionID: string,
  now: Micros = deps.clock.nowMicros(),
): Promise<TwoFactorSessionRow | null> => {
  if (!sessionID) return null;
  const row = await deps.db.get<TwoFactorSessionRow>(
    keys.twoFactorSession(tokenHash(sessionID)).pk,
    'META',
  );
  if (!row) return null;
  if (row.createdAt + TWO_FACTOR_SESSION_VALIDITY_MICROS <= now) return null;
  return row;
};

/** Resolve a session ID to its user, or null when unknown/expired. */
export const resolveTwoFactorSession = async (
  deps: Deps,
  sessionID: string,
  now: Micros = deps.clock.nowMicros(),
): Promise<number | null> => (await resolveTwoFactorSessionRow(deps, sessionID, now))?.userId ?? null;

/**
 * Count one proof attempt against the session and 429 past the cap. Called
 * BEFORE the code/secret compare, so a crash after the compare can never
 * hand out a free attempt, and a correct code past the cap still 429s.
 * The increment is an atomic ADD (F0): parallel guesses cannot overwrite
 * each other's count. `ttl` rides along so a row conjured by a lost race
 * with consumeTwoFactorSession still expires.
 */
export const recordTwoFactorAttempt = async (
  deps: Deps,
  row: TwoFactorSessionRow,
): Promise<number> => {
  const { attemptCount } = await deps.db.addToCountersReturning(
    row.pk,
    row.sk,
    { attemptCount: 1 },
    { ttl: row.ttl },
  );
  return attemptCount!;
};

/** One-shot: a session is spent once it yields a token. */
export const consumeTwoFactorSession = async (deps: Deps, sessionID: string): Promise<void> => {
  await deps.db.delete(keys.twoFactorSession(tokenHash(sessionID)).pk, 'META');
};
