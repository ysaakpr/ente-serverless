/**
 * [FILE-DATA] — the 7 scenario groups: vid_preview + img_preview round-trips,
 * video-data commit+fetch, mldata put/fetch batch, status-diff integrity,
 * type gates, authz.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { createAlbum, uploadAndCommit, type UploadedFile } from '../helpers/upload.ts';
import { b64 } from '../../src/lib/b64.ts';
import { objectKey } from '../../src/domain/fileData.ts';

let world: TestWorld;
let account: Account;
let up: UploadedFile;

beforeEach(async () => {
  world = await makeWorld();
  account = await signupAccount(world, 'fd@b.c');
  const album = await createAlbum(world, account);
  up = await uploadAndCommit(world, account, album, new Uint8Array(randomBytes(256)), new Uint8Array(randomBytes(32)));
});

describe('vid_preview: upload-url -> PUT video-data -> preview + fetch', () => {
  it('full HLS round-trip', async () => {
    // 1. get preview upload url and PUT the encrypted video
    const urlRes = await world.request(
      'GET',
      `/files/data/preview-upload-url?fileID=${up.fileId}&type=vid_preview`,
      { token: account.token },
    );
    expect(urlRes.status).toBe(200);
    const { objectID, url } = (await urlRes.json()) as { objectID: string; url: string };
    expect(objectID).toMatch(/^pv_/);
    const videoBytes = new Uint8Array(randomBytes(4096));
    await world.deps.blobs.uploadViaUrl(url, videoBytes);

    // 2. commit via PUT /files/video-data
    const playlist = b64(randomBytes(200));
    const commit = await world.request('PUT', '/files/video-data', {
      token: account.token,
      body: {
        fileID: up.fileId,
        objectID,
        objectSize: videoBytes.length,
        playlist,
        playlistHeader: b64(randomBytes(24)),
      },
    });
    expect(commit.status).toBe(200);
    expect(await commit.json()).toEqual({});

    // 3. GET /files/data/preview serves the video bytes
    const preview = await world.request(
      'GET',
      `/files/data/preview?fileID=${up.fileId}&type=vid_preview`,
      { token: account.token },
    );
    expect(preview.status).toBe(200);
    const previewUrl = ((await preview.json()) as { url: string }).url;
    expect(Buffer.from(await world.deps.blobs.downloadViaUrl(previewUrl))).toEqual(Buffer.from(videoBytes));

    // 4. batch fetch returns the playlist
    const fetchRes = await world.request('POST', '/files/data/fetch', {
      token: account.token,
      body: { fileIDs: [up.fileId], type: 'vid_preview' },
    });
    const fetchBody = (await fetchRes.json()) as { data: Array<{ encryptedData: string }> };
    expect(fetchBody.data[0]!.encryptedData).toBe(playlist);
  });

  it('video-data commit with wrong objectSize -> 400; missing object -> 503', async () => {
    const urlRes = await world.request(
      'GET',
      `/files/data/preview-upload-url?fileID=${up.fileId}&type=vid_preview`,
      { token: account.token },
    );
    const { objectID, url } = (await urlRes.json()) as { objectID: string; url: string };
    await world.deps.blobs.uploadViaUrl(url, new Uint8Array(randomBytes(100)));

    const mismatch = await world.request('PUT', '/files/video-data', {
      token: account.token,
      body: { fileID: up.fileId, objectID, objectSize: 999, playlist: 'cA==', playlistHeader: 'aA==' },
    });
    expect(mismatch.status).toBe(400);

    const missing = await world.request('PUT', '/files/video-data', {
      token: account.token,
      body: { fileID: up.fileId, objectID: 'pv_nope', objectSize: 1, playlist: 'cA==', playlistHeader: 'aA==' },
    });
    expect(missing.status).toBe(503);
  });
});

describe('img_preview: protocol-ready round-trip', () => {
  it('upload-url -> PUT -> preview GET serves bytes', async () => {
    const urlRes = await world.request(
      'GET',
      `/files/data/preview-upload-url?fileID=${up.fileId}&type=img_preview`,
      { token: account.token },
    );
    const { objectID, url } = (await urlRes.json()) as { objectID: string; url: string };
    expect(objectID).toMatch(/^pi_/);
    const bytes = new Uint8Array(randomBytes(2048));
    await world.deps.blobs.uploadViaUrl(url, bytes);

    const preview = await world.request(
      'GET',
      `/files/data/preview?fileID=${up.fileId}&type=img_preview`,
      { token: account.token },
    );
    expect(preview.status).toBe(200);
    const previewUrl = ((await preview.json()) as { url: string }).url;
    expect(Buffer.from(await world.deps.blobs.downloadViaUrl(previewUrl))).toEqual(Buffer.from(bytes));
  });
});

describe('mldata put/fetch', () => {
  it('PUT + single fetch + batch fetch with pendingIndexFileIDs', async () => {
    const encryptedData = b64(randomBytes(512));
    const put = await world.request('PUT', '/files/data', {
      token: account.token,
      body: { fileID: up.fileId, type: 'mldata', encryptedData, decryptionHeader: b64(randomBytes(24)) },
    });
    expect(put.status).toBe(200);

    const single = await world.request('GET', `/files/data/fetch?fileID=${up.fileId}&type=mldata`, {
      token: account.token,
    });
    expect(single.status).toBe(200);
    expect(((await single.json()) as { data: { encryptedData: string } }).data.encryptedData).toBe(encryptedData);

    const album2 = await createAlbum(world, account, 'second');
    const second = await uploadAndCommit(world, account, album2, new Uint8Array(randomBytes(64)), new Uint8Array(randomBytes(16)));
    const batch = await world.request('POST', '/files/data/fetch', {
      token: account.token,
      body: { fileIDs: [up.fileId, second.fileId], type: 'mldata' },
    });
    const body = (await batch.json()) as { data: unknown[]; pendingIndexFileIDs: number[] };
    expect(body.data).toHaveLength(1);
    expect(body.pendingIndexFileIDs).toEqual([second.fileId]);
  });
});

describe('status-diff', () => {
  it('emits rows after lastUpdatedAt only; validates lastUpdatedAt', async () => {
    await world.request('PUT', '/files/data', {
      token: account.token,
      body: { fileID: up.fileId, type: 'mldata', encryptedData: b64(randomBytes(64)), decryptionHeader: b64(randomBytes(24)) },
    });
    const diff1 = await world.request('POST', '/files/data/status-diff', {
      token: account.token,
      body: { lastUpdatedAt: 0 },
    });
    const body1 = (await diff1.json()) as { diff: Array<{ fileID: number; type: string; updatedAt: number }> };
    expect(body1.diff.map((d) => d.type)).toContain('mldata');

    const cursor = Math.max(...body1.diff.map((d) => d.updatedAt));
    const diff2 = await world.request('POST', '/files/data/status-diff', {
      token: account.token,
      body: { lastUpdatedAt: cursor },
    });
    expect(((await diff2.json()) as { diff: unknown[] }).diff).toHaveLength(0);

    const invalid = await world.request('POST', '/files/data/status-diff', {
      token: account.token,
      body: {},
    });
    expect(invalid.status).toBe(400);
  });
});

describe('type gates + authz', () => {
  it('rejects exactly what museum rejects', async () => {
    // PUT /files/data only accepts mldata
    const badPut = await world.request('PUT', '/files/data', {
      token: account.token,
      body: { fileID: up.fileId, type: 'vid_preview', encryptedData: 'eA==', decryptionHeader: 'aA==' },
    });
    expect(badPut.status).toBe(400);

    // fetch only vid_preview | mldata
    const badFetch = await world.request('POST', '/files/data/fetch', {
      token: account.token,
      body: { fileIDs: [up.fileId], type: 'img_preview' },
    });
    expect(badFetch.status).toBe(400);

    // preview urls only vid_preview | img_preview
    const badPreview = await world.request(
      'GET',
      `/files/data/preview-upload-url?fileID=${up.fileId}&type=mldata`,
      { token: account.token },
    );
    expect(badPreview.status).toBe(400);

    // batch cap 200
    const bigBatch = await world.request('POST', '/files/data/fetch', {
      token: account.token,
      body: { fileIDs: Array.from({ length: 201 }, (_, i) => i + 1), type: 'mldata' },
    });
    expect(bigBatch.status).toBe(400);
  });

  it('authz on all routes: foreign file is 403, no token is 401', async () => {
    const other = await signupAccount(world, 'fd-other@b.c');
    const foreignPut = await world.request('PUT', '/files/data', {
      token: other.token,
      body: { fileID: up.fileId, type: 'mldata', encryptedData: 'eA==', decryptionHeader: 'aA==' },
    });
    expect(foreignPut.status).toBe(403);
    const foreignPreview = await world.request(
      'GET',
      `/files/data/preview-upload-url?fileID=${up.fileId}&type=vid_preview`,
      { token: other.token },
    );
    expect(foreignPreview.status).toBe(403);
    expect((await world.request('PUT', '/files/data', { body: {} })).status).toBe(401);
  });
});

/**
 * objectID is the ONE client-controlled value that reaches an S3 key: PUT
 * /files/video-data takes it back from the caller and objectKey() interpolates it
 * into `<owner>/file-data/<fileID>/<type>/<objectID>`. Museum answers 400 {} to
 * every malformed shape we probed on this route (D41).
 */
describe('objectID validation on PUT /files/video-data', () => {
  const REJECTED = [
    '../../../../9999/file-data/1/mldata', // escape to another user's prefix
    'pv_a/../../escape',
    'pv_a/b',
    'pv_a.b', // no dots: blocks any `..` segment by construction
    'plain-not-prefixed',
    'xx_11111111',
    `pv_${'a'.repeat(65)}`, // past the length bound
  ];

  it('rejects traversal and malformed ids with 400, writing nothing', async () => {
    for (const objectID of REJECTED) {
      const res = await world.request('PUT', '/files/video-data', {
        token: account.token,
        body: {
          fileID: up.fileId,
          objectID,
          objectSize: 10,
          playlist: 'cA==',
          playlistHeader: 'aA==',
        },
      });
      expect(res.status, objectID).toBe(400);
    }

    // No fd row was created by any of them.
    const preview = await world.request(
      'GET',
      `/files/data/preview?fileID=${up.fileId}&type=vid_preview`,
      { token: account.token },
    );
    expect(preview.status).toBe(404);
  });

  it('still accepts the server-issued objectID (round-trip unaffected)', async () => {
    const urlRes = await world.request(
      'GET',
      `/files/data/preview-upload-url?fileID=${up.fileId}&type=vid_preview`,
      { token: account.token },
    );
    const { objectID, url } = (await urlRes.json()) as { objectID: string; url: string };
    const bytes = new Uint8Array(randomBytes(64));
    await world.deps.blobs.uploadViaUrl(url, bytes);

    const commit = await world.request('PUT', '/files/video-data', {
      token: account.token,
      body: {
        fileID: up.fileId,
        objectID,
        objectSize: bytes.length,
        playlist: b64(randomBytes(32)),
        playlistHeader: b64(randomBytes(24)),
      },
    });
    expect(commit.status).toBe(200);
  });

  /** The backstop: even if a future caller skips the edge check, no escaping key. */
  it('objectKey refuses to build an escaping key at all', () => {
    expect(() => objectKey(1, 2, 'vid_preview', 'pv_ok')).not.toThrow();
    for (const bad of ['../x', 'pv_a/b', 'pv_a..b', '']) {
      expect(() => objectKey(1, 2, 'vid_preview', bad), bad).toThrow(/refusing to build/);
    }
  });
});
