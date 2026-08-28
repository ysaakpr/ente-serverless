/**
 * [SHARING] Phase C endpoints — POST /collections/share, /collections/unshare,
 * /collections/leave/:collectionID, GET /collections/sharees. Every status and
 * body shape pinned against museum source (pkg/api/collection.go +
 * pkg/controller/collections/share.go + repo/collection.go — citations in the
 * handlers).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { createAlbum, uploadAndCommit } from '../helpers/upload.ts';
import { getSharee } from '../../src/domain/sharing.ts';
import { b64 } from '../../src/lib/b64.ts';

let world: TestWorld;
let owner: Account;
let mate: Account;
let album: number;

/** A well-formed sealed collection key: 32 key + 48 crypto_box_seal overhead. */
const sealedKey = () => b64(randomBytes(80));

const share = (
  token: string,
  body: Record<string, unknown>,
): Promise<Response> => world.request('POST', '/collections/share', { token, body });

const shareBody = (overrides: Record<string, unknown> = {}) => ({
  collectionID: album,
  email: mate.email,
  encryptedKey: sealedKey(),
  ...overrides,
});

const item = (id: number) => ({
  id,
  encryptedKey: b64(randomBytes(48)),
  keyDecryptionNonce: b64(randomBytes(24)),
});

/** Commit a file the sharee owns into their own album, add it to `album`. */
const addOwnFileToShared = async (account: Account) => {
  const ownAlbum = await createAlbum(world, account, 'own');
  const up = await uploadAndCommit(world, account, ownAlbum, new Uint8Array(randomBytes(64)), new Uint8Array(randomBytes(16)));
  const res = await world.request('POST', '/collections/add-files', {
    token: account.token,
    body: { collectionID: album, files: [item(up.fileId)] },
  });
  expect(res.status).toBe(200);
  return up;
};

const ownerDiff = async () => {
  const res = await world.request('GET', `/collections/v2/diff?collectionID=${album}&sinceTime=0`, {
    token: owner.token,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { diff: Array<{ id: number; isDeleted: boolean }> }).diff;
};

beforeEach(async () => {
  world = await makeWorld();
  owner = await signupAccount(world, 'sh-owner@b.c');
  mate = await signupAccount(world, 'sh-mate@b.c');
  album = await createAlbum(world, owner, 'shared');
});

describe('POST /collections/share', () => {
  it('shares as VIEWER by default and returns the full sharee list (museum {"sharees":[CollectionUser]})', async () => {
    const res = await share(owner.token, shareBody());
    expect(res.status).toBe(200);
    const { sharees } = (await res.json()) as { sharees: unknown[] };
    expect(sharees).toEqual([{ id: mate.userId, email: mate.email, name: '', role: 'VIEWER' }]);

    const row = await getSharee(world.deps, album, mate.userId);
    expect(row).toMatchObject({ role: 'VIEWER', sharedBy: owner.userId });
    expect(row!.sharedAt).toBeGreaterThan(0);
  });

  it('persists an explicit COLLABORATOR role, and re-sharing upserts role + key (museum ON CONFLICT)', async () => {
    await share(owner.token, shareBody({ role: 'COLLABORATOR' }));
    expect((await getSharee(world.deps, album, mate.userId))!.role).toBe('COLLABORATOR');

    const first = await getSharee(world.deps, album, mate.userId);
    const rewrap = sealedKey();
    const res = await share(owner.token, shareBody({ role: 'VIEWER', encryptedKey: rewrap }));
    expect(res.status).toBe(200);
    const after = await getSharee(world.deps, album, mate.userId);
    expect(after!.role).toBe('VIEWER');
    expect(after!.encryptedKey).toBe(rewrap);
    // shared_at survives a live re-share (museum's ON CONFLICT CASE).
    expect(after!.sharedAt).toBe(first!.sharedAt);
  });

  it('rejects unknown email (404), self (400), unknown collection (404), foreign caller (403)', async () => {
    expect((await share(owner.token, shareBody({ email: 'nobody@b.c' }))).status).toBe(404);
    expect((await share(owner.token, shareBody({ email: owner.email }))).status).toBe(400);
    expect((await share(owner.token, shareBody({ collectionID: 424242 }))).status).toBe(404);
    // Non-owner (member or not) is 403: museum collectionForShareMutation
    // requires owner or ADMIN, and no ADMIN rows exist (D49).
    expect((await share(mate.token, shareBody({ email: owner.email }))).status).toBe(403);
    await share(owner.token, shareBody({ role: 'COLLABORATOR' }));
    expect((await share(mate.token, shareBody({ email: owner.email }))).status).toBe(403);
  });

  it('rejects a malformed sealed key with museum\'s bare 500 (validateSealedCollectionKey), missing fields with 400', async () => {
    expect((await share(owner.token, shareBody({ encryptedKey: b64(randomBytes(48)) }))).status).toBe(500);
    expect((await share(owner.token, shareBody({ encryptedKey: undefined }))).status).toBe(500);
    expect((await share(owner.token, { email: mate.email, encryptedKey: sealedKey() })).status).toBe(400);
    expect((await share(owner.token, shareBody({ email: '' }))).status).toBe(400);
    // ADMIN is honoured since D63 (admin-role.test.ts); a truly unknown
    // string stays our 400 where museum 500s (D50 divergence).
    expect((await share(owner.token, shareBody({ role: 'ADMIN' }))).status).toBe(200);
    expect((await share(owner.token, shareBody({ role: 'BANANA' }))).status).toBe(400);
  });

  it('allows sharing favorites and uncategorized-as-VIEWER; uncategorized-as-COLLABORATOR is 400 (AllowParticipantSharing)', async () => {
    const mk = async (type: string) => {
      const res = await world.request('POST', '/collections', {
        token: owner.token,
        body: {
          encryptedKey: b64(randomBytes(48)),
          keyDecryptionNonce: b64(randomBytes(24)),
          type,
          attributes: { version: 0 },
        },
      });
      return ((await res.json()) as { collection: { id: number } }).collection.id;
    };
    const favorites = await mk('favorites');
    const uncategorized = await mk('uncategorized');

    expect((await share(owner.token, shareBody({ collectionID: favorites, role: 'COLLABORATOR' }))).status).toBe(200);
    expect((await share(owner.token, shareBody({ collectionID: uncategorized, role: 'COLLABORATOR' }))).status).toBe(400);
    expect((await share(owner.token, shareBody({ collectionID: uncategorized, role: 'VIEWER' }))).status).toBe(200);
  });
});

describe('POST /collections/unshare', () => {
  beforeEach(async () => {
    await share(owner.token, shareBody({ role: 'COLLABORATOR' }));
  });

  const unshare = (token: string, email: string, collectionID = album) =>
    world.request('POST', '/collections/unshare', { token, body: { collectionID, email } });

  it('removes the sharee, returns the remaining list, and revokes access', async () => {
    const third = await signupAccount(world, 'sh-third@b.c');
    await share(owner.token, shareBody({ email: third.email }));

    const res = await unshare(owner.token, mate.email);
    expect(res.status).toBe(200);
    const { sharees } = (await res.json()) as { sharees: Array<{ id: number }> };
    expect(sharees.map((s) => s.id)).toEqual([third.userId]);

    expect(await getSharee(world.deps, album, mate.userId)).toBeNull();
    const gone = await world.request('GET', `/collections/${album}`, { token: mate.token });
    expect(gone.status).toBe(403); // non-member again (D49: museum 404, ours 403)
  });

  it('tombstones the sharee\'s own files in the collection (museum UnShareContext collection_files update)', async () => {
    const up = await addOwnFileToShared(mate);
    await unshare(owner.token, mate.email);
    const diff = await ownerDiff();
    expect(diff.find((f) => f.id === up.fileId)!.isDeleted).toBe(true);
  });

  it('404s an email that is not a sharee; 403s a non-owner caller', async () => {
    expect((await unshare(owner.token, 'nobody@b.c')).status).toBe(404);
    expect((await unshare(mate.token, mate.email)).status).toBe(403);
  });
});

describe('POST /collections/leave/:collectionID', () => {
  const leave = (token: string, id = album) =>
    world.request('POST', `/collections/leave/${id}`, { token });

  it('sharee leaves: rows dropped, access revoked, own files removed from the album', async () => {
    await share(owner.token, shareBody({ role: 'COLLABORATOR' }));
    const up = await addOwnFileToShared(mate);

    expect((await leave(mate.token)).status).toBe(200);
    expect(await getSharee(world.deps, album, mate.userId)).toBeNull();
    expect((await world.request('GET', `/collections/${album}`, { token: mate.token })).status).toBe(403);
    // museum Leave -> UnShare: the leaver's own files leave the collection.
    const diff = await ownerDiff();
    expect(diff.find((f) => f.id === up.fileId)!.isDeleted).toBe(true);
  });

  it('owner cannot leave (403); a non-member leave is a 200 no-op; unknown collection 404', async () => {
    expect((await leave(owner.token)).status).toBe(403);
    expect((await leave(mate.token)).status).toBe(200); // never shared: museum returns nil
    expect((await leave(mate.token, 424242)).status).toBe(404);
  });
});

describe('GET /collections/sharees', () => {
  it('any member lists sharees; non-members 403; garbage ids 404 (museum parses to 0)', async () => {
    await share(owner.token, shareBody());
    const url = `/collections/sharees?collectionID=${album}`;

    for (const token of [owner.token, mate.token]) {
      const res = await world.request('GET', url, { token });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { sharees: unknown[] }).sharees).toEqual([
        { id: mate.userId, email: mate.email, name: '', role: 'VIEWER' },
      ]);
    }

    const outsider = await signupAccount(world, 'sh-outsider@b.c');
    expect((await world.request('GET', url, { token: outsider.token })).status).toBe(403);
    expect((await world.request('GET', '/collections/sharees?collectionID=junk', { token: owner.token })).status).toBe(404);
  });
});
