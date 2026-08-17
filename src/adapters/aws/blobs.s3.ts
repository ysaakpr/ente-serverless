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

  async presignPut(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      getS3Client(this.config),
      new PutObjectCommand({ Bucket: this.bucket, Key: key }),
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

  async createMultipart(key: string, partCount: number, expiresInSeconds: number): Promise<MultipartUrls> {
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
