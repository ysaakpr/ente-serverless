/**
 * Auth middleware. Token lookup is by hash, lastUsed bumped on every hit.
 *
 * The token arrives EITHER in X-Auth-Token OR in a `token` query param, header
 * first. The query fallback is not optional: /files/preview/:fileID and
 * /files/download/:fileID answer 307 redirects and the web/desktop client
 * loads them as image sources, which cannot carry custom headers (D32).
 *
 * Oracle capture 2026-08-17 (ghcr.io/ente/server@sha256:f646b68a…), against
 * /users/details/v2, /collections/v2, /files/preview/1, /files/download/1,
 * /files/preview/v2/1, /trash/v2/diff:
 *   - `?token=` is accepted on EVERY private route, not just the redirects;
 *   - valid header + garbage query -> 200, garbage header + valid query -> 401,
 *     i.e. a present header wins and there is no second chance;
 *   - 401 bodies are {"error":"missing token"} and {"error":"invalid token"} —
 *     NOT the bare {} this file previously claimed.
 */

import type { Context, Next } from 'hono';
import type { Deps } from '../deps.ts';
import { keys } from '../domain/model.ts';
import { tokenHash } from '../domain/tokens.ts';
import { appFromClientPackage, type App } from '../domain/apps.ts';
import { MICROS_PER_SECOND } from '../lib/time.ts';

export interface AuthInfo {
  userId: number;
  token: string;
  app: App;
}

export interface TokenRow {
  pk: string;
  sk: string;
  userId: number;
  token: string;
  app: App;
  creationTime: number;
  lastUsedTime: number;
  ip: string;
  ua: string;
  gsi3pk: string;
  gsi3sk: string;
  [attr: string]: unknown;
}

export const requireAuth = (deps: Deps) => async (c: Context, next: Next) => {
  // `||`, not `??`: Go reads the header into a string and falls through on the
  // zero value, so an empty header behaves the same as an absent one.
  const token = c.req.header('X-Auth-Token') || c.req.query('token');
  if (!token) return c.json({ error: 'missing token' }, 401);
  const row = await deps.db.get<TokenRow>(keys.token(tokenHash(token)).pk, 'META');
  if (!row) return c.json({ error: 'invalid token' }, 401);

  // Optional idle expiry (SESSION_IDLE_EXPIRY_SECONDS, default 0 = off, which is
  // museum parity — see D40). `lastUsedTime` is bumped below on every hit but was
  // never READ before this, so a token recovered from anywhere stayed valid for
  // ever. Falls back to creationTime because the bump is fire-and-forget and may
  // legitimately be missing. An expired token is revoked and reported exactly
  // like a revoked one, so this adds no new wire shape.
  const idleLimit = deps.config.sessionIdleExpirySeconds;
  if (idleLimit > 0) {
    const lastSeen = Math.max(row.lastUsedTime ?? 0, row.creationTime ?? 0);
    if (deps.clock.nowMicros() - lastSeen > idleLimit * MICROS_PER_SECOND) {
      deps.db.delete(row.pk, row.sk).catch(() => {});
      return c.json({ error: 'invalid token' }, 401);
    }
  }

  c.set('auth', {
    userId: row.userId,
    token,
    app: row.app ?? appFromClientPackage(c.req.header('X-Client-Package')),
  } satisfies AuthInfo);
  // Fire-and-forget freshness bump; failure must not fail the request.
  deps.db
    .update(row.pk, row.sk, { lastUsedTime: deps.clock.nowMicros() })
    .catch(() => {});
  await next();
};

export const auth = (c: Context): AuthInfo => c.get('auth') as AuthInfo;
