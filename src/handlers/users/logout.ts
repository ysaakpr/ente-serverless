/** POST /users/logout (auth) — revokes the calling token only. Response {}. */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { revokeToken } from '../../domain/sessions.ts';

export const logout = (deps: Deps) => async (c: Context) => {
  await revokeToken(deps, auth(c).token);
  return c.json({});
};
