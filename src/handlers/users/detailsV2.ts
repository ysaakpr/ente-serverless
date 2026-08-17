/**
 * GET /users/details/v2 (auth) — src: ente/details/userdetails.go
 * UserDetailsResponse + pkg/controller/user/user_details.go. Core scope:
 * no family, no passkeys, no locker; bonus zeros.
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { keys } from '../../domain/model.ts';
import { getUser } from '../../domain/users.ts';
import { freeSubscription } from '../../domain/billing.ts';
import { errNotFound } from '../../lib/errors.ts';

export const detailsV2 = (deps: Deps) => async (c: Context) => {
  const { userId } = auth(c);
  const fetchMemoryCount = (c.req.query('memoryCount') ?? 'true') === 'true';

  const user = await getUser(deps, userId);
  if (!user) throw errNotFound();

  const usageRow = await deps.db.get(keys.userUsage(userId).pk, 'USAGE');
  const usage = (usageRow?.bytes as number | undefined) ?? 0;
  const fileCount = (usageRow?.fileCount as number | undefined) ?? 0;
  const srp = await deps.db.get(keys.userSrp(userId).pk, 'SRP');

  const response: Record<string, unknown> = {
    email: user.email,
    usage,
    subscription: freeSubscription(deps, userId),
    storageBonus: 0,
    profileData: {
      canDisableEmailMFA: srp !== null,
      isEmailMFAEnabled: false,
      isTwoFactorEnabled: false,
      passkeyCount: 0,
    },
    bonusData: { storageBonuses: [] },
  };
  if (fetchMemoryCount) {
    response.fileCount = fileCount;
    response.sharedCollectionsCount = 0;
  }
  return c.json(response);
};
