/**
 * [PUBLIC-COLLECTION] the anonymous serving surface — GET /info, GET /diff,
 * the access-token middleware's negative shapes, and device-limit admission.
 * Pinned against pkg/middleware/collection_link.go (bodies verbatim),
 * pkg/api/public_collection.go, pkg/controller/public/collection_link.go
 * GetPublicCollection, pkg/controller/collections/share.go GetPublicDiff.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { createAlbum, uploadAndCommit } from '../helpers/upload.ts';
import { createShareUrl, publicRequest, type PublicLinkFixture } from '../helpers/publicClient.ts';
import { effectiveDeviceLimit } from '../../src/domain/publicLinks.ts';
import { MICROS_PER_HOUR } from '../../src/lib/time.ts';
import { b64 } from '../../src/lib/b64.ts';

let world: TestWorld;
let owner: Account;
let album: number;
let link: PublicLinkFixture;

const info = (accessToken?: string, headers?: Record<string, string>) =>
  publicRequest(world, 'GET', '/public-collection/info', { accessToken, headers });
const diff = (accessToken: string, sinceTime = 0) =>
  publicRequest(world, 'GET', `/public-collection/diff?sinceTime=${sinceTime}`, { accessToken });

beforeEach(async () => {
  world = await makeWorld();
  owner = await signupAccount(world, 'pub-owner@b.c');
  album = await createAlbum(world, owner, 'public');
  link = await createShareUrl(world, owner, album);
});

describe('GET /public-collection/info', () => {
  it('serves the scrubbed collection: blank owner email, sharees null, limited publicURLs, referralCode', async () => {
    const res = await info(link.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      collection: Record<string, unknown>;
      referralCode: string;
    };
    const col = body.collection;
    expect(col.id).toBe(album);
    // repo.Get never selects the owner email — the public surface must not
    // leak it to anonymous viewers.
    expect(col.owner).toEqual({ id: owner.userId, email: '', name: '', role: '' });
    expect(col.sharees).toBeNull();
    expect(col).not.toHaveProperty('magicMetadata');
    expect(col.encryptedKey).toBeTruthy();
    // GetPublicCollection's "limited info" PublicURL: flags only — the token
    // is never echoed back, url/deviceLimit/validTill are Go zero values.
    expect(col.publicURLs).toEqual([
      {
        url: '',
        deviceLimit: 0,
        validTill: 0,
        enableDownload: true,
        enableCollect: false,
        enableComment: false,
        passwordEnabled: false,
        enableJoin: true,
      },
    ]);
    expect(body.referralCode).toBe(''); // storage-bonus stub, D51
  });

  it('hands the browser a link-device token in X-Ente-Link-Device-Token (frozen-oracle header name)', async () => {
    const res = await info(link.token);
    expect(res.headers.get('x-ente-link-device-token')).toBeTruthy();
  });
});

describe('GET /public-collection/diff', () => {
  it('serves entries + tombstones with magicMetadata stripped (pubMagicMetadata passes), hasMore false', async () => {
    const keep = await uploadAndCommit(world, owner, album, new Uint8Array(randomBytes(64)), new Uint8Array(randomBytes(16)));
    const gone = await uploadAndCommit(world, owner, album, new Uint8Array(randomBytes(64)), new Uint8Array(randomBytes(16)));
    const magic = { version: 0, count: 1, data: b64(randomBytes(32)), header: b64(randomBytes(24)) };
    for (const route of ['/files/magic-metadata', '/files/public-magic-metadata']) {
      const set = await world.request('PUT', route, {
        token: owner.token,
        body: { metadataList: [{ id: keep.fileId, magicMetadata: magic }] },
      });
      expect(set.status).toBe(200);
    }
    const trash = await world.request('POST', '/files/trash', {
      token: owner.token,
      body: { items: [{ fileID: gone.fileId, collectionID: album }] },
    });
    expect(trash.status).toBe(200);

    const res = await diff(link.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { diff: Record<string, unknown>[]; hasMore: boolean };
    expect(body.hasMore).toBe(false);
    const kept = body.diff.find((f) => f.id === keep.fileId)!;
    expect(kept.isDeleted).toBe(false);
    expect(kept).not.toHaveProperty('magicMetadata'); // GetPublicDiff scrub
    expect(kept).toHaveProperty('pubMagicMetadata');
    expect(kept.encryptedKey).toBeTruthy();
    const tomb = body.diff.find((f) => f.id === gone.fileId)!;
    expect(tomb.isDeleted).toBe(true);
    // Tombstones keep their stored fields — museum's diff SELECT never blanks
    // deleted links; only the isDeleted flag flips (D61).
    expect(tomb.encryptedKey).toBeTruthy();
    expect(tomb.keyDecryptionNonce).toBeTruthy();
  });

  it('missing/garbage sinceTime is a 400 BAD_REQUEST ApiError (museum ParseInt, unlike the authed diff)', async () => {
    const res = await publicRequest(world, 'GET', '/public-collection/diff', {
      accessToken: link.token,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('BAD_REQUEST');
  });
});

describe('middleware negative parity (enumeration resistance as a property)', () => {
  it('each bad-token class returns its museum shape, and none leak collection data', async () => {
    const expired = await (async () => {
      const a = await createAlbum(world, owner, 'expiring');
      const l = await createShareUrl(world, owner, a);
      const upd = await world.request('PUT', '/collections/share-url', {
        token: owner.token,
        body: { collectionID: a, validTill: world.deps.clock.nowMicros() + 1_000_000 },
      });
      expect(upd.status).toBe(200);
      world.deps.clock.advance(2_000_000);
      return l.token;
    })();
    const disabled = await (async () => {
      const a = await createAlbum(world, owner, 'disabling');
      const l = await createShareUrl(world, owner, a);
      await world.request('DELETE', `/collections/share-url/${a}`, { token: owner.token });
      return l.token;
    })();

    const cases: Array<[string | undefined, number, Record<string, unknown>]> = [
      [undefined, 401, { error: 'missing accessToken', context: 'album_link' }],
      ['GARBAGE123', 401, { error: 'invalid token' }],
      [disabled, 410, { error: 'disabled token' }],
      [expired, 410, { error: 'expired token' }],
    ];
    for (const path of ['/public-collection/info', '/public-collection/diff?sinceTime=0']) {
      for (const [token, status, body] of cases) {
        const res = await publicRequest(world, 'GET', path, { accessToken: token });
        expect([path, res.status]).toEqual([path, status]);
        const json = (await res.json()) as Record<string, unknown>;
        expect(json).toEqual(body);
        expect(JSON.stringify(json)).not.toContain(String(album));
      }
    }
  });
});

describe('device limit', () => {
  const infoAs = (device: { ip: string; ua: string }, extra: Record<string, string> = {}) =>
    publicRequest(world, 'GET', '/public-collection/info', {
      accessToken: link.token,
      headers: { 'x-forwarded-for': device.ip, 'user-agent': device.ua, ...extra },
    });

  it('admits up to the limit by (ip, ua); admitted devices stay in; new ones read 403 LINK_DEVICE_LIMIT_EXCEEDED', async () => {
    const upd = await world.request('PUT', '/collections/share-url', {
      token: owner.token,
      body: { collectionID: album, deviceLimit: 1 },
    });
    expect(upd.status).toBe(200);

    const phone = { ip: '10.0.0.1', ua: 'phone' };
    const laptop = { ip: '10.0.0.2', ua: 'laptop' };
    expect((await infoAs(phone)).status).toBe(200);
    const rejected = await infoAs(laptop);
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({
      code: 'LINK_DEVICE_LIMIT_EXCEEDED',
      message: 'Public link device limit reached',
    });
    // The admitted device keeps its access regardless of the exhausted limit.
    expect((await infoAs(phone)).status).toBe(200);
    // Admission is tied to /info and /diff only — other public routes are not
    // device-gated (museum shouldCheckCollectionLinkDeviceLimit).
    const preview = await publicRequest(world, 'GET', '/public-collection/files/download/v3/1', {
      accessToken: link.token,
      headers: { 'x-forwarded-for': laptop.ip, 'user-agent': laptop.ua },
    });
    expect(preview.status).not.toBe(403);
  });

  it('a valid link-device JWT re-admits without an (ip, ua) record; museum quirk: limit 50 enforces 500', async () => {
    const upd = await world.request('PUT', '/collections/share-url', {
      token: owner.token,
      body: { collectionID: album, deviceLimit: 1 },
    });
    expect(upd.status).toBe(200);
    const phone = { ip: '10.1.0.1', ua: 'phone' };
    const first = await infoAs(phone);
    const deviceToken = first.headers.get('x-ente-link-device-token')!;
    expect(deviceToken).toBeTruthy();

    // A different device presenting the JWT bypasses admission entirely.
    const other = await publicRequest(world, 'GET', '/public-collection/info', {
      accessToken: link.token,
      deviceToken,
      headers: { 'x-forwarded-for': '10.1.0.9', 'user-agent': 'tablet' },
    });
    expect(other.status).toBe(200);
    // ... but the JWT is bound to THIS link: it does not admit on another.
    const foreignAlbum = await createAlbum(world, owner, 'foreign');
    const foreign = await createShareUrl(world, owner, foreignAlbum);
    await world.request('PUT', '/collections/share-url', {
      token: owner.token,
      body: { collectionID: foreignAlbum, deviceLimit: 1 },
    });
    await publicRequest(world, 'GET', '/public-collection/info', {
      accessToken: foreign.token,
      headers: { 'x-forwarded-for': '10.9.9.1', 'user-agent': 'a' },
    });
    const cross = await publicRequest(world, 'GET', '/public-collection/info', {
      accessToken: foreign.token,
      deviceToken,
      headers: { 'x-forwarded-for': '10.9.9.2', 'user-agent': 'b' },
    });
    expect(cross.status).toBe(403);

    expect(effectiveDeviceLimit(50)).toBe(500); // DeviceLimitThreshold * 10
    expect(effectiveDeviceLimit(0)).toBe(0);
    expect(effectiveDeviceLimit(10)).toBe(10);
  });

  it('admission rows carry the rolling TTL backstop — DEVICE# and DEVICES both (P2-1, D53)', async () => {
    expect((await infoAs({ ip: '10.2.0.1', ua: 'phone' })).status).toBe(200);
    const rows = world.deps.db.dump().filter((r) => r.pk.startsWith('PUBTOKEN#'));
    const device = rows.find((r) => (r.sk as string).startsWith('DEVICE#'))!;
    const counter = rows.find((r) => r.sk === 'DEVICES')!;
    const nowSec = world.deps.clock.nowMicros() / 1_000_000;
    for (const row of [device, counter]) {
      expect(typeof row.ttl).toBe('number');
      // 90 days out, the link-META validTill+90d margin.
      expect(row.ttl as number).toBeGreaterThan(nowSec + 89 * 24 * 3600);
      expect(row.ttl as number).toBeLessThanOrEqual(nowSec + 91 * 24 * 3600);
    }
  });

  it('a lost same-device admission race is admitted without double-counting (conditional put, P3-1, D53)', async () => {
    const phone = { ip: '10.3.0.1', ua: 'phone' };
    expect((await infoAs(phone)).status).toBe(200);
    // Simulate the race: a second admit whose pre-check read "unseen" before
    // the first one's write landed — the conditional DEVICE# put then fires
    // against the existing row and must fail WITHOUT incrementing DEVICES.
    const db = world.deps.db;
    const realGet = db.get.bind(db);
    const spy = vi
      .spyOn(db, 'get')
      .mockImplementation(async (pk, sk) => (sk.startsWith('DEVICE#') ? null : realGet(pk, sk)));
    const raced = await infoAs(phone);
    spy.mockRestore();
    expect(raced.status).toBe(200);
    const counter = db.dump().find((r) => r.sk === 'DEVICES')!;
    expect(counter.count).toBe(1);
  });

  it('the per-link daily admission ceiling 429s new devices; admitted ones keep working; next UTC day resets (P2-1, D53)', async () => {
    world.deps.config.publicLinkDailyDeviceLimit = 2;
    const phone = { ip: '10.4.0.1', ua: 'phone' };
    expect((await infoAs(phone)).status).toBe(200);
    expect((await infoAs({ ip: '10.4.0.2', ua: 'laptop' })).status).toBe(200);
    const capped = await infoAs({ ip: '10.4.0.3', ua: 'tablet' });
    expect(capped.status).toBe(429);
    expect(await capped.json()).toEqual({}); // the download/upload ceilings' bare-429 shape
    // No row was minted for the refused device, and admitted devices stay in.
    const counter = world.deps.db.dump().find((r) => r.sk === 'DEVICES')!;
    expect(counter.count).toBe(2);
    expect((await infoAs(phone)).status).toBe(200);
    world.deps.clock.advance(24 * 3600 * 1_000_000); // next UTC day, fresh row
    expect((await infoAs({ ip: '10.4.0.3', ua: 'tablet' })).status).toBe(200);
  });

  it('expiry sliding under a device JWT still 410s (validTill is re-checked every request)', async () => {
    const upd = await world.request('PUT', '/collections/share-url', {
      token: owner.token,
      body: { collectionID: album, validTill: world.deps.clock.nowMicros() + MICROS_PER_HOUR },
    });
    expect(upd.status).toBe(200);
    const res = await info(link.token);
    expect(res.status).toBe(200);
    world.deps.clock.advance(2 * MICROS_PER_HOUR);
    const after = await info(link.token);
    expect(after.status).toBe(410);
    expect(await after.json()).toEqual({ error: 'expired token' });
  });
});
