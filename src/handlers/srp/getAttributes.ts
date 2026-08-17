/**
 * GET /users/srp/attributes?email= — src: ente/srp.go GetSRPAttributesResponse.
 * 404 when the account has no SRP set up (web client branches on it).
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { keys } from '../../domain/model.ts';
import { getKeyAttributes, getUserIdByEmail } from '../../domain/users.ts';
import { errBadRequestSentinel, errNotFound } from '../../lib/errors.ts';

export const getSrpAttributes = (deps: Deps) => async (c: Context) => {
  const email = c.req.query('email');
  if (!email) throw errBadRequestSentinel();

  const userId = await getUserIdByEmail(deps, email);
  if (userId === null) throw errNotFound();

  const srp = await deps.db.get(keys.userSrp(userId).pk, 'SRP');
  if (!srp) throw errNotFound();
  const keyAttrs = await getKeyAttributes(deps, userId);
  if (!keyAttrs) throw errNotFound();
  const user = await deps.db.get(keys.user(userId).pk, 'META');

  return c.json({
    attributes: {
      srpUserID: srp.srpUserID,
      srpSalt: srp.salt,
      memLimit: keyAttrs.memLimit,
      opsLimit: keyAttrs.opsLimit,
      kekSalt: keyAttrs.kekSalt,
      isEmailMFAEnabled: user?.isEmailMFAEnabled === true,
    },
  });
};
