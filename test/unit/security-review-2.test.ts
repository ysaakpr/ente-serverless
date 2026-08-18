/**
 * Regression tests for the second security review (SECURITY-REVIEW-2, gitignored).
 * Each block fails against the pre-fix code and passes after it.
 *   F1 push/token arbitrary write   F2 SRP cap concurrency   F3 id-collision guard
 *   F4 batch caps                   F5 entityDiff NaN limit  F7 delete reaper + isDeleted
 *   F9 HASHING_KEY length
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { openEncryptedToken, signupAccount, type Account } from '../helpers/client.ts';
import { createAlbum, uploadAndCommit } from '../helpers/upload.ts';
import { b64 } from '../../src/lib/b64.ts';
import { tokenHash } from '../../src/domain/tokens.ts';
import { SRP_ATTEMPT_CAP } from '../../src/domain/srpSessions.ts';
import { MemoryDb } from '../../src/adapters/memory/db.memory.ts';
import { IdGenerator } from '../../src/domain/ids.ts';
import { RealRand, TestClock } from '../../src/adapters/memory/system.memory.ts';
import { newCollectionRow, putCollection } from '../../src/domain/collections.ts';
import { getFile } from '../../src/domain/files.ts';
import { purgeAgedTrash, trashFile, TRASH_RETENTION_MICROS } from '../../src/domain/trash.ts';
import type { Item } from '../../src/ports/db.ts';
import type { Deps } from '../../src/deps.ts';

describe('F1 — push/token cannot write an arbitrary row', () => {
  let world: TestWorld;
  let account: Account;
  beforeEach(async () => {
    world = await makeWorld();
    account = await signupAccount(world, 'f1@b.c');
  });

  it('a forged pk/sk in the body is stripped, not honoured', async () => {
    const forgedToken = 'attacker-chosen-token';
    const forgedPk = `TOKEN#${tokenHash(forgedToken)}`;

    const res = await world.request('POST', '/push/token', {
      token: account.token,
      body: {
        pk: forgedPk,
        sk: 'META',
        userId: 999999,
        token: forgedToken,
        app: 'photos',
        creationTime: 1,
        lastUsedTime: 1,
        gsi3pk: 'USER#999999#TOKENS',
        gsi3sk: '0000000000000001',
        fcmToken: 'legit',
      },
    });
    expect(res.status).toBe(200);

    // The write landed only under the caller's own key, with unknown fields stripped.
    expect(await world.deps.db.get(forgedPk, 'META')).toBeNull();
    const stored = await world.deps.db.get(`USER#${account.userId}`, 'PUSHTOKEN');
    expect(stored).not.toBeNull();
    expect(stored!.fcmToken).toBe('legit');
    expect(stored!.userId).toBeUndefined();
    expect(stored!.token).toBeUndefined();

    // The forged token authenticates nothing.
    const probe = await world.request('GET', '/users/details/v2', { token: forgedToken });
    expect(probe.status).toBe(401);
  });
});

describe('F2 — SRP attempt cap binds under a concurrent burst', () => {
  it('at most SRP_ATTEMPT_CAP guesses reach the compare; all are counted', async () => {
    const world = await makeWorld();
    const account = await signupAccount(world, 'f2@b.c');

    const create = await world.request('POST', '/users/srp/create-session', {
      body: { srpUserID: account.srpUserID, srpA: b64(randomBytes(512)) },
    });
    const { sessionID } = (await create.json()) as { sessionID: string };

    const N = 30;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        world.request('POST', '/users/srp/verify-session', {
          body: { sessionID, srpUserID: account.srpUserID, srpM1: b64(randomBytes(32)) },
        }),
      ),
    );
    const statuses = results.map((r) => r.status);
    const reachedCompare = statuses.filter((s) => s === 401).length; // wrong-password 401
    const capped = statuses.filter((s) => s === 410).length; // TOO_MANY_WRONG_ATTEMPTS

    // The whole point: a burst can no longer slip more than the cap past the gate.
    expect(reachedCompare).toBeLessThanOrEqual(SRP_ATTEMPT_CAP);
    expect(capped).toBe(N - reachedCompare);

    // And every attempt was still counted (atomic ADD — no lost increments).
    const row = await world.deps.db.get(`SRPSESSION#${sessionID}`, 'META');
    expect(row!.attemptCount).toBe(N);
  });
});

describe('F3 — colliding server ids do not overwrite another row', () => {
  it('putCollection re-mints on an id collision instead of clobbering', async () => {
    const clock = new TestClock();
    const db = new MemoryDb();
    const mkDeps = (ids: IdGenerator) =>
      ({ db, ids, clock, rand: new RealRand() } as unknown as Deps);

    const deps1 = mkDeps(new IdGenerator(clock));
    const a = await putCollection(
      deps1,
      newCollectionRow(deps1, 1, 'photos', {
        encryptedKey: 'k',
        keyDecryptionNonce: 'n',
        type: 'album',
      }),
    );

    // A second "instance": a fresh generator on the SAME frozen clock mints the
    // same first id — exactly the cross-instance collision F3 is about.
    const deps2 = mkDeps(new IdGenerator(clock));
    const rowB = newCollectionRow(deps2, 2, 'photos', {
      encryptedKey: 'k2',
      keyDecryptionNonce: 'n2',
      type: 'album',
    });
    expect(rowB.collectionId).toBe(a.collectionId); // collision precondition

    const b = await putCollection(deps2, rowB);
    expect(b.collectionId).not.toBe(a.collectionId); // loser took a fresh id

    // The winner's row is intact — not overwritten by the second owner.
    const stored = await db.get(`COL#${a.collectionId}`, 'META');
    expect(stored!.ownerID).toBe(1);
  });
});

describe('F4 — unbounded batch endpoints are capped (413)', () => {
  let world: TestWorld;
  let account: Account;
  beforeEach(async () => {
    world = await makeWorld();
    account = await signupAccount(world, 'f4@b.c');
  });

  const oversize = Array.from({ length: 1001 }, (_, i) => i + 1);

  it('POST /files/info', async () => {
    const res = await world.request('POST', '/files/info', {
      token: account.token,
      body: { fileIDs: oversize },
    });
    expect(res.status).toBe(413);
  });

  it('POST /trash/delete', async () => {
    const res = await world.request('POST', '/trash/delete', {
      token: account.token,
      body: { fileIDs: oversize },
    });
    expect(res.status).toBe(413);
  });

  it('PUT /files/magic-metadata', async () => {
    const metadataList = oversize.map((id) => ({
      id,
      magicMetadata: { version: 1, count: 1, data: 'x', header: 'y' },
    }));
    const res = await world.request('PUT', '/files/magic-metadata', {
      token: account.token,
      body: { metadataList },
    });
    expect(res.status).toBe(413);
  });
});

describe('F5 — entity diff rejects a non-finite limit', () => {
  let world: TestWorld;
  let account: Account;
  beforeEach(async () => {
    world = await makeWorld();
    account = await signupAccount(world, 'f5@b.c');
  });

  it('limit=abc is 400 (would otherwise drain the partition), valid limits pass', async () => {
    const bad = await world.request(
      'GET',
      '/user-entity/entity/diff?type=location&sinceTime=0&limit=abc',
      { token: account.token },
    );
    expect(bad.status).toBe(400);

    const empty = await world.request(
      'GET',
      '/user-entity/entity/diff?type=location&sinceTime=0&limit=',
      { token: account.token },
    );
    expect(empty.status).toBe(400);

    const ok = await world.request(
      'GET',
      '/user-entity/entity/diff?type=location&sinceTime=0&limit=500',
      { token: account.token },
    );
    expect(ok.status).toBe(200);
  });
});

describe('F7 — account deletion reaps data; tombstoned tokens are refused', () => {
  it('deleting an account enqueues its objects and drops key material', async () => {
    const world = await makeWorld();
    const account = await signupAccount(world, 'f7@b.c');
    const albumId = await createAlbum(world, account);
    const up = await uploadAndCommit(
      world,
      account,
      albumId,
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
    );

    const chal = await world.request('GET', '/users/delete-challenge', { token: account.token });
    const { encryptedChallenge } = (await chal.json()) as { encryptedChallenge: string };
    const challenge = openEncryptedToken(encryptedChallenge, account.keys);

    const del = await world.request('DELETE', '/users/delete', {
      token: account.token,
      body: { challenge },
    });
    expect(del.status).toBe(200);

    // The user's S3 objects are queued for the existing sweep.
    const queuedKeys = world.deps.db
      .dump()
      .filter((r) => r.pk === 'PURGEQ')
      .map((r) => r.objectKey);
    expect(queuedKeys).toContain(up.fileObjectKey);
    expect(queuedKeys).toContain(up.thumbObjectKey);

    // Key material is gone, not left behind under the tombstone.
    expect(await world.deps.db.get(`USER#${account.userId}`, 'KEYS')).toBeNull();
    expect(await world.deps.db.get(`USER#${account.userId}`, 'SRP')).toBeNull();

    // The token is revoked.
    expect(
      (await world.request('GET', '/users/details/v2', { token: account.token })).status,
    ).toBe(401);
  });

  it('a token for a tombstoned account is refused even if the row survives', async () => {
    const world = await makeWorld();
    const account = await signupAccount(world, 'f7b@b.c');

    // Simulate a token that outlived the delete window: tombstone the user but
    // leave the token row in place.
    const user = await world.deps.db.get(`USER#${account.userId}`, 'META');
    await world.deps.db.put({ ...user!, isDeleted: true });

    const res = await world.request('GET', '/users/details/v2', { token: account.token });
    expect(res.status).toBe(401);
  });
});

describe('F6 — a poison row does not wedge the purge batch', () => {
  it('one failing row is skipped; the rest still purge', async () => {
    const world = await makeWorld();
    const account = await signupAccount(world, 'f6@b.c');
    const albumId = await createAlbum(world, account);
    const good = await uploadAndCommit(
      world,
      account,
      albumId,
      new Uint8Array([1]),
      new Uint8Array([2]),
    );
    const poison = await uploadAndCommit(
      world,
      account,
      albumId,
      new Uint8Array([3]),
      new Uint8Array([4]),
    );

    await trashFile(world.deps, account.userId, (await getFile(world.deps, good.fileId))!, albumId);
    await trashFile(world.deps, account.userId, (await getFile(world.deps, poison.fileId))!, albumId);
    world.deps.clock.advance(TRASH_RETENTION_MICROS + 1); // both now due

    // Make the poison file's tombstone write throw, leaving every other op intact.
    const realPut = world.deps.db.put.bind(world.deps.db);
    world.deps.db.put = async (item: Item, opts?: { ifNotExists?: boolean }) => {
      if (item.pk === `TRASH#${account.userId}` && item.sk === `FILE#${poison.fileId}`) {
        throw new Error('poison row');
      }
      return realPut(item, opts);
    };

    // Must NOT reject — the batch completes, the good row is reclaimed.
    const purged = await purgeAgedTrash(world.deps);
    expect(purged).toBe(1);
    expect(await world.deps.db.get(`FILE#${good.fileId}`, 'META')).toBeNull();
    // The poison file survived for a later retry rather than being lost.
    expect(await world.deps.db.get(`FILE#${poison.fileId}`, 'META')).not.toBeNull();
  });
});

describe('F9 — HASHING_KEY length is enforced', () => {
  it('wireAwsDeps rejects a key that does not decode to 32 bytes', async () => {
    const prev = process.env.HASHING_KEY;
    const { wireAwsDeps } = await import('../../src/wire.ts');
    try {
      process.env.HASHING_KEY = Buffer.from('short').toString('base64'); // 5 bytes
      await expect(wireAwsDeps()).rejects.toThrow(/32 bytes/);

      process.env.HASHING_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
      await expect(wireAwsDeps()).resolves.toBeTruthy();
    } finally {
      if (prev === undefined) delete process.env.HASHING_KEY;
      else process.env.HASHING_KEY = prev;
    }
  });
});
