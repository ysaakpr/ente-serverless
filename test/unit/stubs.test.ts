/** Boot stubs — shape + auth, 2 scenarios each (12 total). */

import { beforeEach, describe, expect, it } from 'vitest';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';

let world: TestWorld;
let account: Account;

beforeEach(async () => {
  world = await makeWorld();
  account = await signupAccount(world, 'stub@b.c');
});

describe('remote-store', () => {
  it('write-then-read round-trip; default value; 404 when absent', async () => {
    const put = await world.request('POST', '/remote-store/update', {
      token: account.token,
      body: { key: 'mapEnabled', value: 'true' },
    });
    expect(put.status).toBe(200);
    const get = await world.request('GET', '/remote-store?key=mapEnabled', { token: account.token });
    expect(await get.json()).toEqual({ value: 'true' });

    const dflt = await world.request('GET', '/remote-store?key=unknown&defaultValue=x', { token: account.token });
    expect(await dflt.json()).toEqual({ value: 'x' });
    const missing = await world.request('GET', '/remote-store?key=unknown', { token: account.token });
    expect(missing.status).toBe(404);
  });

  it('requires auth', async () => {
    expect((await world.request('GET', '/remote-store?key=k')).status).toBe(401);
  });
});

describe('feature-flags', () => {
  it('shape from ente/remotestore.go, reflecting stored flags', async () => {
    await world.request('POST', '/remote-store/update', {
      token: account.token,
      body: { key: 'mapEnabled', value: 'true' },
    });
    const res = await world.request('GET', '/remote-store/feature-flags', { token: account.token });
    const flags = (await res.json()) as Record<string, unknown>;
    expect(flags.mapEnabled).toBe(true);
    expect(flags.faceSearchEnabled).toBe(false);
    for (const key of ['enableStripe', 'passKeyEnabled', 'internalUser', 'betaUser', 'castUrl', 'serverApiFlag']) {
      expect(flags).toHaveProperty(key);
    }
  });

  it('requires auth', async () => {
    expect((await world.request('GET', '/remote-store/feature-flags')).status).toBe(401);
  });
});

describe('billing stubs', () => {
  it('plans/v2 is public with a freePlan; subscription + verify return the free sub', async () => {
    const plans = await world.request('GET', '/billing/plans/v2');
    expect(plans.status).toBe(200);
    // Captured 2026-08-17 — museum sends period "year" (D34), freePlan first.
    expect(await plans.json()).toEqual({
      freePlan: {
        storage: world.deps.config.freePlanStorageBytes,
        duration: 100,
        period: 'year',
      },
      plans: [],
    });

    const sub = await world.request('GET', '/billing/subscription', { token: account.token });
    const subBody = (await sub.json()) as { subscription: { productID: string } };
    expect(subBody.subscription.productID).toBe('free');

    const verify = await world.request('POST', '/billing/verify-subscription', {
      token: account.token,
      body: { paymentProvider: 'stripe', productID: 'free', verificationData: '' },
    });
    expect(((await verify.json()) as { subscription: { productID: string } }).subscription.productID).toBe('free');
  });

  it('user-plans mirrors plans/v2 but requires a token (gate finding D34)', async () => {
    expect((await world.request('GET', '/billing/user-plans')).status).toBe(401);

    const authed = await world.request('GET', '/billing/user-plans', { token: account.token });
    expect(authed.status).toBe(200);
    const publicPlans = await world.request('GET', '/billing/plans/v2');
    expect(await authed.json()).toEqual(await publicPlans.json());
  });

  it('subscription requires auth', async () => {
    expect((await world.request('GET', '/billing/subscription')).status).toBe(401);
  });
});

describe('bonus / push / events', () => {
  it('storage-bonus zeros; push token 200 {}; events accepted', async () => {
    const bonus = await world.request('GET', '/storage-bonus/details', { token: account.token });
    expect(((await bonus.json()) as { storageBonuses: unknown[] }).storageBonuses).toEqual([]);

    const push = await world.request('POST', '/push/token', {
      token: account.token,
      body: { fcmToken: 'x' },
    });
    expect(push.status).toBe(200);

    const event = await world.request('POST', '/users/event', {
      token: account.token,
      body: { event: 'sync' },
    });
    expect(event.status).toBe(200);
  });

  it('all require auth', async () => {
    expect((await world.request('GET', '/storage-bonus/details')).status).toBe(401);
    expect((await world.request('POST', '/push/token', { body: {} })).status).toBe(401);
  });
});
