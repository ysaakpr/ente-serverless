/**
 * [SHARING] batch endpoints (D66, upstream 2026-09) — POST /users/public-keys
 * and POST /collections/share/batch. Statuses and bodies match museum main
 * 20fb631 as captured by tools/differential.ts on 2026-10-19.
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
let b: Account;
let d: Account;
let album: number;

const sealedKey = () => b64(randomBytes(80));
const entry = (who: Account, extra: Record<string, unknown> = {}) => ({
  collectionID: album,
  email: who.email,
  encryptedKey: sealedKey(),
  ...extra,
});
const batch = (token: string, body: unknown) =>
  world.request('POST', '/collections/share/batch', { token, body });
const publicKeys = (token: string | undefined, body: unknown) =>
  world.request('POST', '/users/public-keys', { token, body });

beforeEach(async () => {
  world = await makeWorld();
  owner = await signupAccount(world, 'batch-owner@b.c');
  b = await signupAccount(world, 'batch-b@b.c');
  d = await signupAccount(world, 'batch-d@b.c');
  album = await createAlbum(world, owner);
});

describe('POST /users/public-keys', () => {
  it('returns keys in request order', async () => {
    const res = await publicKeys(owner.token, { emails: [d.email, b.email] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      publicKeys: [d.keys.keyAttributes.publicKey, b.keys.keyAttributes.publicKey],
    });
  });

  it('is all-or-nothing with bare-{} errors: 400 shape, 413 over 10, 404 unknown, 401 unauthenticated', async () => {
    const cases: [unknown, number][] = [
      [{}, 400],
      [{ emails: [] }, 400],
      [{ emails: ['  '] }, 400],
      [{ emails: [b.email, b.email.toUpperCase()] }, 400], // duplicate after normalization
      [{ emails: Array.from({ length: 11 }, (_, i) => `x${i}@b.c`) }, 413],
      [{ emails: [b.email, 'nobody@b.c'] }, 404],
    ];
    for (const [body, status] of cases) {
      const res = await publicKeys(owner.token, body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(await res.json()).toEqual({});
    }
    expect((await publicKeys(undefined, { emails: [b.email] })).status).toBe(401);
  });
});

describe('POST /collections/share/batch', () => {
  it('shares with every recipient and returns the full sharee list', async () => {
    const res = await batch(owner.token, { shares: [entry(b), entry(d, { role: 'COLLABORATOR' })] });
    expect(res.status).toBe(200);
    const { sharees } = (await res.json()) as { sharees: { id: number; role: string }[] };
    expect(sharees.map((s) => `${s.id}:${s.role}`).sort()).toEqual(
      [`${b.userId}:VIEWER`, `${d.userId}:COLLABORATOR`].sort(),
    );
    // A re-share through the batch changes the role (museum upserts).
    const again = await batch(owner.token, { shares: [entry(b, { role: 'COLLABORATOR' })] });
    expect(again.status).toBe(200);
    expect((await getSharee(world.deps, album, b.userId))!.role).toBe('COLLABORATOR');
  });

  it('validates the batch before touching access, with museum statuses', async () => {
    const other = await createAlbum(world, owner, 'other');
    const cases: [unknown, number][] = [
      [{}, 400],
      [{ shares: [] }, 400],
      [{ shares: Array.from({ length: 11 }, (_, i) => ({ ...entry(b), email: `y${i}@b.c` })) }, 413],
      [{ shares: [entry(b), { ...entry(d), collectionID: other }] }, 400],
      [{ shares: [entry(b), { ...entry(b), email: b.email.toUpperCase() }] }, 400],
      [{ shares: [entry(owner)] }, 400], // self
      [{ shares: [{ ...entry(b), collectionID: 999999 }] }, 404],
    ];
    for (const [body, status] of cases) {
      const res = await batch(owner.token, body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(status);
      expect(await res.json()).toEqual({});
    }
  });

  it('per-entry errors carry museum messages and leave no partial share', async () => {
    const badKey = await batch(owner.token, { shares: [{ ...entry(b), encryptedKey: b64(randomBytes(10)) }] });
    expect(badKey.status).toBe(400);
    expect(await badKey.json()).toEqual({ code: 'BAD_REQUEST', message: 'encryptedKey must decode to 80 bytes' });

    const badRole = await batch(owner.token, { shares: [entry(b, { role: 'OWNER' })] });
    expect(badRole.status).toBe(400);
    expect(await badRole.json()).toEqual({ code: 'BAD_REQUEST', message: 'invalid role OWNER' });

    const unknown = await batch(owner.token, { shares: [entry(b), { ...entry(d), email: 'nobody@b.c' }] });
    expect(unknown.status).toBe(404);
    expect(await getSharee(world.deps, album, b.userId)).toBeNull(); // b was valid, still not shared
  });

  it('only the owner or an ADMIN sharee may batch-share; others get 403', async () => {
    expect((await batch(d.token, { shares: [entry(b)] })).status).toBe(403); // non-member
    await batch(owner.token, { shares: [entry(d, { role: 'ADMIN' })] });
    const byAdmin = await batch(d.token, { shares: [entry(b)] });
    expect(byAdmin.status).toBe(200);
  });
});

describe('unknown routes keep a non-JSON 404 (mobile batch-share fallback depends on it)', () => {
  it('answers plain text, so a future JSON notFound handler fails here first', async () => {
    // collection_sharing_actions.dart falls back to per-email /collections/share
    // only on UnexpectedApiResponseException, i.e. a 404 whose body is not JSON.
    const res = await world.request('POST', '/definitely/not/a/route', { token: owner.token, body: {} });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(() => JSON.parse(text)).toThrow();
  });
});
