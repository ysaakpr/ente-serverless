/**
 * BYO storage pools on LocalStack (Phase H2, D55) — the real adapters end to
 * end: onboard a second bucket as a keys-mode pool (LocalStack supports the
 * STS API but has no real assumable identities, so the AssumeRole path is
 * covered at unit level with a stubbed STS client; here mode 'keys' exercises
 * the same S3 client construction against a real endpoint), then a pool
 * user's upload round-trips through REAL presigned HTTP into the pool bucket
 * under their own <userID>/ prefix while a default-bucket user is unaffected.
 * Also runs the tools/storagePool.ts onboarding CLI (validation checklist
 * included) against LocalStack.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import sodium from '../../src/lib/sodium.ts';
import { makeIntWorld, LOCALSTACK, type IntWorld } from '../helpers/intWorld.ts';
import { makeClientKeys } from '../helpers/client.ts';
import { getPool, getPoolUsage, putPool, setUserPool } from '../../src/domain/storagePools.ts';
import { getFile } from '../../src/domain/files.ts';
import { b64 } from '../../src/lib/b64.ts';

const POOL_BUCKET = 'ente-pool-int';

let world: IntWorld;
let s3: S3Client;

beforeAll(async () => {
  await sodium.ready;
  world = await makeIntWorld();
  s3 = new S3Client({
    endpoint: LOCALSTACK,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    forcePathStyle: true,
  });
  await s3.send(new CreateBucketCommand({ Bucket: POOL_BUCKET })).catch((err) => {
    const name = (err as { name?: string }).name ?? '';
    if (!name.includes('BucketAlready')) throw err;
  });
});

const uniqueEmail = () => `pool-${randomUUID().slice(0, 8)}@example.org`;

/** Minimal signup: OTT + verify (hardcoded 123456 for @example.org). */
const signup = async (email: string): Promise<{ id: number; token: string; email: string }> => {
  const ott = await world.request('POST', '/users/ott', { body: { email, purpose: 'signup' } });
  expect(ott.status).toBe(200);
  const verify = await world.request('POST', '/users/verify-email', {
    body: { email, ott: '123456' },
  });
  expect(verify.status).toBe(200);
  const { id, token } = (await verify.json()) as { id: number; token: string };
  // collection create requires keyAttributes (museum parity)
  const attrs = await world.request('PUT', '/users/attributes', {
    token,
    body: { keyAttributes: makeClientKeys().keyAttributes },
  });
  expect(attrs.status).toBe(200);
  return { id, token, email };
};

const createAlbum = async (token: string): Promise<number> => {
  const col = await world.request('POST', '/collections', {
    token,
    body: {
      encryptedKey: b64(randomBytes(48)),
      keyDecryptionNonce: b64(randomBytes(24)),
      type: 'album',
    },
  });
  expect(col.status).toBe(200);
  return ((await col.json()) as { collection: { id: number } }).collection.id;
};

const listKeys = async (bucket: string, prefix: string): Promise<string[]> => {
  const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  return (res.Contents ?? []).map((o) => o.Key!);
};

describe('pool round-trip on LocalStack', () => {
  it('pool user uploads into the pool bucket via REAL presigned HTTP; default user unaffected', async () => {
    await putPool(world.deps, {
      poolId: 'int-house',
      mode: 'keys',
      bucket: POOL_BUCKET,
      region: 'us-east-1',
      endpoint: LOCALSTACK,
      accessKey: 'test',
      secretKey: 'test',
    });

    const poolUser = await signup(uniqueEmail());
    const plainUser = await signup(uniqueEmail());
    await setUserPool(world.deps, poolUser.email, 'int-house');
    // the shared table survives across runs — assert usage as a DELTA
    const usageBefore = (await getPoolUsage(world.deps, 'int-house')).bytes;

    // --- pool user: mint -> PUT -> commit -> download, all real HTTP ---
    const cipher = randomBytes(64 * 1024);
    const thumb = randomBytes(2 * 1024);
    const urlsRes = await world.request('GET', '/files/upload-urls?count=2', { token: poolUser.token });
    expect(urlsRes.status).toBe(200);
    const { urls } = (await urlsRes.json()) as { urls: Array<{ objectKey: string; url: string }> };
    // presigned into the POOL bucket (path-style on LocalStack)
    expect(urls[0]!.url).toContain(`/${POOL_BUCKET}/`);
    expect(urls[0]!.objectKey.startsWith(`${poolUser.id}/`)).toBe(true);
    expect((await fetch(urls[0]!.url, { method: 'PUT', body: cipher })).status).toBe(200);
    expect((await fetch(urls[1]!.url, { method: 'PUT', body: thumb })).status).toBe(200);

    const album = await createAlbum(poolUser.token);
    const commit = await world.request('POST', '/files', {
      token: poolUser.token,
      body: {
        id: 0,
        collectionID: album,
        encryptedKey: b64(randomBytes(48)),
        keyDecryptionNonce: b64(randomBytes(24)),
        file: { objectKey: urls[0]!.objectKey, decryptionHeader: b64(randomBytes(24)) },
        thumbnail: { objectKey: urls[1]!.objectKey, decryptionHeader: b64(randomBytes(24)) },
        metadata: { encryptedData: b64(randomBytes(64)), decryptionHeader: b64(randomBytes(24)) },
      },
    });
    expect(commit.status).toBe(200);
    const { id: fileId } = (await commit.json()) as { id: number };

    // bytes are IN the pool bucket under the user's prefix, and pinned
    expect(await listKeys(POOL_BUCKET, urls[0]!.objectKey)).toHaveLength(1);
    expect(await listKeys(world.deps.config.bucketName, urls[0]!.objectKey)).toHaveLength(0);
    expect((await getFile(world.deps, fileId))!.storagePoolId).toBe('int-house');
    expect((await getPoolUsage(world.deps, 'int-house')).bytes - usageBefore).toBe(cipher.length + thumb.length);

    // download round-trips byte-identical through the pool bucket presign
    const dl = await world.request('GET', `/files/download/v2/${fileId}`, { token: poolUser.token });
    expect(dl.status).toBe(200);
    const { url } = (await dl.json()) as { url: string };
    expect(url).toContain(`/${POOL_BUCKET}/`);
    const served = Buffer.from(await (await fetch(url)).arrayBuffer());
    expect(served).toEqual(Buffer.from(cipher));

    // --- default user: everything still lands in the central bucket ---
    const plainUrls = await world.request('GET', '/files/upload-urls?count=1', { token: plainUser.token });
    const { urls: pUrls } = (await plainUrls.json()) as { urls: Array<{ objectKey: string; url: string }> };
    expect(pUrls[0]!.url).toContain(`/${world.deps.config.bucketName}/`);
    expect((await fetch(pUrls[0]!.url, { method: 'PUT', body: randomBytes(1024) })).status).toBe(200);
    expect(await listKeys(world.deps.config.bucketName, pUrls[0]!.objectKey)).toHaveLength(1);
  });

  it('the onboarding CLI validates against the real bucket and writes the encrypted row', async () => {
    const out = execFileSync(
      'node',
      [
        '--experimental-transform-types',
        'tools/storagePool.ts',
        'create',
        'int-cli',
        '--bucket', POOL_BUCKET,
        '--region', 'us-east-1',
        '--endpoint', LOCALSTACK,
        '--access-key', 'test',
        '--secret-key', 'cli-secret-value',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          AWS_ENDPOINT_URL: LOCALSTACK,
          TABLE_NAME: world.deps.config.tableName,
          AWS_REGION: 'us-east-1',
          AWS_ACCESS_KEY_ID: 'test',
          AWS_SECRET_ACCESS_KEY: 'test',
          HASHING_KEY: Buffer.from(world.deps.hashingKey).toString('base64'),
        },
      },
    );
    // the hard checks all passed against the real bucket
    expect(out).toContain('[ ok ] credentials');
    expect(out).toContain('[ ok ] HeadBucket');
    expect(out).toContain('[ ok ] PUT+GET round-trip');
    expect(out).toContain('[ ok ] PutObjectTagging');
    expect(out).toContain('[ ok ] multipart create+abort');
    expect(out).toContain("pool 'int-cli' onboarded");
    // the secret never echoes and never lands plaintext
    expect(out).not.toContain('cli-secret-value');
    const row = (await getPool(world.deps, 'int-cli'))!;
    expect(row.encryptedSecretKey).toBeDefined();
    expect(JSON.stringify(row)).not.toContain('cli-secret-value');

    // the CLI refuses a role-mode onboarding without the ExternalId guard
    let failed = '';
    try {
      execFileSync(
        'node',
        [
          '--experimental-transform-types', 'tools/storagePool.ts',
          'create', 'int-bad', '--bucket', POOL_BUCKET, '--region', 'us-east-1',
          '--role-arn', 'arn:aws:iam::123456789012:role/x',
        ],
        { encoding: 'utf8', env: { ...process.env, AWS_ENDPOINT_URL: LOCALSTACK, TABLE_NAME: world.deps.config.tableName } },
      );
    } catch (err) {
      failed = String((err as { stderr?: string }).stderr ?? err);
    }
    expect(failed).toContain('external-id');
    expect(await getPool(world.deps, 'int-bad')).toBeNull();
  });
});
