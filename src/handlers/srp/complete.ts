/**
 * POST /users/srp/complete (auth) — src: CompleteSRPSetupRequest.
 * Verifies M1 against the temp session; success commits the SRP auth.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { keys } from '../../domain/model.ts';
import { verifySrpSession } from '../../domain/srpSessions.ts';
import { errNotFound } from '../../lib/errors.ts';

const bodySchema = z.object({
  setupID: z.string().uuid(),
  srpM1: z.string().min(1),
});

export const commitSrpAuth = async (
  deps: Deps,
  userId: number,
  srpUserID: string,
  salt: string,
  verifier: string,
): Promise<void> => {
  const existing = await deps.db.get(keys.userSrp(userId).pk, 'SRP');
  const ops = [];
  if (existing && existing.srpUserID !== srpUserID) {
    ops.push({ kind: 'delete' as const, key: keys.srpUserGuard(existing.srpUserID as string) });
  }
  ops.push(
    { kind: 'put' as const, item: { ...keys.userSrp(userId), srpUserID, salt, verifier } },
    { kind: 'put' as const, item: { ...keys.srpUserGuard(srpUserID), userId } },
  );
  await deps.db.transactWrite(ops);
};

export const completeSrpSetup = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());

  const setup = await deps.db.get(keys.srpSetup(body.setupID).pk, 'META');
  if (!setup) throw errNotFound();

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
