/** All environment knobs in one place. Nothing else reads process.env. */

export interface Config {
  tableName: string;
  bucketName: string;
  region: string;
  /** LocalStack endpoint; unset = real AWS. */
  awsEndpoint?: string;
  /** Announced in /ping. */
  instanceId: string;
  mailFrom: string;
  mailFromName: string;
  /** Emails ending in this suffix get the hardcoded OTT (local dev, like museum quickstart). */
  hardcodedOttSuffix?: string;
  hardcodedOttValue?: string;
  /** Presigned URL validity (museum PreSignedRequestValidityDuration = 7 days). */
  presignExpirySeconds: number;
  /** Plan storage for the self-host free plan, bytes (museum self-host default). */
  freePlanStorageBytes: number;
  maxFileSizeBytes: number;
  port: number;
  /** Per-request access log (make lan / make dev — the M5 gate needs it). */
  logRequests: boolean;
}

export const configFromEnv = (): Config => ({
  tableName: process.env.TABLE_NAME ?? 'ente-serverless',
  bucketName: process.env.BUCKET_NAME ?? 'ente-objects',
  region: process.env.AWS_REGION ?? 'us-east-1',
  awsEndpoint: process.env.AWS_ENDPOINT_URL,
  instanceId: process.env.INSTANCE_ID ?? 'ente-serverless-dev',
  mailFrom: process.env.MAIL_FROM ?? 'verify@ente.local',
  mailFromName: process.env.MAIL_FROM_NAME ?? 'Ente',
  hardcodedOttSuffix: process.env.HARDCODED_OTT_SUFFIX,
  hardcodedOttValue: process.env.HARDCODED_OTT_VALUE,
  presignExpirySeconds: Number(process.env.PRESIGN_EXPIRY_SECONDS ?? 7 * 24 * 3600),
  // 10 TiB by default (decision D11, revised 2026-08-17): it's the user's own
  // bucket and bill, but a real ceiling beats "unlimited" as a backstop
  // against a runaway client. Raise it with FREE_PLAN_STORAGE_BYTES.
  freePlanStorageBytes: Number(process.env.FREE_PLAN_STORAGE_BYTES ?? 10 * 1024 ** 4),
  maxFileSizeBytes: Number(process.env.MAX_FILE_SIZE_BYTES ?? 10 * 1024 * 1024 * 1024),
  port: Number(process.env.PORT ?? 8080),
  logRequests: process.env.LOG_REQUESTS === '1',
});
