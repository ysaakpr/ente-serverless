/**
 * POST /users/srp/complete (auth) — src: CompleteSRPSetupRequest.
 * Verifies M1 against the temp session; success commits the SRP auth.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { keys } from '../../domain/model.ts';
import { verifySrpSession } from '../../domain/srpSessions.ts';
import { ConditionFailedError } from '../../ports/db.ts';
import {
  errNotFound,
  errPermissionDenied,
  srpSetupAlreadyComplete,
  srpUserIdTaken,
} from '../../lib/errors.ts';

const bodySchema = z.object({
  setupID: z.string().uuid(),
  srpM1: z.string().min(1),
});

/**
 * Rejects an srpUserID registered to a DIFFERENT account; returns true when the
 * caller already holds it (a password change that keeps the same id — museum
 * answers 200 to that, captured, so it must keep working).
 *
 * This guard is the whole authorization story for SRP login: create-session and
 * verify-session resolve SRPUSER#<srpUserID> to a userId and then trust it. And
 * srpUserID is PUBLIC — GET /users/srp/attributes?email= hands it to anyone. So
 * without this check any authenticated caller could repoint a victim's guard at
 * a verifier of their own and permanently break that victim's password login.
 * Museum is not exposed here: its UNIQUE constraint refuses the write (as a
 * 500). This reproduces the refusal deliberately. See D38.
 */
export const assertSrpUserIdClaimable = async (
  deps: Deps,
  userId: number,
  srpUserID: string,
): Promise<boolean> => {
  const guard = await deps.db.get(keys.srpUserGuard(srpUserID).pk, 'META');
  if (!guard) return false;
  if ((guard.userId as number) !== userId) throw srpUserIdTaken();
  return true;
};

export const commitSrpAuth = async (
  deps: Deps,
  userId: number,
  srpUserID: string,
  salt: string,
  verifier: string,
): Promise<void> => {
  const alreadyOurs = await assertSrpUserIdClaimable(deps, userId, srpUserID);
  const existing = await deps.db.get(keys.userSrp(userId).pk, 'SRP');
  const ops = [];
  if (existing && existing.srpUserID !== srpUserID) {
    ops.push({ kind: 'delete' as const, key: keys.srpUserGuard(existing.srpUserID as string) });
  }
  ops.push(
    { kind: 'put' as const, item: { ...keys.userSrp(userId), srpUserID, salt, verifier } },
    // ifNotExists ONLY when we read no guard, which closes the read-then-write
    // race: a claim landing in between loses the transaction instead of being
    // silently overwritten. Re-registering our own id must stay unconditional —
    // the row already exists and the condition would reject a legitimate
    // password change.
    {
      kind: 'put' as const,
      ifNotExists: !alreadyOurs,
      item: { ...keys.srpUserGuard(srpUserID), userId },
    },
  );
  try {
    await deps.db.transactWrite(ops);
  } catch (err) {
    // The only condition in this transaction is the guard's.
    if (err instanceof ConditionFailedError) throw srpUserIdTaken();
    throw err;
  }
};

export const completeSrpSetup = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
  const { userId } = auth(c);

  // Museum: this route is FIRST-TIME-ONLY. An account that already has SRP gets
  // 400 BAD_REQUEST "SRP setup already complete" and must change its password
  // through /users/srp/update instead. Captured 2026-08-17; it runs BEFORE the
  // srpUserID uniqueness check, which is why an already-configured attacker sees
  // this rather than the 500. (D38)
  const configured = await deps.db.get(keys.userSrp(userId).pk, 'SRP');
  if (configured) throw srpSetupAlreadyComplete();

  const setup = await deps.db.get(keys.srpSetup(body.setupID).pk, 'META');
  if (!setup) throw errNotFound();
  // DELIBERATE DIVERGENCE (D38): museum answers 200 here and commits the setup's
  // material to whoever CALLS, so a thief holding someone's setupID + M1 takes
  // the srpUserID and leaves the owner with no SRP at all — captured. A setupID
  // is not a credential; bind the row to its creator, as updateSrp already did.
  if ((setup.userId as number) !== userId) throw errPermissionDenied();

  const srpM2 = await verifySrpSession(
    deps,
    setup.verifier as string,
    setup.sessionID as string,
    body.srpM1,
  );

  await commitSrpAuth(
    deps,
    setup.userId as number,
    setup.srpUserID as string,
    setup.salt as string,
    setup.verifier as string,
  );

  return c.json({ setupID: body.setupID, srpM2 });
};
