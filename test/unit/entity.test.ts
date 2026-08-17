/** [ENTITY] — 12 scenarios across the 7 routes (oracle parity pending capture). */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { b64 } from '../../src/lib/b64.ts';

let world: TestWorld;
let account: Account;

const keyBody = () => ({
  type: 'location',
  encryptedKey: b64(randomBytes(48)),
  header: b64(randomBytes(24)),
});

const dataBody = () => ({
  type: 'location',
  encryptedData: b64(randomBytes(64)),
  header: b64(randomBytes(24)),
});

beforeEach(async () => {
  world = await makeWorld();
  account = await signupAccount(world, 'ent@b.c');
});

describe('user-entity key', () => {
  it('create + get round-trip; identical re-create is a 200 no-op', async () => {
    const body = keyBody();
    const create = await world.request('POST', '/user-entity/key', { token: account.token, body });
    expect(create.status).toBe(200);
    const again = await world.request('POST', '/user-entity/key', { token: account.token, body });
    expect(again.status).toBe(200);

    const get = await world.request('GET', '/user-entity/key?type=location', { token: account.token });
    expect(get.status).toBe(200);
    const gotten = (await get.json()) as Record<string, unknown>;
    expect(gotten.encryptedKey).toBe(body.encryptedKey);
    expect(gotten.userID).toBe(account.userId);
  });

  it('different material re-create -> 409 ALREADY_EXISTS', async () => {
    await world.request('POST', '/user-entity/key', { token: account.token, body: keyBody() });
    const res = await world.request('POST', '/user-entity/key', { token: account.token, body: keyBody() });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('ALREADY_EXISTS');
  });

  it('ensure creates when missing, returns existing otherwise; get 404 pre-setup', async () => {
    const missing = await world.request('GET', '/user-entity/key?type=location', { token: account.token });
    expect(missing.status).toBe(404);

    const first = keyBody();
    const ensure1 = await world.request('POST', '/user-entity/key/ensure', { token: account.token, body: first });
    expect(ensure1.status).toBe(200);
    const ensure2 = await world.request('POST', '/user-entity/key/ensure', { token: account.token, body: keyBody() });
    expect(((await ensure2.json()) as { encryptedKey: string }).encryptedKey).toBe(first.encryptedKey);
  });

  it('invalid type -> 400; auth required', async () => {
    const bad = await world.request('POST', '/user-entity/key', {
      token: account.token,
      body: { ...keyBody(), type: 'bogus' },
    });
    expect(bad.status).toBe(400);
    expect((await world.request('GET', '/user-entity/key?type=location')).status).toBe(401);
  });
});

describe('user-entity data + diff', () => {
  it('create/update/delete round-trip with diff integrity and tombstones', async () => {
    await world.request('POST', '/user-entity/key', { token: account.token, body: keyBody() });

    const created = (await (
      await world.request('POST', '/user-entity/entity', { token: account.token, body: dataBody() })
    ).json()) as { id: string; updatedAt: number; isDeleted: boolean };
    expect(created.id).toMatch(/^location_/);
    expect(created.isDeleted).toBe(false);

    // diff from 0 sees it
    const diff1 = (await (
      await world.request('GET', '/user-entity/entity/diff?type=location&sinceTime=0&limit=500', {
        token: account.token,
      })
    ).json()) as { diff: Array<{ id: string; updatedAt: number }> };
    expect(diff1.diff.map((e) => e.id)).toContain(created.id);

    // update re-emits after cursor
    const cursor = Math.max(...diff1.diff.map((e) => e.updatedAt));
    const updated = (await (
      await world.request('PUT', '/user-entity/entity', {
        token: account.token,
        body: { id: created.id, ...dataBody() },
      })
    ).json()) as { updatedAt: number };
    expect(updated.updatedAt).toBeGreaterThan(cursor);

    // delete emits a tombstone with nulled payload
    await world.request('DELETE', `/user-entity/entity?id=${created.id}`, { token: account.token });
    const diff2 = (await (
      await world.request('GET', `/user-entity/entity/diff?type=location&sinceTime=${updated.updatedAt}&limit=500`, {
        token: account.token,
      })
    ).json()) as { diff: Array<{ id: string; isDeleted: boolean; encryptedData: string | null }> };
    const tombstone = diff2.diff.find((e) => e.id === created.id)!;
    expect(tombstone.isDeleted).toBe(true);
    expect(tombstone.encryptedData).toBeNull();
  });

  it('update of a missing entity 404; smart_album requires the sa_<uid>_ id shape', async () => {
    const missing = await world.request('PUT', '/user-entity/entity', {
      token: account.token,
      body: { id: 'location_nope', ...dataBody() },
    });
    expect(missing.status).toBe(404);

    const badSa = await world.request('POST', '/user-entity/entity', {
      token: account.token,
      body: { ...dataBody(), type: 'smart_album', id: 'sa_999_x' },
    });
    expect(badSa.status).toBe(400);
  });

  it('diff limit is validated (1..5000) and respected', async () => {
    const bad = await world.request('GET', '/user-entity/entity/diff?type=location&sinceTime=0&limit=9999', {
      token: account.token,
    });
    expect(bad.status).toBe(400);

    for (let i = 0; i < 3; i++) {
      await world.request('POST', '/user-entity/entity', { token: account.token, body: dataBody() });
    }
    const limited = (await (
      await world.request('GET', '/user-entity/entity/diff?type=location&sinceTime=0&limit=2', {
        token: account.token,
      })
    ).json()) as { diff: unknown[] };
    expect(limited.diff).toHaveLength(2);
  });

  it('entities are per-user: another account sees an empty diff', async () => {
    await world.request('POST', '/user-entity/entity', { token: account.token, body: dataBody() });
    const other = await signupAccount(world, 'ent2@b.c');
    const diff = (await (
      await world.request('GET', '/user-entity/entity/diff?type=location&sinceTime=0&limit=500', {
        token: other.token,
      })
    ).json()) as { diff: unknown[] };
    expect(diff.diff).toHaveLength(0);
  });
});
