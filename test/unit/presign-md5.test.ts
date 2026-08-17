/**
 * D37 — the guard that D26 needed and did not have.
 *
 * Real S3 refuses a PUT that carries a Content-MD5 the presigned signature does
 * not cover: `AccessDenied / HeadersNotSigned: content-md5`. Content-MD5 is an
 * integrity header, so S3 will not let an unsigned one through. Neither
 * LocalStack nor the memory adapter verifies signatures, so every local suite
 * passed while every real upload failed — the first cloud deploy backed up
 * ~2000 files' worth of 403s before this surfaced.
 *
 * These assertions need no AWS and no docker: SigV4 presigning is pure local
 * computation, so the signature can be inspected offline.
 */

import { describe, expect, it } from 'vitest';
import { S3Blobs } from '../../src/adapters/aws/blobs.s3.ts';
import { configFromEnv } from '../../src/config.ts';
import { makeWorld } from '../helpers/deps.ts';
import { signupAccount } from '../helpers/client.ts';

/** Endpoint set => the adapter uses dummy credentials, so signing works offline. */
const s3 = () =>
  new S3Blobs({
    ...configFromEnv(),
    awsEndpoint: 'http://127.0.0.1:4567',
    region: 'ap-south-1',
    bucketName: 'ente-sl-presign-test',
  });

const signedHeaders = (url: string): string[] =>
  (new URL(url).searchParams.get('X-Amz-SignedHeaders') ?? '').split(';').filter(Boolean);

const MD5 = 'rL0Y20zC+Fzt72VPzMSk2A==';

describe('presigned PUT signature covers Content-MD5 (D37)', () => {
  it('binds content-md5 into X-Amz-SignedHeaders when the client will send it', async () => {
    const url = await s3().presignPut('u/1/obj', 3600, MD5);
    expect(signedHeaders(url), url).toContain('content-md5');
  });

  it('leaves content-md5 out of the signature when no MD5 was supplied', async () => {
    // The v1 upload-urls route has no MD5 to bind; signing a header the client
    // will not send would break those PUTs in the opposite direction.
    const url = await s3().presignPut('u/1/obj', 3600);
    expect(signedHeaders(url)).not.toContain('content-md5');
  });

  it('always signs host, with or without an MD5', async () => {
    for (const url of [await s3().presignPut('k', 60, MD5), await s3().presignPut('k', 60)]) {
      expect(signedHeaders(url)).toContain('host');
    }
  });
});

/**
 * The bug was not in the adapter — it was the handler parsing the MD5s and then
 * dropping them on the floor. Guard the wiring separately from the signing.
 */
describe('the V2 upload handlers pass the client MD5s to the port (D37)', () => {
  it('POST /files/upload-url forwards contentMD5', async () => {
    const world = await makeWorld();
    const account = await signupAccount(world, 'md5@b.c');
    const res = await world.request('POST', '/files/upload-url', {
      token: account.token,
      body: { contentLength: 1024, contentMD5: MD5 },
    });
    expect(res.status).toBe(200);
    const { objectKey } = (await res.json()) as { objectKey: string };
    expect(world.deps.blobs.presignedMd5.get(objectKey)).toBe(MD5);
  });

  it('POST /files/multipart-upload-url forwards partMd5s in order', async () => {
    const world = await makeWorld();
    const account = await signupAccount(world, 'md5mp@b.c');
    const partMd5s = [MD5, 'ZajifYh5KDgxtmS9i38K1A==', 'CY9rzUYh03PK3k6DJie09g=='];
    const res = await world.request('POST', '/files/multipart-upload-url', {
      token: account.token,
      body: { contentLength: 15 * 1024 * 1024, partLength: 5 * 1024 * 1024, partMd5s },
    });
    expect(res.status).toBe(200);
    const { objectKey } = (await res.json()) as { objectKey: string };
    expect(world.deps.blobs.partMd5s.get(objectKey)).toEqual(partMd5s);
  });
});
