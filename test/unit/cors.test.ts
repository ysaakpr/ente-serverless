/** CORS middleware (gate finding D29) — preflight + every-response headers. */

import { beforeAll, describe, expect, it } from 'vitest';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';

let world: TestWorld;

beforeAll(async () => {
  world = await makeWorld();
});

const ORIGIN = 'http://localhost:3000';

/** Verbatim from the 2026-08-17 museum oracle capture (see src/middleware/cors.ts). */
const ALLOW_HEADERS =
  'Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, X-Auth-Token, ' +
  'X-Space-Session-Token, X-Ente-Space-Link-Auth, X-Auth-Access-Token, ' +
  'X-Cast-Access-Token, X-Auth-Access-Token-JWT, X-Auth-Link-Device-Token, ' +
  'X-Client-Package, X-Client-Version, X-Paste-Consume, Authorization, accept, ' +
  'origin, Cache-Control, X-Requested-With, upgrade-insecure-requests, Range';

describe('CORS', () => {
  it('answers the OPTIONS /users/ott preflight 200 with an empty body', async () => {
    const res = await world.app.request('/users/ott', {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-client-package',
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-methods')).toBe(
      'POST, OPTIONS, GET, PUT, PATCH, DELETE',
    );
    expect(res.headers.get('access-control-allow-headers')).toBe(ALLOW_HEADERS);
    expect(res.headers.get('access-control-expose-headers')).toBe(
      'X-Request-Id, X-Ente-Link-Device-Token',
    );
    expect(res.headers.get('access-control-max-age')).toBe('1728000');
  });

  it('preflights an unauthenticated route without consuming auth', async () => {
    // Preflight carries no X-Auth-Token; museum still answers 200, never 401.
    const res = await world.app.request('/files/upload-urls', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET' },
    });
    expect(res.status).toBe(200);
  });

  it('echoes any origin verbatim (museum accepts all, credentials forbid `*`)', async () => {
    for (const origin of ['https://web.ente.io', 'http://192.168.1.48:3000']) {
      const res = await world.app.request('/ping', { headers: { Origin: origin } });
      expect(res.headers.get('access-control-allow-origin'), origin).toBe(origin);
    }
  });

  it('rides on real (non-preflight) responses too, and does not disturb the body', async () => {
    const res = await world.app.request('/ping', { headers: { Origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'pong', id: world.deps.config.instanceId });
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('emits an empty allow-origin when the request carries no Origin', async () => {
    const res = await world.app.request('/ping');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('');
  });

  it('leaves error statuses intact while still sending the headers', async () => {
    const res = await world.app.request('/files/upload-urls', { headers: { Origin: ORIGIN } });
    expect(res.status).toBe(401); // no X-Auth-Token
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });
});
