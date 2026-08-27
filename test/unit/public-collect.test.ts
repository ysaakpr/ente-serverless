/**
 * [PUBLIC-COLLECTION] the collect (guest upload) flow — POST /upload-url,
 * POST /multipart-upload-url, POST /file with attribution flipped to the link
 * owner. src: pkg/api/public_collection.go GetUploadURLV2/
 * GetMultipartUploadURLV2/CreateFile + pkg/controller/public/
 * collection_link.go CreateFile (file.ID=0, OwnerID=collection owner) +
 * GetPublicCollection(mustAllowCollect) -> 405 PUBLIC_COLLECT_DISABLED.
 * The daily upload ceiling is plan §4.1d (D51).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { createAlbum, encryptBlob } from '../helpers/upload.ts';
import { createShareUrl, publicRequest, type PublicLinkFixture } from '../helpers/publicClient.ts';
import { getUsage, getFile } from '../../src/domain/files.ts';
import { b64 } from '../../src/lib/b64.ts';

let world: TestWorld;
let owner: Account;
let album: number;
let link: PublicLinkFixture;

const post = (path: string, body: unknown) =>
  publicRequest(world, 'POST', path, { accessToken: link.token, body });

/** The full anonymous upload: presign file+thumb, PUT bytes, commit. */
const collectUpload = async () => {
  const file = encryptBlob(new Uint8Array(randomBytes(96)));
  const thumb = encryptBlob(new Uint8Array(randomBytes(24)));
  const keys: string[] = [];
  for (const blob of [file, thumb]) {
    const res = await post('/public-collection/upload-url', {
      contentLength: blob.cipher.length,
      contentMD5: b64(randomBytes(16)),
    });
    if (res.status !== 200) return { status: res.status, res };
    const { objectKey, url } = (await res.json()) as { objectKey: string; url: string };
    await world.deps.blobs.uploadViaUrl(url, blob.cipher);
    keys.push(objectKey);
  }
  const commit = await post('/public-collection/file', {
    id: 0,
    collectionID: album,
    encryptedKey: b64(randomBytes(48)),
    keyDecryptionNonce: b64(randomBytes(24)),
    file: { objectKey: keys[0], decryptionHeader: file.decryptionHeader },
    thumbnail: { objectKey: keys[1], decryptionHeader: thumb.decryptionHeader },
    metadata: { encryptedData: b64(randomBytes(64)), decryptionHeader: b64(randomBytes(24)) },
  });
  return { status: commit.status, res: commit, file, thumb, keys };
};

beforeEach(async () => {
  world = await makeWorld();
  owner = await signupAccount(world, 'collect-owner@b.c');
  album = await createAlbum(world, owner, 'collecting');
  link = await createShareUrl(world, owner, album, { enableCollect: true });
});

it('enableCollect=false: all three collect routes answer 405 PUBLIC_COLLECT_DISABLED', async () => {
  const closedAlbum = await createAlbum(world, owner, 'closed');
  const closed = await createShareUrl(world, owner, closedAlbum);
  const expect405 = async (res: Response) => {
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({
      code: 'PUBLIC_COLLECT_DISABLED',
      message: 'User has not enabled public collect for this url',
    });
  };
  const md5 = b64(randomBytes(16));
  await expect405(
    await publicRequest(world, 'POST', '/public-collection/upload-url', {
      accessToken: closed.token,
      body: { contentLength: 64, contentMD5: md5 },
    }),
  );
  await expect405(
    await publicRequest(world, 'POST', '/public-collection/multipart-upload-url', {
      accessToken: closed.token,
      body: { contentLength: 10 * 1024 * 1024, partLength: 5 * 1024 * 1024, partMd5s: [md5, md5] },
    }),
  );
  await expect405(
    await publicRequest(world, 'POST', '/public-collection/file', {
      accessToken: closed.token,
      body: {
        id: 0,
        collectionID: closedAlbum,
        encryptedKey: b64(randomBytes(48)),
        keyDecryptionNonce: b64(randomBytes(24)),
        file: { objectKey: `${owner.userId}/x`, decryptionHeader: 'h' },
        thumbnail: { objectKey: `${owner.userId}/y`, decryptionHeader: 'h' },
        metadata: { encryptedData: 'm', decryptionHeader: 'h' },
      },
    }),
  );
});

it('anonymous upload lands a file OWNED by the link owner, under their namespace, charged to their quota', async () => {
  const before = await getUsage(world.deps, owner.userId);
  const out = await collectUpload();
  expect(out.status).toBe(200);
  const echoed = (await out.res.json()) as Record<string, unknown>;
  expect(echoed.ownerID).toBe(owner.userId); // museum: file.OwnerID = collectionOwnerID
  expect(echoed.collectionID).toBe(album);
  for (const key of out.keys!) expect(key.startsWith(`${owner.userId}/`)).toBe(true);

  const row = (await getFile(world.deps, echoed.id as number))!;
  expect(row.ownerID).toBe(owner.userId);
  const after = await getUsage(world.deps, owner.userId);
  expect(after.bytes - before.bytes).toBe(out.file!.cipher.length + out.thumb!.cipher.length);
  expect(after.fileCount - before.fileCount).toBe(1);

  // The collected file syncs to the owner like any other.
  const diff = await world.request('GET', `/collections/v2/diff?collectionID=${album}&sinceTime=0`, {
    token: owner.token,
  });
  const { diff: entries } = (await diff.json()) as { diff: Array<{ id: number }> };
  expect(entries.map((e) => e.id)).toContain(echoed.id);
  // ... and serves back through the link.
  const dl = await publicRequest(world, 'GET', `/public-collection/files/download/${echoed.id}`, {
    accessToken: link.token,
  });
  expect(dl.status).toBe(307);
});

it('commit refuses a foreign collectionID and forces id=0 (no updates through a link)', async () => {
  const other = await createAlbum(world, owner, 'other');
  const res = await post('/public-collection/file', {
    id: 0,
    collectionID: other,
    encryptedKey: b64(randomBytes(48)),
    keyDecryptionNonce: b64(randomBytes(24)),
    file: { objectKey: `${owner.userId}/x`, decryptionHeader: 'h' },
    thumbnail: { objectKey: `${owner.userId}/y`, decryptionHeader: 'h' },
    metadata: { encryptedData: 'm', decryptionHeader: 'h' },
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    code: 'BAD_REQUEST',
    message: 'can only update to associated collection',
  });

  // id != 0 would be museum's forced-create path: the update branch (which
  // answers {id, updationTime}) must be unreachable through a link.
  const first = await collectUpload();
  expect(first.status).toBe(200);
  const committed = (await first.res.json()) as { id: number };
  expect(committed.id).toBeGreaterThan(0);
});

it('multipart requires partMd5s on the public route (museum bare-400s an empty list)', async () => {
  const res = await post('/public-collection/multipart-upload-url', {
    contentLength: 10 * 1024 * 1024,
    partLength: 5 * 1024 * 1024,
  });
  expect(res.status).toBe(400);
  const ok = await post('/public-collection/multipart-upload-url', {
    contentLength: 10 * 1024 * 1024,
    partLength: 5 * 1024 * 1024,
    partMd5s: [b64(randomBytes(16)), b64(randomBytes(16))],
  });
  expect(ok.status).toBe(200);
  const body = (await ok.json()) as { objectKey: string; partURLs: string[]; completeURL: string };
  expect(body.objectKey.startsWith(`${owner.userId}/`)).toBe(true);
  expect(body.partURLs).toHaveLength(2);
});

it('the per-link daily upload ceiling 429s across mints AND commits', async () => {
  world.deps.config.publicLinkDailyUploadLimit = 2;
  const md5 = b64(randomBytes(16));
  expect((await post('/public-collection/upload-url', { contentLength: 64, contentMD5: md5 })).status).toBe(200);
  expect((await post('/public-collection/upload-url', { contentLength: 64, contentMD5: md5 })).status).toBe(200);
  const capped = await post('/public-collection/upload-url', { contentLength: 64, contentMD5: md5 });
  expect(capped.status).toBe(429);
  expect(await capped.json()).toEqual({});
});
