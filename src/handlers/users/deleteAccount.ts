/**
 * GET /users/delete-challenge + DELETE /users/delete (auth) —
 * src: pkg/controller/user/user_delete.go. The challenge is sealed to the
 * user's publicKey; the client unseals it and sends it back to prove key
 * possession. Deletion revokes every token and frees the email.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { keys } from '../../domain/model.ts';
import { getKeyAttributes, getUser } from '../../domain/users.ts';
import { listTokenRows } from '../../domain/sessions.ts';
import { encryptToken, generateToken, tokenHash } from '../../domain/tokens.ts';
import { MICROS_PER_HOUR } from '../../lib/time.ts';
import { errNotFound, errPermissionDenied } from '../../lib/errors.ts';

export const getDeleteChallenge = (deps: Deps) => async (c: Context) => {
  const { userId } = auth(c);
  const attrs = await getKeyAttributes(deps, userId);
  if (!attrs) throw errNotFound();

  const challenge = generateToken(deps.rand);
  await deps.db.put({
    pk: `USER#${userId}`,
    sk: 'DELETE-CHALLENGE',
    challengeHash: tokenHash(challenge),
    expiresAt: deps.clock.nowMicros() + MICROS_PER_HOUR,
  });
  return c.json({
    allowDelete: true,
    encryptedChallenge: encryptToken(challenge, attrs.publicKey),
    apps: ['photos'],
  });
};

const deleteSchema = z.object({
  challenge: z.string().min(1),
  feedback: z.string().nullish(),
  reasonCategory: z.string().nullish(),
  reason: z.string().nullish(),
});

export const deleteAccount = (deps: Deps) => async (c: Context) => {
  const body = deleteSchema.parse(await c.req.json());
  const { userId } = auth(c);

  const stored = await deps.db.get(`USER#${userId}`, 'DELETE-CHALLENGE');
  if (
    !stored ||
    (stored.expiresAt as number) < deps.clock.nowMicros() ||
    stored.challengeHash !== tokenHash(body.challenge)
  ) {
    throw errPermissionDenied();
  }

  const user = await getUser(deps, userId);
  if (!user) throw errNotFound();

  for (const row of await listTokenRows(deps, userId)) {
    await deps.db.delete(row.pk, row.sk);
  }
  // Free the email and tombstone the account; bulk data cleanup is the sweep
  // cron's concern (same deferred discipline as museum's queued deletion).
  await deps.db.transactWrite([
    { kind: 'delete', key: keys.emailGuard(user.emailHash) },
    { kind: 'delete', key: { pk: `USER#${userId}`, sk: 'DELETE-CHALLENGE' } },
    { kind: 'put', item: { ...user, isDeleted: true, deletedAt: deps.clock.nowMicros() } },
  ]);
  return c.json({ isSubscriptionCancelled: false, userID: userId });
};
