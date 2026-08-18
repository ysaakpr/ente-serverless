/**
 * SRP session bookkeeping — port of createAndInsertSRPSession /
 * verifySRPSession (pkg/controller/user/srp.go), same statuses and caps.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Deps } from '../deps.ts';
import { keys, padTime } from './model.ts';
import { SrpServer } from './srp.ts';
import { b64, fromB64 } from '../lib/b64.ts';
import {
  badRequest,
  errInvalidPassword,
  sessionAlreadyVerified,
  tooManyUnverifiedSessions,
  tooManyWrongAttempts,
} from '../lib/errors.ts';
import { MICROS_PER_HOUR, MICROS_PER_SECOND } from '../lib/time.ts';

export const MAX_UNVERIFIED_SESSIONS_PER_HOUR = 10;
export const SRP_ATTEMPT_CAP = 5;

/**
 * Row expiry (security review 2026-08-17, finding 2). create-session is
 * unauthenticated and writes two rows per call, keyed by a caller-chosen
 * srpUserID — without a `ttl` that is unbounded table growth for anyone.
 * The session row must outlive a real create→verify round-trip and the
 * replay window that produces SESSION_ALREADY_VERIFIED: 1 hour is generous.
 * The index row feeds the 10-per-hour throttle, which queries back exactly
 * MICROS_PER_HOUR — its TTL must EXCEED that window or the one rate limit
 * that works quietly weakens: 2 hours, guarded by test.
 */
export const SRP_SESSION_TTL_MICROS = MICROS_PER_HOUR;
export const SRP_SESSION_INDEX_TTL_MICROS = 2 * MICROS_PER_HOUR;

interface SrpSessionRow {
  pk: string;
  sk: string;
  srpUserID: string;
  serverKey: string;
  srpA: string;
  isVerified: boolean;
  attemptCount: number;
  isFake: boolean;
  createdAt: number;
  ttl: number;
  [attr: string]: unknown;
}

const sessionsByUser = (srpUserID: string) => `SRPSESSBYUSER#${srpUserID}`;

export const createAndInsertSrpSession = async (
  deps: Deps,
  srpUserID: string,
  verifierB64: string,
  srpA: string,
  isFake = false,
): Promise<{ sessionID: string; srpB: string }> => {
  const srpABytes = fromB64safe(srpA);
  if (srpABytes.length !== 512) throw badRequest('Invalid length for srpA');

  const now = deps.clock.nowMicros();
  const recent = await deps.db.query(sessionsByUser(srpUserID), {
    skFrom: padTime(now - MICROS_PER_HOUR),
  });
  const unverified = recent.filter((r) => r.isVerified !== true).length;
  if (unverified >= MAX_UNVERIFIED_SESSIONS_PER_HOUR) {
    throw tooManyUnverifiedSessions();
  }

  const sessionID = deps.rand.uuid();
  let srpB: string;
  let serverKey: string;
  if (isFake) {
    serverKey = b64(deps.rand.bytes(64));
    srpB = b64(deps.rand.bytes(512));
  } else {
    const secret = deps.rand.bytes(32);
    serverKey = b64(secret);
    const server = new SrpServer(fromB64safe(verifierB64), secret);
    srpB = b64(server.computeB());
  }

  await deps.db.transactWrite([
    {
      kind: 'put',
      item: {
        ...keys.srpSession(sessionID),
        srpUserID,
        serverKey,
        srpA,
        isVerified: false,
        attemptCount: 0,
        isFake,
        createdAt: now,
        ttl: Math.ceil((now + SRP_SESSION_TTL_MICROS) / MICROS_PER_SECOND),
      },
    },
    {
      kind: 'put',
      item: {
        pk: sessionsByUser(srpUserID),
        sk: `${padTime(now)}#${sessionID}`,
        sessionID,
        isVerified: false,
        ttl: Math.ceil((now + SRP_SESSION_INDEX_TTL_MICROS) / MICROS_PER_SECOND),
      },
    },
  ]);

  return { sessionID, srpB };
};

/**
 * Verify M1 for a stored session against `verifier`. Success marks the
 * session verified (single use) and returns M2; failure increments the
 * attempt counter. Statuses match museum exactly.
 */
export const verifySrpSession = async (
  deps: Deps,
  verifierB64: string,
  sessionID: string,
  srpM1: string,
  expectedSrpUserID?: string,
): Promise<string> => {
  const m1Bytes = fromB64safe(srpM1);
  if (m1Bytes.length !== 32) throw badRequest(`srpM1 size is ${m1Bytes.length}, expected 32`);

  const session = await deps.db.get<SrpSessionRow>(keys.srpSession(sessionID).pk, 'META');
  if (!session) throw errInvalidPassword(); // do not reveal whether the session exists

  // SECURITY-REVIEW-2 (defense-in-depth): bind the session to the srpUserID in
  // the request, so a leaked/guessed sessionID cannot be exercised under a
  // different identity to burn a victim's attempt counter. Same 401 as any
  // other failure — reveals nothing. Rejected before the counter is touched.
  if (expectedSrpUserID !== undefined && session.srpUserID !== expectedSrpUserID) {
    throw errInvalidPassword();
  }

  if (session.isVerified) throw sessionAlreadyVerified();

  // SECURITY-REVIEW-2 F2: count the attempt with an atomic ADD and gate on the
  // RETURNED post-increment value, BEFORE the compare — never on `session`,
  // whose `attemptCount` came from the eventually-consistent `get` above. The
  // previous gate read that stale value and discarded this ADD's result, so a
  // concurrent burst slipped unbounded guesses past a cap of 5. This mirrors
  // the OTT (ott.ts) and TOTP (twoFactor.ts) fixes: increment first, judge
  // second. The fake branch caps identically, so an unknown srpUserID is
  // indistinguishable from a wrong password even at the cap boundary. `ttl`
  // rides along so a row conjured after TTL deletion still expires.
  const { attemptCount } = await deps.db.addToCountersReturning(
    session.pk,
    session.sk,
    { attemptCount: 1 },
    { ttl: session.ttl },
  );
  if (attemptCount! > SRP_ATTEMPT_CAP) throw tooManyWrongAttempts();

  if (session.isFake) throw errInvalidPassword();

  const server = new SrpServer(fromB64safe(verifierB64), fromB64safe(session.serverKey));
  let ok = false;
  let m2 = '';
  try {
    const proofs = server.proofs(fromB64safe(session.srpA));
    ok = timingSafeEqual(Buffer.from(proofs.m1), Buffer.from(m1Bytes));
    m2 = b64(proofs.m2);
  } catch {
    ok = false;
  }

  if (!ok) throw errInvalidPassword();

  await deps.db.update(session.pk, session.sk, { isVerified: true });
  await deps.db
    .update(sessionsByUser(session.srpUserID), `${padTime(session.createdAt)}#${sessionID}`, {
      isVerified: true,
    })
    .catch(() => {}); // rate-limit bookkeeping only
  return m2;
};

const fromB64safe = (s: string): Uint8Array => {
  try {
    return fromB64(s);
  } catch {
    throw badRequest('invalid base64 encoding');
  }
};
