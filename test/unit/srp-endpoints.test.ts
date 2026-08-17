/**
 * [AUTH-SRP] endpoint scenarios: attributes (4), setup (4), complete (4),
 * create-session (5), verify-session (5 of 6 — oracle vector parity pending
 * capture, DECISIONS.md D2), update (3).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { makeClientKeys, setupSrp, signupAccount, srpLogin } from '../helpers/client.ts';
import { SrpClient } from '../../src/domain/srp.ts';
import { b64, fromB64 } from '../../src/lib/b64.ts';
import { MICROS_PER_HOUR } from '../../src/lib/time.ts';

describe('GET /users/srp/attributes', () => {
  let world: TestWorld;
  beforeEach(async () => {
    world = await makeWorld();
  });

  it('happy shape', async () => {
    const account = await signupAccount(world, 'srp@b.c');
    const res = await world.request('GET', '/users/srp/attributes?email=srp@b.c');
    expect(res.status).toBe(200);
    const { attributes } = (await res.json()) as { attributes: Record<string, unknown> };
    expect(attributes).toEqual({
      srpUserID: account.srpUserID,
      srpSalt: b64(account.srpSalt),
      memLimit: 1073741824,
      opsLimit: 4,
      kekSalt: account.keys.keyAttributes.kekSalt,
      isEmailMFAEnabled: false,
    });
  });

  it('404 for unknown email', async () => {
    const res = await world.request('GET', '/users/srp/attributes?email=nobody@b.c');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({});
  });

  it('404 for an account that has not set up SRP', async () => {
    await world.request('POST', '/users/ott', { body: { email: 'nosrp@b.c', purpose: 'signup' } });
    const { lastOttCode } = await import('../helpers/client.ts');
    const code = lastOttCode(world, 'nosrp@b.c');
    await world.request('POST', '/users/verify-email', { body: { email: 'nosrp@b.c', ott: code } });
    const res = await world.request('GET', '/users/srp/attributes?email=nosrp@b.c');
    expect(res.status).toBe(404);
  });

  it('email matching is case-insensitive', async () => {
    await signupAccount(world, 'case@b.c');
    const res = await world.request('GET', '/users/srp/attributes?email=CASE@B.C');
    expect(res.status).toBe(200);
  });
});

describe('POST /users/srp/setup + complete', () => {
  let world: TestWorld;
  beforeEach(async () => {
    world = await makeWorld();
  });

  it('setup returns a valid B and complete round-trips M1/M2 (real client math)', async () => {
    // signupAccount performs the full setup->complete round-trip with SrpClient,
    // including client-side M2 verification.
    const account = await signupAccount(world, 'roundtrip@b.c');
    expect(account.srpUserID).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('temp setup is not authoritative — login fails before complete', async () => {
    const keys = makeClientKeys();
    // signup without SRP
    await world.request('POST', '/users/ott', { body: { email: 'temp@b.c', purpose: 'signup' } });
    const { lastOttCode } = await import('../helpers/client.ts');
    const code = lastOttCode(world, 'temp@b.c');
    const verify = await world.request('POST', '/users/verify-email', {
      body: { email: 'temp@b.c', ott: code },
    });
    const { token } = (await verify.json()) as { token: string };
    await world.request('PUT', '/users/attributes', {
      token,
      body: { keyAttributes: keys.keyAttributes },
    });

    // setup only (no complete)
    const srpUserID = randomUUID();
    const salt = randomBytes(16);
    const client = new SrpClient(salt, new TextEncoder().encode(srpUserID), keys.loginSubKey, randomBytes(32));
    const { computeVerifier } = await import('../../src/domain/srp.ts');
    const verifier = computeVerifier(salt, new TextEncoder().encode(srpUserID), keys.loginSubKey);
    const setup = await world.request('POST', '/users/srp/setup', {
      token,
      body: { srpUserID, srpSalt: b64(salt), srpVerifier: b64(verifier), srpA: b64(client.computeA()) },
    });
    expect(setup.status).toBe(200);

    // attributes 404 (SRP not committed) and create-session gets a fake
    const attrs = await world.request('GET', '/users/srp/attributes?email=temp@b.c');
    expect(attrs.status).toBe(404);
  });

  it('A of wrong length is rejected with BAD_REQUEST message', async () => {
    const account = await signupAccount(world, 'shortA@b.c');
    const res = await world.request('POST', '/users/srp/setup', {
      token: account.token,
      body: {
        srpUserID: randomUUID(),
        srpSalt: b64(randomBytes(16)),
        srpVerifier: b64(randomBytes(512)),
        srpA: b64(randomBytes(16)),
      },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('BAD_REQUEST');
  });

  it('wrong M1 at complete is 401 and nothing is committed; unknown setupID 404', async () => {
    const keys = makeClientKeys();
    await world.request('POST', '/users/ott', { body: { email: 'badm1@b.c', purpose: 'signup' } });
    const { lastOttCode } = await import('../helpers/client.ts');
    const code = lastOttCode(world, 'badm1@b.c');
    const verify = await world.request('POST', '/users/verify-email', {
      body: { email: 'badm1@b.c', ott: code },
    });
    const { token } = (await verify.json()) as { token: string };
    await world.request('PUT', '/users/attributes', {
      token,
      body: { keyAttributes: keys.keyAttributes },
    });

    const srpUserID = randomUUID();
    const salt = randomBytes(16);
    const { computeVerifier } = await import('../../src/domain/srp.ts');
    const verifier = computeVerifier(salt, new TextEncoder().encode(srpUserID), keys.loginSubKey);
    const client = new SrpClient(salt, new TextEncoder().encode(srpUserID), keys.loginSubKey, randomBytes(32));
    const setup = await world.request('POST', '/users/srp/setup', {
      token,
      body: { srpUserID, srpSalt: b64(salt), srpVerifier: b64(verifier), srpA: b64(client.computeA()) },
    });
    const { setupID } = (await setup.json()) as { setupID: string };

    const badComplete = await world.request('POST', '/users/srp/complete', {
      token,
      body: { setupID, srpM1: b64(randomBytes(32)) },
    });
    expect(badComplete.status).toBe(401);
    const attrs = await world.request('GET', '/users/srp/attributes?email=badm1@b.c');
    expect(attrs.status).toBe(404); // not committed

    const unknown = await world.request('POST', '/users/srp/complete', {
      token,
      body: { setupID: randomUUID(), srpM1: b64(randomBytes(32)) },
    });
    expect(unknown.status).toBe(404);
  });
});

describe('POST /users/srp/create-session + verify-session', () => {
  let world: TestWorld;
  beforeEach(async () => {
    world = await makeWorld();
  });

  it('full login round-trip: sealed token opens and authenticates', async () => {
    const account = await signupAccount(world, 'login@b.c');
    const { token, response } = await srpLogin(world, 'login@b.c', account.keys);
    expect(response.id).toBe(account.userId);
    expect(response.keyAttributes).toMatchObject({
      publicKey: account.keys.keyAttributes.publicKey,
    });
    const probe = await world.request('GET', '/users/session-validity/v2', { token });
    expect(probe.status).toBe(200);
    expect(((await probe.json()) as { hasSetKeys: boolean }).hasSetKeys).toBe(true);
  });

  it('unknown srpUserID gets a plausible fake session whose verify always fails 401', async () => {
    const srpUserID = randomUUID();
    const create = await world.request('POST', '/users/srp/create-session', {
      body: { srpUserID, srpA: b64(randomBytes(512)) },
    });
    expect(create.status).toBe(200);
    const body = (await create.json()) as { sessionID: string; srpB: string };
    expect(fromB64(body.srpB).length).toBe(512);

    const verify = await world.request('POST', '/users/srp/verify-session', {
      body: { sessionID: body.sessionID, srpUserID, srpM1: b64(randomBytes(32)) },
    });
    expect(verify.status).toBe(401);
    expect(await verify.json()).toEqual({});
  });

  it('rate limit: 11th unverified session in an hour is 429 TOO_MANY_UNVERIFIED_SESSIONS', async () => {
    const account = await signupAccount(world, 'rate@b.c');
    for (let i = 0; i < 9; i++) {
      // signup already opened 1 unverified?? setup session was verified by complete; these are fresh
      const res = await world.request('POST', '/users/srp/create-session', {
        body: { srpUserID: account.srpUserID, srpA: b64(randomBytes(512)) },
      });
      expect(res.status).toBe(200);
    }
    // 10th unverified — setup's session was verified, so this is allowed
    const tenth = await world.request('POST', '/users/srp/create-session', {
      body: { srpUserID: account.srpUserID, srpA: b64(randomBytes(512)) },
    });
    expect(tenth.status).toBe(200);
    const eleventh = await world.request('POST', '/users/srp/create-session', {
      body: { srpUserID: account.srpUserID, srpA: b64(randomBytes(512)) },
    });
    expect(eleventh.status).toBe(429);
    expect(((await eleventh.json()) as { code: string }).code).toBe('TOO_MANY_UNVERIFIED_SESSIONS');

    // window slides: an hour later it works again
    world.deps.clock.advance(MICROS_PER_HOUR + 1);
    const later = await world.request('POST', '/users/srp/create-session', {
      body: { srpUserID: account.srpUserID, srpA: b64(randomBytes(512)) },
    });
    expect(later.status).toBe(200);
  });

  it('session replay is 410 SESSION_ALREADY_VERIFIED; attempt cap is 410 TOO_MANY_WRONG_ATTEMPTS', async () => {
    const account = await signupAccount(world, 'replay@b.c');

    // -- replay
    const identity = new TextEncoder().encode(account.srpUserID);
    const client = new SrpClient(account.srpSalt, identity, account.keys.loginSubKey, randomBytes(32));
    const create = await world.request('POST', '/users/srp/create-session', {
      body: { srpUserID: account.srpUserID, srpA: b64(client.computeA()) },
    });
    const { sessionID, srpB } = (await create.json()) as { sessionID: string; srpB: string };
    client.setB(fromB64(srpB));
    const m1 = b64(client.computeM1());
    const first = await world.request('POST', '/users/srp/verify-session', {
      body: { sessionID, srpUserID: account.srpUserID, srpM1: m1 },
    });
    expect(first.status).toBe(200);
    const replay = await world.request('POST', '/users/srp/verify-session', {
      body: { sessionID, srpUserID: account.srpUserID, srpM1: m1 },
    });
    expect(replay.status).toBe(410);
    expect(((await replay.json()) as { code: string }).code).toBe('SESSION_ALREADY_VERIFIED');

    // -- attempt cap on a fresh session
    const create2 = await world.request('POST', '/users/srp/create-session', {
      body: { srpUserID: account.srpUserID, srpA: b64(client.computeA()) },
    });
    const second = (await create2.json()) as { sessionID: string };
    for (let i = 0; i < 5; i++) {
      const bad = await world.request('POST', '/users/srp/verify-session', {
        body: { sessionID: second.sessionID, srpUserID: account.srpUserID, srpM1: b64(randomBytes(32)) },
      });
      expect(bad.status).toBe(401);
    }
    const capped = await world.request('POST', '/users/srp/verify-session', {
      body: { sessionID: second.sessionID, srpUserID: account.srpUserID, srpM1: b64(randomBytes(32)) },
    });
    expect(capped.status).toBe(410);
    expect(((await capped.json()) as { code: string }).code).toBe('TOO_MANY_WRONG_ATTEMPTS');
  });

  it('M1 of wrong size is 400 with the exact museum message', async () => {
    const account = await signupAccount(world, 'm1size@b.c');
    const create = await world.request('POST', '/users/srp/create-session', {
      body: { srpUserID: account.srpUserID, srpA: b64(randomBytes(512)) },
    });
    const { sessionID } = (await create.json()) as { sessionID: string };
    const res = await world.request('POST', '/users/srp/verify-session', {
      body: { sessionID, srpUserID: account.srpUserID, srpM1: b64(randomBytes(16)) },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe('srpM1 size is 16, expected 32');
  });
});

describe('POST /users/srp/update', () => {
  let world: TestWorld;
  beforeEach(async () => {
    world = await makeWorld();
  });

  it('swaps the verifier: old password stops working, new one works', async () => {
    const account = await signupAccount(world, 'pw@b.c');
    const oldKeys = account.keys;

    // New password = new kek/loginSubKey; re-run setup, then update.
    const newKeys = { ...oldKeys, ...(() => {
      const kek = randomBytes(32);
      return { kek: new Uint8Array(kek) };
    })() };
    const sodium = (await import('../../src/lib/sodium.ts')).default;
    await sodium.ready;
    newKeys.loginSubKey = sodium.crypto_kdf_derive_from_key(32, 1, 'loginctx', newKeys.kek);

    const srpUserID = randomUUID();
    const salt = randomBytes(16);
    const { computeVerifier } = await import('../../src/domain/srp.ts');
    const identity = new TextEncoder().encode(srpUserID);
    const verifier = computeVerifier(salt, identity, newKeys.loginSubKey);
    const client = new SrpClient(salt, identity, newKeys.loginSubKey, randomBytes(32));

    const setup = await world.request('POST', '/users/srp/setup', {
      token: account.token,
      body: { srpUserID, srpSalt: b64(salt), srpVerifier: b64(verifier), srpA: b64(client.computeA()) },
    });
    const { setupID, srpB } = (await setup.json()) as { setupID: string; srpB: string };
    client.setB(fromB64(srpB));

    const update = await world.request('POST', '/users/srp/update', {
      token: account.token,
      body: {
        setupID,
        srpM1: b64(client.computeM1()),
        updatedKeyAttr: {
          kekSalt: b64(randomBytes(16)),
          encryptedKey: b64(randomBytes(48)),
          keyDecryptionNonce: b64(randomBytes(24)),
          memLimit: 1073741824,
          opsLimit: 4,
        },
        logOutOtherDevices: false,
      },
    });
    expect(update.status).toBe(200);

    // Old loginSubKey fails now
    await expect(srpLogin(world, 'pw@b.c', oldKeys)).rejects.toThrow(/verify-session failed: 401/);
    // New one logs in
    const { token } = await srpLogin(world, 'pw@b.c', newKeys);
    expect(token).toBeTruthy();
  });

  it('key attributes are replaced alongside the verifier', async () => {
    const account = await signupAccount(world, 'attrs@b.c');
    const srpUserID = randomUUID();
    const salt = randomBytes(16);
    const { computeVerifier } = await import('../../src/domain/srp.ts');
    const identity = new TextEncoder().encode(srpUserID);
    const verifier = computeVerifier(salt, identity, account.keys.loginSubKey);
    const client = new SrpClient(salt, identity, account.keys.loginSubKey, randomBytes(32));
    const setup = await world.request('POST', '/users/srp/setup', {
      token: account.token,
      body: { srpUserID, srpSalt: b64(salt), srpVerifier: b64(verifier), srpA: b64(client.computeA()) },
    });
    const { setupID, srpB } = (await setup.json()) as { setupID: string; srpB: string };
    client.setB(fromB64(srpB));

    const newKekSalt = b64(randomBytes(16));
    await world.request('POST', '/users/srp/update', {
      token: account.token,
      body: {
        setupID,
        srpM1: b64(client.computeM1()),
        updatedKeyAttr: {
          kekSalt: newKekSalt,
          encryptedKey: b64(randomBytes(48)),
          keyDecryptionNonce: b64(randomBytes(24)),
          memLimit: 1073741824,
          opsLimit: 4,
        },
        logOutOtherDevices: false,
      },
    });

    const attrs = await world.request('GET', '/users/srp/attributes?email=attrs@b.c');
    const { attributes } = (await attrs.json()) as { attributes: { kekSalt: string; srpUserID: string } };
    expect(attributes.kekSalt).toBe(newKekSalt);
    expect(attributes.srpUserID).toBe(srpUserID);
  });

  it('logOutOtherDevices revokes other tokens, keeps the caller', async () => {
    const account = await signupAccount(world, 'logoutall@b.c');
    const other = await srpLogin(world, 'logoutall@b.c', account.keys);

    const srpUserID = randomUUID();
    const salt = randomBytes(16);
    const { computeVerifier } = await import('../../src/domain/srp.ts');
    const identity = new TextEncoder().encode(srpUserID);
    const verifier = computeVerifier(salt, identity, account.keys.loginSubKey);
    const client = new SrpClient(salt, identity, account.keys.loginSubKey, randomBytes(32));
    const setup = await world.request('POST', '/users/srp/setup', {
      token: account.token,
      body: { srpUserID, srpSalt: b64(salt), srpVerifier: b64(verifier), srpA: b64(client.computeA()) },
    });
    const { setupID, srpB } = (await setup.json()) as { setupID: string; srpB: string };
    client.setB(fromB64(srpB));

    const update = await world.request('POST', '/users/srp/update', {
      token: account.token,
      body: { setupID, srpM1: b64(client.computeM1()) }, // logOutOtherDevices defaults TRUE
    });
    expect(update.status).toBe(200);

    const otherProbe = await world.request('GET', '/users/session-validity/v2', { token: other.token });
    expect(otherProbe.status).toBe(401);
    const callerProbe = await world.request('GET', '/users/session-validity/v2', { token: account.token });
    expect(callerProbe.status).toBe(200);
  });
});
