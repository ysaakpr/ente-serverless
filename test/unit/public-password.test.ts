/**
 * [PUBLIC-COLLECTION] password gate — POST /public-collection/verify-password
 * and the middleware's JWT enforcement. src: pkg/controller/public/
 * link_common.go verifyPassword/validateJWTToken, ente/jwt LinkPasswordClaim,
 * pkg/middleware/collection_link.go (whitelist + 401 {"error":{}} body).
 * The wrong-attempt 429 cap is this repo's plan-§4.1c hardening (D51).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { createAlbum, uploadAndCommit } from '../helpers/upload.ts';
import { createShareUrl, publicRequest, type PublicLinkFixture } from '../helpers/publicClient.ts';
import { b64 } from '../../src/lib/b64.ts';

let world: TestWorld;
let owner: Account;
let album: number;
let link: PublicLinkFixture;
let passHash: string;

const verify = (hash: string, headers: Record<string, string> = {}) =>
  publicRequest(world, 'POST', '/public-collection/verify-password', {
    accessToken: link.token,
    body: { passHash: hash },
    headers,
  });

const unlock = async (): Promise<string> => {
  const res = await verify(passHash);
  expect(res.status).toBe(200);
  return ((await res.json()) as { jwtToken: string }).jwtToken;
};

beforeEach(async () => {
  world = await makeWorld();
  owner = await signupAccount(world, 'pw-owner@b.c');
  album = await createAlbum(world, owner, 'locked');
  link = await createShareUrl(world, owner, album);
  passHash = b64(randomBytes(32));
  const set = await world.request('PUT', '/collections/share-url', {
    token: owner.token,
    body: { collectionID: album, passHash, nonce: b64(randomBytes(16)), memLimit: 67108864, opsLimit: 2 },
  });
  expect(set.status).toBe(200);
});

describe('the middleware JWT gate', () => {
  it('info stays open (whitelisted, KDF params served); diff/download demand the JWT -> 401 {"error":{}}', async () => {
    const infoRes = await publicRequest(world, 'GET', '/public-collection/info', {
      accessToken: link.token,
    });
    expect(infoRes.status).toBe(200);
    const { collection } = (await infoRes.json()) as { collection: { publicURLs: Record<string, unknown>[] } };
    expect(collection.publicURLs[0]).toMatchObject({ passwordEnabled: true, memLimit: 67108864, opsLimit: 2 });

    for (const path of ['/public-collection/diff?sinceTime=0', '/public-collection/files/download/1']) {
      const noJwt = await publicRequest(world, 'GET', path, { accessToken: link.token });
      expect(noJwt.status).toBe(401);
      expect(await noJwt.json()).toEqual({ error: {} }); // gin.H{"error": err} marshals the error to {}
      const badJwt = await publicRequest(world, 'GET', path, {
        accessToken: link.token,
        jwt: 'not.a.jwt',
      });
      expect(badJwt.status).toBe(401);
    }
  });

  it('a fresh JWT unlocks the gated routes end to end', async () => {
    const up = await uploadAndCommit(world, owner, album, new Uint8Array(randomBytes(64)), new Uint8Array(randomBytes(16)));
    const jwt = await unlock();
    const diffRes = await publicRequest(world, 'GET', '/public-collection/diff?sinceTime=0', {
      accessToken: link.token,
      jwt,
    });
    expect(diffRes.status).toBe(200);
    const dl = await publicRequest(world, 'GET', `/public-collection/files/download/${up.fileId}`, {
      accessToken: link.token,
      jwt,
    });
    expect(dl.status).toBe(307);
    expect(
      Buffer.from(await world.deps.blobs.downloadViaUrl(dl.headers.get('location')!)),
    ).toEqual(Buffer.from(up.file.cipher));
  });

  it('the JWT dies with a password change and with its 30-day expiry', async () => {
    const jwt = await unlock();
    const gated = (token: string) =>
      publicRequest(world, 'GET', '/public-collection/diff?sinceTime=0', {
        accessToken: link.token,
        jwt: token,
      });
    expect((await gated(jwt)).status).toBe(200);

    world.deps.clock.advance(31 * 24 * 3600 * 1_000_000);
    expect((await gated(jwt)).status).toBe(401); // expiryTime claim enforced

    const fresh = await unlock();
    const rotate = await world.request('PUT', '/collections/share-url', {
      token: owner.token,
      body: { collectionID: album, passHash: b64(randomBytes(32)), nonce: b64(randomBytes(16)), memLimit: 67108864, opsLimit: 2 },
    });
    expect(rotate.status).toBe(200);
    expect((await gated(fresh)).status).toBe(401); // passKey no longer matches
  });
});

describe('POST /public-collection/verify-password', () => {
  it('wrong hash 401 {}, right hash issues the JWT; missing body / unpassworded link 400', async () => {
    const wrong = await verify(b64(randomBytes(32)));
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({});
    expect((await unlock()).split('.')).toHaveLength(3);

    const missing = await publicRequest(world, 'POST', '/public-collection/verify-password', {
      accessToken: link.token,
      body: {},
    });
    expect(missing.status).toBe(400);

    const openAlbum = await createAlbum(world, owner, 'open');
    const openLink = await createShareUrl(world, owner, openAlbum);
    const notConfigured = await publicRequest(world, 'POST', '/public-collection/verify-password', {
      accessToken: openLink.token,
      body: { passHash: passHash },
    });
    expect(notConfigured.status).toBe(400); // museum: "password is not configured for the link"
  });

  it('20 wrong attempts per (link, ip) trip the 429 cap; another ip is unaffected; the window slides shut', async () => {
    const attacker = { 'x-forwarded-for': '10.66.0.1' };
    for (let i = 0; i < 20; i++) {
      expect((await verify(b64(randomBytes(32)), attacker)).status).toBe(401);
    }
    expect((await verify(b64(randomBytes(32)), attacker)).status).toBe(429);
    // Even the RIGHT hash is refused while the cap holds (cheap-fail first).
    expect((await verify(passHash, attacker)).status).toBe(429);
    // A different source is not collateral damage.
    expect((await verify(passHash, { 'x-forwarded-for': '10.66.0.2' })).status).toBe(200);
    // The cap lifts once the window expires (TTL'd counter row).
    world.deps.clock.advance(61 * 60 * 1_000_000);
    expect((await verify(passHash, attacker)).status).toBe(200);
  });
});
