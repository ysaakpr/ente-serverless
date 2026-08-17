/**
 * [UPLOAD] — upload-urls (4), multipart (2; abort-lifecycle is an infra
 * test), POST /files commit (9), PUT /files/update + thumbnail (3).
 * Includes the M3 gate: encrypt -> upload (single + multipart) -> commit ->
 * download -> decrypt -> byte-identical.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { createAlbum, decryptBlob, encryptBlob, uploadAndCommit } from '../helpers/upload.ts';
import { b64 } from '../../src/lib/b64.ts';

let world: TestWorld;
let account: Account;
let albumId: number;

beforeEach(async () => {
  world = await makeWorld();
  account = await signupAccount(world, 'up@b.c');
  albumId = await createAlbum(world, account);
});

describe('GET /files/upload-urls', () => {
  it('returns N urls with distinct keys under the caller prefix', async () => {
    const res = await world.request('GET', '/files/upload-urls?count=3', { token: account.token });
    expect(res.status).toBe(200);
    const { urls } = (await res.json()) as { urls: Array<{ objectKey: string; url: string }> };
    expect(urls).toHaveLength(3);
    const keys = urls.map((u) => u.objectKey);
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(key.startsWith(`${account.userId}/`)).toBe(true);
  });

  it('caps count at 50', async () => {
    const res = await world.request('GET', '/files/upload-urls?count=80', { token: account.token });
    const { urls } = (await res.json()) as { urls: unknown[] };
    expect(urls).toHaveLength(50);
  });

  it('quota-blocked accounts get 426', async () => {
    world.deps.config.freePlanStorageBytes = 10;
    await world.deps.db.addToCounters(`USER#${account.userId}`, 'USAGE', { bytes: 11 });
    const res = await world.request('GET', '/files/upload-urls?count=1', { token: account.token });
    expect(res.status).toBe(426);
  });

  it('requires auth', async () => {
    expect((await world.request('GET', '/files/upload-urls?count=1')).status).toBe(401);
  });
});

describe('POST /files (commit)', () => {
  it('M3 gate: single-part round-trip is byte-identical, appears in diff', async () => {
    const plain = new Uint8Array(randomBytes(256 * 1024));
    const thumbPlain = new Uint8Array(randomBytes(8 * 1024));
    const up = await uploadAndCommit(world, account, albumId, plain, thumbPlain);

    expect(up.response.ownerID).toBe(account.userId);
    expect(typeof up.response.updationTime).toBe('number');

    // download via v2 url + decrypt
    const dl = await world.request('GET', `/files/download/v2/${up.fileId}`, { token: account.token });
    expect(dl.status).toBe(200);
    const { url } = (await dl.json()) as { url: string };
    const cipher = await world.deps.blobs.downloadViaUrl(url);
    expect(Buffer.from(decryptBlob(new Uint8Array(cipher), up.file))).toEqual(Buffer.from(plain));

    // appears in collection diff
    const diff = await world.request('GET', `/collections/v2/diff?collectionID=${albumId}&sinceTime=0`, {
      token: account.token,
    });
    const body = (await diff.json()) as { diff: Array<{ id: number }>; hasMore: boolean };
    expect(body.diff.map((f) => f.id)).toContain(up.fileId);
    expect(body.hasMore).toBe(false);
  });

  it('M3 gate: multipart (3 parts) round-trip is byte-identical', async () => {
    const plain = new Uint8Array(randomBytes(6 * 1024 * 1024));
    const up = await uploadAndCommit(world, account, albumId, plain, new Uint8Array(randomBytes(2048)), {
      multipartParts: 3,
    });
    const dl = await world.request('GET', `/files/download/v2/${up.fileId}`, { token: account.token });
    const { url } = (await dl.json()) as { url: string };
    const cipher = await world.deps.blobs.downloadViaUrl(url);
    expect(Buffer.from(decryptBlob(new Uint8Array(cipher), up.file))).toEqual(Buffer.from(plain));
  });

  it('missing S3 object -> 503 OBJECT_SIZE_FETCH_FAILED, nothing written', async () => {
    const res = await world.request('POST', '/files', {
      token: account.token,
      body: {
        id: 0,
        collectionID: albumId,
        encryptedKey: b64(randomBytes(48)),
        keyDecryptionNonce: b64(randomBytes(24)),
        file: { objectKey: `${account.userId}/nope`, decryptionHeader: b64(randomBytes(24)) },
        thumbnail: { objectKey: `${account.userId}/nope2`, decryptionHeader: b64(randomBytes(24)) },
        metadata: { encryptedData: 'x', decryptionHeader: b64(randomBytes(24)) },
        updationTime: 1,
      },
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('OBJECT_SIZE_FETCH_FAILED');
    const details = await world.request('GET', '/users/details/v2', { token: account.token });
    expect(((await details.json()) as { usage: number }).usage).toBe(0);
  });

  it('claimed size mismatch -> 400', async () => {
    const file = encryptBlob(new Uint8Array(randomBytes(1024)));
    const thumb = encryptBlob(new Uint8Array(randomBytes(128)));
    const fileKey = `${account.userId}/f1`;
    const thumbKey = `${account.userId}/t1`;
    await world.deps.blobs.put(fileKey, file.cipher);
    await world.deps.blobs.put(thumbKey, thumb.cipher);
    const res = await world.request('POST', '/files', {
      token: account.token,
      body: {
        id: 0,
        collectionID: albumId,
        encryptedKey: b64(randomBytes(48)),
        keyDecryptionNonce: b64(randomBytes(24)),
        file: { objectKey: fileKey, decryptionHeader: file.decryptionHeader, size: 999999 },
        thumbnail: { objectKey: thumbKey, decryptionHeader: thumb.decryptionHeader },
        metadata: { encryptedData: 'x', decryptionHeader: b64(randomBytes(24)) },
        updationTime: 1,
      },
    });
    expect(res.status).toBe(400);
  });

  it('foreign objectKey prefix rejected 400', async () => {
    const res = await world.request('POST', '/files', {
      token: account.token,
      body: {
        id: 0,
        collectionID: albumId,
        encryptedKey: b64(randomBytes(48)),
        keyDecryptionNonce: b64(randomBytes(24)),
        file: { objectKey: `999999/x`, decryptionHeader: b64(randomBytes(24)) },
        thumbnail: { objectKey: `999999/y`, decryptionHeader: b64(randomBytes(24)) },
        metadata: { encryptedData: 'x', decryptionHeader: b64(randomBytes(24)) },
        updationTime: 1,
      },
    });
    expect(res.status).toBe(400);
  });

  it('foreign collection rejected 403', async () => {
    const other = await signupAccount(world, 'other@b.c');
    const otherAlbum = await createAlbum(world, other);
    await expect(
      uploadAndCommit(world, account, otherAlbum, new Uint8Array(randomBytes(64)), new Uint8Array(randomBytes(16))),
    ).rejects.toThrow(/commit failed: 403/);
  });

  it('quota exceeded -> 426 (museum ErrStorageLimitExceeded), nothing written', async () => {
    world.deps.config.freePlanStorageBytes = 100;
    await expect(
      uploadAndCommit(world, account, albumId, new Uint8Array(randomBytes(4096)), new Uint8Array(randomBytes(512))),
    ).rejects.toThrow(/commit failed: 426/);
    const details = await world.request('GET', '/users/details/v2', { token: account.token });
    expect(((await details.json()) as { usage: number }).usage).toBe(0);
  });

  it('usage counter incremented exactly once per commit', async () => {
    const plain = new Uint8Array(randomBytes(1000));
    const thumbPlain = new Uint8Array(randomBytes(100));
    const up = await uploadAndCommit(world, account, albumId, plain, thumbPlain);
    const details = await world.request('GET', '/users/details/v2', { token: account.token });
    const body = (await details.json()) as { usage: number; fileCount: number };
    expect(body.usage).toBe(up.file.cipher.length + up.thumb.cipher.length);
    expect(body.fileCount).toBe(1);
  });

  it('duplicate objectKey re-commit with identical attributes returns the same id; different -> 400', async () => {
    const plain = new Uint8Array(randomBytes(512));
    const thumbPlain = new Uint8Array(randomBytes(64));
    const up = await uploadAndCommit(world, account, albumId, plain, thumbPlain);

    // identical re-commit (iOS retry) -> same id
    const again = await world.request('POST', '/files', {
      token: account.token,
      body: {
        id: 0,
        collectionID: albumId,
        encryptedKey: up.response.encryptedKey,
        keyDecryptionNonce: up.response.keyDecryptionNonce,
        file: { objectKey: up.fileObjectKey, decryptionHeader: up.file.decryptionHeader },
        thumbnail: { objectKey: up.thumbObjectKey, decryptionHeader: up.thumb.decryptionHeader },
        metadata: (up.response.metadata as { encryptedData: string; decryptionHeader: string }),
        updationTime: 1,
      },
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { id: number }).id).toBe(up.fileId);

    // different metadata -> 400
    const different = await world.request('POST', '/files', {
      token: account.token,
      body: {
        id: 0,
        collectionID: albumId,
        encryptedKey: b64(randomBytes(48)),
        keyDecryptionNonce: b64(randomBytes(24)),
        file: { objectKey: up.fileObjectKey, decryptionHeader: up.file.decryptionHeader },
        thumbnail: { objectKey: up.thumbObjectKey, decryptionHeader: up.thumb.decryptionHeader },
        metadata: { encryptedData: b64(randomBytes(64)), decryptionHeader: b64(randomBytes(24)) },
        updationTime: 1,
      },
    });
    expect(different.status).toBe(400);
  });

  it('update path (id != 0) re-points attributes, bumps updationTime, preserves owner', async () => {
    const up = await uploadAndCommit(world, account, albumId, new Uint8Array(randomBytes(512)), new Uint8Array(randomBytes(64)));
    const firstUpdation = up.response.updationTime as number;

    const newFile = encryptBlob(new Uint8Array(randomBytes(700)));
    const newThumb = encryptBlob(new Uint8Array(randomBytes(50)));
    const newFileKey = `${account.userId}/newf`;
    const newThumbKey = `${account.userId}/newt`;
    await world.deps.blobs.put(newFileKey, newFile.cipher);
    await world.deps.blobs.put(newThumbKey, newThumb.cipher);

    const res = await world.request('PUT', '/files/update', {
      token: account.token,
      body: {
        id: up.fileId,
        collectionID: albumId,
        file: { objectKey: newFileKey, decryptionHeader: newFile.decryptionHeader },
        thumbnail: { objectKey: newThumbKey, decryptionHeader: newThumb.decryptionHeader },
        metadata: { encryptedData: b64(randomBytes(64)), decryptionHeader: b64(randomBytes(24)) },
        updationTime: 1,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; updationTime: number };
    expect(body.id).toBe(up.fileId);
    expect(body.updationTime).toBeGreaterThan(firstUpdation);

    // diff re-emits with new decryptionHeader; owner preserved
    const diff = await world.request('GET', `/collections/v2/diff?collectionID=${albumId}&sinceTime=${firstUpdation}`, {
      token: account.token,
    });
    const diffBody = (await diff.json()) as { diff: Array<Record<string, unknown>> };
    const entry = diffBody.diff.find((f) => f.id === up.fileId)!;
    expect(entry.ownerID).toBe(account.userId);
    expect((entry.file as { decryptionHeader: string }).decryptionHeader).toBe(newFile.decryptionHeader);
  });

  it('PUT /files/thumbnail replaces the thumb (shrink only) and reruns verification', async () => {
    const up = await uploadAndCommit(world, account, albumId, new Uint8Array(randomBytes(512)), new Uint8Array(randomBytes(200)));

    // larger thumbnail -> 500 (museum plain error)
    const bigger = encryptBlob(new Uint8Array(randomBytes(4000)));
    const biggerKey = `${account.userId}/bigthumb`;
    await world.deps.blobs.put(biggerKey, bigger.cipher);
    const rejected = await world.request('PUT', '/files/thumbnail', {
      token: account.token,
      body: { fileID: up.fileId, thumbnail: { objectKey: biggerKey, decryptionHeader: bigger.decryptionHeader } },
    });
    expect(rejected.status).toBe(500);

    // smaller thumbnail accepted, usage adjusted
    const before = ((await (await world.request('GET', '/users/details/v2', { token: account.token })).json()) as { usage: number }).usage;
    const smaller = encryptBlob(new Uint8Array(randomBytes(50)));
    const smallerKey = `${account.userId}/smallthumb`;
    await world.deps.blobs.put(smallerKey, smaller.cipher);
    const ok = await world.request('PUT', '/files/thumbnail', {
      token: account.token,
      body: { fileID: up.fileId, thumbnail: { objectKey: smallerKey, decryptionHeader: smaller.decryptionHeader } },
    });
    expect(ok.status).toBe(200);
    const after = ((await (await world.request('GET', '/users/details/v2', { token: account.token })).json()) as { usage: number }).usage;
    expect(after).toBe(before - (up.thumb.cipher.length - smaller.cipher.length));

    // preview now serves the new thumb
    const pv = await world.request('GET', `/files/preview/v2/${up.fileId}`, { token: account.token });
    const { url } = (await pv.json()) as { url: string };
    const served = await world.deps.blobs.downloadViaUrl(url);
    expect(Buffer.from(served)).toEqual(Buffer.from(smaller.cipher));
  });
});
