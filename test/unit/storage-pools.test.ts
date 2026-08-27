/**
 * [POOLS] Phase H2 (D55) — BYO storage pools: many users share one
 * household-owned bucket, keys stay <userID>/<uuid>, files PIN the pool their
 * bytes landed in at commit time, quota has a pool-shared tier, and pool
 * membership grants NOTHING through authorization. All off-parity by design
 * (museum has no pools): wire shapes are untouched — clients only ever see
 * presigned URLs — and capture-diff runs with no pool rows (byte-identical).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { createAlbum, encryptBlob, uploadAndCommit } from '../helpers/upload.ts';
import { createShareUrl, publicRequest } from '../helpers/publicClient.ts';
import {
  decryptPoolSecret,
  getPool,
  getPoolUsage,
  putPool,
  setPoolDisabled,
  setUserPool,
} from '../../src/domain/storagePools.ts';
import { getFile } from '../../src/domain/files.ts';
import { getUser } from '../../src/domain/users.ts';
import { upsertInvite } from '../../src/domain/invites.ts';
import { enqueueObjectDeletion, sweepDeletedObjects } from '../../src/domain/objectSweep.ts';
import { S3BlobsResolver } from '../../src/adapters/aws/blobs.pool.ts';
import { S3Blobs } from '../../src/adapters/aws/blobs.s3.ts';
import { b64 } from '../../src/lib/b64.ts';

let world: TestWorld;

const makePool = (poolId: string, opts: { quotaBytes?: number } = {}) =>
  putPool(world.deps, {
    poolId,
    mode: 'keys',
    bucket: `${poolId}-photos`,
    region: 'eu-west-1',
    accessKey: `AKIA${poolId.toUpperCase()}`,
    secretKey: `very-secret-${poolId}-key`,
    poolStorageLimitBytes: opts.quotaBytes,
  });

/** The isolated memory namespace holding one pool's bytes. */
const poolBucket = (poolId: string) => world.deps.blobs.forPool(poolId);

const upload = (account: Account, album: number, fileBytes = 96, thumbBytes = 24) =>
  uploadAndCommit(
    world,
    account,
    album,
    new Uint8Array(randomBytes(fileBytes)),
    new Uint8Array(randomBytes(thumbBytes)),
  );

beforeEach(async () => {
  world = await makeWorld();
});

describe('pool routing + file pinning', () => {
  it("a member's upload lands in the pool bucket under their own prefix; default users unaffected", async () => {
    await makePool('smith');
    const alice = await signupAccount(world, 'alice@b.c');
    const bob = await signupAccount(world, 'bob@b.c');
    await setUserPool(world.deps, alice.email, 'smith');

    const albumA = await createAlbum(world, alice);
    const upA = await upload(alice, albumA);

    // bytes in the pool namespace, under alice's own prefix; NOT in the default bucket
    expect(upA.fileObjectKey.startsWith(`${alice.userId}/`)).toBe(true);
    expect(await poolBucket('smith').head(upA.fileObjectKey)).not.toBeNull();
    expect(await world.deps.blobs.head(upA.fileObjectKey)).toBeNull();

    // the commit stamped the pin
    const fileRow = await getFile(world.deps, upA.fileId);
    expect(fileRow!.storagePoolId).toBe('smith');

    // pool usage mirrors the per-user counter
    const poolUsage = await getPoolUsage(world.deps, 'smith');
    expect(poolUsage.bytes).toBe(upA.file.cipher.length + upA.thumb.cipher.length);
    expect(poolUsage.fileCount).toBe(1);

    // default-bucket user is untouched by the pool machinery
    const albumB = await createAlbum(world, bob);
    const upB = await upload(bob, albumB);
    expect(await world.deps.blobs.head(upB.fileObjectKey)).not.toBeNull();
    expect((await getFile(world.deps, upB.fileId))!.storagePoolId).toBeUndefined();

    // and alice's file round-trips through the normal download route
    const dl = await world.request('GET', `/files/download/v2/${upA.fileId}`, { token: alice.token });
    expect(dl.status).toBe(200);
    const { url } = (await dl.json()) as { url: string };
    expect(Buffer.from(await world.deps.blobs.downloadViaUrl(url))).toEqual(Buffer.from(upA.file.cipher));
  });

  it('pin follows the file: reassignment affects only NEW uploads', async () => {
    await makePool('p1');
    await makePool('p2');
    const alice = await signupAccount(world, 'mover@b.c');
    await setUserPool(world.deps, alice.email, 'p1');
    const album = await createAlbum(world, alice);
    const oldUp = await upload(alice, album);

    await setUserPool(world.deps, alice.email, 'p2');

    // the OLD file still downloads — resolved from its p1 PIN, not the current pool
    const dl = await world.request('GET', `/files/download/v2/${oldUp.fileId}`, { token: alice.token });
    expect(dl.status).toBe(200);
    const { url } = (await dl.json()) as { url: string };
    expect(url).toContain('pool=p1');
    expect(Buffer.from(await world.deps.blobs.downloadViaUrl(url))).toEqual(Buffer.from(oldUp.file.cipher));

    // previews resolve the pin too
    const pv = await world.request('GET', `/files/preview/v2/${oldUp.fileId}`, { token: alice.token });
    expect(pv.status).toBe(200);
    expect(((await pv.json()) as { url: string }).url).toContain('pool=p1');

    // the NEW upload lands in p2 and is pinned there
    const newUp = await upload(alice, album);
    expect((await getFile(world.deps, newUp.fileId))!.storagePoolId).toBe('p2');
    expect(await poolBucket('p2').head(newUp.fileObjectKey)).not.toBeNull();
    expect(await poolBucket('p1').head(newUp.fileObjectKey)).toBeNull();

    // each pool's usage counts only its own pinned bytes
    expect((await getPoolUsage(world.deps, 'p1')).bytes).toBe(oldUp.file.cipher.length + oldUp.thumb.cipher.length);
    expect((await getPoolUsage(world.deps, 'p2')).bytes).toBe(newUp.file.cipher.length + newUp.thumb.cipher.length);
  });

  it('detaching a user routes NEW uploads back to the central bucket', async () => {
    await makePool('p1');
    const alice = await signupAccount(world, 'leaver@b.c');
    await setUserPool(world.deps, alice.email, 'p1');
    const album = await createAlbum(world, alice);
    await upload(alice, album);

    await setUserPool(world.deps, alice.email, null);
    expect((await getUser(world.deps, alice.userId))!.storagePoolId).toBeUndefined();
    const up = await upload(alice, album);
    expect(await world.deps.blobs.head(up.fileObjectKey)).not.toBeNull();
    expect((await getFile(world.deps, up.fileId))!.storagePoolId).toBeUndefined();
  });

  it('an invite carrying storagePoolId lands the signup in the pool, and re-invite keeps it', async () => {
    await makePool('fam');
    await upsertInvite(world.deps, 'kid@b.c', { storagePoolId: 'fam' });
    // a later plain re-invite must not drop the pool assignment
    await upsertInvite(world.deps, 'kid@b.c');
    const kid = await signupAccount(world, 'kid@b.c');
    expect((await getUser(world.deps, kid.userId))!.storagePoolId).toBe('fam');

    const album = await createAlbum(world, kid);
    const up = await upload(kid, album);
    expect(await poolBucket('fam').head(up.fileObjectKey)).not.toBeNull();
  });
});

describe('pool quota (shared cap, one museum-shaped 426)', () => {
  it('aggregates across members: the second member is refused once the pool cap is hit', async () => {
    const alice = await signupAccount(world, 'qa@b.c');
    const bob = await signupAccount(world, 'qb@b.c');
    const albumA = await createAlbum(world, alice);
    // measure one upload's total, then cap the pool below two of them
    await makePool('capped');
    await setUserPool(world.deps, alice.email, 'capped');
    await setUserPool(world.deps, bob.email, 'capped');
    const upA = await upload(alice, albumA);
    const total = upA.file.cipher.length + upA.thumb.cipher.length;
    const { setPoolQuota } = await import('../../src/domain/storagePools.ts');
    await setPoolQuota(world.deps, 'capped', Math.floor(total * 1.5));

    // bob's mint still passes (pool bytes < cap), but his commit must 426
    const albumB = await createAlbum(world, bob);
    await expect(upload(bob, albumB)).rejects.toThrow(/426/);

    // and the eligibility probe refuses outright once usage >= cap
    await setPoolQuota(world.deps, 'capped', total);
    const probe = await world.request('GET', '/files/upload-urls?count=1', { token: bob.token });
    expect(probe.status).toBe(426);
  });

  it('per-user override blocks BEFORE the pool cap (0 means ZERO inside a pool too)', async () => {
    await makePool('roomy'); // unlimited pool
    const alice = await signupAccount(world, 'zero@b.c');
    await setUserPool(world.deps, alice.email, 'roomy');
    const { setUserStorage } = await import('../../src/domain/invites.ts');
    await setUserStorage(world.deps, alice.email, 0);

    const res = await world.request('POST', '/files/upload-url', {
      token: alice.token,
      body: { contentLength: 10, contentMD5: b64(randomBytes(16)) },
    });
    expect(res.status).toBe(426);
    expect(await res.json()).toEqual({}); // museum-shaped sentinel
  });

  it('a disabled pool refuses NEW mints with the same 426; pinned reads still serve', async () => {
    await makePool('paused');
    const alice = await signupAccount(world, 'paused@b.c');
    await setUserPool(world.deps, alice.email, 'paused');
    const album = await createAlbum(world, alice);
    const up = await upload(alice, album);

    await setPoolDisabled(world.deps, 'paused', true);
    const mint = await world.request('GET', '/files/upload-urls?count=1', { token: alice.token });
    expect(mint.status).toBe(426);
    // reads resolve through the pin regardless
    const dl = await world.request('GET', `/files/download/v2/${up.fileId}`, { token: alice.token });
    expect(dl.status).toBe(200);
  });
});

describe('public collect into a pooled owner', () => {
  it("collect bytes land in the LINK OWNER's pool, pinned and counted", async () => {
    await makePool('smith');
    const owner = await signupAccount(world, 'pool-owner@b.c');
    await setUserPool(world.deps, owner.email, 'smith');
    const album = await createAlbum(world, owner, 'collecting');
    const link = await createShareUrl(world, owner, album, { enableCollect: true });

    const file = encryptBlob(new Uint8Array(randomBytes(96)));
    const thumb = encryptBlob(new Uint8Array(randomBytes(24)));
    const keys: string[] = [];
    for (const blob of [file, thumb]) {
      const res = await publicRequest(world, 'POST', '/public-collection/upload-url', {
        accessToken: link.token,
        body: { contentLength: blob.cipher.length, contentMD5: b64(randomBytes(16)) },
      });
      expect(res.status).toBe(200);
      const { objectKey, url } = (await res.json()) as { objectKey: string; url: string };
      expect(objectKey.startsWith(`${owner.userId}/`)).toBe(true);
      expect(url).toContain('pool=smith'); // presigned into the owner's pool
      await world.deps.blobs.uploadViaUrl(url, blob.cipher);
      keys.push(objectKey);
    }
    const commit = await publicRequest(world, 'POST', '/public-collection/file', {
      accessToken: link.token,
      body: {
        id: 0,
        collectionID: album,
        encryptedKey: b64(randomBytes(48)),
        keyDecryptionNonce: b64(randomBytes(24)),
        file: { objectKey: keys[0], decryptionHeader: file.decryptionHeader },
        thumbnail: { objectKey: keys[1], decryptionHeader: thumb.decryptionHeader },
        metadata: { encryptedData: b64(randomBytes(64)), decryptionHeader: b64(randomBytes(24)) },
      },
    });
    expect(commit.status).toBe(200);
    const { id } = (await commit.json()) as { id: number };
    expect((await getFile(world.deps, id))!.storagePoolId).toBe('smith');
    expect((await getPoolUsage(world.deps, 'smith')).bytes).toBe(file.cipher.length + thumb.cipher.length);
    expect(await poolBucket('smith').head(keys[0]!)).not.toBeNull();

    // and the shared cap gates the collect mint like any other upload
    const { setPoolQuota } = await import('../../src/domain/storagePools.ts');
    await setPoolQuota(world.deps, 'smith', file.cipher.length + thumb.cipher.length);
    const refused = await publicRequest(world, 'POST', '/public-collection/upload-url', {
      accessToken: link.token,
      body: { contentLength: 64, contentMD5: b64(randomBytes(16)) },
    });
    expect(refused.status).toBe(426);
  });
});

describe('purge + sweep against pinned pools', () => {
  it('permanent delete removes bytes from the PINNED pool and decrements its usage', async () => {
    await makePool('gc');
    const alice = await signupAccount(world, 'gc@b.c');
    await setUserPool(world.deps, alice.email, 'gc');
    const album = await createAlbum(world, alice);
    const up = await upload(alice, album);

    // move the user away first — the purge must still hit the PIN, not the current pool
    await setUserPool(world.deps, alice.email, null);

    await world.request('POST', '/files/trash', {
      token: alice.token,
      body: { items: [{ fileID: up.fileId, collectionID: album }] },
    });
    const del = await world.request('POST', '/trash/delete', {
      token: alice.token,
      body: { fileIDs: [up.fileId] },
    });
    expect(del.status).toBe(200);

    expect(await sweepDeletedObjects(world.deps)).toBe(2);
    expect(await poolBucket('gc').head(up.fileObjectKey)).toBeNull();
    expect(await poolBucket('gc').head(up.thumbObjectKey)).toBeNull();
    const usage = await getPoolUsage(world.deps, 'gc');
    expect(usage.bytes).toBe(0);
    expect(usage.fileCount).toBe(0);
  });

  it('a pool that cannot be resolved quarantines ITS rows only; others sweep, rows stay for retry', async () => {
    await world.deps.blobs.put('1/default-obj', Buffer.from('x'));
    await enqueueObjectDeletion(world.deps, [
      { objectKey: '1/ghost-obj', poolId: 'ghost' }, // no POOL#ghost row -> unresolvable
      { objectKey: '1/default-obj' },
      { objectKey: '1/ghost-obj-2', poolId: 'ghost' },
    ]);

    const swept = await sweepDeletedObjects(world.deps);
    expect(swept).toBe(1); // only the default-bucket row
    expect(await world.deps.blobs.head('1/default-obj')).toBeNull();

    // the ghost rows are INTACT for the next run (never dropped, never crashed)
    const remaining = world.deps.db.dump().filter((r) => r.pk === 'PURGEQ');
    expect(remaining).toHaveLength(2);
    expect(remaining.every((r) => r.poolId === 'ghost')).toBe(true);
  });

  it('account deletion enqueues pinned deletes and returns the bytes to the pool counter', async () => {
    await makePool('bye');
    const alice = await signupAccount(world, 'bye@b.c');
    await setUserPool(world.deps, alice.email, 'bye');
    const album = await createAlbum(world, alice);
    const up = await upload(alice, album);
    expect((await getPoolUsage(world.deps, 'bye')).bytes).toBeGreaterThan(0);

    const { reapUserData } = await import('../../src/domain/accountReaper.ts');
    await reapUserData(world.deps, alice.userId);
    expect(await sweepDeletedObjects(world.deps)).toBe(2);
    expect(await poolBucket('bye').head(up.fileObjectKey)).toBeNull();
    expect((await getPoolUsage(world.deps, 'bye')).bytes).toBe(0);
  });
});

describe('privacy: the pool is invisible to authorization (the user requirement)', () => {
  it('same pool, no share: B cannot reach A\'s file through ANY path; a normal share opens it', async () => {
    await makePool('house');
    const alice = await signupAccount(world, 'pa@b.c');
    const bob = await signupAccount(world, 'pb@b.c');
    await setUserPool(world.deps, alice.email, 'house');
    await setUserPool(world.deps, bob.email, 'house');
    const album = await createAlbum(world, alice, 'private');
    const up = await upload(alice, album);

    // downloads + previews: 404 (membership never disclosed as 403)
    for (const path of [
      `/files/download/${up.fileId}`,
      `/files/download/v2/${up.fileId}`,
      `/files/preview/${up.fileId}`,
      `/files/preview/v2/${up.fileId}`,
    ]) {
      const res = await world.request('GET', path, { token: bob.token });
      expect(res.status, path).toBe(404);
    }
    // file info: strict ownership 403 on a foreign id (museum semantics)
    const info = await world.request('POST', '/files/info', {
      token: bob.token,
      body: { fileIDs: [up.fileId] },
    });
    expect(info.status).toBe(403);
    // collection diff of a foreign album: denied (403, D49)
    const diff = await world.request(
      'GET',
      `/collections/v2/diff?collectionID=${album}&sinceTime=0`,
      { token: bob.token },
    );
    expect(diff.status).toBe(403);

    // an EXPLICIT share is the only thing that opens access
    const share = await world.request('POST', '/collections/share', {
      token: alice.token,
      body: { collectionID: album, email: bob.email, encryptedKey: b64(randomBytes(80)), role: 'VIEWER' },
    });
    expect(share.status).toBe(200);
    expect((await world.request('GET', `/files/download/v2/${up.fileId}`, { token: bob.token })).status).toBe(200);
  });

  it('by construction: the authz resolvers never mention pools', () => {
    const src = (rel: string) => readFileSync(join(import.meta.dirname, '../../src', rel), 'utf8');
    // Extract exactly the two access resolvers and assert no pool vocabulary
    // ever creeps into them — the grep-level lock on "pools are storage only".
    const between = (text: string, from: string) => {
      const at = text.indexOf(from);
      expect(at, `missing ${from}`).toBeGreaterThan(-1);
      const rest = text.slice(at);
      const end = rest.indexOf('\nexport const', 1);
      return end === -1 ? rest : rest.slice(0, end);
    };
    const accessibleFile = between(src('domain/files.ts'), 'export const getAccessibleFile');
    const collectionAccess = between(src('domain/collections.ts'), 'export const resolveCollectionAccess');
    for (const [name, body] of [
      ['getAccessibleFile', accessibleFile],
      ['resolveCollectionAccess', collectionAccess],
    ] as const) {
      expect(body, `${name} consults pool state`).not.toMatch(/storagePool|poolId|POOL#/i);
    }
  });
});

describe('credentials at rest + role mode', () => {
  it('keys-mode secrets are secretbox-encrypted: no plaintext anywhere in a table dump', async () => {
    await makePool('sealed');
    const dump = JSON.stringify(world.deps.db.dump());
    expect(dump).not.toContain('very-secret-sealed-key');
    expect(dump).not.toContain('AKIASEALED');

    const row = (await getPool(world.deps, 'sealed'))!;
    expect(row.encryptedAccessKey).toBeDefined();
    expect(row.encryptedSecretKey).toBeDefined();
    // and the derived-key decryption round-trips
    expect(decryptPoolSecret(world.deps.hashingKey, row.encryptedSecretKey!)).toBe('very-secret-sealed-key');
    expect(decryptPoolSecret(world.deps.hashingKey, row.encryptedAccessKey!)).toBe('AKIASEALED');
  });

  it('role mode: AssumeRole carries the ExternalId, creds are cached, presigns clamp to the session', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const stubSts = {
      send: async (cmd: { input: Record<string, unknown> }) => {
        calls.push(cmd.input);
        return {
          Credentials: {
            AccessKeyId: 'ASIASTUB',
            SecretAccessKey: 'stub-secret',
            SessionToken: 'stub-token',
            Expiration: new Date(Date.now() + 3600 * 1000),
          },
        };
      },
    };
    const config = world.deps.config;
    const resolver = new S3BlobsResolver(config, new S3Blobs(config), stubSts as never);
    const blobs = await resolver.forPool({
      poolId: 'role-pool',
      mode: 'role',
      bucket: 'role-bucket',
      region: 'us-east-1',
      roleArn: 'arn:aws:iam::123456789012:role/ente-pool',
      externalId: 'the-external-id',
    });

    // presign is local SigV4 (no network); a 7-day request must clamp to <= 1h
    const url = await blobs.presignPut('1/obj', 7 * 24 * 3600);
    const expires = Number(new URL(url).searchParams.get('X-Amz-Expires'));
    expect(expires).toBeLessThanOrEqual(3600);
    expect(expires).toBeGreaterThan(3000);
    expect(url).toContain('role-bucket');

    await blobs.presignGet('1/obj', 3600);
    expect(calls).toHaveLength(1); // second presign rode the cached session
    expect(calls[0]!.ExternalId).toBe('the-external-id');
    expect(calls[0]!.RoleArn).toBe('arn:aws:iam::123456789012:role/ente-pool');
  });
});

describe('pool-create CLI secret passing (H3): POOL_ACCESS_KEY/POOL_SECRET_KEY env form', () => {
  // Spawn the real CLI with a minimal environment; both cases exit before any
  // AWS call (the LocalStack-backed happy path lives in pools.int.test.ts).
  const runCli = (cliArgs: string[], env: Record<string, string>) => {
    try {
      const stdout = execFileSync(
        'node',
        ['--experimental-transform-types', 'tools/storagePool.ts', ...cliArgs],
        { encoding: 'utf8', env: { PATH: process.env.PATH!, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number | null; stdout?: unknown; stderr?: unknown };
      return { status: e.status ?? -1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
    }
  };
  const createArgs = ['create', 'envpool', '--bucket', 'env-bucket', '--region', 'us-east-1', '--skip-validation'];

  it('env vars alone select keys mode — no --access-key/--secret-key flags needed', () => {
    // Without HASHING_KEY the CLI must stop at the keys-mode encryption gate,
    // which proves the env credentials were picked up (no creds = usage exit).
    const res = runCli(createArgs, { POOL_ACCESS_KEY: 'AKIAENVFORM', POOL_SECRET_KEY: 'env-secret-value' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('create (keys mode) needs HASHING_KEY');
    // and the secret never echoes, whatever the exit path
    expect(res.stdout + res.stderr).not.toContain('env-secret-value');
  });

  it('no flags and no env vars is still a usage error, not an accidental mode', () => {
    const res = runCli(createArgs, {});
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('usage:');
  });
});
