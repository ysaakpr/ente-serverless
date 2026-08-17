/**
 * Gate finding D28: the app's post-trash sync reads collectionID from
 * /trash/v2/diff and resolves it via GET /collections/:collectionID.
 * Replays the exact on-device sequence from the 2026-08-17 gate log.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { createAlbum, uploadAndCommit } from '../helpers/upload.ts';

let world: TestWorld;
let account: Account;

beforeEach(async () => {
  world = await makeWorld();
  account = await signupAccount(world, 'origin@b.c');
});

describe('trash diff origin collection (D28)', () => {
  it('trash entry carries the origin collectionID + that collection’s wrapped key', async () => {
    const album = await createAlbum(world, account);
    const up = await uploadAndCommit(world, account, album, new Uint8Array(randomBytes(128)), new Uint8Array(randomBytes(16)));

    await world.request('POST', '/files/trash', {
      token: account.token,
      body: { items: [{ fileID: up.fileId, collectionID: album }] },
    });

    const diff = await world.request('GET', '/trash/v2/diff?sinceTime=0', { token: account.token });
    const { diff: entries } = (await diff.json()) as {
      diff: Array<{ file: Record<string, unknown> }>;
    };
    const entry = entries[0]!.file;
    expect(entry.collectionID).toBe(album);
    expect(entry.encryptedKey).toBe(up.response.encryptedKey); // the link's wrapped key
    expect(entry.keyDecryptionNonce).toBe(up.response.keyDecryptionNonce);

    // ...and the app can resolve that collection (the /collections/0 fix)
    const col = await world.request('GET', `/collections/${entry.collectionID}`, {
      token: account.token,
    });
    expect(col.status).toBe(200);
    expect(((await col.json()) as { collection: { id: number } }).collection.id).toBe(album);
  });

  it('legacy trash rows without a stored origin recover it from the tombstoned link', async () => {
    const album = await createAlbum(world, account);
    const up = await uploadAndCommit(world, account, album, new Uint8Array(randomBytes(64)), new Uint8Array(randomBytes(16)));
    await world.request('POST', '/files/trash', {
      token: account.token,
      body: { items: [{ fileID: up.fileId, collectionID: album }] },
    });

    // simulate a pre-D28 row: strip the stored collectionID
    const row = (await world.deps.db.get(`TRASH#${account.userId}`, `FILE#${up.fileId}`))!;
    await world.deps.db.put({ ...row, collectionID: undefined });

    const diff = await world.request('GET', '/trash/v2/diff?sinceTime=0', { token: account.token });
    const { diff: entries } = (await diff.json()) as { diff: Array<{ file: { collectionID: number } }> };
    expect(entries[0]!.file.collectionID).toBe(album);
  });
});

describe('GET /collections/:collectionID', () => {
  it('returns {"collection"} incl. deleted ones; 404 unknown; 403 foreign; static routes still win', async () => {
    const album = await createAlbum(world, account);

    const ok = await world.request('GET', `/collections/${album}`, { token: account.token });
    expect(ok.status).toBe(200);

    // deleted collections are still resolvable (museum IncludeDeleted: true)
    await world.request('DELETE', `/collections/v3/${album}?collectionID=${album}&keepFiles=false`, {
      token: account.token,
    });
    const deleted = await world.request('GET', `/collections/${album}`, { token: account.token });
    expect(deleted.status).toBe(200);
    expect(((await deleted.json()) as { collection: { isDeleted: boolean } }).collection.isDeleted).toBe(true);

    // unknown (incl. the app's old /collections/0 probe) -> 404 like museum
    expect((await world.request('GET', '/collections/0', { token: account.token })).status).toBe(404);

    const other = await signupAccount(world, 'origin-other@b.c');
    const otherAlbum = await createAlbum(world, other);
    expect((await world.request('GET', `/collections/${otherAlbum}`, { token: account.token })).status).toBe(403);

    // the param route must not shadow the static ones
    expect((await world.request('GET', '/collections/v2?sinceTime=0', { token: account.token })).status).toBe(200);
    expect((await world.request('GET', '/collections/v2/diff?collectionID=1&sinceTime=0', { token: account.token })).status).toBe(404); // unknown id, not a routing miss
  });
});
