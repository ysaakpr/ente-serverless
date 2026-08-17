/**
 * Auth token transport (gate finding D32). The web/desktop client loads
 * /files/preview/:fileID as an image source, so the token can only travel in
 * the query string — museum accepts it there on every private route.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';

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
