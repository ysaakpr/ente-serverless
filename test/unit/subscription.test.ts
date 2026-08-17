/**
 * Free subscription determinism (gate finding D30). The web client refetches
 * /users/details/v2 whenever the response changes, so a clock-derived expiry
 * loops it forever — these lock the captured museum shape and the stability.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { plusHundredYears } from '../../src/domain/billing.ts';
import { keys } from '../../src/domain/model.ts';
import { MICROS_PER_DAY } from '../../src/lib/time.ts';

let world: TestWorld;
let account: Account;

beforeEach(async () => {
  world = await makeWorld();
  account = await signupAccount(world, 'billing@b.c');
});

const details = async () => {
  const res = await world.request('GET', '/users/details/v2', { token: account.token });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
};

const subscription = async () => (await details()).subscription as Record<string, unknown>;

describe('free subscription', () => {
  it('carries the captured museum shape', async () => {
    expect(await subscription()).toEqual({
      id: account.userId,
      userID: account.userId,
      productID: 'free',
      storage: world.deps.config.freePlanStorageBytes,
      originalTransactionID: 'none',
      expiryTime: expect.any(Number),
      paymentProvider: '',
      attributes: {},
      price: '',
      period: 'year', // museum sends "year", not "" — capture 2026-08-17
    });
  });

  it('expires exactly 100 calendar years after the account was created', async () => {
    const { pk, sk } = keys.user(account.userId);
    const user = await world.deps.db.get(pk, sk);
    const creationTime = user!.creationTime as number;
    expect((await subscription()).expiryTime).toBe(plusHundredYears(creationTime));
    // Sanity: far future, not the old 100-day horizon.
    expect((await subscription()).expiryTime).toBeGreaterThan(
      creationTime + 36_000 * MICROS_PER_DAY,
    );
  });

  it('serialises details/v2 keys in museum struct order', async () => {
    // Capture 2026-08-17; the capture-diff harness (D2) compares envelopes.
    expect(Object.keys(await details())).toEqual([
      'email',
      'usage',
      'subscription',
      'fileCount',
      'sharedCollectionsCount',
      'storageBonus',
      'profileData',
      'bonusData',
    ]);
  });

  it('is byte-identical across repeated calls (the refetch-loop guard)', async () => {
    const first = JSON.stringify(await details());
    const second = JSON.stringify(await details());
    expect(second).toBe(first);
  });

  it('does not drift when the clock advances between calls', async () => {
    const before = await subscription();
    world.deps.clock.advance(45 * MICROS_PER_DAY);
    expect(await subscription()).toEqual(before);
  });

  it('GET /billing/subscription agrees with /users/details/v2', async () => {
    const res = await world.request('GET', '/billing/subscription', { token: account.token });
    expect(res.status).toBe(200);
    const { subscription: fromBilling } = (await res.json()) as Record<string, unknown>;
    expect(fromBilling).toEqual(await subscription());
  });

  it('POST /billing/verify-subscription agrees too', async () => {
    const res = await world.request('POST', '/billing/verify-subscription', {
      token: account.token,
      body: {},
    });
    expect(res.status).toBe(200);
    const { subscription: fromVerify } = (await res.json()) as Record<string, unknown>;
    expect(fromVerify).toEqual(await subscription());
  });
});
