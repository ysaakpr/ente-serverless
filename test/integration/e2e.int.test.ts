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
