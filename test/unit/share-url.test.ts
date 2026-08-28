/**
 * [PUBLIC-LINKS] management — POST/PUT/DELETE /collections/share-url and the
 * publicURLs population on the owner feed / getById / sharee feed. Shapes
 * pinned against pkg/api/collection.go ShareURL/UpdateShareURL/UnShareURL,
 * pkg/controller/collections/share.go, pkg/controller/public/
 * collection_link.go, ente/public_collection.go (citations in the handlers).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { createAlbum } from '../helpers/upload.ts';
import { createShareUrl, publicRequest } from '../helpers/publicClient.ts';
import { b64 } from '../../src/lib/b64.ts';

let world: TestWorld;
let owner: Account;
let album: number;

const sealedKey = () => b64(randomBytes(80));

const create = (body: Record<string, unknown>, token = owner.token) =>
  world.request('POST', '/collections/share-url', { token, body });
const update = (body: Record<string, unknown>, token = owner.token) =>
  world.request('PUT', '/collections/share-url', { token, body });
const remove = (collectionID: number, token = owner.token) =>
  world.request('DELETE', `/collections/share-url/${collectionID}`, { token });

const getById = async (token: string, id: number) => {
  const res = await world.request('GET', `/collections/${id}`, { token });
  expect(res.status).toBe(200);
  return ((await res.json()) as { collection: Record<string, unknown> }).collection;
};

const feed = async (token: string) => {
  const res = await world.request('GET', '/collections/v2?sinceTime=0', { token });
  expect(res.status).toBe(200);
  return ((await res.json()) as { collections: Record<string, unknown>[] }).collections;
};

const PASSWORD_PARAMS = {
  passHash: b64(randomBytes(32)),
  nonce: b64(randomBytes(16)),
  memLimit: 67108864,
  opsLimit: 2,
};

beforeEach(async () => {
  world = await makeWorld();
  owner = await signupAccount(world, 'url-owner@b.c');
  album = await createAlbum(world, owner, 'linked');
});

describe('POST /collections/share-url', () => {
  it('mints a 10-char token and answers {"result": PublicURL} with museum defaults', async () => {
    const res = await create({ collectionID: album });
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as { result: Record<string, unknown> };
    expect(result.url).toBe(`https://albums.ente.com/?t=${new URL(result.url as string).searchParams.get('t')}`);
    const token = new URL(result.url as string).searchParams.get('t')!;
    expect(token).toMatch(/^[2-9A-HJ-NP-Z]{10}$/); // museum shortuuid[0:10] uppercased
    // museum CreateLink response: download on, join on, collect off, no
    // password, no expiry/limit; nonce/memLimit/opsLimit/minRole omitted.
    expect(result).toMatchObject({
      deviceLimit: 0,
      validTill: 0,
      enableDownload: true,
      enableCollect: false,
      enableComment: false,
      enableJoin: true,
      passwordEnabled: false,
    });
    for (const absent of ['nonce', 'memLimit', 'opsLimit', 'minRole']) {
      expect(result).not.toHaveProperty(absent);
    }
  });

  it('a second create returns the EXISTING link, not an error (museum ErrActiveLinkAlreadyExists path)', async () => {
    const first = await createShareUrl(world, owner, album);
    const res = await create({ collectionID: album, enableCollect: true });
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as { result: Record<string, unknown> };
    expect(result.url).toBe(first.url); // same token; the new flags were ignored
    expect(result.enableCollect).toBe(false);
  });

  it('AllowSharing: uncategorized 400, favorites 200 (a different predicate from participant sharing)', async () => {
    for (const [type, status] of [['uncategorized', 400], ['favorites', 200]] as const) {
      const res = await world.request('POST', '/collections', {
        token: owner.token,
        body: {
          encryptedKey: b64(randomBytes(48)),
          keyDecryptionNonce: b64(randomBytes(24)),
          type,
          attributes: { version: 0 },
        },
      });
      const { collection } = (await res.json()) as { collection: { id: number } };
      expect((await create({ collectionID: collection.id })).status).toBe(status);
    }
  });

  it('owner-only: sharees and strangers read 403, unknown collections 404, deviceLimit range-checked', async () => {
    const other = await signupAccount(world, 'url-other@b.c');
    expect((await create({ collectionID: album }, other.token)).status).toBe(403);
    expect((await create({ collectionID: 999999 })).status).toBe(404);
    const res = await create({ collectionID: album, deviceLimit: 51 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: 'BAD_REQUEST',
      message: 'device limit: 51 out of range [0-50]',
    });
  });
});

describe('publicURLs population (the three D50 seams)', () => {
  it('owner feed + getById emit the full token-bearing PublicURL; link-less stays []', async () => {
    expect((await getById(owner.token, album)).publicURLs).toEqual([]);
    const { url } = await createShareUrl(world, owner, album);
    const fed = (await feed(owner.token)).find((c) => c.id === album)!;
    expect(fed.publicURLs).toEqual([
      expect.objectContaining({ url, enableDownload: true, passwordEnabled: false }),
    ]);
    expect((await getById(owner.token, album)).publicURLs).toEqual(fed.publicURLs);
  });

  it('sharee feed/getById see the link filtered by minRole (FilterPublicURLsForRole)', async () => {
    const viewer = await signupAccount(world, 'url-viewer@b.c');
    const shared = await world.request('POST', '/collections/share', {
      token: owner.token,
      body: { collectionID: album, email: viewer.email, encryptedKey: sealedKey() },
    });
    expect(shared.status).toBe(200);
    const { url } = await createShareUrl(world, owner, album);

    // No minRole: the VIEWER sharee sees the full URL — museum behaviour.
    let entry = (await feed(viewer.token)).find((c) => c.id === album)!;
    expect(entry.publicURLs).toEqual([expect.objectContaining({ url })]);

    // minRole COLLABORATOR hides it from a VIEWER on feed and getById alike.
    expect((await update({ collectionID: album, minRole: 'COLLABORATOR' })).status).toBe(200);
    entry = (await feed(viewer.token)).find((c) => c.id === album)!;
    expect(entry.publicURLs).toEqual([]);
    expect((await getById(viewer.token, album)).publicURLs).toEqual([]);
    // ... while the owner still sees it, minRole included.
    expect((await getById(owner.token, album)).publicURLs).toEqual([
      expect.objectContaining({ url, minRole: 'COLLABORATOR' }),
    ]);
  });
});

describe('PUT /collections/share-url', () => {
  beforeEach(async () => {
    await createShareUrl(world, owner, album);
  });

  it('round-trips flags, validTill and deviceLimit, and answers {"result": PublicURL}', async () => {
    const validTill = world.deps.clock.nowMicros() + 3_600_000_000;
    const res = await update({
      collectionID: album,
      validTill,
      deviceLimit: 25,
      enableDownload: false,
      enableCollect: true,
      enableComment: true,
      enableJoin: false,
    });
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as { result: Record<string, unknown> };
    expect(result).toMatchObject({
      validTill,
      deviceLimit: 25,
      enableDownload: false,
      enableCollect: true,
      enableComment: true,
      enableJoin: false,
    });
    // Absent fields left alone; the change shows in the owner feed.
    const fed = (await feed(owner.token)).find((c) => c.id === album)!;
    expect(fed.publicURLs).toEqual([expect.objectContaining({ deviceLimit: 25, validTill })]);
  });

  it('sets and disables the password (all four params together; passwordEnabled + KDF params emitted)', async () => {
    const res = await update({ collectionID: album, ...PASSWORD_PARAMS });
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as { result: Record<string, unknown> };
    expect(result).toMatchObject({
      passwordEnabled: true,
      nonce: PASSWORD_PARAMS.nonce,
      memLimit: 67108864,
      opsLimit: 2,
    });
    expect(result).not.toHaveProperty('passHash'); // the hash never echoes

    const off = await update({ collectionID: album, disablePassword: true });
    const { result: cleared } = (await off.json()) as { result: Record<string, unknown> };
    expect(cleared.passwordEnabled).toBe(false);
    expect(cleared).not.toHaveProperty('nonce');
  });

  it('validation table — museum Validate(), message for message', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, 'all parameters are missing'],
      [{ memLimit: 67108864, opsLimit: 2 }, 'all parameters are missing'], // mem/ops alone do not count
      [{ deviceLimit: -1 }, 'device limit: -1 out of range [0-50]'],
      [
        { validTill: world.deps.clock.nowMicros() - 1 },
        'valid till should be greater than current timestamp',
      ],
      [
        { passHash: 'x', nonce: 'y' },
        'all password params should be either present or missing',
      ],
      [
        { ...PASSWORD_PARAMS, memLimit: 1024 },
        'invalid KDF parameters',
      ],
      [
        { ...PASSWORD_PARAMS, disablePassword: true },
        'can not set and disable password in same request',
      ],
      [{ minRole: 'EDITOR' }, 'invalid min role EDITOR'],
    ];
    for (const [body, message] of cases) {
      const res = await update({ collectionID: album, ...body });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: 'BAD_REQUEST', message });
    }
  });

  it('404 with no active link, 403 for non-owners', async () => {
    const bare = await createAlbum(world, owner, 'bare');
    expect((await update({ collectionID: bare, enableCollect: true })).status).toBe(404);
    const other = await signupAccount(world, 'url-put-other@b.c');
    expect((await update({ collectionID: album, enableCollect: true }, other.token)).status).toBe(403);
  });
});

describe('DELETE /collections/share-url/:collectionID', () => {
  it('bare 200 (no body), publicURLs back to [], the token dies, and a re-create mints a NEW token', async () => {
    const first = await createShareUrl(world, owner, album);
    const res = await remove(album);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(''); // museum c.Status(200) — not the collection JSON

    expect((await getById(owner.token, album)).publicURLs).toEqual([]);
    const dead = await publicRequest(world, 'GET', '/public-collection/info', {
      accessToken: first.token,
    });
    expect(dead.status).toBe(410);
    expect(await dead.json()).toEqual({ error: 'disabled token' });

    // Deleting again is still 200 (museum's UPDATE matches zero rows).
    expect((await remove(album)).status).toBe(200);

    // Re-enable mints a NEW token; the old one stays dead forever (plan §4.3).
    const second = await createShareUrl(world, owner, album);
    expect(second.token).not.toBe(first.token);
    expect(
      (await publicRequest(world, 'GET', '/public-collection/info', { accessToken: first.token }))
        .status,
    ).toBe(410);
    expect(
      (await publicRequest(world, 'GET', '/public-collection/info', { accessToken: second.token }))
        .status,
    ).toBe(200);
  });

  it('owner-only and shape-checked', async () => {
    await createShareUrl(world, owner, album);
    const other = await signupAccount(world, 'url-del-other@b.c');
    expect((await remove(album, other.token)).status).toBe(403);
    const bad = await world.request('DELETE', '/collections/share-url/garbage', {
      token: owner.token,
    });
    expect(bad.status).toBe(400);
  });
});
