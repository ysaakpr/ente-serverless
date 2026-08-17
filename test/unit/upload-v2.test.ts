/**
 * [UPLOAD] V2 routes — the ones the CURRENT mobile app calls (found during
 * the M5 device gate): upload-eligibility, POST upload-url, POST
 * multipart-upload-url. Bare (unwrapped) response shapes.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';

let world: TestWorld;
let account: Account;

beforeEach(async () => {
  world = await makeWorld();
  account = await signupAccount(world, 'v2@b.c');
});

describe('GET /files/upload-eligibility', () => {
  it('200 empty when under quota; 426 when over; auth required', async () => {
    const ok = await world.request('GET', '/files/upload-eligibility', { token: account.token });
    expect(ok.status).toBe(200);

    world.deps.config.freePlanStorageBytes = 10;
    await world.deps.db.addToCounters(`USER#${account.userId}`, 'USAGE', { bytes: 11 });
    const over = await world.request('GET', '/files/upload-eligibility', { token: account.token });
    expect(over.status).toBe(426);

    expect((await world.request('GET', '/files/upload-eligibility')).status).toBe(401);
  });
});

describe('POST /files/upload-url (V2)', () => {
  it('returns a bare {objectKey, url} under the caller prefix; the url accepts the bytes', async () => {
    const bytes = randomBytes(2048);
    const md5 = createHash('md5').update(bytes).digest('base64');
    const res = await world.request('POST', '/files/upload-url', {
      token: account.token,
      body: { contentLength: bytes.length, contentMD5: md5 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { objectKey: string; url: string };
    expect(body.objectKey.startsWith(`${account.userId}/`)).toBe(true);
    expect(body.url).toBeTruthy();
    expect(body).not.toHaveProperty('urls'); // bare, unlike v1

    await world.deps.blobs.uploadViaUrl(body.url, bytes);
    const head = await world.deps.blobs.head(body.objectKey);
    expect(head?.contentLength).toBe(bytes.length);
  });

  it('contentLength <= 0 and > max are 400; over-quota is 426', async () => {
    const bad = await world.request('POST', '/files/upload-url', {
      token: account.token,
      body: { contentLength: 0, contentMD5: 'x' },
    });
    expect(bad.status).toBe(400);

    const tooBig = await world.request('POST', '/files/upload-url', {
      token: account.token,
      body: { contentLength: world.deps.config.maxFileSizeBytes + 1, contentMD5: 'x' },
    });
    expect(tooBig.status).toBe(400);

    world.deps.config.freePlanStorageBytes = 100;
    const overQuota = await world.request('POST', '/files/upload-url', {
      token: account.token,
      body: { contentLength: 200, contentMD5: 'x' },
    });
    expect(overQuota.status).toBe(426);
  });
});

describe('POST /files/multipart-upload-url (V2)', () => {
  it('part count derives from contentLength/partLength; bare shape; parts land', async () => {
    const partLength = 5 * 1024 * 1024;
    const contentLength = partLength + 1024; // 2 parts
    const res = await world.request('POST', '/files/multipart-upload-url', {
      token: account.token,
      body: { contentLength, partLength, partMd5s: ['a', 'b'] },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { objectKey: string; partURLs: string[]; completeURL: string };
    expect(body.partURLs).toHaveLength(2);
    expect(body.objectKey.startsWith(`${account.userId}/`)).toBe(true);
    expect(typeof body.completeURL).toBe('string');

    await world.deps.blobs.uploadViaUrl(body.partURLs[0]!, randomBytes(partLength));
    await world.deps.blobs.uploadViaUrl(body.partURLs[1]!, randomBytes(1024));
    await world.deps.blobs.completeViaUrl(body.completeURL);
    const head = await world.deps.blobs.head(body.objectKey);
    expect(head?.contentLength).toBe(contentLength);
  });

  it('rejects bad partLength and mismatched partMd5s count', async () => {
    const tooSmallPart = await world.request('POST', '/files/multipart-upload-url', {
      token: account.token,
      body: { contentLength: 10 * 1024 * 1024, partLength: 1024, partMd5s: null },
    });
    expect(tooSmallPart.status).toBe(400);

    const mismatch = await world.request('POST', '/files/multipart-upload-url', {
      token: account.token,
      body: { contentLength: 11 * 1024 * 1024, partLength: 5 * 1024 * 1024, partMd5s: ['only-one'] },
    });
    expect(mismatch.status).toBe(400);
  });
});
