/**
 * [PUBLIC-LINKS] POST /collections/join-link — an AUTHED user joins a shared
 * album by presenting the link's access token alongside their session. src:
 * pkg/api/collection.go JoinLink + pkg/controller/collections/share.go
 * JoinViaLink (dual credentials; role VIEWER, or COLLABORATOR when
 * enableCollect; CanJoin's 400 matrix; token-mismatch 403; the password JWT's
 * parse-fail-500 / wrong-passKey-401 split).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { createAlbum } from '../helpers/upload.ts';
import { createShareUrl, publicRequest } from '../helpers/publicClient.ts';
import { getSharee } from '../../src/domain/sharing.ts';
import { b64 } from '../../src/lib/b64.ts';

let world: TestWorld;
let owner: Account;
let joiner: Account;
let album: number;

const sealedKey = () => b64(randomBytes(80));

const join = (
  accessToken: string,
  overrides: Record<string, unknown> = {},
  opts: { session?: string; jwt?: string } = {},
) =>
  world.request('POST', '/collections/join-link', {
    token: opts.session ?? joiner.token,
    body: { collectionID: album, encryptedKey: sealedKey(), ...overrides },
    headers: {
      'x-auth-access-token': accessToken,
      ...(opts.jwt ? { 'x-auth-access-token-jwt': opts.jwt } : {}),
    },
  });

beforeEach(async () => {
  world = await makeWorld();
  owner = await signupAccount(world, 'join-owner@b.c');
  joiner = await signupAccount(world, 'join-mate@b.c');
  album = await createAlbum(world, owner, 'joinable');
});

it('joins as VIEWER (200 {}), lands the share row with sharedBy=owner, and the album reaches the joiner feed', async () => {
  const link = await createShareUrl(world, owner, album);
  const res = await join(link.token);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({});

  const row = (await getSharee(world.deps, album, joiner.userId))!;
  expect(row).toMatchObject({ role: 'VIEWER', sharedBy: owner.userId });

  const feed = await world.request('GET', '/collections/v2?sinceTime=0', { token: joiner.token });
  const { collections } = (await feed.json()) as { collections: Array<Record<string, unknown>> };
  const joined = collections.find((c) => c.id === album)!;
  expect(joined.encryptedKey).toBe(row.encryptedKey); // the joiner's own wrapped key
});

it('an enableCollect link grants COLLABORATOR (museum JoinViaLink role pick)', async () => {
  const link = await createShareUrl(world, owner, album, { enableCollect: true });
  expect((await join(link.token)).status).toBe(200);
  expect((await getSharee(world.deps, album, joiner.userId))!.role).toBe('COLLABORATOR');
});

it('refusal matrix: owner 400, wrong/absent token 403, join/download disabled 400, expired 400, disabled 404, no session 401', async () => {
  const link = await createShareUrl(world, owner, album);

  expect((await join(link.token, {}, { session: owner.token })).status).toBe(400); // owner can not join
  expect((await join('WRONGTOKEN')).status).toBe(403); // token doesn't match collection

  const flip = (body: Record<string, unknown>) =>
    world.request('PUT', '/collections/share-url', {
      token: owner.token,
      body: { collectionID: album, ...body },
    });
  await flip({ enableJoin: false });
  expect((await join(link.token)).status).toBe(400);
  await flip({ enableJoin: true, enableDownload: false });
  expect((await join(link.token)).status).toBe(400); // CanJoin: download disabled
  await flip({ enableDownload: true, validTill: world.deps.clock.nowMicros() + 1_000_000 });
  world.deps.clock.advance(2_000_000);
  expect((await join(link.token)).status).toBe(400); // CanJoin: expired

  // Disabled means no active link at all -> 404 (museum GetActiveCollectionLinkRow
  // filters is_disabled, so CanJoin's isDisabled arm is unreachable there too).
  await world.request('DELETE', `/collections/share-url/${album}`, { token: owner.token });
  expect((await join(link.token)).status).toBe(404);

  const fresh = await createShareUrl(world, owner, album);
  const noSession = await world.request('POST', '/collections/join-link', {
    body: { collectionID: album, encryptedKey: sealedKey() },
    headers: { 'x-auth-access-token': fresh.token },
  });
  expect(noSession.status).toBe(401); // authed route: session required

  const badKey = await join(fresh.token, { encryptedKey: b64(randomBytes(16)) });
  expect(badKey.status).toBe(500); // sealed-key shape: museum's bare-500 mapping
});

it('password links: missing/garbled JWT is museum\'s bare 500, a valid unlock JWT joins', async () => {
  const link = await createShareUrl(world, owner, album);
  const passHash = b64(randomBytes(32));
  await world.request('PUT', '/collections/share-url', {
    token: owner.token,
    body: { collectionID: album, passHash, nonce: b64(randomBytes(16)), memLimit: 67108864, opsLimit: 2 },
  });

  const noJwt = await join(link.token);
  expect(noJwt.status).toBe(500); // golang-jwt parse error propagates as a plain error

  const unlock = await publicRequest(world, 'POST', '/public-collection/verify-password', {
    accessToken: link.token,
    body: { passHash },
  });
  const { jwtToken } = (await unlock.json()) as { jwtToken: string };
  expect((await join(link.token, {}, { jwt: jwtToken })).status).toBe(200);
});
