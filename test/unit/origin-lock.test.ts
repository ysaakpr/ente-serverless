/**
 * Origin lock (security review 2026-08-17, finding 4). The Function URL is a
 * tofu output and reachable directly, so any edge control (WAF, response
 * headers) is bypassable until the app itself refuses requests that did not
 * come through CloudFront — proven by the shared secret header CloudFront
 * injects at the origin. Off by default so make dev / make lan keep working.
 */

import { describe, expect, it } from 'vitest';
import { makeWorld } from '../helpers/deps.ts';

describe('origin lock', () => {
  it('is OFF by default — no header needed (make dev / make lan)', async () => {
    const world = await makeWorld();
    const res = await world.request('GET', '/ping');
    expect(res.status).toBe(200);
  });

  it('with ORIGIN_SECRET set, a request without the header is a bare 403', async () => {
    const world = await makeWorld({ originSecret: 'edge-secret' });
    const res = await world.request('GET', '/ping');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({});
  });

  it('a wrong secret is also refused', async () => {
    const world = await makeWorld({ originSecret: 'edge-secret' });
    const res = await world.request('GET', '/ping', {
      headers: { 'x-origin-secret': 'wrong' },
    });
    expect(res.status).toBe(403);
  });

  it('the CloudFront-injected header opens every route, preflights included', async () => {
    const world = await makeWorld({ originSecret: 'edge-secret' });
    const ok = await world.request('GET', '/ping', {
      headers: { 'x-origin-secret': 'edge-secret' },
    });
    expect(ok.status).toBe(200);

    const preflight = await world.request('OPTIONS', '/users/ott', {
      headers: { 'x-origin-secret': 'edge-secret', origin: 'https://web.ente.io' },
    });
    expect(preflight.status).toBe(200); // museum's CORS shape survives the lock
  });
});
