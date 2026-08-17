/**
 * X-Auth-Token middleware. Museum's middleware rejects with 401 and an empty
 * JSON body; token lookup is by hash, lastUsed bumped on every hit.
 */

import type { Context, Next } from 'hono';
import type { Deps } from '../deps.ts';
import { keys } from '../domain/model.ts';
import { tokenHash } from '../domain/tokens.ts';
import { appFromClientPackage, type App } from '../domain/apps.ts';

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
  const token = c.req.header('X-Auth-Token');
  if (!token) return c.json({}, 401);
  const row = await deps.db.get<TokenRow>(keys.token(tokenHash(token)).pk, 'META');
  if (!row) return c.json({}, 401);
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
