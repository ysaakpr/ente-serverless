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
import { MICROS_PER_HOUR } from '../lib/time.ts';

export const MAX_UNVERIFIED_SESSIONS_PER_HOUR = 10;
export const SRP_ATTEMPT_CAP = 5;

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
      },
    },
    {
      kind: 'put',
      item: {
        pk: sessionsByUser(srpUserID),
        sk: `${padTime(now)}#${sessionID}`,
        sessionID,
        isVerified: false,
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
): Promise<string> => {
  const m1Bytes = fromB64safe(srpM1);
  if (m1Bytes.length !== 32) throw badRequest(`srpM1 size is ${m1Bytes.length}, expected 32`);

  const session = await deps.db.get<SrpSessionRow>(keys.srpSession(sessionID).pk, 'META');
  if (!session) throw errInvalidPassword(); // do not reveal whether the session exists

  if (session.isFake) {
    await deps.db.update(session.pk, session.sk, { attemptCount: session.attemptCount + 1 });
    throw errInvalidPassword();
  }
  if (session.isVerified) throw sessionAlreadyVerified();
  if (session.attemptCount >= SRP_ATTEMPT_CAP) throw tooManyWrongAttempts();

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

  if (!ok) {
    await deps.db.update(session.pk, session.sk, { attemptCount: session.attemptCount + 1 });
    throw errInvalidPassword();
  }

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
