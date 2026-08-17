/**
 * F0 (security review 2026-08-17): `addToCountersReturning` is the race-free
 * capped-counter primitive behind the TOTP and OTT attempt caps. The contract
 * under test: N concurrent increments yield the distinct set 1..N — a property
 * a read-modify-write `db.update()` cannot provide, which is exactly the bug
 * the review's findings 1 and 3 shared.
 */

import { describe, expect, it } from 'vitest';
import { MemoryDb } from '../../src/adapters/memory/db.memory.ts';

describe('Db.addToCountersReturning', () => {
  it('N concurrent increments return the distinct set 1..N (no lost updates)', async () => {
    const db = new MemoryDb();
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, () => db.addToCountersReturning('CAP#x', 'ATTEMPTS', { count: 1 })),
    );
    const seen = results.map((r) => r.count!).sort((a, b) => a - b);
    expect(seen).toEqual(Array.from({ length: N }, (_, i) => i + 1));

    const row = await db.get('CAP#x', 'ATTEMPTS');
    expect(row!.count).toBe(N);
  });

  it('creates the item when missing and applies `set` alongside the ADD', async () => {
    const db = new MemoryDb();
    const out = await db.addToCountersReturning('CAP#y', 'ATTEMPTS', { count: 1 }, { ttl: 1234 });
    expect(out.count).toBe(1);

    const row = await db.get('CAP#y', 'ATTEMPTS');
    expect(row).toMatchObject({ pk: 'CAP#y', sk: 'ATTEMPTS', count: 1, ttl: 1234 });
  });

  it('leaves unrelated attributes on the row untouched', async () => {
    const db = new MemoryDb();
    await db.put({ pk: 'CAP#z', sk: 'ATTEMPTS', count: 3, note: 'keep' });
    const out = await db.addToCountersReturning('CAP#z', 'ATTEMPTS', { count: 2 });
    expect(out.count).toBe(5);
    expect((await db.get('CAP#z', 'ATTEMPTS'))!.note).toBe('keep');
  });

  it('regression guard: the same load through update() DOES lose increments', async () => {
    // Documents why the primitive exists. If MemoryDb.update() ever becomes
    // atomic-read-modify-write this starts failing — delete the test then; the
    // primitive above remains the only cap-safe path on real DynamoDB either way.
    const db = new MemoryDb();
    await db.put({ pk: 'CAP#w', sk: 'ATTEMPTS', count: 0 });
    await Promise.all(
      Array.from({ length: 50 }, async () => {
        const row = await db.get('CAP#w', 'ATTEMPTS');
        await db.update('CAP#w', 'ATTEMPTS', { count: (row!.count as number) + 1 });
      }),
    );
    const row = await db.get('CAP#w', 'ATTEMPTS');
    expect((row!.count as number)).toBeLessThan(50);
  });
});
