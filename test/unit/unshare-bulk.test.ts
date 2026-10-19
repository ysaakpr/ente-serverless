/**
 * [SHARING] POST /collections/unshare/bulk (D66, museum main BulkUnShare) —
 * request-level validation is bare {}; per-collection outcomes ride in
 * `results` (unshared / already_unshared / not_shared / failed). Shapes match
 * museum 20fb631 (tools/differential.ts, 2026-10-19).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { createAlbum } from '../helpers/upload.ts';
import { getSharee } from '../../src/domain/sharing.ts';
import { b64 } from '../../src/lib/b64.ts';

let world: TestWorld;
let owner: Account;
let mate: Account;
let outsider: Account;
let shared: number;
let unshared: number;

const bulk = (token: string, body: Record<string, unknown>) =>
  world.request('POST', '/collections/unshare/bulk', {
    token,
    body: { recipientUserID: mate.userId, source: 'manual', ...body },
  });
const statuses = async (res: Response) =>
  ((await res.json()) as { results: { collectionID: number; status: string }[] }).results.map((r) => r.status);

beforeEach(async () => {
  world = await makeWorld();
  owner = await signupAccount(world, 'bulk-owner@b.c');
  mate = await signupAccount(world, 'bulk-mate@b.c');
  outsider = await signupAccount(world, 'bulk-out@b.c');
  shared = await createAlbum(world, owner, 'shared');
  unshared = await createAlbum(world, owner, 'private');
  const res = await world.request('POST', '/collections/share', {
    token: owner.token,
    body: { collectionID: shared, email: mate.email, encryptedKey: b64(randomBytes(80)) },
  });
  expect(res.status).toBe(200);
});

describe('POST /collections/unshare/bulk', () => {
  it('reports per-collection outcomes in request order and revokes access', async () => {
    const res = await bulk(owner.token, { collectionIDs: [shared, unshared, 999999] });
    expect(res.status).toBe(200);
    expect(await statuses(res)).toEqual(['unshared', 'not_shared', 'failed']);
    expect(await getSharee(world.deps, shared, mate.userId)).toBeNull();

    const repeat = await bulk(owner.token, { collectionIDs: [shared] });
    expect(await statuses(repeat)).toEqual(['already_unshared']);
  });

  it('a non-owner gets "failed", never a request error', async () => {
    const res = await bulk(outsider.token, { collectionIDs: [shared] });
    expect(res.status).toBe(200);
    expect(await statuses(res)).toEqual(['failed']);
    expect(await getSharee(world.deps, shared, mate.userId)).not.toBeNull();
  });

  it('request-level validation is bare {}: 400 shape/source/duplicates/recipient, 413 over 100', async () => {
    const cases: [Record<string, unknown>, number][] = [
      [{ source: 'weird', collectionIDs: [shared] }, 400],
      [{ collectionIDs: [] }, 400],
      [{ collectionIDs: [shared, shared] }, 400],
      [{ recipientUserID: owner.userId, collectionIDs: [shared] }, 400], // self
      [{ recipientUserID: 0, collectionIDs: [shared] }, 400],
      [{ recipientUserID: -5, collectionIDs: [shared] }, 400],
      [{ collectionIDs: Array.from({ length: 101 }, (_, i) => i + 1) }, 413],
    ];
    for (const [body, status] of cases) {
      const res = await bulk(owner.token, body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(status);
      expect(await res.json()).toEqual({});
    }
  });
});
