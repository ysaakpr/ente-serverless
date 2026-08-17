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
  presignPut(key: string, expiresInSeconds: number): Promise<string>;
  presignGet(key: string, expiresInSeconds: number): Promise<string>;
  createMultipart(key: string, partCount: number, expiresInSeconds: number): Promise<MultipartUrls>;
  /**
   * Object tags drive the storage-class lifecycle: museum's key layout puts
   * originals AND thumbnails under the same `userID/uuid` prefix, so the
   * GLACIER_IR rule filters on `tier=original`, applied at commit time.
   */
  setTags(key: string, tags: Record<string, string>): Promise<void>;
}
