/**
 * POST /users/srp/update (auth) — src: UpdateSRPAndKeysRequest.
 * Password change: verify M1 for the pending setup, swap the SRP auth,
 * merge updatedKeyAttr into key attributes, and (default TRUE) revoke all
 * other tokens.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { keys } from '../../domain/model.ts';
import { verifySrpSession } from '../../domain/srpSessions.ts';
import { commitSrpAuth } from './complete.ts';
import { getKeyAttributes, putKeyAttributes } from '../../domain/users.ts';
import { revokeOtherTokens } from '../../domain/sessions.ts';
import { errNotFound, errPermissionDenied } from '../../lib/errors.ts';

const bodySchema = z.object({
  setupID: z.string().uuid(),
  srpM1: z.string().min(1),
  updatedKeyAttr: z
    .object({
      kekSalt: z.string(),
      encryptedKey: z.string(),
      keyDecryptionNonce: z.string(),
      memLimit: z.number(),
      opsLimit: z.number(),
    })
    .optional(),
  logOutOtherDevices: z.boolean().nullish(),
});

export const updateSrp = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
  const { userId, token } = auth(c);

  const setup = await deps.db.get(keys.srpSetup(body.setupID).pk, 'META');
  if (!setup) throw errNotFound();
  if ((setup.userId as number) !== userId) throw errPermissionDenied();

  const srpM2 = await verifySrpSession(
    deps,
    setup.verifier as string,
    setup.sessionID as string,
    body.srpM1,
  );

  await commitSrpAuth(
    deps,
    userId,
    setup.srpUserID as string,
    setup.salt as string,
    setup.verifier as string,
  );

  if (body.updatedKeyAttr) {
    const existing = await getKeyAttributes(deps, userId);
    if (existing) {
      await putKeyAttributes(deps, userId, { ...existing, ...body.updatedKeyAttr });
    }
  }

  // museum: clearTokens defaults to true when logOutOtherDevices is absent.
  if (body.logOutOtherDevices !== false) {
    await revokeOtherTokens(deps, userId, token);
  }

  return c.json({ setupID: body.setupID, srpM2 });
};
