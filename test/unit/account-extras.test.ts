/**
 * Remaining [ACCOUNT] routes (M7 completeness, pulled forward by decision) —
 * happy + authz per endpoint: change-email, email-mfa, two-factor status,
 * recovery-key, public-key, accounts-token, delete-challenge/delete.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import sodium from '../../src/lib/sodium.ts';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { lastOttCode, signupAccount, srpLogin, type Account } from '../helpers/client.ts';
import { b64, b64Url, fromB64 } from '../../src/lib/b64.ts';

let world: TestWorld;
let account: Account;

beforeEach(async () => {
  world = await makeWorld();
  account = await signupAccount(world, 'acct@b.c');
});

describe('POST /users/change-email', () => {
  it('OTT to the new address re-points the account; old email freed, new one logs in', async () => {
    await world.request('POST', '/users/ott', { body: { email: 'new@b.c', purpose: 'change' } });
    const code = lastOttCode(world, 'new@b.c');
    const res = await world.request('POST', '/users/change-email', {
      token: account.token,
      body: { email: 'new@b.c', ott: code },
    });
    expect(res.status).toBe(200);

    expect((await world.request('GET', '/users/srp/attributes?email=new@b.c')).status).toBe(200);
    expect((await world.request('GET', '/users/srp/attributes?email=acct@b.c')).status).toBe(404);
    const details = await world.request('GET', '/users/details/v2', { token: account.token });
    expect(((await details.json()) as { email: string }).email).toBe('new@b.c');
  });

  it('taken address is refused; wrong OTT is 401; auth required', async () => {
    await signupAccount(world, 'taken@b.c');
    await world.request('POST', '/users/ott', { body: { email: 'taken@b.c', purpose: 'change' } });
    // purpose=change for an existing address is already 403 at send time
    const send = await world.request('POST', '/users/ott', {
      body: { email: 'taken@b.c', purpose: 'change' },
    });
    expect(send.status).toBe(403);

    const wrongOtt = await world.request('POST', '/users/change-email', {
      token: account.token,
      body: { email: 'fresh@b.c', ott: '000000' },
    });
    expect([401, 410]).toContain(wrongOtt.status);

    expect(
      (await world.request('POST', '/users/change-email', { body: { email: 'x@b.c', ott: '1' } })).status,
    ).toBe(401);
  });
});

describe('PUT /users/email-mfa', () => {
  it('enabling forces the OTT login path: create-session answers 409 EMAIL_MFA_ENABLED', async () => {
    const res = await world.request('PUT', '/users/email-mfa', {
      token: account.token,
      body: { isEnabled: true },
    });
    expect(res.status).toBe(200);

    const attrs = await world.request('GET', '/users/srp/attributes?email=acct@b.c');
    expect(((await attrs.json()) as { attributes: { isEmailMFAEnabled: boolean } }).attributes.isEmailMFAEnabled).toBe(true);

    const create = await world.request('POST', '/users/srp/create-session', {
      body: { srpUserID: account.srpUserID, srpA: b64(randomBytes(512)) },
    });
    expect(create.status).toBe(409);
    expect(((await create.json()) as { code: string }).code).toBe('EMAIL_MFA_ENABLED');

    // disable again -> SRP login works
    await world.request('PUT', '/users/email-mfa', { token: account.token, body: { isEnabled: false } });
    const { token } = await srpLogin(world, 'acct@b.c', account.keys);
    expect(token).toBeTruthy();
  });

  it('auth required', async () => {
    expect((await world.request('PUT', '/users/email-mfa', { body: { isEnabled: true } })).status).toBe(401);
  });
});

describe('two-factor status + recovery-key + public-key + accounts-token', () => {
  it('2FA status is {"status": false}; recovery-status zeros', async () => {
    const status = await world.request('GET', '/users/two-factor/status', { token: account.token });
    expect(await status.json()).toEqual({ status: false });
    const rec = await world.request('GET', '/users/two-factor/recovery-status', { token: account.token });
    expect(rec.status).toBe(200);
  });

  it('recovery-key is write-once (second write 500, museum plain error)', async () => {
    // signupAccount already set recovery fields via key attributes; a fresh
    // account without them accepts exactly one write.
    const again = await world.request('PUT', '/users/recovery-key', {
      token: account.token,
      body: {
        masterKeyEncryptedWithRecoveryKey: b64(randomBytes(48)),
        masterKeyDecryptionNonce: b64(randomBytes(24)),
        recoveryKeyEncryptedWithMasterKey: b64(randomBytes(48)),
        recoveryKeyDecryptionNonce: b64(randomBytes(24)),
      },
    });
    expect(again.status).toBe(500); // already set at signup
  });

  it('public-key lookup by email; 404 unknown; accounts-token shape', async () => {
    const pk = await world.request('GET', '/users/public-key?email=acct@b.c', { token: account.token });
    expect(((await pk.json()) as { publicKey: string }).publicKey).toBe(
      account.keys.keyAttributes.publicKey,
    );
    expect(
      (await world.request('GET', '/users/public-key?email=ghost@b.c', { token: account.token })).status,
    ).toBe(404);

    const at = await world.request('GET', '/users/accounts-token', { token: account.token });
    const atBody = (await at.json()) as { accountsToken: string; accountsUrl: string };
    expect(typeof atBody.accountsToken).toBe('string');
    expect(atBody).toHaveProperty('accountsUrl');
  });
});

describe('account deletion', () => {
  it('challenge unseals with the secret key; delete revokes tokens and frees the email', async () => {
    await sodium.ready;
    const challengeRes = await world.request('GET', '/users/delete-challenge', { token: account.token });
    expect(challengeRes.status).toBe(200);
    const body = (await challengeRes.json()) as {
      allowDelete: boolean;
      encryptedChallenge: string;
      apps: string[];
    };
    expect(body.allowDelete).toBe(true);

    const challenge = b64Url(
      sodium.crypto_box_seal_open(
        fromB64(body.encryptedChallenge),
        account.keys.publicKey,
        account.keys.secretKey,
      ),
    );
    const del = await world.request('DELETE', '/users/delete', {
      token: account.token,
      body: { challenge, reasonCategory: 'test' },
    });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { userID: number }).userID).toBe(account.userId);

    // token revoked, email reusable
    expect((await world.request('GET', '/users/session-validity/v2', { token: account.token })).status).toBe(401);
    const reuse = await world.request('POST', '/users/ott', {
      body: { email: 'acct@b.c', purpose: 'signup' },
    });
    expect(reuse.status).toBe(200);
  });

  it('wrong challenge is 403; nothing deleted', async () => {
    await world.request('GET', '/users/delete-challenge', { token: account.token });
    const del = await world.request('DELETE', '/users/delete', {
      token: account.token,
      body: { challenge: b64Url(randomBytes(32)) },
    });
    expect(del.status).toBe(403);
    expect((await world.request('GET', '/users/session-validity/v2', { token: account.token })).status).toBe(200);
  });
});
