/**
 * In-memory Blobs — unit tests. Presigned URLs are `memory://` tokens; the
 * synthetic client "uploads" through uploadViaUrl, which mirrors what a real
 * PUT to a presigned S3 URL does (bytes land at the signed key, no auth).
 *
 * Pool namespaces (H2, D55): the ROOT instance owns per-pool child instances
 * (`forPool`), each an isolated bucket. URLs minted by a child carry
 * `&pool=<id>`, and the root's uploadViaUrl/downloadViaUrl/completeViaUrl
 * route on it — so test helpers keep talking to `world.deps.blobs` and
 * multi-pool tests can assert exactly which bucket the bytes landed in.
 */

import type { Blobs, BlobHead, BlobsResolver, MultipartUrls, PoolDescriptor } from '../../ports/blobs.ts';

export class MemoryBlobs implements Blobs {
  private objects = new Map<string, Buffer>();
  private multiparts = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  tags = new Map<string, Record<string, string>>();
  private children = new Map<string, MemoryBlobs>();

  constructor(private poolId?: string) {}

  /** The isolated namespace for one pool (created on first use). */
  forPool(poolId: string): MemoryBlobs {
    let child = this.children.get(poolId);
    if (!child) {
      child = new MemoryBlobs(poolId);
      this.children.set(poolId, child);
    }
    return child;
  }

  /** `&pool=<id>` marker on every URL a pool namespace mints. */
  private poolParam(): string {
    return this.poolId ? `&pool=${encodeURIComponent(this.poolId)}` : '';
  }

  /** Route a presigned URL to the namespace that minted it. */
  private route(url: string): MemoryBlobs {
    const m = url.match(/[?&]pool=([^&]+)/);
    if (!m) return this;
    const id = decodeURIComponent(m[1]!);
    if (this.poolId === id) return this;
    const child = this.children.get(id);
    if (!child) throw new Error(`no such pool namespace: ${id}`);
    return child;
  }

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

  /**
   * Recorded so tests can assert the MD5s a handler was given actually reach the
   * port. The real adapter binds them into the signature (D37) and a dropped
   * value is invisible locally — memory and LocalStack both ignore signatures,
   * so only real S3 would have complained.
   */
  presignedMd5 = new Map<string, string | undefined>();
  partMd5s = new Map<string, readonly string[] | undefined>();

  async presignPut(key: string, expiresInSeconds: number, contentMd5?: string): Promise<string> {
    this.presignedMd5.set(key, contentMd5);
    return `memory://put/${encodeURIComponent(key)}?expires=${expiresInSeconds}${this.poolParam()}`;
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return `memory://get/${encodeURIComponent(key)}?expires=${expiresInSeconds}${this.poolParam()}`;
  }

  async createMultipart(
    key: string,
    partCount: number,
    expiresInSeconds: number,
    partMd5s?: readonly string[],
  ): Promise<MultipartUrls> {
    this.partMd5s.set(key, partMd5s);
    const uploadID = `mpu-${this.multiparts.size + 1}`;
    this.multiparts.set(uploadID, { key, parts: new Map() });
    const partUrls = Array.from(
      { length: partCount },
      (_, i) =>
        `memory://part/${uploadID}/${i + 1}/${encodeURIComponent(key)}?expires=${expiresInSeconds}${this.poolParam()}`,
    );
    return {
      objectKey: key,
      uploadID,
      partUrls,
      completeUrl: `memory://complete/${uploadID}${
        this.poolId ? `?pool=${encodeURIComponent(this.poolId)}` : ''
      }`,
    };
  }

  async abortMultipart(_key: string, uploadID: string): Promise<void> {
    // Tolerates unknown uploads, like the S3 adapter's NoSuchUpload path.
    this.multiparts.delete(uploadID);
  }

  // ---- test-side "S3" the synthetic client talks to ----

  /** Simulate the client PUTting bytes to a presigned URL. */
  async uploadViaUrl(url: string, body: Buffer | Uint8Array): Promise<void> {
    const target = this.route(url);
    const put = url.match(/^memory:\/\/put\/([^?]+)/);
    if (put) {
      target.objects.set(decodeURIComponent(put[1]!), Buffer.from(body));
      return;
    }
    const part = url.match(/^memory:\/\/part\/([^/]+)\/(\d+)\//);
    if (part) {
      const mpu = target.multiparts.get(part[1]!);
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
    return this.route(url).get(decodeURIComponent(get[1]!));
  }

  /** Simulate the multipart complete call. */
  async completeViaUrl(url: string): Promise<void> {
    const m = url.match(/^memory:\/\/complete\/([^?]+)/);
    if (!m) throw new Error(`not a memory complete url: ${url}`);
    const target = this.route(url);
    const mpu = target.multiparts.get(m[1]!);
    if (!mpu) throw new Error('no such multipart upload');
    const ordered = [...mpu.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, buf]) => buf);
    target.objects.set(mpu.key, Buffer.concat(ordered));
    target.multiparts.delete(m[1]!);
  }
}

/** Memory resolver: pool descriptor -> the root instance's pool namespace. */
export class MemoryBlobsResolver implements BlobsResolver {
  constructor(private root: MemoryBlobs) {}

  async forPool(pool: PoolDescriptor | null | undefined): Promise<Blobs> {
    return pool ? this.root.forPool(pool.poolId) : this.root;
  }
}
