/**
 * [D65] Stale-object GC — museum's temp_objects machinery. Every upload-URL
 * mint records the key (controller/file.go getObjectURL → AddTempObjectKey,
 * multipart mints → AddMultipartTempObjectKey); the cron sweep deletes keys
 * whose row expired without a commit claiming them (the OBJ# guard row —
 * museum ObjectRepo.DoesObjectExist in object_cleanup.go
 * removeUnreportedObject), aborting multipart uploads first. Expiry = mint
 * + 2× presigned-PUT validity (museum 2 × PreSignedRequestValidityDuration).
 */

import { beforeEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { createAlbum, uploadAndCommit } from '../helpers/upload.ts';
import { createShareUrl, publicRequest } from '../helpers/publicClient.ts';
import { sweepStaleObjects } from '../../src/domain/staleObjects.ts';
import { putPool, setUserPool } from '../../src/domain/storagePools.ts';
import { b64 } from '../../src/lib/b64.ts';

let world: TestWorld;
let A: Account;

const MICROS = 1_000_000;
const tempWindowMicros = () => 2 * world.deps.config.presignPutExpirySeconds * MICROS;

beforeEach(async () => {
  world = await makeWorld();
  A = await signupAccount(world, 'stale-a@b.c');
});

const staleRows = () => world.deps.db.query('STALEQ', {});

const mintSingle = async (account: Account): Promise<string> => {
  const res = await world.request('GET', '/files/upload-urls?count=1', { token: account.token });
  expect(res.status).toBe(200);
  const { urls } = (await res.json()) as { urls: Array<{ objectKey: string; url: string }> };
  return urls[0]!.objectKey;
};

it('every mint records a temp row: single, multipart, V2, and both public collect mints', async () => {
  const k1 = await mintSingle(A);

  const mp = await world.request('GET', '/files/multipart-upload-urls?count=2', { token: A.token });
  expect(mp.status).toBe(200);

  const v2 = await world.request('POST', '/files/upload-url', {
    token: A.token, body: { contentLength: 1024, contentMD5: b64(randomBytes(16)) },
  });
  expect(v2.status).toBe(200);

  const v2mp = await world.request('POST', '/files/multipart-upload-url', {
    token: A.token,
    body: { contentLength: 12 * 1024 * 1024, partLength: 5 * 1024 * 1024, partMd5s: [b64(randomBytes(16)), b64(randomBytes(16)), b64(randomBytes(16))] },
  });
  expect(v2mp.status).toBe(200);

  const album = await createAlbum(world, A, 'collect');
  const link = await createShareUrl(world, A, album, { enableCollect: true });
  const pub1 = await publicRequest(world, 'POST', '/public-collection/upload-url', {
    accessToken: link.token, body: { contentLength: 1024, contentMD5: b64(randomBytes(16)) },
  });
  expect(pub1.status).toBe(200);
  const pub2 = await publicRequest(world, 'POST', '/public-collection/multipart-upload-url', {
    accessToken: link.token,
    body: { contentLength: 12 * 1024 * 1024, partLength: 5 * 1024 * 1024, partMd5s: [b64(randomBytes(16)), b64(randomBytes(16)), b64(randomBytes(16))] },
  });
  expect(pub2.status).toBe(200);

  const rows = await staleRows();
  expect(rows).toHaveLength(6);
  expect(rows.every((r) => (r.expiresAt as number) > world.deps.clock.nowMicros())).toBe(true);
  expect(rows.some((r) => r.objectKey === k1)).toBe(true);
  // the three multipart mints carry their upload id for the abort
  expect(rows.filter((r) => r.uploadID).length).toBe(3);
});

it('sweep is a no-op before expiry, and never touches claimed (committed) objects after it', async () => {
  const album = await createAlbum(world, A, 'claimed');
  const up = await uploadAndCommit(world, A, album, new Uint8Array(randomBytes(96)), new Uint8Array(randomBytes(24)));

  // not expired yet -> nothing resolved
  expect(await sweepStaleObjects(world.deps)).toBe(0);
  expect((await staleRows()).length).toBe(2); // file + thumb mints

  world.deps.clock.advance(tempWindowMicros() + MICROS);
  const resolved = await sweepStaleObjects(world.deps);
  expect(resolved).toBe(2); // both rows resolved as CLAIMED
  expect(await staleRows()).toHaveLength(0);
  // the committed bytes survive
  expect(await world.deps.blobs.head(up.fileObjectKey)).not.toBeNull();
  expect(await world.deps.blobs.head(up.thumbObjectKey)).not.toBeNull();
});

it('deletes an uploaded-but-never-committed object once expired (the 426 orphan)', async () => {
  const objectKey = await mintSingle(A);
  await world.deps.blobs.put(objectKey, randomBytes(512)); // client PUT, commit never happens

  world.deps.clock.advance(tempWindowMicros() + MICROS);
  expect(await sweepStaleObjects(world.deps)).toBe(1);
  expect(await world.deps.blobs.head(objectKey)).toBeNull();
  expect(await staleRows()).toHaveLength(0);
});

it('aborts an abandoned multipart upload and drops its row', async () => {
  const mp = await world.request('GET', '/files/multipart-upload-urls?count=2', { token: A.token });
  const { urls } = (await mp.json()) as { urls: { objectKey: string } };
  const rowsBefore = await staleRows();
  const uploadID = rowsBefore[0]!.uploadID as string;
  expect(uploadID).toBeTruthy();
  expect(world.deps.blobs.multiparts.has(uploadID)).toBe(true);

  world.deps.clock.advance(tempWindowMicros() + MICROS);
  expect(await sweepStaleObjects(world.deps)).toBe(1);
  expect(world.deps.blobs.multiparts.has(uploadID)).toBe(false); // aborted
  expect(await world.deps.blobs.head(urls.objectKey)).toBeNull();
  expect(await staleRows()).toHaveLength(0);
});

it('pool mints pin their pool and the sweep deletes from THAT bucket; unresolvable pools quarantine', async () => {
  await putPool(world.deps, {
    poolId: 'stale-pool', mode: 'keys', bucket: 'stale-pool-photos', region: 'eu-west-1',
    accessKey: 'AKIASTALE', secretKey: 'very-secret',
  });
  await setUserPool(world.deps, A.email, 'stale-pool');

  const objectKey = await mintSingle(A);
  const rows = await staleRows();
  expect(rows[0]!.poolId).toBe('stale-pool');
  const poolBucket = world.deps.blobs.forPool('stale-pool');
  await poolBucket.put(objectKey, randomBytes(256)); // uncommitted pool bytes

  world.deps.clock.advance(tempWindowMicros() + MICROS);
  expect(await sweepStaleObjects(world.deps)).toBe(1);
  expect(await poolBucket.head(objectKey)).toBeNull();

  // a row pinned to a pool that no longer resolves stays quarantined
  const orphanKey = `${A.userId}/orphan`;
  await world.deps.db.put({
    pk: 'STALEQ', sk: `0#orphan`, objectKey: orphanKey,
    expiresAt: world.deps.clock.nowMicros() - 1, poolId: 'gone-pool',
  });
  expect(await sweepStaleObjects(world.deps)).toBe(0);
  expect(await staleRows()).toHaveLength(1); // left for the next run
});
