/** S3 implementation of the Blobs port (LocalStack + real AWS). */

import {
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  PutObjectTaggingCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Blobs, BlobHead, MultipartUrls } from '../../ports/blobs.ts';
import type { Config } from '../../config.ts';
import { getS3Client } from './clients.ts';

export class S3Blobs implements Blobs {
  constructor(private config: Config) {}

  private get bucket() {
    return this.config.bucketName;
  }

  async put(key: string, body: Buffer | Uint8Array): Promise<void> {
    await getS3Client(this.config).send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await getS3Client(this.config).send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return Buffer.from(await res.Body!.transformToByteArray());
  }

  async head(key: string): Promise<BlobHead | null> {
    try {
      const res = await getS3Client(this.config).send(
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
    await getS3Client(this.config).send(
      new PutObjectTaggingCommand({
        Bucket: this.bucket,
        Key: key,
        Tagging: { TagSet: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) },
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await getS3Client(this.config).send(
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
      getS3Client(this.config),
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentMD5: contentMd5 }),
      { expiresIn: expiresInSeconds },
    );
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      getS3Client(this.config),
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  async createMultipart(
    key: string,
    partCount: number,
    expiresInSeconds: number,
    partMd5s?: readonly string[],
  ): Promise<MultipartUrls> {
    const client = getS3Client(this.config);
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
          { expiresIn: expiresInSeconds },
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
      { expiresIn: expiresInSeconds },
    );
    return { objectKey: key, uploadID, partUrls, completeUrl };
  }
}
