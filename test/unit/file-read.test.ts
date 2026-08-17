/** [FILE-READ] — download (4), preview (3), info/size (3). */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { createAlbum, uploadAndCommit, type UploadedFile } from '../helpers/upload.ts';

let world: TestWorld;
let owner: Account;
let stranger: Account;
let albumId: number;
let up: UploadedFile;

beforeEach(async () => {
  world = await makeWorld();
  owner = await signupAccount(world, 'owner@b.c');
  stranger = await signupAccount(world, 'stranger@b.c');
  albumId = await createAlbum(world, owner);
  up = await uploadAndCommit(world, owner, albumId, new Uint8Array(randomBytes(2048)), new Uint8Array(randomBytes(256)));
});

describe('GET /files/download', () => {
  it('v1 is a 307 redirect with Location; v2 returns {url}; both serve the bytes', async () => {
    const v1 = await world.request('GET', `/files/download/${up.fileId}`, { token: owner.token });
    expect(v1.status).toBe(307);
    const location = v1.headers.get('location')!;
    expect(Buffer.from(await world.deps.blobs.downloadViaUrl(location))).toEqual(Buffer.from(up.file.cipher));

    const v2 = await world.request('GET', `/files/download/v2/${up.fileId}`, { token: owner.token });
    expect(v2.status).toBe(200);
    const { url } = (await v2.json()) as { url: string };
    expect(Buffer.from(await world.deps.blobs.downloadViaUrl(url))).toEqual(Buffer.from(up.file.cipher));
  });

  it('non-member gets 404 (museum sql.ErrNoRows path)', async () => {
    const res = await world.request('GET', `/files/download/v2/${up.fileId}`, { token: stranger.token });
    expect(res.status).toBe(404);
  });

  it('trashed file still downloadable by owner', async () => {
    await world.request('POST', '/files/trash', {
      token: owner.token,
      body: { items: [{ fileID: up.fileId, collectionID: albumId }] },
    });
    const res = await world.request('GET', `/files/download/v2/${up.fileId}`, { token: owner.token });
    expect(res.status).toBe(200);
  });

  it('unknown id 404', async () => {
    const res = await world.request('GET', '/files/download/v2/123456789', { token: owner.token });
    expect(res.status).toBe(404);
  });
});

describe('GET /files/preview', () => {
  it('serves the thumbnail object, not the file', async () => {
    const res = await world.request('GET', `/files/preview/v2/${up.fileId}`, { token: owner.token });
    const { url } = (await res.json()) as { url: string };
    const bytes = await world.deps.blobs.downloadViaUrl(url);
    expect(Buffer.from(bytes)).toEqual(Buffer.from(up.thumb.cipher));
    expect(Buffer.from(bytes)).not.toEqual(Buffer.from(up.file.cipher));
  });

  it('authz mirrors download', async () => {
    expect((await world.request('GET', `/files/preview/v2/${up.fileId}`, { token: stranger.token })).status).toBe(404);
  });

  it('v1 preview is a 307 redirect', async () => {
    const res = await world.request('GET', `/files/preview/${up.fileId}`, { token: owner.token });
    expect(res.status).toBe(307);
  });
});

describe('POST /files/info + /files/size', () => {
  it('sizes match the committed objects', async () => {
    const info = await world.request('POST', '/files/info', {
      token: owner.token,
      body: { fileIDs: [up.fileId] },
    });
    expect(info.status).toBe(200);
    const body = (await info.json()) as { filesInfo: Array<{ id: number; fileInfo: { fileSize: number; thumbSize: number } }> };
    expect(body.filesInfo[0]).toEqual({
      id: up.fileId,
      fileInfo: { fileSize: up.file.cipher.length, thumbSize: up.thumb.cipher.length },
    });

    const size = await world.request('POST', '/files/size', {
      token: owner.token,
      body: { fileIDs: [up.fileId] },
    });
    expect(((await size.json()) as { size: number }).size).toBe(up.file.cipher.length);
  });

  it('info on foreign files -> 403; unknown ids -> 400', async () => {
    const foreign = await world.request('POST', '/files/info', {
      token: stranger.token,
      body: { fileIDs: [up.fileId] },
    });
    expect(foreign.status).toBe(403);
    const unknown = await world.request('POST', '/files/info', {
      token: owner.token,
      body: { fileIDs: [42] },
    });
    expect(unknown.status).toBe(400);
  });

  it('size silently excludes foreign files', async () => {
    const res = await world.request('POST', '/files/size', {
      token: stranger.token,
      body: { fileIDs: [up.fileId] },
    });
    expect(((await res.json()) as { size: number }).size).toBe(0);
  });
});
