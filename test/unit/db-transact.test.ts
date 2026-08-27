/**
 * transactWrite contract (PENDING-FEATURES-PLAN §4.7): the sharing dual-writes
 * hang off this primitive, so the properties under test are the ones sharing
 * needs — all-or-nothing on condition failure, and a hard refusal of batches
 * past DynamoDB's TransactWriteItems ceiling (both adapters, checked before
 * anything is applied or sent).
 */

import { describe, expect, it } from 'vitest';
import { MemoryDb } from '../../src/adapters/memory/db.memory.ts';
import { DynamoDb } from '../../src/adapters/aws/db.dynamo.ts';
import { ConditionFailedError, MAX_TRANSACT_OPS, type TransactOp } from '../../src/ports/db.ts';
import { configFromEnv } from '../../src/config.ts';

describe('Db.transactWrite', () => {
  it('applies puts and deletes together', async () => {
    const db = new MemoryDb();
    await db.put({ pk: 'A', sk: 'META', v: 1 });
    await db.transactWrite([
      { kind: 'put', item: { pk: 'B', sk: 'META', v: 2 } },
      { kind: 'delete', key: { pk: 'A', sk: 'META' } },
    ]);
    expect(await db.get('A', 'META')).toBeNull();
    expect((await db.get('B', 'META'))!.v).toBe(2);
  });

  it('a failing condition applies NOTHING — earlier ops in the batch included', async () => {
    const db = new MemoryDb();
    await db.put({ pk: 'EXISTS', sk: 'META' });
    await db.put({ pk: 'VICTIM', sk: 'META', keep: true });
    await expect(
      db.transactWrite([
        { kind: 'put', item: { pk: 'NEW', sk: 'META' } },
        { kind: 'delete', key: { pk: 'VICTIM', sk: 'META' } },
        { kind: 'put', ifNotExists: true, item: { pk: 'EXISTS', sk: 'META' } },
      ]),
    ).rejects.toThrow(ConditionFailedError);
    expect(await db.get('NEW', 'META')).toBeNull(); // put rolled back
    expect(await db.get('VICTIM', 'META')).not.toBeNull(); // delete rolled back
  });

  it('refuses batches past the DynamoDB 100-item limit with a clear error', async () => {
    const oversized: TransactOp[] = Array.from({ length: MAX_TRANSACT_OPS + 1 }, (_, i) => ({
      kind: 'put' as const,
      item: { pk: `P#${i}`, sk: 'META' },
    }));

    const memory = new MemoryDb();
    await expect(memory.transactWrite(oversized)).rejects.toThrow(/101 ops exceeds .* 100/);
    expect(await memory.get('P#0', 'META')).toBeNull(); // nothing applied

    // Same guard on the AWS adapter — thrown before any network call, so no
    // LocalStack needed here.
    const dynamo = new DynamoDb(configFromEnv());
    await expect(dynamo.transactWrite(oversized)).rejects.toThrow(/101 ops exceeds .* 100/);
  });

  it('accepts exactly MAX_TRANSACT_OPS ops', async () => {
    const db = new MemoryDb();
    await db.transactWrite(
      Array.from({ length: MAX_TRANSACT_OPS }, (_, i) => ({
        kind: 'put' as const,
        item: { pk: `Q#${i}`, sk: 'META' },
      })),
    );
    expect(await db.get(`Q#${MAX_TRANSACT_OPS - 1}`, 'META')).not.toBeNull();
  });
});
