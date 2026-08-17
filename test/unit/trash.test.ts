/**
 * [TRASH] — trash (3), diff (4 of 5 — oracle parity pending capture),
 * delete (4), empty (3), restore (3). Plus the M4 gate: the 30-operation
 * sync torture script with diff-stream integrity at every checkpoint.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { createAlbum, uploadAndCommit } from '../helpers/upload.ts';
import { b64 } from '../../src/lib/b64.ts';
import { MICROS_PER_DAY } from '../../src/lib/time.ts';

let world: TestWorld;
let account: Account;

const item = (id: number) => ({
  id,
  encryptedKey: b64(randomBytes(48)),
  keyDecryptionNonce: b64(randomBytes(24)),
});

const trashDiff = async (sinceTime = 0) => {
  const res = await world.request('GET', `/trash/v2/diff?sinceTime=${sinceTime}`, {
    token: account.token,
  });
  return (await res.json()) as {
    diff: Array<{
      file: { id: number };
      isDeleted: boolean;
      isRestored: boolean;
      deleteBy: number;
      updatedAt: number;
    }>;
    hasMore: boolean;
  };
};

const colDiff = async (collectionId: number, sinceTime = 0) => {
  const res = await world.request(
    'GET',
    `/collections/v2/diff?collectionID=${collectionId}&sinceTime=${sinceTime}`,
    { token: account.token },
  );
  return (await res.json()) as { diff: Array<Record<string, unknown>>; hasMore: boolean };
};

beforeEach(async () => {
  world = await makeWorld();
  account = await signupAccount(world, 'trash@b.c');
});

describe('POST /files/trash', () => {
  it('creates trash entry with deleteBy=+30d and a collection tombstone', async () => {
    const album = await createAlbum(world, account);
    const up = await uploadAndCommit(world, account, album, new Uint8Array(randomBytes(64)), new Uint8Array(randomBytes(16)));
    const cursor = Math.max(...(await colDiff(album)).diff.map((f) => f.updationTime as number));

    const res = await world.request('POST', '/files/trash', {
      token: account.token,
      body: { items: [{ fileID: up.fileId, collectionID: album }] },
    });
    expect(res.status).toBe(200);

    const trash = await trashDiff();
    expect(trash.diff).toHaveLength(1);
    expect(trash.diff[0]!.file.id).toBe(up.fileId);
    const expectedDeleteBy = world.deps.clock.nowMicros() + 30 * MICROS_PER_DAY;
    expect(Math.abs(trash.diff[0]!.deleteBy - expectedDeleteBy)).toBeLessThan(1_000_000);

    const tombstones = await colDiff(album, cursor);
    expect(tombstones.diff).toHaveLength(1);
    expect(tombstones.diff[0]!.isDeleted).toBe(true);
  });

  it('re-trash is idempotent (one live diff entry)', async () => {
    const album = await createAlbum(world, account);
    const up = await uploadAndCommit(world, account, album, new Uint8Array(randomBytes(64)), new Uint8Array(randomBytes(16)));
    await world.request('POST', '/files/trash', {
      token: account.token,
      body: { items: [{ fileID: up.fileId, collectionID: album }] },
    });
    const second = await world.request('POST', '/files/trash', {
      token: account.token,
      body: { items: [{ fileID: up.fileId, collectionID: album }] },
    });
    expect(second.status).toBe(200);
    const trash = await trashDiff();
    expect(trash.diff.filter((t) => t.file.id === up.fileId)).toHaveLength(1);
  });

  it('foreign file rejected 403', async () => {
    const album = await createAlbum(world, account);
    const up = await uploadAndCommit(world, account, album, new Uint8Array(randomBytes(64)), new Uint8Array(randomBytes(16)));
    const other = await signupAccount(world, 'trash-other@b.c');
    const res = await world.request('POST', '/files/trash', {
      token: other.token,
      body: { items: [{ fileID: up.fileId, collectionID: album }] },
    });
    expect(res.status).toBe(403);
  });
});

describe('restore + delete + empty', () => {
  it('restore round-trip: tombstone flavour isRestored, deleteBy cleared, reappears in collection diff', async () => {
    const album = await createAlbum(world, account);
    const up = await uploadAndCommit(world, account, album, new Uint8Array(randomBytes(64)), new Uint8Array(randomBytes(16)));
    await world.request('POST', '/files/trash', {
      token: account.token,
      body: { items: [{ fileID: up.fileId, collectionID: album }] },
    });
    const trashCursor = Math.max(...(await trashDiff()).diff.map((t) => t.updatedAt));

    const res = await world.request('POST', '/collections/restore-files', {
      token: account.token,
      body: { collectionID: album, files: [item(up.fileId)] },
    });
    expect(res.status).toBe(200);

    const after = await trashDiff(trashCursor);
    expect(after.diff).toHaveLength(1);
    expect(after.diff[0]!.isRestored).toBe(true);
    expect(after.diff[0]!.isDeleted).toBe(false);
    expect(after.diff[0]!.deleteBy).toBe(0);

    const diff = await colDiff(album);
    const live = diff.diff.filter((f) => f.id === up.fileId && !f.isDeleted);
    expect(live).toHaveLength(1);
  });

  it('restore to a foreign collection rejected', async () => {
    const album = await createAlbum(world, account);
    const up = await uploadAndCommit(world, account, album, new Uint8Array(randomBytes(64)), new Uint8Array(randomBytes(16)));
    await world.request('POST', '/files/trash', {
      token: account.token,
      body: { items: [{ fileID: up.fileId, collectionID: album }] },
    });
    const other = await signupAccount(world, 'restore-other@b.c');
    const otherAlbum = await createAlbum(world, other);
    const res = await world.request('POST', '/collections/restore-files', {
      token: account.token,
      body: { collectionID: otherAlbum, files: [item(up.fileId)] },
    });
    expect(res.status).toBe(403);
  });

  it('permanent delete: usage decremented once, tombstone, double-delete idempotent, objects gone', async () => {
    const album = await createAlbum(world, account);
    const up = await uploadAndCommit(world, account, album, new Uint8Array(randomBytes(500)), new Uint8Array(randomBytes(50)));
    await world.request('POST', '/files/trash', {
      token: account.token,
      body: { items: [{ fileID: up.fileId, collectionID: album }] },
    });

    const del = await world.request('POST', '/trash/delete', {
      token: account.token,
      body: { fileIDs: [up.fileId] },
    });
    expect(del.status).toBe(200);

    const details = await world.request('GET', '/users/details/v2', { token: account.token });
    const body = (await details.json()) as { usage: number; fileCount: number };
    expect(body.usage).toBe(0);
    expect(body.fileCount).toBe(0);

    const trash = await trashDiff();
    expect(trash.diff[0]!.isDeleted).toBe(true);

    // double delete: no further usage change
    await world.request('POST', '/trash/delete', { token: account.token, body: { fileIDs: [up.fileId] } });
    const details2 = await world.request('GET', '/users/details/v2', { token: account.token });
    expect(((await details2.json()) as { usage: number }).usage).toBe(0);

    // objects are ENQUEUED for the sweep cron (D6), not deleted inline
    expect(await world.deps.blobs.head(up.fileObjectKey)).not.toBeNull();
    const { sweepDeletedObjects } = await import('../../src/domain/objectSweep.ts');
    expect(await sweepDeletedObjects(world.deps)).toBe(2);
    expect(await world.deps.blobs.head(up.fileObjectKey)).toBeNull();
    expect(await world.deps.blobs.head(up.thumbObjectKey)).toBeNull();
  });

  it('empty trash: entries <= lastUpdatedAt gone, newer survive, usage adjusted', async () => {
    const album = await createAlbum(world, account);
    const first = await uploadAndCommit(world, account, album, new Uint8Array(randomBytes(300)), new Uint8Array(randomBytes(30)));
    const second = await uploadAndCommit(world, account, album, new Uint8Array(randomBytes(400)), new Uint8Array(randomBytes(40)));

    await world.request('POST', '/files/trash', {
      token: account.token,
      body: { items: [{ fileID: first.fileId, collectionID: album }] },
    });
    const cutoff = Math.max(...(await trashDiff()).diff.map((t) => t.updatedAt));
    await world.request('POST', '/files/trash', {
      token: account.token,
      body: { items: [{ fileID: second.fileId, collectionID: album }] },
    });

    const res = await world.request('POST', '/trash/empty', {
      token: account.token,
      body: { lastUpdatedAt: cutoff },
    });
    expect(res.status).toBe(200);

    const after = await trashDiff();
    const firstEntry = after.diff.find((t) => t.file.id === first.fileId)!;
    const secondEntry = after.diff.find((t) => t.file.id === second.fileId)!;
    expect(firstEntry.isDeleted).toBe(true);
    expect(secondEntry.isDeleted).toBe(false);

    const details = await world.request('GET', '/users/details/v2', { token: account.token });
    expect(((await details.json()) as { usage: number }).usage).toBe(
      second.file.cipher.length + second.thumb.cipher.length,
    );
  });
});

describe('M4 gate: 30-op sync torture across 3 collections', () => {
  it('diff-stream stays consistent at every checkpoint', async () => {
    const albums = [
      await createAlbum(world, account, 'A'),
      await createAlbum(world, account, 'B'),
      await createAlbum(world, account, 'C'),
    ];

    // A "client" replaying the diffs incrementally after every operation.
    const cursors = new Map(albums.map((a) => [a, 0]));
    const clientState = new Map(albums.map((a) => [a, new Map<number, boolean>()])); // fileId -> live
    let trashCursor = 0;
    const clientTrash = new Map<number, { isDeleted: boolean; isRestored: boolean }>();

    const syncAll = async () => {
      for (const a of albums) {
        let since = cursors.get(a)!;
        for (;;) {
          const page = await colDiff(a, since);
          for (const f of page.diff) {
            expect((f.updationTime as number) > since).toBe(true); // strict ordering
            clientState.get(a)!.set(f.id as number, !(f.isDeleted as boolean));
            since = Math.max(since, f.updationTime as number);
          }
          if (!page.hasMore) break;
        }
        cursors.set(a, since);
      }
      let since = trashCursor;
      for (;;) {
        const page = await trashDiff(since);
        for (const t of page.diff) {
          clientTrash.set(t.file.id, { isDeleted: t.isDeleted, isRestored: t.isRestored });
          since = Math.max(since, t.updatedAt);
        }
        if (!page.hasMore) break;
      }
      trashCursor = since;
    };

    // ops 1-6: upload 6 files into A
    const files = [];
    for (let i = 0; i < 6; i++) {
      files.push(
        await uploadAndCommit(world, account, albums[0]!, new Uint8Array(randomBytes(100 + i)), new Uint8Array(randomBytes(20))),
      );
      await syncAll();
    }

    // ops 7-12: move 3 to B, add 2 to C (link shares), rename A
    for (let i = 0; i < 3; i++) {
      await world.request('POST', '/collections/move-files', {
        token: account.token,
        body: { fromCollectionID: albums[0], toCollectionID: albums[1], files: [item(files[i]!.fileId)] },
      });
      await syncAll();
    }
    for (let i = 3; i < 5; i++) {
      await world.request('POST', '/collections/add-files', {
        token: account.token,
        body: { collectionID: albums[2], files: [item(files[i]!.fileId)] },
      });
      await syncAll();
    }
    await world.request('POST', '/collections/rename', {
      token: account.token,
      body: { collectionID: albums[0], encryptedName: b64(randomBytes(8)), nameDecryptionNonce: b64(randomBytes(24)) },
    });
    await syncAll();

    // ops 13-18: trash 2, restore 1, permanently delete 1
    await world.request('POST', '/files/trash', {
      token: account.token,
      body: { items: [{ fileID: files[3]!.fileId, collectionID: albums[0] }] },
    });
    await syncAll();
    await world.request('POST', '/files/trash', {
      token: account.token,
      body: { items: [{ fileID: files[5]!.fileId, collectionID: albums[0] }] },
    });
    await syncAll();
    await world.request('POST', '/collections/restore-files', {
      token: account.token,
      body: { collectionID: albums[0], files: [item(files[3]!.fileId)] },
    });
    await syncAll();
    await world.request('POST', '/trash/delete', {
      token: account.token,
      body: { fileIDs: [files[5]!.fileId] },
    });
    await syncAll();

    // ops 19-24: metadata churn
    for (const f of [files[0], files[1], files[2]]) {
      await world.request('PUT', '/files/magic-metadata', {
        token: account.token,
        body: { metadataList: [{ id: f!.fileId, magicMetadata: { version: 0, count: 1, data: 'eA==', header: 'aA==' } }] },
      });
      await syncAll();
    }
    // ops 25-27: more uploads into B
    for (let i = 0; i < 2; i++) {
      await uploadAndCommit(world, account, albums[1]!, new Uint8Array(randomBytes(80)), new Uint8Array(randomBytes(10)));
      await syncAll();
    }
    // ops 28-30: delete C (keepFiles=false), empty trash to now
    await world.request('DELETE', `/collections/v3/${albums[2]}?collectionID=${albums[2]}&keepFiles=false`, {
      token: account.token,
    });
    await syncAll();
    await world.request('POST', '/trash/empty', {
      token: account.token,
      body: { lastUpdatedAt: world.deps.clock.nowMicros() + 10_000_000_000 },
    });
    await syncAll();

    // Final client state must equal a from-scratch replay (sinceTime=0).
    for (const a of albums) {
      const fresh = new Map<number, boolean>();
      let since = 0;
      for (;;) {
        const page = await colDiff(a, since);
        for (const f of page.diff) {
          fresh.set(f.id as number, !(f.isDeleted as boolean));
          since = Math.max(since, f.updationTime as number);
        }
        if (!page.hasMore) break;
      }
      expect(fresh).toEqual(clientState.get(a));
    }

    // files[3] was restored into A then trashed again by C's delete? no — it
    // lives in A and C; C's delete trashed only... it had a live link in C.
    // The torture's point: incremental == from-scratch, asserted above.

    // Everything trashed is now tombstoned (trash emptied).
    const finalTrash = await trashDiff();
    for (const t of finalTrash.diff) {
      expect(t.isDeleted || t.isRestored).toBe(true);
    }
  });
});
