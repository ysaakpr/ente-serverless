/**
 * GET /users/session-validity/v2 (auth) — src: pkg/api/user.go
 * GetSessionValidityV2: {"hasSetKeys":true,"keyAttributes":{...}} or
 * {"hasSetKeys":false}. Auth middleware supplies the 401 for dead tokens.
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { getKeyAttributes } from '../../domain/users.ts';

export const sessionValidity = (deps: Deps) => async (c: Context) => {
  const { userId } = auth(c);
  const keyAttributes = await getKeyAttributes(deps, userId);
  if (!keyAttributes) return c.json({ hasSetKeys: false });
  return c.json({ hasSetKeys: true, keyAttributes });
};
