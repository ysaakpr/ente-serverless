/**
 * GET /users/sessions + DELETE /users/session?token= (auth) —
 * src: ente/user.go Session, pkg/api/user.go GetActiveSessions/TerminateSession
 * + pkg/controller/user/userauth.go (museum main, upstream 0e2d6b2473 /
 * d115d57593). The list is per-app, like museum's repo query.
 *
 * Sessions are identified by an OPAQUE id, never the bearer token:
 * `th:` + base64url(sha256(token)) without padding, plus `isCurrent` for the
 * caller's own session. DELETE accepts that id or (legacy clients) a raw
 * token; terminating the CURRENT session this way is a 400 — museum steers
 * the client to /users/logout. A malformed `th:` id is a 400; an unknown or
 * foreign one is a silent 200 no-op (museum deletes by user + hash).
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { listTokenRows } from '../../domain/sessions.ts';
import { tokenHash } from '../../domain/tokens.ts';
import { badRequest } from '../../lib/errors.ts';

const SESSION_ID_PREFIX = 'th:';

const sessionId = (token: string): string =>
  SESSION_ID_PREFIX + Buffer.from(tokenHash(token), 'hex').toString('base64url');

/** Identifier -> the hex sha256 our TOKEN# rows are keyed by. */
const identifierHash = (identifier: string): string => {
  if (!identifier.startsWith(SESSION_ID_PREFIX)) return tokenHash(identifier);
  const encoded = identifier.slice(SESSION_ID_PREFIX.length);
  const raw = Buffer.from(encoded, 'base64url');
  // Reject anything that does not round-trip: museum decodes with
  // RawURLEncoding and requires exactly 32 bytes.
  if (raw.length !== 32 || raw.toString('base64url') !== encoded) {
    throw badRequest('invalid session identifier');
  }
  return raw.toString('hex');
};

export const getSessions = (deps: Deps) => async (c: Context) => {
  const { userId, app, token } = auth(c);
  const rows = await listTokenRows(deps, userId);
  const sessions = rows
    .filter((r) => r.app === app)
    .map((r) => ({
      token: sessionId(r.token),
      isCurrent: r.token === token,
      creationTime: r.creationTime,
      ip: r.ip,
      ua: r.ua,
      prettyUA: r.ua,
      lastUsedTime: r.lastUsedTime,
    }));
  return c.json({ sessions });
};

export const terminateSession = (deps: Deps) => async (c: Context) => {
  const { userId, token } = auth(c);
  const hash = identifierHash(c.req.query('token') ?? '');
  if (hash === tokenHash(token)) throw badRequest('use logout to terminate the current session');
  const row = await deps.db.get<{ pk: string; sk: string; userId: number }>(`TOKEN#${hash}`, 'META');
  if (row && row.userId === userId) await deps.db.delete(row.pk, row.sk);
  return c.json({});
};
