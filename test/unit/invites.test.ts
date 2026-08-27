/**
 * [INVITES] [QUOTA] Phase H1 (D54) — invite-gated signup, per-user storage
 * limits, viewer accounts, and the operator tooling's row-writing functions.
 * All off-parity by design (museum has no invite mode): the wire shapes stay
 * museum-shaped, only VALUES differ, and login is never gated.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { lastOttCode, signupAccount, type Account } from '../helpers/client.ts';
import { createAlbum, uploadAndCommit } from '../helpers/upload.ts';
import {
  getInvite,
  revokeInvite,
  setUserStorage,
  upsertInvite,
} from '../../src/domain/invites.ts';
import { getUser } from '../../src/domain/users.ts';
import { b64 } from '../../src/lib/b64.ts';

const GIB = 1024 ** 3;

const sendOtt = (world: TestWorld, email: string, purpose = 'signup') =>
  world.request('POST', '/users/ott', { body: { email, purpose } });

const sealedKey = () => b64(randomBytes(80));

/** Owner uploads a file and shares the album with `email`. */
const shareAlbumWithFile = async (world: TestWorld, owner: Account, email: string, role = 'VIEWER') => {
  const album = await createAlbum(world, owner, 'shared');
  const up = await uploadAndCommit(world, owner, album, new Uint8Array(randomBytes(64)), new Uint8Array(randomBytes(16)));
  const res = await world.request('POST', '/collections/share', {
    token: owner.token,
    body: { collectionID: album, email, encryptedKey: sealedKey(), role },
  });
  expect(res.status).toBe(200);
  return { album, fileId: up.fileId };
};

describe('invite-gated signup (D54)', () => {
  let world: TestWorld;
  beforeEach(async () => {
    world = await makeWorld({ signupMode: 'invite' });
  });

  it('default mode is open: uninvited signup is unchanged (regression)', async () => {
    const open = await makeWorld();
    expect(open.deps.config.signupMode).toBe('open');
    const account = await signupAccount(open, 'anyone@b.c');
    const user = await getUser(open.deps, account.userId);
    expect(user!.storageLimitBytes).toBeUndefined();
    expect(user!.viewer).toBeUndefined();
  });

  it('invite mode: uninvited signup is 403 {} and NO OTT is stored or mailed', async () => {
    const res = await sendOtt(world, 'stranger@b.c');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({});
    expect(world.deps.mail.sent).toHaveLength(0);
    expect(world.deps.db.dump().filter((r) => r.pk.startsWith('OTT#'))).toHaveLength(0);
  });

  it('invite mode gates on account state, not purpose — old clients send purpose ""', async () => {
    expect((await sendOtt(world, 'stranger@b.c', '')).status).toBe(403);
  });

  it('login is NEVER gated: existing users keep their exact museum errors', async () => {
    await upsertInvite(world.deps, 'member@b.c');
    const member = await signupAccount(world, 'member@b.c');

    const login = await sendOtt(world, member.email, 'login');
    expect(login.status).toBe(200);
    expect(lastOttCode(world, member.email)).toMatch(/^\d{6}$/);

    // login+missing stays museum's 404 USER_NOT_REGISTERED, not the invite 403
    const missing = await sendOtt(world, 'ghost@b.c', 'login');
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe('USER_NOT_REGISTERED');
  });

  it('invited signup completes; the user row carries the overrides; the invite is consumed but kept', async () => {
    await upsertInvite(world.deps, '  Viewer@B.C ', { storageLimitBytes: 0, viewer: true });
    const account = await signupAccount(world, 'viewer@b.c'); // full OTT+SRP flow

    const user = await getUser(world.deps, account.userId);
    expect(user).toMatchObject({ storageLimitBytes: 0, viewer: true, home: 'local' });

    const invite = await getInvite(world.deps, 'viewer@b.c');
    expect(invite).not.toBeNull(); // audit trail kept
    expect(invite!.consumedAt).toBeGreaterThan(0);
  });

  it('belt and braces: an invite revoked between OTT and verify still blocks account creation', async () => {
    await upsertInvite(world.deps, 'late@b.c');
    expect((await sendOtt(world, 'late@b.c')).status).toBe(200);
    const code = lastOttCode(world, 'late@b.c');
    expect(await revokeInvite(world.deps, 'late@b.c')).toBe('revoked');

    const verify = await world.request('POST', '/users/verify-email', {
      body: { email: 'late@b.c', ott: code },
    });
    expect(verify.status).toBe(403);
    expect(world.deps.db.dump().filter((r) => r.pk.startsWith('EMAIL#'))).toHaveLength(0);
  });

  it('re-running the upsert re-arms a consumed invite', async () => {
    await upsertInvite(world.deps, 'again@b.c');
    await signupAccount(world, 'again@b.c');
    expect((await getInvite(world.deps, 'again@b.c'))!.consumedAt).toBeGreaterThan(0);

    await upsertInvite(world.deps, 'again@b.c', { storageLimitBytes: 5 * GIB });
    const rearmed = await getInvite(world.deps, 'again@b.c');
    expect(rearmed!.consumedAt).toBeUndefined();
    expect(rearmed!.storageLimitBytes).toBe(5 * GIB);
  });
});

describe('per-user storage quota (D54: 0 means ZERO)', () => {
  let world: TestWorld;
  let zero: Account; // storageLimitBytes 0, NOT a viewer — the limit alone must block
  beforeEach(async () => {
    world = await makeWorld(); // open mode: overrides apply whenever an invite exists
    await upsertInvite(world.deps, 'zero@b.c', { storageLimitBytes: 0 });
    zero = await signupAccount(world, 'zero@b.c');
  });

  it('0-byte user: every upload-URL mint and the eligibility probe are 426', async () => {
    expect((await world.request('GET', '/files/upload-urls?count=1', { token: zero.token })).status).toBe(426);
    expect((await world.request('GET', '/files/multipart-upload-urls?count=2', { token: zero.token })).status).toBe(426);
    expect((await world.request('GET', '/files/upload-eligibility', { token: zero.token })).status).toBe(426);
    expect(
      (
        await world.request('POST', '/files/upload-url', {
          token: zero.token,
          body: { contentLength: 10, contentMD5: 'x' },
        })
      ).status,
    ).toBe(426);
  });

  it('0-byte user: a commit is 426 even when the bytes are already in the bucket', async () => {
    const album = await createAlbum(world, zero, 'own');
    const fileKey = `${zero.userId}/smuggled-file`;
    const thumbKey = `${zero.userId}/smuggled-thumb`;
    await world.deps.blobs.put(fileKey, randomBytes(32));
    await world.deps.blobs.put(thumbKey, randomBytes(8));

    const res = await world.request('POST', '/files', {
      token: zero.token,
      body: {
        id: 0,
        collectionID: album,
        encryptedKey: b64(randomBytes(48)),
        keyDecryptionNonce: b64(randomBytes(24)),
        file: { objectKey: fileKey, decryptionHeader: b64(randomBytes(24)) },
        thumbnail: { objectKey: thumbKey, decryptionHeader: b64(randomBytes(24)) },
        metadata: { encryptedData: b64(randomBytes(64)), decryptionHeader: b64(randomBytes(24)) },
      },
    });
    expect(res.status).toBe(426);
  });

  it('0-byte user still receives a share and downloads its files', async () => {
    const owner = await signupAccount(world, 'owner@b.c');
    const { album, fileId } = await shareAlbumWithFile(world, owner, zero.email);

    const diff = await world.request('GET', `/collections/v2/diff?collectionID=${album}&sinceTime=0`, {
      token: zero.token,
    });
    expect(diff.status).toBe(200);
    expect(((await diff.json()) as { diff: Array<{ id: number }> }).diff.map((f) => f.id)).toContain(fileId);
    expect((await world.request('GET', `/files/download/v2/${fileId}`, { token: zero.token })).status).toBe(200);
  });

  it('details/v2 and the billing stub report the per-user storage, museum-shaped', async () => {
    await upsertInvite(world.deps, 'small@b.c', { storageLimitBytes: 5 * GIB });
    const small = await signupAccount(world, 'small@b.c');

    const details = await world.request('GET', '/users/details/v2', { token: small.token });
    const detailsBody = (await details.json()) as { subscription: Record<string, unknown>; usage: number };
    expect(detailsBody.subscription.storage).toBe(5 * GIB);
    // envelope unchanged — same subscription fields as every free account
    expect(Object.keys(detailsBody.subscription).sort()).toEqual([
      'attributes', 'expiryTime', 'id', 'originalTransactionID', 'paymentProvider',
      'period', 'price', 'productID', 'storage', 'userID',
    ]);

    const sub = await world.request('GET', '/billing/subscription', { token: small.token });
    expect(((await sub.json()) as { subscription: { storage: number } }).subscription.storage).toBe(5 * GIB);

    // no override -> config default (regression)
    const owner = await signupAccount(world, 'plain@b.c');
    const plain = await world.request('GET', '/users/details/v2', { token: owner.token });
    expect(((await plain.json()) as { subscription: { storage: number } }).subscription.storage).toBe(
      world.deps.config.freePlanStorageBytes,
    );
  });

  it('set-storage adjusts an existing user post hoc, and clearing restores the default', async () => {
    const account = await signupAccount(world, 'grown@b.c');
    const toolDeps = { db: world.deps.db, hashingKey: world.deps.hashingKey };

    expect(await setUserStorage(toolDeps, 'grown@b.c', 10)).toEqual({ userId: account.userId });
    await expect(
      uploadAndCommit(world, account, await createAlbum(world, account), new Uint8Array(randomBytes(64)), new Uint8Array(randomBytes(16))),
    ).rejects.toThrow(/426/);

    expect(await setUserStorage(toolDeps, 'grown@b.c', null)).toEqual({ userId: account.userId });
    const album = await createAlbum(world, account, 'after');
    const up = await uploadAndCommit(world, account, album, new Uint8Array(randomBytes(64)), new Uint8Array(randomBytes(16)));
    expect(up.fileId).toBeGreaterThan(0);

    expect(await setUserStorage(toolDeps, 'nobody@b.c', 10)).toBeNull();
  });
});

describe('viewer accounts (D54)', () => {
  let world: TestWorld;
  let owner: Account;
  let viewer: Account;
  beforeEach(async () => {
    world = await makeWorld();
    await upsertInvite(world.deps, 'viewer@b.c', { viewer: true });
    owner = await signupAccount(world, 'owner@b.c');
    viewer = await signupAccount(world, 'viewer@b.c');
  });

  const create = (type: string) =>
    world.request('POST', '/collections', {
      token: viewer.token,
      body: {
        encryptedKey: b64(randomBytes(48)),
        keyDecryptionNonce: b64(randomBytes(24)),
        encryptedName: b64(randomBytes(12)),
        nameDecryptionNonce: b64(randomBytes(24)),
        type,
        attributes: {},
      },
    });

  it('album/folder creation is 403; the SPECIAL collections stay creatable (client boot safety)', async () => {
    expect((await create('album')).status).toBe(403);
    expect((await create('folder')).status).toBe(403);

    // favorites/uncategorized: metadata-only rows the stock apps auto-create
    // (first favorite tap / remove-from-last-album) — blocking them would
    // break a viewer's consume-a-share loop, so they are exempt.
    const fav = await create('favorites');
    expect(fav.status).toBe(200);
    const favId = ((await fav.json()) as { collection: { id: number } }).collection.id;
    const again = await create('favorites');
    expect(((await again.json()) as { collection: { id: number } }).collection.id).toBe(favId);
    expect((await create('uncategorized')).status).toBe(200);
  });

  it('viewer upload paths are 426 (storage-limit family, self-consistent with 0 bytes)', async () => {
    expect((await world.request('GET', '/files/upload-urls?count=1', { token: viewer.token })).status).toBe(426);
    expect((await world.request('GET', '/files/upload-eligibility', { token: viewer.token })).status).toBe(426);
    expect(
      (
        await world.request('POST', '/files/upload-url', {
          token: viewer.token,
          body: { contentLength: 10, contentMD5: 'x' },
        })
      ).status,
    ).toBe(426);
  });

  it('viewer consumes a share end to end: diff, download, leave', async () => {
    const { album, fileId } = await shareAlbumWithFile(world, owner, viewer.email);

    const diff = await world.request('GET', `/collections/v2/diff?collectionID=${album}&sinceTime=0`, {
      token: viewer.token,
    });
    expect(diff.status).toBe(200);
    expect((await world.request('GET', `/files/download/v2/${fileId}`, { token: viewer.token })).status).toBe(200);
    expect((await world.request('GET', `/files/preview/v2/${fileId}`, { token: viewer.token })).status).toBe(200);

    expect((await world.request('POST', `/collections/leave/${album}`, { token: viewer.token })).status).toBe(200);
    expect((await world.request('GET', `/files/download/v2/${fileId}`, { token: viewer.token })).status).toBe(404);
  });

  it('viewer subscription reports 0 storage (real number, museum shape)', async () => {
    const details = await world.request('GET', '/users/details/v2', { token: viewer.token });
    expect(((await details.json()) as { subscription: { storage: number } }).subscription.storage).toBe(0);
  });
});

describe('operator tooling row-writing (tools/invite.ts is a thin CLI over these)', () => {
  let world: TestWorld;
  beforeEach(async () => {
    world = await makeWorld();
  });

  it('upsertInvite writes INVITE#<lowercased-email>/META with home "local" and no gsi attributes (D48 rule)', async () => {
    await upsertInvite(world.deps, ' Mixed@Case.Org ', { storageLimitBytes: 2 * GIB, viewer: false });
    const rows = world.deps.db.dump().filter((r) => r.pk.startsWith('INVITE#'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pk: 'INVITE#mixed@case.org',
      sk: 'META',
      email: 'mixed@case.org',
      storageLimitBytes: 2 * GIB,
      viewer: false,
      home: 'local',
    });
    expect(rows[0]!.createdAt).toBeGreaterThan(0);
    for (const attr of ['gsi1pk', 'gsi1sk', 'gsi2pk', 'gsi2sk', 'gsi3pk', 'gsi3sk']) {
      expect(rows[0]![attr]).toBeUndefined();
    }
  });

  it('revokeInvite deletes unconsumed rows, refuses consumed ones, reports missing ones', async () => {
    expect(await revokeInvite(world.deps, 'none@b.c')).toBe('not-found');

    await upsertInvite(world.deps, 'open@b.c');
    expect(await revokeInvite(world.deps, 'open@b.c')).toBe('revoked');
    expect(await getInvite(world.deps, 'open@b.c')).toBeNull();

    await upsertInvite(world.deps, 'used@b.c');
    await signupAccount(world, 'used@b.c');
    expect(await revokeInvite(world.deps, 'used@b.c')).toBe('consumed');
    expect(await getInvite(world.deps, 'used@b.c')).not.toBeNull(); // audit row kept
  });
});
