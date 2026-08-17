/**
 * [KEYS]/[ACCOUNT] — PUT /users/attributes (3), session-validity (2),
 * logout (2), sessions + delete session (3), details/v2 (3).
 * M2 gate: multi-device session lifecycle exercised end to end.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { makeClientKeys, signupAccount, srpLogin } from '../helpers/client.ts';

describe('PUT /users/attributes', () => {
  let world: TestWorld;
  beforeEach(async () => {
    world = await makeWorld();
  });

  it('stores and echoes via session-validity; second write is 403', async () => {
    const account = await signupAccount(world, 'keys@b.c');
    const probe = await world.request('GET', '/users/session-validity/v2', { token: account.token });
    const body = (await probe.json()) as { hasSetKeys: boolean; keyAttributes: Record<string, unknown> };
    expect(body.hasSetKeys).toBe(true);
    expect(body.keyAttributes.publicKey).toBe(account.keys.keyAttributes.publicKey);

    const again = await world.request('PUT', '/users/attributes', {
      token: account.token,
      body: { keyAttributes: makeClientKeys().keyAttributes },
    });
    expect(again.status).toBe(403); // museum: key attributes are already set
  });

  it('requires auth', async () => {
    const res = await world.request('PUT', '/users/attributes', {
      body: { keyAttributes: makeClientKeys().keyAttributes },
    });
    expect(res.status).toBe(401);
  });

  it('rejects unexpected KDF strength', async () => {
    const account = await signupAccount(world, 'kdf@b.c');
    void account;
    const world2 = await makeWorld();
    const acct2 = await (async () => {
      // fresh account with no keys yet
      await world2.request('POST', '/users/ott', { body: { email: 'kdf2@b.c', purpose: 'signup' } });
      const { lastOttCode } = await import('../helpers/client.ts');
      const code = lastOttCode(world2, 'kdf2@b.c');
      const verify = await world2.request('POST', '/users/verify-email', {
        body: { email: 'kdf2@b.c', ott: code },
      });
      return (await verify.json()) as { token: string };
    })();
    const bad = { ...makeClientKeys().keyAttributes, memLimit: 1073741824, opsLimit: 8 };
    const res = await world2.request('PUT', '/users/attributes', {
      token: acct2.token,
      body: { keyAttributes: bad },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe('Unexpected KDF strength');
  });
});

describe('session lifecycle (M2 gate)', () => {
  let world: TestWorld;
  beforeEach(async () => {
    world = await makeWorld();
  });

  it('logout kills only the calling token', async () => {
    const account = await signupAccount(world, 'lo@b.c');
    const second = await srpLogin(world, 'lo@b.c', account.keys);

    const res = await world.request('POST', '/users/logout', { token: second.token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});

    expect((await world.request('GET', '/users/session-validity/v2', { token: second.token })).status).toBe(401);
    expect((await world.request('GET', '/users/session-validity/v2', { token: account.token })).status).toBe(200);
  });

  it('sessions list contains both devices with metadata; remote revoke works', async () => {
    const account = await signupAccount(world, 'multi@b.c');
    const second = await srpLogin(world, 'multi@b.c', account.keys);

    const list = await world.request('GET', '/users/sessions', { token: account.token });
    expect(list.status).toBe(200);
    const { sessions } = (await list.json()) as { sessions: Array<Record<string, unknown>> };
    const tokens = sessions.map((s) => s.token);
    expect(tokens).toContain(account.token);
    expect(tokens).toContain(second.token);
    for (const s of sessions) {
      expect(typeof s.creationTime).toBe('number');
      expect(typeof s.lastUsedTime).toBe('number');
      expect(s).toHaveProperty('ua');
      expect(s).toHaveProperty('prettyUA');
      expect(s).toHaveProperty('ip');
    }

    // remote revoke of the second device
    const del = await world.request(
      'DELETE',
      `/users/session?token=${encodeURIComponent(second.token)}`,
      { token: account.token },
    );
    expect(del.status).toBe(200);
    expect((await world.request('GET', '/users/session-validity/v2', { token: second.token })).status).toBe(401);
  });

  it('cannot revoke another user token', async () => {
    const alice = await signupAccount(world, 'alice@b.c');
    const bob = await signupAccount(world, 'bob@b.c');
    await world.request('DELETE', `/users/session?token=${encodeURIComponent(bob.token)}`, {
      token: alice.token,
    });
    // bob still alive
    expect((await world.request('GET', '/users/session-validity/v2', { token: bob.token })).status).toBe(200);
  });
});

describe('GET /users/details/v2', () => {
  let world: TestWorld;
  beforeEach(async () => {
    world = await makeWorld();
  });

  it('fresh-account shape (capture-parity fields)', async () => {
    const account = await signupAccount(world, 'details@b.c');
    const res = await world.request('GET', '/users/details/v2', { token: account.token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.email).toBe('details@b.c');
    expect(body.usage).toBe(0);
    expect(body.fileCount).toBe(0);
    expect(body.sharedCollectionsCount).toBe(0);
    expect(body.storageBonus).toBe(0);
    expect(body.subscription).toMatchObject({
      productID: 'free',
      originalTransactionID: 'none',
      userID: account.userId,
    });
    expect((body.subscription as { storage: number }).storage).toBeGreaterThan(0);
    expect(body.profileData).toEqual({
      canDisableEmailMFA: true,
      isEmailMFAEnabled: false,
      isTwoFactorEnabled: false,
      passkeyCount: 0,
    });
  });

  it('memoryCount=false omits fileCount', async () => {
    const account = await signupAccount(world, 'nomem@b.c');
    const res = await world.request('GET', '/users/details/v2?memoryCount=false', {
      token: account.token,
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.fileCount).toBeUndefined();
  });

  it('requires auth', async () => {
    expect((await world.request('GET', '/users/details/v2')).status).toBe(401);
  });
});
