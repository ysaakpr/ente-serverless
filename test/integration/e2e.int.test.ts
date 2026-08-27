/**
 * Integration on LocalStack — the milestone gates end to end with the REAL
 * adapters and REAL presigned HTTP:
 *  - M1: signup -> keys -> SRP setup -> logout -> SRP login -> unseal token
 *  - M3: encrypt -> presigned PUT (single + multipart) -> commit -> presigned
 *        GET -> decrypt -> byte-identical
 *  - OTT mail actually lands in (LocalStack) SES
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import sodium from '../../src/lib/sodium.ts';
import { makeIntWorld, LOCALSTACK, type IntWorld } from '../helpers/intWorld.ts';
import { makeClientKeys, openEncryptedToken, type ClientKeys } from '../helpers/client.ts';
import { computeVerifier, SrpClient } from '../../src/domain/srp.ts';
import { b64, fromB64 } from '../../src/lib/b64.ts';
import { ConditionFailedError } from '../../src/ports/db.ts';

let world: IntWorld;

beforeAll(async () => {
  await sodium.ready;
  world = await makeIntWorld();
});

const uniqueEmail = () => `int-${randomUUID().slice(0, 8)}@example.org`;

const fullSignup = async (email: string, keys: ClientKeys) => {
  const ott = await world.request('POST', '/users/ott', { body: { email, purpose: 'signup' } });
  expect(ott.status).toBe(200);
  const verify = await world.request('POST', '/users/verify-email', {
    body: { email, ott: '123456' }, // hardcoded OTT for @example.org (museum quickstart parity)
  });
  expect(verify.status).toBe(200);
  const { id, token } = (await verify.json()) as { id: number; token: string };

  const attrs = await world.request('PUT', '/users/attributes', {
    token,
    body: { keyAttributes: keys.keyAttributes },
  });
  expect(attrs.status).toBe(200);

  const srpUserID = randomUUID();
  const salt = randomBytes(16);
  const identity = new TextEncoder().encode(srpUserID);
  const verifier = computeVerifier(salt, identity, keys.loginSubKey);
  const client = new SrpClient(salt, identity, keys.loginSubKey, randomBytes(32));
  const setup = await world.request('POST', '/users/srp/setup', {
    token,
    body: { srpUserID, srpSalt: b64(salt), srpVerifier: b64(verifier), srpA: b64(client.computeA()) },
  });
  expect(setup.status).toBe(200);
  const { setupID, srpB } = (await setup.json()) as { setupID: string; srpB: string };
  client.setB(fromB64(srpB));
  const complete = await world.request('POST', '/users/srp/complete', {
    token,
    body: { setupID, srpM1: b64(client.computeM1()) },
  });
  expect(complete.status).toBe(200);
  return { id, token, srpUserID, salt };
};

describe('M1 gate on LocalStack', () => {
  it('signup -> SRP setup -> logout -> SRP login -> sealed token round-trip', async () => {
    const email = uniqueEmail();
    const keys = makeClientKeys();
    const { token, srpUserID, salt } = await fullSignup(email, keys);

    // logout
    expect((await world.request('POST', '/users/logout', { token })).status).toBe(200);
    expect((await world.request('GET', '/users/session-validity/v2', { token })).status).toBe(401);

    // SRP login
    const identity = new TextEncoder().encode(srpUserID);
    const client = new SrpClient(salt, identity, keys.loginSubKey, randomBytes(32));
    const create = await world.request('POST', '/users/srp/create-session', {
      body: { srpUserID, srpA: b64(client.computeA()) },
    });
    expect(create.status).toBe(200);
    const { sessionID, srpB } = (await create.json()) as { sessionID: string; srpB: string };
    client.setB(fromB64(srpB));
    const verify = await world.request('POST', '/users/srp/verify-session', {
      body: { sessionID, srpUserID, srpM1: b64(client.computeM1()) },
    });
    expect(verify.status).toBe(200);
    const body = (await verify.json()) as { encryptedToken: string; srpM2: string };
    expect(client.checkM2(fromB64(body.srpM2))).toBe(true);

    const newToken = openEncryptedToken(body.encryptedToken, keys);
    const probe = await world.request('GET', '/users/session-validity/v2', { token: newToken });
    expect(probe.status).toBe(200);
  });

  /**
   * D38 end to end on the REAL adapters. Scope, precisely: the refusal here comes
   * from `assertSrpUserIdClaimable`'s READ, which throws before the transaction
   * runs — so this proves the guard and the victim's survival against real
   * DynamoDB, but NOT the conditional write. That write only fires on the race
   * (a claim landing between our read and our write); its DynamoDB behaviour is
   * asserted separately, just below.
   */
  it('a taken srpUserID is refused on the real adapter, victim login intact', async () => {
    const victimEmail = uniqueEmail();
    const victimKeys = makeClientKeys();
    const victim = await fullSignup(victimEmail, victimKeys);

    // Attacker with key attributes but NO SRP — the state that reaches the guard
    // (a configured account is stopped earlier by the first-time-only 400).
    const attackerEmail = uniqueEmail();
    const attackerKeys = makeClientKeys();
    const ott = await world.request('POST', '/users/ott', {
      body: { email: attackerEmail, purpose: 'signup' },
    });
    expect(ott.status).toBe(200);
    const verify = await world.request('POST', '/users/verify-email', {
      body: { email: attackerEmail, ott: '123456' },
    });
    const { token: attackerToken } = (await verify.json()) as { token: string };
    expect(
      (
        await world.request('PUT', '/users/attributes', {
          token: attackerToken,
          body: { keyAttributes: attackerKeys.keyAttributes },
        })
      ).status,
    ).toBe(200);

    // Claim the victim's srpUserID against a verifier of the attacker's choosing.
    const salt = randomBytes(16);
    const identity = new TextEncoder().encode(victim.srpUserID);
    const verifier = computeVerifier(salt, identity, attackerKeys.loginSubKey);
    const client = new SrpClient(salt, identity, attackerKeys.loginSubKey, randomBytes(32));
    const setup = await world.request('POST', '/users/srp/setup', {
      token: attackerToken,
      body: {
        srpUserID: victim.srpUserID,
        srpSalt: b64(salt),
        srpVerifier: b64(verifier),
        srpA: b64(client.computeA()),
      },
    });
    expect(setup.status).toBe(200); // museum parity: setup never refuses
    const { setupID, srpB } = (await setup.json()) as { setupID: string; srpB: string };
    client.setB(fromB64(srpB));

    const complete = await world.request('POST', '/users/srp/complete', {
      token: attackerToken,
      body: { setupID, srpM1: b64(client.computeM1()) },
    });
    expect(complete.status).toBe(500); // museum's UNIQUE-violation shape (D38)

    // The guard still resolves to the victim, and the victim still logs in.
    const guard = await world.deps.db.get(`SRPUSER#${victim.srpUserID}`, 'META');
    expect(guard!.userId).toBe(victim.id);

    const loginClient = new SrpClient(
      victim.salt,
      identity,
      victimKeys.loginSubKey,
      randomBytes(32),
    );
    const create = await world.request('POST', '/users/srp/create-session', {
      body: { srpUserID: victim.srpUserID, srpA: b64(loginClient.computeA()) },
    });
    expect(create.status).toBe(200);
    const created = (await create.json()) as { sessionID: string; srpB: string };
    loginClient.setB(fromB64(created.srpB));
    const login = await world.request('POST', '/users/srp/verify-session', {
      body: {
        sessionID: created.sessionID,
        srpUserID: victim.srpUserID,
        srpM1: b64(loginClient.computeM1()),
      },
    });
    expect(login.status).toBe(200);
  });

  /**
   * The race half of D38's guard: `commitSrpAuth` writes the guard under
   * `ifNotExists` so a claim landing after its read still loses. That relies on
   * DynamoDB honouring `attribute_not_exists(pk)` inside TransactWriteItems AND
   * on db.dynamo.ts mapping the resulting TransactionCanceledException to
   * ConditionFailedError — neither observable against MemoryDb. Asserted at the
   * port so it cannot silently rot.
   */
  it('DynamoDB refuses a conditional transactWrite onto an existing key', async () => {
    const pk = `SRPUSER#int-${randomUUID()}`;
    const guard = { pk, sk: 'META', userId: 1 };

    // First claim wins.
    await world.deps.db.transactWrite([{ kind: 'put', ifNotExists: true, item: guard }]);
    expect((await world.deps.db.get(pk, 'META'))!.userId).toBe(1);

    // A second, racing claim must be refused — and must not overwrite.
    await expect(
      world.deps.db.transactWrite([
        { kind: 'put', ifNotExists: true, item: { pk, sk: 'META', userId: 2 } },
      ]),
    ).rejects.toBeInstanceOf(ConditionFailedError);
    expect((await world.deps.db.get(pk, 'META'))!.userId).toBe(1);

    await world.deps.db.delete(pk, 'META');
  });

  /**
   * Phase A (PENDING-FEATURES-PLAN §4.7): the sharing dual-writes assume a
   * failing condition rolls back EVERY op in the batch on real DynamoDB —
   * MemoryDb proves the port contract, this proves the adapter honours it.
   */
  it('DynamoDB rolls back the whole transactWrite batch on a failed condition', async () => {
    const ns = `int-${randomUUID()}`;
    await world.deps.db.put({ pk: `COL#${ns}`, sk: 'SHAREE#1', role: 'VIEWER' });
    await world.deps.db.put({ pk: `COL#${ns}`, sk: 'LINK', tokenHash: 'existing' });

    await expect(
      world.deps.db.transactWrite([
        { kind: 'put', item: { pk: `COL#${ns}`, sk: 'SHAREE#2', role: 'VIEWER' } },
        { kind: 'delete', key: { pk: `COL#${ns}`, sk: 'SHAREE#1' } },
        // Condition failure: the LINK pointer above already exists.
        { kind: 'put', ifNotExists: true, item: { pk: `COL#${ns}`, sk: 'LINK', tokenHash: 'x' } },
      ]),
    ).rejects.toBeInstanceOf(ConditionFailedError);

    // Put rolled back, delete rolled back, loser's pointer never landed.
    expect(await world.deps.db.get(`COL#${ns}`, 'SHAREE#2')).toBeNull();
    expect((await world.deps.db.get(`COL#${ns}`, 'SHAREE#1'))!.role).toBe('VIEWER');
    expect((await world.deps.db.get(`COL#${ns}`, 'LINK'))!.tokenHash).toBe('existing');

    await world.deps.db.delete(`COL#${ns}`, 'SHAREE#1');
    await world.deps.db.delete(`COL#${ns}`, 'LINK');
  });
});

describe('M3 gate on LocalStack (real presigned HTTP)', () => {
  it('single-part: PUT to presigned URL, commit verifies via HeadObject, GET round-trips bytes', async () => {
    const keys = makeClientKeys();
    const { token } = await fullSignup(uniqueEmail(), keys);

    // album
    const col = await world.request('POST', '/collections', {
      token,
      body: {
        encryptedKey: b64(randomBytes(48)),
        keyDecryptionNonce: b64(randomBytes(24)),
        type: 'album',
      },
    });
    const albumId = ((await col.json()) as { collection: { id: number } }).collection.id;

    // encrypt + upload via REAL presigned PUT
    const plain = randomBytes(128 * 1024);
    const fileKey = sodium.crypto_secretbox_keygen();
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const cipher = sodium.crypto_secretbox_easy(plain, nonce, fileKey);
    const thumbCipher = sodium.crypto_secretbox_easy(randomBytes(1024), nonce, fileKey);

    const urlsRes = await world.request('GET', '/files/upload-urls?count=2', { token });
    const { urls } = (await urlsRes.json()) as { urls: Array<{ objectKey: string; url: string }> };
    const put1 = await fetch(urls[0]!.url, { method: 'PUT', body: cipher });
    expect(put1.status).toBe(200);
    const put2 = await fetch(urls[1]!.url, { method: 'PUT', body: thumbCipher });
    expect(put2.status).toBe(200);

    // commit
    const commit = await world.request('POST', '/files', {
      token,
      body: {
        id: 0,
        collectionID: albumId,
        encryptedKey: b64(randomBytes(48)),
        keyDecryptionNonce: b64(randomBytes(24)),
        file: { objectKey: urls[0]!.objectKey, decryptionHeader: b64(nonce), size: cipher.length },
        thumbnail: { objectKey: urls[1]!.objectKey, decryptionHeader: b64(nonce) },
        metadata: { encryptedData: b64(randomBytes(64)), decryptionHeader: b64(randomBytes(24)) },
        updationTime: Date.now() * 1000,
      },
    });
    expect(commit.status).toBe(200);
    const committed = (await commit.json()) as { id: number };

    // download via presigned GET, decrypt, byte-identical
    const dl = await world.request('GET', `/files/download/v2/${committed.id}`, { token });
    const { url } = (await dl.json()) as { url: string };
    const served = Buffer.from(await (await fetch(url)).arrayBuffer());
    expect(served).toEqual(Buffer.from(cipher));
    const decrypted = sodium.crypto_secretbox_open_easy(new Uint8Array(served), nonce, fileKey);
    expect(Buffer.from(decrypted)).toEqual(plain);

    // usage reflects the upload
    const details = await world.request('GET', '/users/details/v2', { token });
    expect(((await details.json()) as { usage: number }).usage).toBe(cipher.length + thumbCipher.length);
  });

  it('multipart >= 5MB: presigned parts + complete, object materializes', async () => {
    const keys = makeClientKeys();
    const { token } = await fullSignup(uniqueEmail(), keys);

    const partSize = 5 * 1024 * 1024;
    const body = randomBytes(partSize + 1024 * 1024); // 6 MB, 2 parts
    const mpu = await world.request('GET', '/files/multipart-upload-urls?count=2', { token });
    const { urls } = (await mpu.json()) as {
      urls: { objectKey: string; partURLs: string[]; completeURL: string };
    };

    const etags: string[] = [];
    for (let i = 0; i < 2; i++) {
      const part = body.subarray(i * partSize, Math.min((i + 1) * partSize, body.length));
      const res = await fetch(urls.partURLs[i]!, { method: 'PUT', body: part });
      expect(res.status).toBe(200);
      etags.push(res.headers.get('etag')!);
    }
    const completeXml =
      '<CompleteMultipartUpload>' +
      etags.map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`).join('') +
      '</CompleteMultipartUpload>';
    const complete = await fetch(urls.completeURL, { method: 'POST', body: completeXml });
    expect(complete.status).toBe(200);

    const head = await world.deps.blobs.head(urls.objectKey);
    expect(head?.contentLength).toBe(body.length);
  });
});

describe('thumbnail fetch as a browser performs it (D32/D33)', () => {
  it('307 by query token, and the redirect target answers CORS', async () => {
    const keys = makeClientKeys();
    const { token } = await fullSignup(uniqueEmail(), keys);

    const col = await world.request('POST', '/collections', {
      token,
      body: {
        encryptedKey: b64(randomBytes(48)),
        keyDecryptionNonce: b64(randomBytes(24)),
        type: 'album',
      },
    });
    const albumId = ((await col.json()) as { collection: { id: number } }).collection.id;

    const fileKey = sodium.crypto_secretbox_keygen();
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const cipher = sodium.crypto_secretbox_easy(randomBytes(4096), nonce, fileKey);
    const thumbCipher = sodium.crypto_secretbox_easy(randomBytes(1024), nonce, fileKey);

    const urlsRes = await world.request('GET', '/files/upload-urls?count=2', { token });
    const { urls } = (await urlsRes.json()) as { urls: Array<{ objectKey: string; url: string }> };
    expect((await fetch(urls[0]!.url, { method: 'PUT', body: cipher })).status).toBe(200);
    expect((await fetch(urls[1]!.url, { method: 'PUT', body: thumbCipher })).status).toBe(200);

    const commit = await world.request('POST', '/files', {
      token,
      body: {
        id: 0,
        collectionID: albumId,
        encryptedKey: b64(randomBytes(48)),
        keyDecryptionNonce: b64(randomBytes(24)),
        file: { objectKey: urls[0]!.objectKey, decryptionHeader: b64(nonce), size: cipher.length },
        thumbnail: { objectKey: urls[1]!.objectKey, decryptionHeader: b64(nonce) },
        metadata: { encryptedData: b64(randomBytes(64)), decryptionHeader: b64(randomBytes(24)) },
        updationTime: Date.now() * 1000,
      },
    });
    expect(commit.status).toBe(200);
    const { id: fileId } = (await commit.json()) as { id: number };

    // No X-Auth-Token: exactly what an image load from the desktop app sends.
    const redirect = await world.request('GET', `/files/preview/${fileId}?token=${token}`);
    expect(redirect.status).toBe(307);
    const location = redirect.headers.get('location')!;
    expect(location).toBeTruthy();

    // The browser follows the 307 and enforces CORS on THAT response; after a
    // cross-origin redirect it sends Origin: null, which only `*` satisfies.
    for (const origin of ['http://localhost:3000', 'null']) {
      const served = await fetch(location, { headers: { Origin: origin } });
      expect(served.status, origin).toBe(200);
      expect(served.headers.get('access-control-allow-origin'), origin).toBe('*');
      expect(Buffer.from(await served.arrayBuffer()), origin).toEqual(Buffer.from(thumbCipher));
    }
  });
});

describe('SES delivery on LocalStack', () => {
  it('OTT email for a non-hardcoded domain lands in SES', async () => {
    const email = `real-${randomUUID().slice(0, 8)}@example.com`;
    const res = await world.request('POST', '/users/ott', { body: { email, purpose: 'signup' } });
    expect(res.status).toBe(200);

    const messages = (await (await fetch(`${LOCALSTACK}/_aws/ses`)).json()) as {
      messages: Array<{ Destination: { ToAddresses: string[] }; Subject: string }>;
    };
    const mine = messages.messages.filter((m) => m.Destination.ToAddresses.includes(email));
    expect(mine.length).toBe(1);
    expect(mine[0]!.Subject).toMatch(/^Verification code: \d{6}$/);
  });
});
