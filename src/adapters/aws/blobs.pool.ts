/**
 * Pool-aware Blobs resolver (H2, D55): yields an S3Blobs bound to one pool's
 * bucket with that pool's credentials. Clients are cached per pool —
 * mode 'keys' builds one static client; mode 'role' assumes the pool's role
 * with the MANDATORY ExternalId and caches the temporary credentials for
 * ~50 minutes (refreshed with a 10-minute margin), rebuilding the S3 client
 * on each refresh. Presigns from a role-mode pool are clamped to the
 * remaining session lifetime (see S3BlobsOptions.maxPresignExpirySeconds).
 *
 * Rotation caveat: the cache keys on the descriptor's non-secret shape, so a
 * re-onboarded pool (new creds/role/bucket) takes effect immediately; only a
 * SECRET-only rotation with an identical access key id would ride the old
 * client until the process recycles.
 */

import { S3Client } from '@aws-sdk/client-s3';
import { AssumeRoleCommand, type STSClient } from '@aws-sdk/client-sts';
import type { Blobs, BlobsResolver, PoolDescriptor } from '../../ports/blobs.ts';
import type { Config } from '../../config.ts';
import { S3Blobs } from './blobs.s3.ts';
import { getStsClient } from './clients.ts';

/** AssumeRole session length; 1h is every role's guaranteed-allowed maximum. */
const SESSION_SECONDS = 3600;
/** Refresh when less than this remains — creds are effectively cached ~50 min. */
const REFRESH_MARGIN_SECONDS = 600;
/** Presign clamp headroom below the hard session expiry. */
const PRESIGN_SAFETY_SECONDS = 30;

const poolClientBase = (pool: PoolDescriptor) => ({
  region: pool.region,
  ...(pool.endpoint ? { endpoint: pool.endpoint, forcePathStyle: true } : {}),
  // Same D23 rule as the central client: flexible checksums poison presigned
  // PUTs with an x-amz-checksum-crc32 the client's body can never match.
  requestChecksumCalculation: 'WHEN_REQUIRED' as const,
  responseChecksumValidation: 'WHEN_REQUIRED' as const,
});

export class S3BlobsResolver implements BlobsResolver {
  private cache = new Map<string, Blobs>();

  constructor(
    private config: Config,
    private defaultBlobs: Blobs,
    /** Injectable for unit tests — LocalStack has no real assumable identities. */
    private sts: Pick<STSClient, 'send'> | undefined = undefined,
  ) {}

  async forPool(pool: PoolDescriptor | null | undefined): Promise<Blobs> {
    if (!pool) return this.defaultBlobs;
    // Non-secret shape only — accessKey is the key ID, not the secret.
    const cacheKey = JSON.stringify([
      pool.poolId, pool.mode, pool.bucket, pool.region,
      pool.endpoint, pool.roleArn, pool.externalId, pool.accessKey,
    ]);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const blobs = pool.mode === 'keys' ? this.keysBlobs(pool) : this.roleBlobs(pool);
    this.cache.set(cacheKey, blobs);
    return blobs;
  }

  private keysBlobs(pool: PoolDescriptor): Blobs {
    const client = new S3Client({
      ...poolClientBase(pool),
      credentials: { accessKeyId: pool.accessKey!, secretAccessKey: pool.secretKey! },
    });
    return new S3Blobs(this.config, { bucket: pool.bucket, client: async () => client });
  }

  private roleBlobs(pool: PoolDescriptor): Blobs {
    let client: S3Client | undefined;
    let expiresAtMs = 0;
    /** In-flight refresh (D56): concurrent callers arriving after an idle
     * spell share ONE AssumeRole instead of thundering-herding STS — and each
     * of them then clamps against the session it actually signs with, since
     * expiresAtMs is stamped before the shared promise resolves. */
    let refreshing: Promise<S3Client> | undefined;

    const refresh = async (): Promise<S3Client> => {
      const res = await (this.sts ?? getStsClient(this.config)).send(
        new AssumeRoleCommand({
          RoleArn: pool.roleArn!,
          // ExternalId is MANDATORY (putPool enforces it): without it, anyone
          // who learns the role ARN could point their own deployment at it —
          // the classic confused deputy. D55.
          ExternalId: pool.externalId!,
          RoleSessionName: `ente-pool-${pool.poolId}`.slice(0, 64),
          DurationSeconds: SESSION_SECONDS,
        }),
      );
      const creds = res.Credentials!;
      expiresAtMs = creds.Expiration
        ? new Date(creds.Expiration).getTime()
        : Date.now() + SESSION_SECONDS * 1000;
      client = new S3Client({
        ...poolClientBase(pool),
        credentials: {
          accessKeyId: creds.AccessKeyId!,
          secretAccessKey: creds.SecretAccessKey!,
          sessionToken: creds.SessionToken,
        },
      });
      return client;
    };

    const getClient = async (): Promise<S3Client> => {
      if (client && expiresAtMs - Date.now() > REFRESH_MARGIN_SECONDS * 1000) return client;
      // A failed refresh clears the slot so the NEXT call retries rather than
      // pinning every future presign to one rejected promise.
      refreshing ??= refresh().finally(() => {
        refreshing = undefined;
      });
      return refreshing;
    };

    const maxPresignExpirySeconds = (): number =>
      Math.max(
        60,
        Math.floor((expiresAtMs - Date.now()) / 1000) - PRESIGN_SAFETY_SECONDS,
      );

    return new S3Blobs(this.config, {
      bucket: pool.bucket,
      client: getClient,
      maxPresignExpirySeconds,
    });
  }
}
