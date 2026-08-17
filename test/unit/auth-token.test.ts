/**
 * Auth token transport (gate finding D32). The web/desktop client loads
 * /files/preview/:fileID as an image source, so the token can only travel in
 * the query string — museum accepts it there on every private route.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { tokenHash } from '../../src/domain/tokens.ts';
import { MICROS_PER_SECOND } from '../../src/lib/time.ts';

let world: TestWorld;
let account: Account;

beforeEach(async () => {
  world = await makeWorld();
  account = await signupAccount(world, 'authtoken@b.c');
});

/** Bypasses the helper's header injection so the query param is the only auth. */
const bare = (path: string) => world.app.request(path);

describe('auth token transport', () => {
  it('accepts ?token= with no header at all', async () => {
    const res = await bare(`/users/details/v2?token=${encodeURIComponent(account.token)}`);
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      email: 'authtoken@b.c',
    });
  });

  it('accepts ?token= on every private route shape, not just the redirects', async () => {
    const routes = [
      '/users/details/v2',
      '/collections/v2',
      '/trash/v2/diff?sinceTime=0',
      '/user-entity/key?type=location',
    ];
    for (const route of routes) {
      const sep = route.includes('?') ? '&' : '?';
      const res = await bare(`${route}${sep}token=${encodeURIComponent(account.token)}`);
      expect(res.status, route).not.toBe(401);
    }
  });

  it('authenticates GET /files/preview/:fileID by query token (the 401 loop)', async () => {
    // Unknown fileID: what matters is that auth passed, so it is not a 401.
    const res = await bare(`/files/preview/404404?token=${encodeURIComponent(account.token)}`);
    expect(res.status).not.toBe(401);
  });

  it('still rejects the same route with no token', async () => {
    const res = await bare('/files/preview/404404');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'missing token' });
  });

  it('rejects a garbage query token', async () => {
    const res = await bare('/users/details/v2?token=not-a-real-token');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid token' });
  });

  it('lets a present header win over a garbage query param', async () => {
    const res = await world.request('GET', '/users/details/v2?token=garbage', {
      token: account.token,
    });
    expect(res.status).toBe(200);
  });

  it('does not give a garbage header a second chance via the query', async () => {
    const res = await world.request(
      'GET',
      `/users/details/v2?token=${encodeURIComponent(account.token)}`,
      { token: 'garbage-header-token' },
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid token' });
  });

  it('treats an empty query token as missing', async () => {
    const res = await bare('/users/details/v2?token=');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'missing token' });
  });
});

/** Let the middleware's fire-and-forget lastUsedTime bump land. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Idle expiry (D40). Museum's `tokens` table has NO expiry column — verified
 * against the oracle's Postgres schema — so OFF is the parity default and these
 * pin both halves: that the default really is off, and that the opt-in works.
 */
describe('session idle expiry', () => {
  const TEN_YEARS = 10 * 365 * 24 * 3600 * MICROS_PER_SECOND;

  it('is off by default — a token idle for ten years still authenticates', async () => {
    expect(world.deps.config.sessionIdleExpirySeconds).toBe(0);
    world.deps.clock.advance(TEN_YEARS);
    const res = await world.request('GET', '/users/details/v2', { token: account.token });
    expect(res.status).toBe(200);
  });

  it('when configured, an idle token is revoked and reads as invalid', async () => {
    world.deps.config.sessionIdleExpirySeconds = 3600;
    world.deps.clock.advance(2 * 3600 * MICROS_PER_SECOND);

    const res = await world.request('GET', '/users/details/v2', { token: account.token });
    expect(res.status).toBe(401);
    // Same body a revoked token gets, so expiry adds no new wire shape (D32).
    expect(await res.json()).toEqual({ error: 'invalid token' });

    // Actually revoked, not just rejected.
    await flush();
    expect(await world.deps.db.get(`TOKEN#${tokenHash(account.token)}`, 'META')).toBeNull();
  });

  it('activity inside the window keeps the session alive indefinitely', async () => {
    world.deps.config.sessionIdleExpirySeconds = 3600;

    // Half a window of idling, then a request — which must bump lastUsedTime.
    world.deps.clock.advance(1800 * MICROS_PER_SECOND);
    expect((await world.request('GET', '/users/details/v2', { token: account.token })).status).toBe(200);
    await flush();
    const bumped = await world.deps.db.get(`TOKEN#${tokenHash(account.token)}`, 'META');
    expect(bumped!.lastUsedTime).toBe(world.deps.clock.nowMicros());

    // Another half window. Past the limit measured from LOGIN, inside it measured
    // from the bump — so a 401 here would mean the bump is not being read.
    world.deps.clock.advance(1800 * MICROS_PER_SECOND);
    expect((await world.request('GET', '/users/details/v2', { token: account.token })).status).toBe(200);
  });

  it('survives a token row with no lastUsedTime by falling back to creationTime', async () => {
    world.deps.config.sessionIdleExpirySeconds = 3600;
    const pk = `TOKEN#${tokenHash(account.token)}`;
    await world.deps.db.update(pk, 'META', { lastUsedTime: undefined });

    // Fresh creationTime -> still valid.
    expect((await world.request('GET', '/users/details/v2', { token: account.token })).status).toBe(200);
  });
});

/**
 * The token travels in the query string on every private route (D32), so the
 * access log must never render a query string — that is the one place a bearer
 * token could start leaking into CloudWatch. Guarding the logger rather than
 * trusting it stays right.
 */
describe('access log never contains the token', () => {
  it('logs the path only, with logRequests on', async () => {
    const logWorld = await makeWorld({ logRequests: true });
    const acct = await signupAccount(logWorld, 'logged@b.c');
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.join(' '));
    try {
      await logWorld.app.request(`/users/details/v2?token=${encodeURIComponent(acct.token)}`);
    } finally {
      console.log = original;
    }

    expect(lines.some((l) => l.includes('/users/details/v2'))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain(acct.token);
      expect(line).not.toContain('token=');
      expect(line).not.toContain('?');
    }
  });
});
