/**
 * GET /users/details/v2 (auth) — src: ente/details/userdetails.go
 * UserDetailsResponse + pkg/controller/user/user_details.go. Core scope:
 * no family, no passkeys, no locker; bonus zeros. TOTP 2FA is real as of D36,
 * and the capture shows profileData.isTwoFactorEnabled flipping to true once
 * it is enabled, so it reads the stored state.
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { keys } from '../../domain/model.ts';
import { getUser } from '../../domain/users.ts';
import { freeSubscription } from '../../domain/billing.ts';
import { isTwoFactorEnabled } from '../../domain/twoFactor.ts';
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

  // Key order mirrors museum's struct order (capture 2026-08-17) so the
  // capture-diff harness (D2) sees byte-identical envelopes.
  const response: Record<string, unknown> = {
    email: user.email,
    usage,
    subscription: freeSubscription(deps, user),
    ...(fetchMemoryCount ? { fileCount, sharedCollectionsCount: 0 } : {}),
    storageBonus: 0,
    profileData: {
      canDisableEmailMFA: srp !== null,
      isEmailMFAEnabled: false,
      isTwoFactorEnabled: await isTwoFactorEnabled(deps, userId),
      passkeyCount: 0,
    },
    bonusData: { storageBonuses: [] },
  };
  return c.json(response);
};
