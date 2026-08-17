/** [AUTH-OTT] POST /users/verify-email — 6 scenarios. */

import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { lastOttCode, makeClientKeys, openEncryptedToken, signupAccount } from '../helpers/client.ts';

const sendAndGetCode = async (world: TestWorld, email: string, purpose = 'signup') => {
  const res = await world.request('POST', '/users/ott', { body: { email, purpose } });
  if (res.status !== 200) throw new Error(`ott ${res.status}`);
  return lastOttCode(world, email);
};

describe('POST /users/verify-email', () => {
  let world: TestWorld;
  beforeEach(async () => {
    world = await makeWorld();
  });

  it('new-user signup returns id + plaintext token, no keyAttributes', async () => {
    const code = await sendAndGetCode(world, 'new@b.c');
    const res = await world.request('POST', '/users/verify-email', {
      body: { email: 'new@b.c', ott: code },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.id).toBe('number');
    expect(typeof body.token).toBe('string');
    expect(body.keyAttributes).toBeUndefined();
    expect(body.encryptedToken).toBeUndefined();
    // always-rendered empties (Go json tags without omitempty)
    expect(body.passkeySessionID).toBe('');
    expect(body.twoFactorSessionID).toBe('');
    expect(body.twoFactorSessionIDV2).toBe('');
    expect(body.accountsUrl).toBe('');
  });

  it('existing user with keys gets a sealed encryptedToken that opens with the secret key', async () => {
    const account = await signupAccount(world, 'full@b.c');
    const code = await sendAndGetCode(world, 'full@b.c', 'login');
    const res = await world.request('POST', '/users/verify-email', {
      body: { email: 'full@b.c', ott: code },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.token).toBeUndefined();
    expect(body.keyAttributes).toMatchObject({ publicKey: account.keys.keyAttributes.publicKey });
    const token = openEncryptedToken(body.encryptedToken as string, account.keys);
    // the unsealed token authenticates
    const probe = await world.request('GET', '/users/session-validity/v2', { token });
    expect(probe.status).toBe(200);
  });

  it('wrong code is 401 {}', async () => {
    await sendAndGetCode(world, 'w@b.c');
    const res = await world.request('POST', '/users/verify-email', {
      body: { email: 'w@b.c', ott: '000000' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({});
  });

  it('replayed code is rejected (single use)', async () => {
    const code = await sendAndGetCode(world, 'r@b.c');
    const first = await world.request('POST', '/users/verify-email', {
      body: { email: 'r@b.c', ott: code },
    });
    expect(first.status).toBe(200);
    const replay = await world.request('POST', '/users/verify-email', {
      body: { email: 'r@b.c', ott: code },
    });
    expect(replay.status).toBe(410); // consumed -> no active OTT
  });

  it('attempt cap locks out after 20 wrong codes (429)', async () => {
    await sendAndGetCode(world, 'cap@b.c');
    for (let i = 0; i < 20; i++) {
      const res = await world.request('POST', '/users/verify-email', {
        body: { email: 'cap@b.c', ott: '999999' },
      });
      expect(res.status).toBe(401);
    }
    const locked = await world.request('POST', '/users/verify-email', {
      body: { email: 'cap@b.c', ott: '999999' },
    });
    expect(locked.status).toBe(429);
  });

  it('token row is stored under a hash key, with the plaintext retrievable for sessions', async () => {
    const code = await sendAndGetCode(world, 't@b.c');
    const res = await world.request('POST', '/users/verify-email', {
      body: { email: 't@b.c', ott: code },
    });
    const { token } = (await res.json()) as { token: string };
    const hash = createHash('sha256').update(token).digest('hex');
    const row = await world.deps.db.get(`TOKEN#${hash}`, 'META');
    expect(row).not.toBeNull();
    expect(row!.token).toBe(token);
  });
});
