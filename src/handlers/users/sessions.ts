/**
 * GET /users/sessions + DELETE /users/session?token= (auth) —
 * src: ente/user.go Session, pkg/api/user.go GetActiveSessions/TerminateSession.
 * The list is per-app, like museum's repo query.
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { listTokenRows } from '../../domain/sessions.ts';
import { revokeUserToken } from '../../domain/sessions.ts';
import { errBadRequestSentinel } from '../../lib/errors.ts';

export const getSessions = (deps: Deps) => async (c: Context) => {
  const { userId, app } = auth(c);
  const rows = await listTokenRows(deps, userId);
  const sessions = rows
    .filter((r) => r.app === app)
    .map((r) => ({
      token: r.token,
      creationTime: r.creationTime,
      ip: r.ip,
      ua: r.ua,
      prettyUA: r.ua,
      lastUsedTime: r.lastUsedTime,
    }));
  return c.json({ sessions });
};

export const terminateSession = (deps: Deps) => async (c: Context) => {
  const { userId } = auth(c);
  const token = c.req.query('token');
  if (!token) throw errBadRequestSentinel();
  await revokeUserToken(deps, userId, token); // silently no-op when not owned (museum deletes by user+token)
  return c.json({});
};
