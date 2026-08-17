/** Trash purge cron + int64-id JS-number safety (build plan §1). */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { createAlbum, uploadAndCommit } from '../helpers/upload.ts';
import { purgeAgedTrash } from '../../src/domain/trash.ts';
import { MICROS_PER_DAY } from '../../src/lib/time.ts';
import { IdGenerator } from '../../src/domain/ids.ts';
import { TestClock } from '../../src/adapters/memory/system.memory.ts';

let world: TestWorld;
let account: Account;

beforeEach(async () => {
  world = await makeWorld();
  account = await signupAccount(world, 'purge@b.c');
});

describe('trash purge cron', () => {
  it('purges entries past deleteBy, leaves fresh ones, decrements usage', async () => {
    const album = await createAlbum(world, account);
    const old = await uploadAndCommit(world, account, album, new Uint8Array(randomBytes(100)), new Uint8Array(randomBytes(10)));
    await world.request('POST', '/files/trash', {
      token: account.token,
      body: { items: [{ fileID: old.fileId, collectionID: album }] },
    });

    world.deps.clock.advance(15 * MICROS_PER_DAY);
    const fresh = await uploadAndCommit(world, account, album, new Uint8Array(randomBytes(200)), new Uint8Array(randomBytes(20)));
    await world.request('POST', '/files/trash', {
      token: account.token,
      body: { items: [{ fileID: fresh.fileId, collectionID: album }] },
    });

    world.deps.clock.advance(16 * MICROS_PER_DAY); // old: 31d (due), fresh: 16d (not due)
    const purged = await purgeAgedTrash(world.deps);
    expect(purged).toBe(1);

    // the purged file's two objects are swept by the cron's second half
    const { sweepDeletedObjects } = await import('../../src/domain/objectSweep.ts');
    expect(await sweepDeletedObjects(world.deps)).toBe(2);
    expect(await world.deps.blobs.head(old.fileObjectKey)).toBeNull();
    expect(await world.deps.blobs.head(fresh.fileObjectKey)).not.toBeNull();

    const details = await world.request('GET', '/users/details/v2', { token: account.token });
    const { usage } = (await details.json()) as { usage: number };
    expect(usage).toBe(fresh.file.cipher.length + fresh.thumb.cipher.length);

    // second run is a no-op
    expect(await purgeAgedTrash(world.deps)).toBe(0);
  });
});

describe('id generator', () => {
  it('epoch-microsecond ids stay safe JS integers and strictly increase', () => {
    const clock = new TestClock();
    const ids = new IdGenerator(clock);
    let last = 0;
    for (let i = 0; i < 1000; i++) {
      const id = ids.next();
      expect(Number.isSafeInteger(id)).toBe(true);
      expect(id).toBeGreaterThan(last);
      last = id;
    }
    // headroom check: 2^53 micros is ~year 2255 — 5x today's epoch
    expect(Date.now() * 1000 * 5).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});
