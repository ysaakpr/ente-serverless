/**
 * [AUTH-2FA] TOTP end to end (gate finding D36) — every shape here was taken
 * from the oracle capture. The login-path cases matter most: a bug there
 * locks a real user out of their own account.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import sodium from '../../src/lib/sodium.ts';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { lastOttCode, openEncryptedToken, signupAccount, srpLogin, type Account } from '../helpers/client.ts';
import { totpCode, TOTP_PERIOD_SECONDS } from '../../src/domain/totp.ts';
import { TWO_FACTOR_SESSION_VALIDITY_MICROS } from '../../src/domain/twoFactor.ts';
import { b64 } from '../../src/lib/b64.ts';
import { MICROS_PER_MINUTE, MICROS_PER_SECOND } from '../../src/lib/time.ts';

let world: TestWorld;
let account: Account;

beforeEach(async () => {
  world = await makeWorld();
  account = await signupAccount(world, '2fa@b.c');
});

const now = () => world.deps.clock.nowMicros();

/** setup -> enable, returning the TOTP secret the client would have kept. */
const enable2fa = async (): Promise<string> => {
  const setup = await world.request('POST', '/users/two-factor/setup', { token: account.token });
  expect(setup.status).toBe(200);
  const { secretCode } = (await setup.json()) as { secretCode: string; qrCode: string };

  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const recoveryKey = sodium.crypto_secretbox_keygen();
  const res = await world.request('POST', '/users/two-factor/enable', {
    token: account.token,
    body: {
      code: totpCode(secretCode, now()),
      encryptedTwoFactorSecret: b64(
        sodium.crypto_secretbox_easy(new TextEncoder().encode(secretCode), nonce, recoveryKey),
      ),
      twoFactorSecretDecryptionNonce: b64(nonce),
    },
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe(''); // museum sends an empty body
  return secretCode;
};

describe('2FA setup + enable', () => {
  it('setup returns a 32-char secret and a decodable 200x200 PNG', async () => {
    const res = await world.request('POST', '/users/two-factor/setup', { token: account.token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { secretCode: string; qrCode: string };
    expect(Object.keys(body)).toEqual(['secretCode', 'qrCode']);
    expect(body.secretCode).toMatch(/^[A-Z2-7]{32}$/);

    const png = Buffer.from(body.qrCode, 'base64');
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(200); // IHDR width
    expect(png.readUInt32BE(20)).toBe(200); // IHDR height
  });

  it('enable rejects a wrong code with 401 and leaves 2FA off', async () => {
    await world.request('POST', '/users/two-factor/setup', { token: account.token });
    const res = await world.request('POST', '/users/two-factor/enable', {
      token: account.token,
      body: {
        code: '000000',
        encryptedTwoFactorSecret: 'x',
        twoFactorSecretDecryptionNonce: 'y',
      },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({});

    const status = await world.request('GET', '/users/two-factor/status', { token: account.token });
    expect(await status.json()).toEqual({ status: false });
  });

  it('enable without a preceding setup is refused', async () => {
    const res = await world.request('POST', '/users/two-factor/enable', {
      token: account.token,
      body: {
        code: '000000',
        encryptedTwoFactorSecret: 'x',
        twoFactorSecretDecryptionNonce: 'y',
      },
    });
    expect(res.status).toBe(401);
  });

  it('status flips to true once enabled', async () => {
    await enable2fa();
    const status = await world.request('GET', '/users/two-factor/status', { token: account.token });
    expect(await status.json()).toEqual({ status: true });
  });

  it('details/v2 profileData.isTwoFactorEnabled tracks it too (captured)', async () => {
    const read = async () => {
      const res = await world.request('GET', '/users/details/v2', { token: account.token });
      return (await res.json()) as { profileData: { isTwoFactorEnabled: boolean } };
    };
    expect((await read()).profileData.isTwoFactorEnabled).toBe(false);
    await enable2fa();
    expect((await read()).profileData.isTwoFactorEnabled).toBe(true);

    await world.request('POST', '/users/two-factor/disable', { token: account.token });
    expect((await read()).profileData.isTwoFactorEnabled).toBe(false);
  });
});

describe('login once 2FA is on', () => {
  it('SRP login returns a twoFactorSessionID and NO token', async () => {
    await enable2fa();
    const { response } = await srpLogin(world, '2fa@b.c', account.keys).catch((err) => {
      throw err;
    });
    expect(Object.keys(response)).toEqual([
      'id',
      'passkeySessionID',
      'accountsUrl',
      'twoFactorSessionID',
      'twoFactorSessionIDV2',
      'srpM2',
    ]);
    expect(response.twoFactorSessionID).toBeTruthy();
    expect(response.encryptedToken).toBeUndefined();
    expect(response.token).toBeUndefined();
  });

  it('the email-OTT path switches to the same shape', async () => {
    await enable2fa();
    await world.request('POST', '/users/ott', { body: { email: '2fa@b.c', purpose: 'login' } });
    const res = await world.request('POST', '/users/verify-email', {
      body: { email: '2fa@b.c', ott: lastOttCode(world, '2fa@b.c') },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([
      'id',
      'passkeySessionID',
      'accountsUrl',
      'twoFactorSessionID',
      'twoFactorSessionIDV2',
    ]);
    expect(body.encryptedToken).toBeUndefined();
  });

  it('verify exchanges a correct code for a working token', async () => {
    const secret = await enable2fa();
    const { response } = await srpLogin(world, '2fa@b.c', account.keys);

    const res = await world.request('POST', '/users/two-factor/verify', {
      body: { sessionID: response.twoFactorSessionID, code: totpCode(secret, now()) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['id', 'keyAttributes', 'encryptedToken']);

    const token = openEncryptedToken(body.encryptedToken as string, account.keys);
    const probe = await world.request('GET', '/users/session-validity/v2', { token });
    expect(probe.status).toBe(200);
  });

  it('verify rejects a wrong code with 401 and mints nothing', async () => {
    await enable2fa();
    const { response } = await srpLogin(world, '2fa@b.c', account.keys);
    const res = await world.request('POST', '/users/two-factor/verify', {
      body: { sessionID: response.twoFactorSessionID, code: '000000' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({});
  });

  it('a session is single-use', async () => {
    const secret = await enable2fa();
    const { response } = await srpLogin(world, '2fa@b.c', account.keys);
    const sessionID = response.twoFactorSessionID as string;

    expect(
      (await world.request('POST', '/users/two-factor/verify', {
        body: { sessionID, code: totpCode(secret, now()) },
      })).status,
    ).toBe(200);
    expect(
      (await world.request('POST', '/users/two-factor/verify', {
        body: { sessionID, code: totpCode(secret, now()) },
      })).status,
    ).toBe(401);
  });

  it('a session expires', async () => {
    const secret = await enable2fa();
    const { response } = await srpLogin(world, '2fa@b.c', account.keys);
    world.deps.clock.advance(TWO_FACTOR_SESSION_VALIDITY_MICROS + MICROS_PER_MINUTE);
    const res = await world.request('POST', '/users/two-factor/verify', {
      body: { sessionID: response.twoFactorSessionID, code: totpCode(secret, now()) },
    });
    expect(res.status).toBe(401);
  });

  it('an unknown session id is refused', async () => {
    await enable2fa();
    const res = await world.request('POST', '/users/two-factor/verify', {
      body: { sessionID: b64(randomBytes(32)), code: '123456' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts a code from the neighbouring window (clock skew)', async () => {
    const secret = await enable2fa();
    const { response } = await srpLogin(world, '2fa@b.c', account.keys);
    const previous = totpCode(secret, now() - TOTP_PERIOD_SECONDS * MICROS_PER_SECOND);
    const res = await world.request('POST', '/users/two-factor/verify', {
      body: { sessionID: response.twoFactorSessionID, code: previous },
    });
    expect(res.status).toBe(200);
  });
});

describe('recovery and disable', () => {
  it('recover hands back what the client stored, then remove clears 2FA', async () => {
    const secret = await enable2fa();
    const { response } = await srpLogin(world, '2fa@b.c', account.keys);
    const sessionID = response.twoFactorSessionID as string;

    const rec = await world.request(
      'GET',
      `/users/two-factor/recover?sessionID=${encodeURIComponent(sessionID)}`,
    );
    expect(rec.status).toBe(200);
    expect(Object.keys((await rec.json()) as object)).toEqual([
      'encryptedSecret',
      'secretDecryptionNonce',
    ]);

    const wrong = await world.request('POST', '/users/two-factor/remove', {
      body: { sessionID, secret: 'WRONGSECRET' },
    });
    expect(wrong.status).toBe(403); // 403 here, not the 401 a bad CODE gets
    expect(await wrong.json()).toEqual({});

    const res = await world.request('POST', '/users/two-factor/remove', {
      body: { sessionID, secret },
    });
    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()) as object)).toEqual([
      'id',
      'keyAttributes',
      'encryptedToken',
    ]);

    // 2FA is now off: a fresh login goes straight through with a token.
    const after = await srpLogin(world, '2fa@b.c', account.keys);
    expect(after.response.twoFactorSessionID).toBe('');
    expect(after.response.encryptedToken).toBeTruthy();
  });

  it('disable turns it off and restores the plain login shape', async () => {
    await enable2fa();
    const res = await world.request('POST', '/users/two-factor/disable', { token: account.token });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');

    const status = await world.request('GET', '/users/two-factor/status', { token: account.token });
    expect(await status.json()).toEqual({ status: false });

    const after = await srpLogin(world, '2fa@b.c', account.keys);
    expect(after.response.encryptedToken).toBeTruthy();
  });

  it('all the token-guarded routes still require a token', async () => {
    for (const path of [
      '/users/two-factor/setup',
      '/users/two-factor/enable',
      '/users/two-factor/disable',
    ]) {
      expect((await world.request('POST', path, { body: {} })).status, path).toBe(401);
    }
  });
});
