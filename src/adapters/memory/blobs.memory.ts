/**
 * In-memory Blobs — unit tests. Presigned URLs are `memory://` tokens; the
 * synthetic client "uploads" through uploadViaUrl, which mirrors what a real
 * PUT to a presigned S3 URL does (bytes land at the signed key, no auth).
 */

import type { Blobs, BlobHead, MultipartUrls } from '../../ports/blobs.ts';

export class MemoryBlobs implements Blobs {
  private objects = new Map<string, Buffer>();
  private multiparts = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  tags = new Map<string, Record<string, string>>();

  async setTags(key: string, tags: Record<string, string>): Promise<void> {
    if (!this.objects.has(key)) throw new Error(`NoSuchKey: ${key}`);
    this.tags.set(key, { ...tags });
  }

  async put(key: string, body: Buffer | Uint8Array): Promise<void> {
    this.objects.set(key, Buffer.from(body));
  }

  async get(key: string): Promise<Buffer> {
    const found = this.objects.get(key);
    if (!found) throw new Error(`NoSuchKey: ${key}`);
    return Buffer.from(found);
  }

  async head(key: string): Promise<BlobHead | null> {
    const found = this.objects.get(key);
    if (!found) return null;
    return { contentLength: found.length, etag: `"mem-${found.length}"` };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async presignPut(key: string, expiresInSeconds: number): Promise<string> {
    return `memory://put/${encodeURIComponent(key)}?expires=${expiresInSeconds}`;
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return `memory://get/${encodeURIComponent(key)}?expires=${expiresInSeconds}`;
  }

  async createMultipart(key: string, partCount: number, expiresInSeconds: number): Promise<MultipartUrls> {
    const uploadID = `mpu-${this.multiparts.size + 1}`;
    this.multiparts.set(uploadID, { key, parts: new Map() });
    const partUrls = Array.from(
      { length: partCount },
      (_, i) => `memory://part/${uploadID}/${i + 1}/${encodeURIComponent(key)}?expires=${expiresInSeconds}`,
    );
    return { objectKey: key, uploadID, partUrls, completeUrl: `memory://complete/${uploadID}` };
  }

  // ---- test-side "S3" the synthetic client talks to ----

  /** Simulate the client PUTting bytes to a presigned URL. */
  async uploadViaUrl(url: string, body: Buffer | Uint8Array): Promise<void> {
    const put = url.match(/^memory:\/\/put\/([^?]+)/);
    if (put) {
      this.objects.set(decodeURIComponent(put[1]!), Buffer.from(body));
      return;
    }
    const part = url.match(/^memory:\/\/part\/([^/]+)\/(\d+)\//);
    if (part) {
      const mpu = this.multiparts.get(part[1]!);
      if (!mpu) throw new Error('no such multipart upload');
      mpu.parts.set(Number(part[2]), Buffer.from(body));
      return;
    }
    throw new Error(`not a memory presigned PUT url: ${url}`);
  }

  /** Simulate the client GETting a presigned URL. */
  async downloadViaUrl(url: string): Promise<Buffer> {
    const get = url.match(/^memory:\/\/get\/([^?]+)/);
    if (!get) throw new Error(`not a memory presigned GET url: ${url}`);
    return this.get(decodeURIComponent(get[1]!));
  }

  /** Simulate the multipart complete call. */
  async completeViaUrl(url: string): Promise<void> {
    const m = url.match(/^memory:\/\/complete\/(.+)$/);
    if (!m) throw new Error(`not a memory complete url: ${url}`);
    const mpu = this.multiparts.get(m[1]!);
    if (!mpu) throw new Error('no such multipart upload');
    const ordered = [...mpu.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, buf]) => buf);
    this.objects.set(mpu.key, Buffer.concat(ordered));
    this.multiparts.delete(m[1]!);
  }
}
