/** [AUTH-OTT] POST /users/ott — 6 scenarios (integration SES case in test/integration). */

import { beforeEach, describe, expect, it } from 'vitest';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { lastOttCode, signupAccount } from '../helpers/client.ts';
import { MICROS_PER_HOUR } from '../../src/lib/time.ts';

describe('POST /users/ott', () => {
  let world: TestWorld;
  beforeEach(async () => {
    world = await makeWorld();
  });

  it('200 + mail sent with a 6-digit code', async () => {
    const res = await world.request('POST', '/users/ott', {
      body: { email: 'a@b.c', purpose: 'signup', client: 'test' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(''); // museum: c.Status(200), empty body
    expect(world.deps.mail.sent).toHaveLength(1);
    expect(lastOttCode(world, 'a@b.c')).toMatch(/^\d{6}$/);
  });

  it('stores the code hashed, not plaintext', async () => {
    await world.request('POST', '/users/ott', { body: { email: 'a@b.c', purpose: 'signup' } });
    const code = lastOttCode(world, 'a@b.c');
    const rows = world.deps.db.dump().filter((r) => r.pk.startsWith('OTT#'));
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows)).not.toContain(code);
  });

  it('TTL expiry rejects the code (410)', async () => {
    await world.request('POST', '/users/ott', { body: { email: 'a@b.c', purpose: 'signup' } });
    const code = lastOttCode(world, 'a@b.c');
    world.deps.clock.advance(MICROS_PER_HOUR + 1);
    const res = await world.request('POST', '/users/verify-email', {
      body: { email: 'a@b.c', ott: code },
    });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({});
  });

  it('active-code cap fires 429 at the 11th request', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await world.request('POST', '/users/ott', {
        body: { email: 'a@b.c', purpose: 'signup' },
      });
      expect(res.status).toBe(200);
    }
    const eleventh = await world.request('POST', '/users/ott', {
      body: { email: 'a@b.c', purpose: 'signup' },
    });
    expect(eleventh.status).toBe(429);
    expect(await eleventh.json()).toEqual({});
  });

  it('disclosure matches museum: signup+existing 409, login+missing 404', async () => {
    await signupAccount(world, 'existing@example.com');
    const signupExisting = await world.request('POST', '/users/ott', {
      body: { email: 'existing@example.com', purpose: 'signup' },
    });
    expect(signupExisting.status).toBe(409);
    expect(await signupExisting.json()).toEqual({
      code: 'USER_ALREADY_REGISTERED',
      message: 'User is already registered',
    });

    const loginMissing = await world.request('POST', '/users/ott', {
      body: { email: 'missing@example.com', purpose: 'login' },
    });
    expect(loginMissing.status).toBe(404);
    expect(await loginMissing.json()).toEqual({
      code: 'USER_NOT_REGISTERED',
      message: 'User is not registered',
    });
  });

  it('login for an account without keys is 404 USER_SIGNUP_INCOMPLETE', async () => {
    await world.request('POST', '/users/ott', { body: { email: 'half@b.c', purpose: 'signup' } });
    const code = lastOttCode(world, 'half@b.c');
    await world.request('POST', '/users/verify-email', { body: { email: 'half@b.c', ott: code } });

    const res = await world.request('POST', '/users/ott', {
      body: { email: 'half@b.c', purpose: 'login' },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('USER_SIGNUP_INCOMPLETE');
  });
});
