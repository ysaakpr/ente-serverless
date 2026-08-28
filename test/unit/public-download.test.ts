/**
 * [PUBLIC-COLLECTION] file serving — GET /files/download/:fileID (+v3) and
 * /files/preview/:fileID (+thumbnail/v3) through a link. src: pkg/api/
 * public_collection.go getFileForType/getFileURL + pkg/controller/file.go
 * GetPublicOrCastFileURL (live collection link required) + api/file.go
 * fileURLV3Error (v3 maps missing to 400 NOT_FOUND). The enableDownload 403
 * and the daily ceiling 429 are this repo's plan-§4.2/§4.1d hardenings (D51 —
 * museum leaves enableDownload to the client).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { createAlbum, uploadAndCommit, type UploadedFile } from '../helpers/upload.ts';
import { createShareUrl, publicRequest, type PublicLinkFixture } from '../helpers/publicClient.ts';

let world: TestWorld;
let owner: Account;
let album: number;
let link: PublicLinkFixture;
let up: UploadedFile;

const get = (path: string) => publicRequest(world, 'GET', path, { accessToken: link.token });

beforeEach(async () => {
  world = await makeWorld();
  owner = await signupAccount(world, 'dl-owner@b.c');
  album = await createAlbum(world, owner, 'dl');
  link = await createShareUrl(world, owner, album);
  up = await uploadAndCommit(world, owner, album, new Uint8Array(randomBytes(64)), new Uint8Array(randomBytes(16)));
});

it('307 original + preview serve the real bytes; v3 variants answer {"url"}', async () => {
  const dl = await get(`/public-collection/files/download/${up.fileId}`);
  expect(dl.status).toBe(307);
  expect(Buffer.from(await world.deps.blobs.downloadViaUrl(dl.headers.get('location')!))).toEqual(
    Buffer.from(up.file.cipher),
  );
  const pv = await get(`/public-collection/files/preview/${up.fileId}`);
  expect(pv.status).toBe(307);
  expect(Buffer.from(await world.deps.blobs.downloadViaUrl(pv.headers.get('location')!))).toEqual(
    Buffer.from(up.thumb.cipher),
  );
  for (const [path, blob] of [
    [`/public-collection/files/download/v3/${up.fileId}`, up.file],
    [`/public-collection/files/thumbnail/v3/${up.fileId}`, up.thumb],
  ] as const) {
    const res = await get(path);
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(Buffer.from(await world.deps.blobs.downloadViaUrl(url))).toEqual(Buffer.from(blob.cipher));
  }
});

it('only files LIVE-linked to THIS collection serve: foreign 404 {} / v3 400 NOT_FOUND, tombstoned 404', async () => {
  const otherAlbum = await createAlbum(world, owner, 'elsewhere');
  const foreign = await uploadAndCommit(world, owner, otherAlbum, new Uint8Array(randomBytes(64)), new Uint8Array(randomBytes(16)));

  const redirect = await get(`/public-collection/files/download/${foreign.fileId}`);
  expect(redirect.status).toBe(404);
  expect(await redirect.json()).toEqual({});
  const v3 = await get(`/public-collection/files/download/v3/${foreign.fileId}`);
  expect(v3.status).toBe(400); // museum fileURLV3Error: "so 404 can signal endpoint unavailability"
  expect(await v3.json()).toEqual({ code: 'NOT_FOUND', message: 'requested object was not found' });

  const trash = await world.request('POST', '/files/trash', {
    token: owner.token,
    body: { items: [{ fileID: up.fileId, collectionID: album }] },
  });
  expect(trash.status).toBe(200);
  expect((await get(`/public-collection/files/download/${up.fileId}`)).status).toBe(404);
});

it('enableDownload=false: original 403 {} (both variants), previews still serve — access control, not DRM', async () => {
  const upd = await world.request('PUT', '/collections/share-url', {
    token: owner.token,
    body: { collectionID: album, enableDownload: false },
  });
  expect(upd.status).toBe(200);

  const dl = await get(`/public-collection/files/download/${up.fileId}`);
  expect(dl.status).toBe(403);
  expect(await dl.json()).toEqual({});
  expect((await get(`/public-collection/files/download/v3/${up.fileId}`)).status).toBe(403);
  expect((await get(`/public-collection/files/preview/${up.fileId}`)).status).toBe(307);
  expect((await get(`/public-collection/files/thumbnail/v3/${up.fileId}`)).status).toBe(200);
});

it('the per-link daily download ceiling 429s, and resets with the UTC day', async () => {
  world.deps.config.publicLinkDailyDownloadLimit = 2;
  expect((await get(`/public-collection/files/preview/${up.fileId}`)).status).toBe(307);
  expect((await get(`/public-collection/files/download/${up.fileId}`)).status).toBe(307);
  const capped = await get(`/public-collection/files/download/${up.fileId}`);
  expect(capped.status).toBe(429);
  expect(await capped.json()).toEqual({});
  world.deps.clock.advance(24 * 3600 * 1_000_000); // next UTC day, fresh row
  expect((await get(`/public-collection/files/download/${up.fileId}`)).status).toBe(307);
});
