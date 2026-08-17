/** [FILE-META] PUT /files/magic-metadata + public variant — 5 scenarios. */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { createAlbum, uploadAndCommit, type UploadedFile } from '../helpers/upload.ts';
import { b64 } from '../../src/lib/b64.ts';

let world: TestWorld;
let owner: Account;
let albumId: number;
let up: UploadedFile;

const meta = (version: number, count = 3) => ({
  version,
  count,
  data: b64(randomBytes(48)),
  header: b64(randomBytes(24)),
});

beforeEach(async () => {
  world = await makeWorld();
  owner = await signupAccount(world, 'meta@b.c');
  albumId = await createAlbum(world, owner);
  up = await uploadAndCommit(world, owner, albumId, new Uint8Array(randomBytes(256)), new Uint8Array(randomBytes(32)));
});

describe('PUT /files/magic-metadata', () => {
  it('update lands and re-emits the file in the collection diff', async () => {
    const before = up.response.updationTime as number;
    const res = await world.request('PUT', '/files/magic-metadata', {
      token: owner.token,
      body: { metadataList: [{ id: up.fileId, magicMetadata: meta(0) }] },
    });
    expect(res.status).toBe(200);

    const diff = await world.request('GET', `/collections/v2/diff?collectionID=${albumId}&sinceTime=${before}`, {
      token: owner.token,
    });
    const body = (await diff.json()) as { diff: Array<Record<string, unknown>> };
    const entry = body.diff.find((f) => f.id === up.fileId)!;
    expect(entry.magicMetadata).toBeDefined();
    expect((entry.magicMetadata as { version: number }).version).toBe(1);
  });

  it('stale version -> 409 version mismatch', async () => {
    await world.request('PUT', '/files/magic-metadata', {
      token: owner.token,
      body: { metadataList: [{ id: up.fileId, magicMetadata: meta(0) }] },
    });
    const stale = await world.request('PUT', '/files/magic-metadata', {
      token: owner.token,
      body: { metadataList: [{ id: up.fileId, magicMetadata: meta(0) }] },
    });
    expect(stale.status).toBe(409);
  });

  it('count regression greater than 2 rejected', async () => {
    await world.request('PUT', '/files/magic-metadata', {
      token: owner.token,
      body: { metadataList: [{ id: up.fileId, magicMetadata: meta(0, 10) }] },
    });
    const regressed = await world.request('PUT', '/files/magic-metadata', {
      token: owner.token,
      body: { metadataList: [{ id: up.fileId, magicMetadata: meta(1, 5) }] },
    });
    expect(regressed.status).toBe(409);
  });

  it('owner-only for both magic and pubMagic', async () => {
    const other = await signupAccount(world, 'other-meta@b.c');
    for (const path of ['/files/magic-metadata', '/files/public-magic-metadata']) {
      const res = await world.request('PUT', path, {
        token: other.token,
        body: { metadataList: [{ id: up.fileId, magicMetadata: meta(0) }] },
      });
      expect(res.status).toBe(403);
    }
  });

  it('batch validation is all-or-nothing: one bad entry blocks the write', async () => {
    await world.request('PUT', '/files/magic-metadata', {
      token: owner.token,
      body: { metadataList: [{ id: up.fileId, magicMetadata: meta(0, 5) }] },
    });
    const second = await uploadAndCommit(world, owner, albumId, new Uint8Array(randomBytes(64)), new Uint8Array(randomBytes(16)));
    const res = await world.request('PUT', '/files/magic-metadata', {
      token: owner.token,
      body: {
        metadataList: [
          { id: second.fileId, magicMetadata: meta(0) }, // valid
          { id: up.fileId, magicMetadata: meta(0, 5) }, // stale version
        ],
      },
    });
    expect(res.status).toBe(409);
    // the valid entry must NOT have been applied
    const diff = await world.request('GET', `/collections/v2/diff?collectionID=${albumId}&sinceTime=0`, {
      token: owner.token,
    });
    const body = (await diff.json()) as { diff: Array<Record<string, unknown>> };
    const entry = body.diff.find((f) => f.id === second.fileId)!;
    expect(entry.magicMetadata).toBeUndefined();
  });
});
