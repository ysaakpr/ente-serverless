/** S3 implementation of the Blobs port (LocalStack + real AWS). */

import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  PutObjectTaggingCommand,
  UploadPartCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Blobs, BlobHead, MultipartUrls } from '../../ports/blobs.ts';
import type { Config } from '../../config.ts';
import { getS3Client } from './clients.ts';

/**
 * Pool overrides (H2, D55): the default instance keeps the singleton client
 * and central bucket; blobs.pool.ts builds instances bound to a pool's bucket
 * with per-pool credentials. `client` is a getter because role-mode pools
 * rebuild the client whenever the STS session is refreshed.
 */
export interface S3BlobsOptions {
  bucket?: string;
  client?: () => Promise<S3Client>;
  /**
   * Upper bound on presign validity, seconds. Role-mode pools clamp every
   * presign to the REMAINING AssumeRole session lifetime: a SigV4 URL signed
   * with temporary credentials dies when the session does, whatever its
   * X-Amz-Expires says — so an unclamped 24h PUT URL would silently expire
   * within the hour. Clamping keeps the URL honest (D55).
   */
  maxPresignExpirySeconds?: () => number;
}

export class S3Blobs implements Blobs {
  constructor(private config: Config, private opts: S3BlobsOptions = {}) {}

  private get bucket() {
    return this.opts.bucket ?? this.config.bucketName;
  }

  private async client(): Promise<S3Client> {
    return this.opts.client ? this.opts.client() : getS3Client(this.config);
  }

  private clampExpiry(expiresInSeconds: number): number {
    const max = this.opts.maxPresignExpirySeconds?.();
    return max === undefined ? expiresInSeconds : Math.min(expiresInSeconds, max);
  }

  async put(key: string, body: Buffer | Uint8Array): Promise<void> {
    await (await this.client()).send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await (await this.client()).send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return Buffer.from(await res.Body!.transformToByteArray());
  }

  async head(key: string): Promise<BlobHead | null> {
    try {
      const res = await (await this.client()).send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { contentLength: res.ContentLength ?? 0, etag: res.ETag ?? '' };
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NotFound' || name === 'NoSuchKey' || name === '404') return null;
      throw err;
    }
  }

  async setTags(key: string, tags: Record<string, string>): Promise<void> {
    await (await this.client()).send(
      new PutObjectTaggingCommand({
        Bucket: this.bucket,
        Key: key,
        Tagging: { TagSet: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) },
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await (await this.client()).send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  /**
   * Passing ContentMD5 is all that is needed to land `content-md5` in
   * X-Amz-SignedHeaders — the presigner signs the header because it is present
   * and cannot be hoisted to the query string. Real S3 rejects a PUT whose
   * Content-MD5 is NOT signed, so this argument is load-bearing, not a nicety
   * (D37). Verified: `signableHeaders: ['content-md5']` adds nothing here and is
   * deliberately not used — with no such header set it signs nothing at all.
   * Undefined leaves the header off, so MD5-less callers stay signed host-only.
   */
  async presignPut(key: string, expiresInSeconds: number, contentMd5?: string): Promise<string> {
    return getSignedUrl(
      await this.client(),
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentMD5: contentMd5 }),
      { expiresIn: this.clampExpiry(expiresInSeconds) },
    );
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      await this.client(),
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: this.clampExpiry(expiresInSeconds) },
    );
  }

  async createMultipart(
    key: string,
    partCount: number,
    expiresInSeconds: number,
    partMd5s?: readonly string[],
  ): Promise<MultipartUrls> {
    const client = await this.client();
    const expiresIn = this.clampExpiry(expiresInSeconds);
    const created = await client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key }),
    );
    const uploadID = created.UploadId!;
    const partUrls = await Promise.all(
      Array.from({ length: partCount }, (_, i) =>
        getSignedUrl(
          client,
          new UploadPartCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadID,
            PartNumber: i + 1,
            // Per-part MD5 — the app sends one per part, so each must be signed.
            ContentMD5: partMd5s?.[i],
          }),
          { expiresIn },
        ),
      ),
    );
    // Museum presigns the CompleteMultipartUpload POST; the SDK can presign it
    // as a plain POST of the parts XML to the upload URL.
    const completeUrl = await getSignedUrl(
      client,
      new (await import('@aws-sdk/client-s3')).CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadID,
      }),
      { expiresIn },
    );
    return { objectKey: key, uploadID, partUrls, completeUrl };
  }

  async abortMultipart(key: string, uploadID: string): Promise<void> {
    const client = await this.client();
    try {
      await client.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadID }),
      );
    } catch (err) {
      // Completed or already-aborted upload — nothing left to abort (D65).
      if ((err as { name?: string }).name === 'NoSuchUpload') return;
      throw err;
    }
  }
}
