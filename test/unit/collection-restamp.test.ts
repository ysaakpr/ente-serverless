/**
 * [D62] Every collection_files mutation and every public-link write restamps
 * the collection, so /collections/v2 re-emits it and synced clients re-diff.
 * src: museum bumps collections.updation_time in repo/file.go (Create, Update,
 * UpdateMagicAttributes, UpdateThumbnail), repo/collection.go (AddFiles,
 * MoveFiles, RestoreFiles, RemoveFilesV3), repo/trash.go (TrashFiles), and on
 * every public_collection_tokens INSERT/UPDATE via the
 * fn_update_collections_updation_time_using_update_at trigger (schema-level —
 * invisible in the Go source; read from the oracle's Postgres).
 *
 * Oracle-verified 2026-08-27: after an anonymous collect upload museum's
 * owner feed re-emits the collection with updationTime == the new file link's
 * stamp; before D62 our feed returned [] and the stock clients (which only
 * re-diff collections whose updationTime advanced) never showed guest
 * uploads or link-config changes to the owner.
 */

import { beforeEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { createAlbum, encryptBlob, uploadAndCommit } from '../helpers/upload.ts';
import { createShareUrl, publicRequest } from '../helpers/publicClient.ts';
import { bumpCollectionForward, getCollection } from '../../src/domain/collections.ts';
import { b64 } from '../../src/lib/b64.ts';

let world: TestWorld;
let A: Account;

beforeEach(async () => {
  world = await makeWorld();
  A = await signupAccount(world, 'restamp-a@b.c');
});

const feedSince = async (account: Account, since: number): Promise<any[]> => {
  const res = await world.request('GET', `/collections/v2?sinceTime=${since}`, {
    token: account.token,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { collections: any[] }).collections;
};

/** What a synced stock client knows: the max updationTime it has seen. */
const lastSync = async (account: Account): Promise<number> =>
  Math.max(...(await feedSince(account, 0)).map((c) => c.updationTime as number));

const reEmitted = async (account: Account, since: number, collectionId: number) =>
  (await feedSince(account, since)).find((c) => c.id === collectionId);

const seed = () => new Uint8Array(randomBytes(64));

it('authed commit re-emits the collection, stamped to the new file link', async () => {
  const album = await createAlbum(world, A, 'commit');
  const since = await lastSync(A);
  const up = await uploadAndCommit(world, A, album, seed(), seed());
  const entry = await reEmitted(A, since, album);
  expect(entry).toBeDefined();
  // museum sets equality: the collection stamp IS the link's updationTime
  expect(entry.updationTime).toBe(up.response.updationTime);
});

it('anonymous collect commit re-emits for the owner (the invisible-guest-upload bug)', async () => {
  const album = await createAlbum(world, A, 'collect');
  const link = await createShareUrl(world, A, album, { enableCollect: true });
  const since = await lastSync(A);

  const file = encryptBlob(seed());
  const thumb = encryptBlob(seed());
  const keys: string[] = [];
  for (const blob of [file, thumb]) {
    const mint = await publicRequest(world, 'POST', '/public-collection/upload-url', {
      accessToken: link.token,
      body: { contentLength: blob.cipher.length, contentMD5: b64(randomBytes(16)) },
    });
    expect(mint.status).toBe(200);
    const { objectKey, url } = (await mint.json()) as { objectKey: string; url: string };
    await world.deps.blobs.uploadViaUrl(url, blob.cipher);
    keys.push(objectKey);
  }
  const commit = await publicRequest(world, 'POST', '/public-collection/file', {
    accessToken: link.token,
    body: {
      id: 0,
      collectionID: album,
      encryptedKey: b64(randomBytes(48)),
      keyDecryptionNonce: b64(randomBytes(24)),
      file: { objectKey: keys[0], decryptionHeader: file.decryptionHeader },
      thumbnail: { objectKey: keys[1], decryptionHeader: thumb.decryptionHeader },
      metadata: { encryptedData: b64(randomBytes(64)), decryptionHeader: b64(randomBytes(24)) },
    },
  });
  expect(commit.status).toBe(200);
  const committed = (await commit.json()) as { id: number; updationTime: number };

  const entry = await reEmitted(A, since, album);
  expect(entry).toBeDefined();
  expect(entry.updationTime).toBe(committed.updationTime);
});

it('share-url create/update/disable each re-emit; returning the existing link does not', async () => {
  const album = await createAlbum(world, A, 'link-ops');
  const since0 = await lastSync(A);
  const mint = await world.request('POST', '/collections/share-url', {
    token: A.token,
    body: { collectionID: album },
  });
  expect(mint.status).toBe(200);
  expect(await reEmitted(A, since0, album)).toBeDefined();

  // re-mint returns the existing link — no INSERT, museum's trigger stays quiet
  const since1 = await lastSync(A);
  const again = await world.request('POST', '/collections/share-url', {
    token: A.token,
    body: { collectionID: album },
  });
  expect(again.status).toBe(200);
  expect(await reEmitted(A, since1, album)).toBeUndefined();

  const upd = await world.request('PUT', '/collections/share-url', {
    token: A.token,
    body: { collectionID: album, enableDownload: false },
  });
  expect(upd.status).toBe(200);
  const entry = await reEmitted(A, since1, album);
  expect(entry).toBeDefined();
  // the re-emitted entry carries the NEW link config for the app to render
  expect(entry.publicURLs[0].enableDownload).toBe(false);

  const since2 = await lastSync(A);
  const kill = await world.request('DELETE', `/collections/share-url/${album}`, { token: A.token });
  expect(kill.status).toBe(200);
  const afterKill = await reEmitted(A, since2, album);
  expect(afterKill).toBeDefined();
  expect(afterKill.publicURLs).toEqual([]);

  // no active link left: DELETE again disables nothing and bumps nothing
  const since3 = await lastSync(A);
  await world.request('DELETE', `/collections/share-url/${album}`, { token: A.token });
  expect(await reEmitted(A, since3, album)).toBeUndefined();
});

it('collaborator add-files and remove-files v3 re-emit for the owner', async () => {
  const B = await signupAccount(world, 'restamp-b@b.c');
  const album = await createAlbum(world, A, 'shared');
  const share = await world.request('POST', '/collections/share', {
    token: A.token,
    body: { collectionID: album, email: B.email, encryptedKey: b64(randomBytes(80)), role: 'COLLABORATOR' },
  });
  expect(share.status).toBe(200);

  const bAlbum = await createAlbum(world, B, 'b-own');
  const up = await uploadAndCommit(world, B, bAlbum, seed(), seed());

  const sinceAdd = await lastSync(A);
  const add = await world.request('POST', '/collections/add-files', {
    token: B.token,
    body: {
      collectionID: album,
      files: [{ id: up.fileId, encryptedKey: b64(randomBytes(48)), keyDecryptionNonce: b64(randomBytes(24)) }],
    },
  });
  expect(add.status).toBe(200);
  expect(await reEmitted(A, sinceAdd, album)).toBeDefined();

  const sinceRemove = await lastSync(A);
  const remove = await world.request('POST', '/collections/v3/remove-files', {
    token: B.token,
    body: { collectionID: album, fileIDs: [up.fileId] },
  });
  expect(remove.status).toBe(200);
  expect(await reEmitted(A, sinceRemove, album)).toBeDefined();
});

it('move-files re-emits both collections', async () => {
  const from = await createAlbum(world, A, 'from');
  const to = await createAlbum(world, A, 'to');
  const up = await uploadAndCommit(world, A, from, seed(), seed());
  const since = await lastSync(A);
  const move = await world.request('POST', '/collections/move-files', {
    token: A.token,
    body: {
      fromCollectionID: from,
      toCollectionID: to,
      files: [{ id: up.fileId, encryptedKey: b64(randomBytes(48)), keyDecryptionNonce: b64(randomBytes(24)) }],
    },
  });
  expect(move.status).toBe(200);
  expect(await reEmitted(A, since, from)).toBeDefined();
  expect(await reEmitted(A, since, to)).toBeDefined();
});

it('trash re-emits every collection containing the file; restore re-emits again', async () => {
  const album1 = await createAlbum(world, A, 't1');
  const album2 = await createAlbum(world, A, 't2');
  const up = await uploadAndCommit(world, A, album1, seed(), seed());
  const add = await world.request('POST', '/collections/add-files', {
    token: A.token,
    body: {
      collectionID: album2,
      files: [{ id: up.fileId, encryptedKey: b64(randomBytes(48)), keyDecryptionNonce: b64(randomBytes(24)) }],
    },
  });
  expect(add.status).toBe(200);

  const sinceTrash = await lastSync(A);
  const trash = await world.request('POST', '/files/trash', {
    token: A.token,
    body: { items: [{ fileID: up.fileId, collectionID: album1 }] },
  });
  expect(trash.status).toBe(200);
  expect(await reEmitted(A, sinceTrash, album1)).toBeDefined();
  expect(await reEmitted(A, sinceTrash, album2)).toBeDefined();

  const sinceRestore = await lastSync(A);
  const restore = await world.request('POST', '/collections/restore-files', {
    token: A.token,
    body: {
      collectionID: album1,
      files: [{ id: up.fileId, encryptedKey: b64(randomBytes(48)), keyDecryptionNonce: b64(randomBytes(24)) }],
    },
  });
  expect(restore.status).toBe(200);
  expect(await reEmitted(A, sinceRestore, album1)).toBeDefined();
});

it('file magic-metadata update re-emits the containing collection', async () => {
  const album = await createAlbum(world, A, 'mmd');
  const up = await uploadAndCommit(world, A, album, seed(), seed());
  const since = await lastSync(A);
  const res = await world.request('PUT', '/files/magic-metadata', {
    token: A.token,
    body: {
      metadataList: [
        {
          id: up.fileId,
          magicMetadata: { version: 1, count: 1, data: b64(randomBytes(48)), header: b64(randomBytes(24)) },
        },
      ],
    },
  });
  expect(res.status).toBe(200);
  expect(await reEmitted(A, since, album)).toBeDefined();
});

it('thumbnail replace re-emits the containing collection', async () => {
  const album = await createAlbum(world, A, 'thumb');
  const up = await uploadAndCommit(world, A, album, seed(), seed());
  const newThumb = encryptBlob(seed());
  const mint = await world.request('GET', '/files/upload-urls?count=1', { token: A.token });
  const { urls } = (await mint.json()) as { urls: Array<{ objectKey: string; url: string }> };
  await world.deps.blobs.uploadViaUrl(urls[0]!.url, newThumb.cipher);

  const since = await lastSync(A);
  const res = await world.request('PUT', '/files/thumbnail', {
    token: A.token,
    body: {
      fileID: up.fileId,
      thumbnail: { objectKey: urls[0]!.objectKey, decryptionHeader: newThumb.decryptionHeader },
    },
  });
  expect(res.status).toBe(200);
  expect(await reEmitted(A, since, album)).toBeDefined();
});

it('bumpCollectionForward is forward-only, like the museum trigger guard', async () => {
  const album = await createAlbum(world, A, 'guard');
  const row = await getCollection(world.deps, album);
  const stamp = row!.updationTime;
  await bumpCollectionForward(world.deps, album, stamp - 10);
  expect((await getCollection(world.deps, album))!.updationTime).toBe(stamp);
  await bumpCollectionForward(world.deps, album, stamp + 10);
  expect((await getCollection(world.deps, album))!.updationTime).toBe(stamp + 10);
});
