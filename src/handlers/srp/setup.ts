/**
 * POST /users/srp/setup (auth) — src: SetupSRPRequest -> SetupSRPResponse.
 * Stores a temp setup row + opens a session against the candidate verifier;
 * nothing becomes the account's SRP auth until complete.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { keys } from '../../domain/model.ts';
import { createAndInsertSrpSession } from '../../domain/srpSessions.ts';

const bodySchema = z.object({
  srpUserID: z.string().uuid(),
  srpSalt: z.string().min(1),
  srpVerifier: z.string().min(1),
  srpA: z.string().min(1),
});

export const setupSrp = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
  const { userId } = auth(c);

  // NO srpUserID collision check here, deliberately: museum answers 200 to a
  // setup naming somebody else's srpUserID and only refuses at complete/update
  // (captured 2026-08-17, D38). Rejecting early would be a gratuitous divergence
  // — nothing is committed yet, and an attacker can already mint sessions
  // through the public /users/srp/create-session. commitSrpAuth is the gate.
  const { sessionID, srpB } = await createAndInsertSrpSession(
    deps,
    body.srpUserID,
    body.srpVerifier,
    body.srpA,
  );

  const setupID = deps.rand.uuid();
  await deps.db.put({
    ...keys.srpSetup(setupID),
    userId,
    sessionID,
    srpUserID: body.srpUserID,
    salt: body.srpSalt,
    verifier: body.srpVerifier,
    createdAt: deps.clock.nowMicros(),
  });

  return c.json({ setupID, srpB });
};
