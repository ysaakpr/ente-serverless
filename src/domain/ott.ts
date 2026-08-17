/**
 * OTT store — museum semantics (pkg/controller/user/userauth.go):
 * 6-digit code, 1-hour validity, max 10 active codes, 20 wrong attempts
 * locks until active codes expire. Codes are stored hashed (invisible
 * hardening over museum's plaintext storage — the wire behaviour is equal).
 */

import { createHash } from 'node:crypto';
import type { Deps } from '../deps.ts';
import { keys } from './model.ts';
import { errExpiredOTT, errIncorrectOTT, errTooManyBadRequest } from '../lib/errors.ts';
import { MICROS_PER_HOUR, MICROS_PER_SECOND } from '../lib/time.ts';

export const OTT_VALIDITY_MICROS = MICROS_PER_HOUR; // museum: 60 * 60 * 1000000
export const OTT_ACTIVE_CODE_LIMIT = 10;
export const OTT_WRONG_ATTEMPT_LIMIT = 20;

const codeHash = (code: string): string => createHash('sha256').update(code).digest('hex');
const ATTEMPTS_SK = 'ATTEMPTS';

export const generateOttCode = (deps: Deps): string =>
  String(deps.rand.int(1_000_000)).padStart(6, '0');

const activeRows = async (deps: Deps, emailHash: string, app: string) => {
  const partition = keys.ottPartition(emailHash, app);
  const now = deps.clock.nowMicros();
  const rows = await deps.db.query(partition, {});
  return rows.filter((r) => r.sk !== ATTEMPTS_SK && (r.expiresAt as number) > now);
};

/** Throws 429 when the active-code cap is hit (museum ErrTooManyBadRequest). */
export const storeOtt = async (deps: Deps, emailHash: string, app: string, code: string): Promise<void> => {
  const active = await activeRows(deps, emailHash, app);
  if (active.length >= OTT_ACTIVE_CODE_LIMIT) throw errTooManyBadRequest();
  const now = deps.clock.nowMicros();
  await deps.db.put({
    ...keys.ott(emailHash, app, codeHash(code)),
    expiresAt: now + OTT_VALIDITY_MICROS,
    ttl: Math.ceil((now + OTT_VALIDITY_MICROS) / 1_000_000),
  });
};

/**
 * Single-use verification: 429 past the wrong-attempt cap, 410 with no active
 * code, 401 on a wrong code (attempt recorded).
 */
export const consumeOtt = async (deps: Deps, emailHash: string, app: string, code: string): Promise<void> => {
  const partition = keys.ottPartition(emailHash, app);
  const now = deps.clock.nowMicros();

  const attempts = await deps.db.get(partition, ATTEMPTS_SK);
  const attemptsLive = attempts !== null && (attempts.expiresAt as number) > now;
  if (attemptsLive && (attempts!.count as number) >= OTT_WRONG_ATTEMPT_LIMIT) {
    throw errTooManyBadRequest();
  }
  // The lock expires with the codes (D12: "locks until codes expire"). A stale
  // row must be cleared before the atomic ADD below, or its dead count would
  // keep feeding the cap after the lock should have lifted.
  if (attempts && !attemptsLive) await deps.db.delete(partition, ATTEMPTS_SK);

  const active = await activeRows(deps, emailHash, app);
  if (active.length === 0) throw errExpiredOTT();

  const hash = codeHash(code.trim());
  const match = active.find((r) => r.sk === hash);
  if (!match) {
    // Atomic ADD with the post-increment value (F0): a plain put here is a
    // read-modify-write that concurrent guesses overwrite, so the 20-attempt
    // cap never binds under parallel load (finding 3, 2026-08-17 review).
    // `expiresAt` keeps the lock lifting with the newest code; `ttl` bounds
    // the row itself, since the ADD conjures it for arbitrary email hashes.
    const expiresAt = Math.max(...active.map((r) => r.expiresAt as number));
    const { count } = await deps.db.addToCountersReturning(
      partition,
      ATTEMPTS_SK,
      { count: 1 },
      { expiresAt, ttl: Math.ceil(expiresAt / MICROS_PER_SECOND) },
    );
    if (count! > OTT_WRONG_ATTEMPT_LIMIT) throw errTooManyBadRequest();
    throw errIncorrectOTT();
  }
  await deps.db.delete(partition, hash);
};
