/**
 * [SHARING] [SYNC] Phase C sharee sync feed — the query-time merge in
 * GET /collections/v2 (owned gsi2 partition ++ SHARED# reverse rows ++
 * SHAREDTOMB# unshare tombstones), the sharee-shaped collection JSON
 * (museum repo/collection.go GetCollectionsSharedWithUser), the getById key
 * swap, and the delete/account cascades that feed sharee tombstones.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { createAlbum, uploadAndCommit, type UploadedFile } from '../helpers/upload.ts';
import { getSharee, listSharedCollectionIds } from '../../src/domain/sharing.ts';
import { reapUserData } from '../../src/domain/accountReaper.ts';
import { b64 } from '../../src/lib/b64.ts';

interface CollectionJson {
  id: number;
  owner: { id: number; email: string; name: string; role: string };
  encryptedKey: string;
  keyDecryptionNonce?: string;
  attributes: Record<string, unknown>;
  sharees: Array<{ id: number; email: string; name: string; role: string }> | null;
  publicURLs: unknown;
  updationTime: number;
  isDeleted?: boolean;
  sharedAt?: number;
  app: string;
  [k: string]: unknown;
}

let world: TestWorld;
let owner: Account;
let mate: Account;
let album: number;
let wrappedKey: string;
let ownerFile: UploadedFile;

const sealedKey = () => b64(randomBytes(80));

const share = async (email: string, role = 'VIEWER', collectionID = album, key = sealedKey()) => {
  const res = await world.request('POST', '/collections/share', {
    token: owner.token,
    body: { collectionID, email, encryptedKey: key, role },
  });
  expect(res.status).toBe(200);
  return key;
};

const getV2 = async (token: string, sinceTime = 0): Promise<CollectionJson[]> => {
  const res = await world.request('GET', `/collections/v2?sinceTime=${sinceTime}`, { token });
  expect(res.status).toBe(200);
  return ((await res.json()) as { collections: CollectionJson[] }).collections;
};

const maxStamp = (cols: CollectionJson[]) => Math.max(0, ...cols.map((c) => c.updationTime));

beforeEach(async () => {
  world = await makeWorld();
  owner = await signupAccount(world, 'feed-owner@b.c');
  mate = await signupAccount(world, 'feed-mate@b.c');
  album = await createAlbum(world, owner, 'shared');
  ownerFile = await uploadAndCommit(world, owner, album, new Uint8Array(randomBytes(96)), new Uint8Array(randomBytes(16)));
  wrappedKey = await share(mate.email, 'COLLABORATOR');
});

describe('sharee /collections/v2 (query-time merge)', () => {
  it('emits the shared collection in the museum sharee shape: THEIR wrapped key, no nonce, owner email, role, zero attributes', async () => {
    const cols = await getV2(mate.token);
    const entry = cols.find((c) => c.id === album)!;
    expect(entry).toBeDefined();

    // encryptedKey is collection_shares.encrypted_key; keyDecryptionNonce is
    // ABSENT (omitempty + never selected for sharees) — a sealed box needs none.
    expect(entry.encryptedKey).toBe(wrappedKey);
    expect('keyDecryptionNonce' in entry).toBe(false);
    expect(entry.owner).toEqual({ id: owner.userId, email: owner.email, name: '', role: '' });
    expect(entry.attributes).toEqual({ version: 0 }); // museum: zero struct for sharees
    expect(entry.sharees).toEqual([{ id: mate.userId, email: mate.email, name: '', role: 'COLLABORATOR' }]);
    expect(entry.sharedAt).toBeGreaterThan(0);
    expect(entry.app).toBe('photos');
    expect(entry.isDeleted).toBeUndefined(); // omitempty: live rows carry no flag

    // The sharee's own albums still ride the owned partition unchanged.
    const ownAlbum = await createAlbum(world, mate, 'mine');
    const again = await getV2(mate.token);
    expect(again.find((c) => c.id === ownAlbum)!.keyDecryptionNonce).toBeTruthy();
  });

  it('owner\'s feed now populates sharees ([] when unshared) and keeps its own key material', async () => {
    const solo = await createAlbum(world, owner, 'solo');
    const cols = await getV2(owner.token);
    const sharedEntry = cols.find((c) => c.id === album)!;
    expect(sharedEntry.sharees).toEqual([{ id: mate.userId, email: mate.email, name: '', role: 'COLLABORATOR' }]);
    expect(sharedEntry.keyDecryptionNonce).toBeTruthy();
    expect(cols.find((c) => c.id === solo)!.sharees).toEqual([]);
  });

  it('respects sinceTime: a share surfaces via the collection restamp, an owner edit re-emits it', async () => {
    const synced = maxStamp(await getV2(mate.token));
    expect((await getV2(mate.token, synced)).map((c) => c.id)).toEqual([]);

    // Owner renames -> collections.updation_time moves -> sharee re-receives.
    const rename = await world.request('POST', '/collections/rename', {
      token: owner.token,
      body: { collectionID: album, encryptedName: b64(randomBytes(12)), nameDecryptionNonce: b64(randomBytes(24)) },
    });
    expect(rename.status).toBe(200);
    const after = await getV2(mate.token, synced);
    expect(after.map((c) => c.id)).toEqual([album]);

    // A second album shared later surfaces alone past the newer cursor.
    const synced2 = maxStamp(await getV2(mate.token));
    const album2 = await createAlbum(world, owner, 'second');
    await share(mate.email, 'VIEWER', album2);
    expect((await getV2(mate.token, synced2)).map((c) => c.id)).toEqual([album2]);
  });

  it('unshare surfaces as a per-user tombstone; the owner and feed of others never see it; re-share resurrects', async () => {
    const synced = maxStamp(await getV2(mate.token));
    const third = await signupAccount(world, 'feed-third@b.c');
    await share(third.email, 'VIEWER');
    const thirdSynced = maxStamp(await getV2(third.token));

    const unshare = await world.request('POST', '/collections/unshare', {
      token: owner.token,
      body: { collectionID: album, email: mate.email },
    });
    expect(unshare.status).toBe(200);

    // The sharee's delta: exactly one tombstone for the album, no live entry.
    const delta = await getV2(mate.token, synced);
    const tomb = delta.find((c) => c.id === album)!;
    expect(tomb.isDeleted).toBe(true);
    expect(tomb.updationTime).toBeGreaterThan(synced);
    expect(delta.filter((c) => c.id === album)).toHaveLength(1);
    // Full resync: the collection is gone except for the tombstone.
    const full = await getV2(mate.token);
    expect(full.filter((c) => c.id === album && !c.isDeleted)).toHaveLength(0);

    // Owner still sees the collection live (per-user tombstone, plan §3.4)...
    const ownerCols = await getV2(owner.token);
    expect(ownerCols.find((c) => c.id === album)!.isDeleted).toBeUndefined();
    // ...and the remaining sharee sees a refreshed LIVE entry, not a tombstone.
    const thirdDelta = await getV2(third.token, thirdSynced);
    const thirdEntry = thirdDelta.find((c) => c.id === album)!;
    expect(thirdEntry.isDeleted).toBeUndefined();
    expect(thirdEntry.sharees).toEqual([{ id: third.userId, email: third.email, name: '', role: 'VIEWER' }]);

    // Re-share: the tombstone row is deleted in the same transaction, the
    // collection comes back live (museum ON CONFLICT is_deleted = FALSE).
    const resynced = maxStamp(await getV2(mate.token, synced));
    const rewrap = await share(mate.email, 'VIEWER');
    const back = await getV2(mate.token, resynced);
    expect(back.filter((c) => c.id === album)).toHaveLength(1);
    expect(back[0]!.isDeleted).toBeUndefined();
    expect(back[0]!.encryptedKey).toBe(rewrap);
    expect((await getV2(mate.token)).filter((c) => c.id === album && c.isDeleted)).toHaveLength(0);
  });

  it('pure-owner regression: a user with no sharing gets exactly the pre-Phase-C feed (plus sharees/publicURLs: [])', async () => {
    const solo = await signupAccount(world, 'feed-solo@b.c');
    const a1 = await createAlbum(world, solo, 'one');
    const a2 = await createAlbum(world, solo, 'two');
    const cols = await getV2(solo.token);
    expect(cols.map((c) => c.id).sort()).toEqual([a1, a2].sort());
    for (const col of cols) {
      expect(col.sharees).toEqual([]);
      // Phase D: museum emits [] on the v2 feed for link-less collections
      // (repo GetCollectionsOwnedByUserV2 initializes the empty slice).
      expect(col.publicURLs).toEqual([]);
      expect(col.keyDecryptionNonce).toBeTruthy();
    }
    const synced = maxStamp(cols);
    expect(await getV2(solo.token, synced)).toEqual([]);
  });
});

describe('sharee getById + diff', () => {
  it('GET /collections/:id hands the sharee THEIR wrapped key and the sharee list', async () => {
    const res = await world.request('GET', `/collections/${album}`, { token: mate.token });
    expect(res.status).toBe(200);
    const { collection } = (await res.json()) as { collection: CollectionJson };
    expect(collection.encryptedKey).toBe(wrappedKey);
    expect(collection.sharees).toEqual([{ id: mate.userId, email: mate.email, name: '', role: 'COLLABORATOR' }]);

    const asOwner = await world.request('GET', `/collections/${album}`, { token: owner.token });
    const ownerView = ((await asOwner.json()) as { collection: CollectionJson }).collection;
    expect(ownerView.encryptedKey).not.toBe(wrappedKey); // the owner keeps their own
    expect(ownerView.sharees).toEqual(collection.sharees);
  });

  it('sharee diff returns owner + collaborator files with attribution (Phase B plumbing intact)', async () => {
    const ownAlbum = await createAlbum(world, mate, 'mine');
    const up = await uploadAndCommit(world, mate, ownAlbum, new Uint8Array(randomBytes(64)), new Uint8Array(randomBytes(16)));
    const add = await world.request('POST', '/collections/add-files', {
      token: mate.token,
      body: { collectionID: album, files: [{ id: up.fileId, encryptedKey: b64(randomBytes(48)), keyDecryptionNonce: b64(randomBytes(24)) }] },
    });
    expect(add.status).toBe(200);

    const res = await world.request('GET', `/collections/v2/diff?collectionID=${album}&sinceTime=0`, { token: mate.token });
    expect(res.status).toBe(200);
    const { diff } = (await res.json()) as { diff: Array<{ id: number; ownerID: number; collectionOwnerID: number }> };
    expect(diff.find((f) => f.id === ownerFile.fileId)!.ownerID).toBe(owner.userId);
    const mateEntry = diff.find((f) => f.id === up.fileId)!;
    expect(mateEntry.ownerID).toBe(mate.userId);
    expect(mateEntry.collectionOwnerID).toBe(owner.userId);
  });
});

describe('cascades', () => {
  it('deleting a shared collection tombstones every sharee (museum ScheduleDelete)', async () => {
    const third = await signupAccount(world, 'feed-del@b.c');
    await share(third.email, 'VIEWER');
    const synced = maxStamp(await getV2(mate.token));

    const del = await world.request(
      'DELETE',
      `/collections/v3/${album}?collectionID=${album}&keepFiles=false`,
      { token: owner.token },
    );
    expect(del.status).toBe(200);

    for (const account of [mate, third]) {
      expect(await getSharee(world.deps, album, account.userId)).toBeNull();
      const delta = await getV2(account.token, account === mate ? synced : 0);
      const tomb = delta.find((c) => c.id === album)!;
      expect(tomb.isDeleted).toBe(true);
    }
  });

  it('account deletion revokes shares in both directions (museum ResetUserSharingAccess)', async () => {
    // mate is sharee of owner's album AND owner of an album shared with owner.
    const mateAlbum = await createAlbum(world, mate, 'mates');
    const back = await world.request('POST', '/collections/share', {
      token: mate.token,
      body: { collectionID: mateAlbum, email: owner.email, encryptedKey: sealedKey() },
    });
    expect(back.status).toBe(200);
    const ownerSynced = maxStamp(await getV2(owner.token));

    await reapUserData(world.deps, mate.userId);

    // Direction 1: mate's sharee rows on owner's album are gone.
    expect(await getSharee(world.deps, album, mate.userId)).toBeNull();
    expect(await listSharedCollectionIds(world.deps, mate.userId)).toEqual([]);
    // Direction 2: owner receives a tombstone for the album mate had shared.
    const delta = await getV2(owner.token, ownerSynced);
    const tomb = delta.find((c) => c.id === mateAlbum)!;
    expect(tomb.isDeleted).toBe(true);
    // And owner's own album now lists no sharees.
    const ownAgain = await getV2(owner.token);
    expect(ownAgain.find((c) => c.id === album)!.sharees).toEqual([]);
  });
});
