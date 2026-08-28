/**
 * Blobs port — one bucket (museum's object layout: `{userID}/{uuid}` for
 * file/thumbnail, `file-data` prefixes for derived data). Bytes never pass
 * through the API in ente; this port exists for presigning + HeadObject
 * verification, and for tests to plant/read objects.
 */

export interface BlobHead {
  contentLength: number;
  etag: string;
}

export interface MultipartUrls {
  objectKey: string;
  uploadID: string;
  partUrls: string[];
  completeUrl: string;
}

export interface Blobs {
  put(key: string, body: Buffer | Uint8Array): Promise<void>;
  get(key: string): Promise<Buffer>;
  head(key: string): Promise<BlobHead | null>;
  delete(key: string): Promise<void>;
  /**
   * `contentMd5` MUST be bound into the signature whenever the client will send
   * a Content-MD5 header. Real S3 rejects an unsigned Content-MD5 outright —
   * `AccessDenied: There were headers present in the request which were not
   * signed / HeadersNotSigned: content-md5` — because it is an integrity header.
   * LocalStack does not verify signatures at all, which is how the opposite
   * assumption survived in D26 until the first real upload (D37).
   */
  presignPut(key: string, expiresInSeconds: number, contentMd5?: string): Promise<string>;
  presignGet(key: string, expiresInSeconds: number): Promise<string>;
  /** `partMd5s[i]` is bound into part i+1's signature — same rule as above. */
  createMultipart(
    key: string,
    partCount: number,
    expiresInSeconds: number,
    partMd5s?: readonly string[],
  ): Promise<MultipartUrls>;
  /**
   * Abort one multipart upload (the stale-object sweep, D65 — museum
   * object_cleanup.go AbortMultipartUpload). MUST tolerate an upload that no
   * longer exists (completed or already aborted): resolve, never throw, for
   * S3's NoSuchUpload.
   */
  abortMultipart(key: string, uploadID: string): Promise<void>;
  /**
   * Object tags drive the storage-class lifecycle: museum's key layout puts
   * originals AND thumbnails under the same `userID/uuid` prefix, so the
   * GLACIER_IR rule filters on `tier=original`, applied at commit time.
   */
  setTags(key: string, tags: Record<string, string>): Promise<void>;
}

// --- BYO storage pools (Phase H2, D55) --------------------------------------

/**
 * Everything an adapter needs to talk to one pool's bucket. Built by the
 * domain layer from the POOL#<id>/META row — `accessKey`/`secretKey` arrive
 * here already DECRYPTED (they are secretbox-encrypted at rest, storagePools.ts)
 * and must never be logged or persisted by an adapter.
 */
export interface PoolDescriptor {
  poolId: string;
  /** 'role' = STS AssumeRole with ExternalId; 'keys' = static credentials. */
  mode: 'role' | 'keys';
  bucket: string;
  region: string;
  /** S3-compatible endpoint (Minio, R2, LocalStack); unset = real AWS S3. */
  endpoint?: string;
  roleArn?: string;
  externalId?: string;
  accessKey?: string;
  secretKey?: string;
}

/**
 * Yields the Blobs client for one pool. `null`/`undefined` is the DEFAULT
 * pool — the central bucket, exactly the pre-H2 singleton — so every call
 * site routes through this and unpooled users cost nothing extra.
 */
export interface BlobsResolver {
  forPool(pool: PoolDescriptor | null | undefined): Promise<Blobs>;
}
