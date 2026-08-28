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
  /**
   * Presigned URL validity, split by verb (security review 2026-08-17,
   * finding 5). Museum's single PreSignedRequestValidityDuration is 7 days for
   * both. GET keeps that default until an M5 device gate proves the client
   * re-fetches rather than caches URLs (D26/D32 both punished exactly this
   * kind of assumption); shorten it with PRESIGN_GET_EXPIRY_SECONDS once
   * proven. PUT — a week-long write grant to a key — defaults to 24 hours,
   * which keeps big uploads on slow links viable while cutting the window 7×.
   * PRESIGN_EXPIRY_SECONDS still overrides both, so nothing breaks mid-deploy.
   */
  presignGetExpirySeconds: number;
  presignPutExpirySeconds: number;
  /** Plan storage for the self-host free plan, bytes (museum self-host default). */
  freePlanStorageBytes: number;
  maxFileSizeBytes: number;
  port: number;
  /** Per-request access log (make lan / make dev — the M5 gate needs it). */
  logRequests: boolean;
  /**
   * Origin lock (security review 2026-08-17, finding 4). When set, every
   * request must carry this value in `x-origin-secret` or be refused 403 —
   * CloudFront injects the header at the origin, so the direct Function URL
   * stops being a bypass of every edge control (WAF, response headers).
   * Unset (make dev / make lan, neither of which goes through CloudFront)
   * the check is off entirely.
   */
  originSecret?: string;
  /**
   * Idle lifetime for a session token, seconds. 0 = never expires, which is
   * museum's behaviour and therefore the default: its `tokens` table has no
   * expiry column at all (oracle schema, D40), so switching this on is a
   * deliberate divergence that WILL log real devices out once they idle past it.
   */
  sessionIdleExpirySeconds: number;
  /**
   * Public-albums web app origin — museum `apps.public-albums`
   * (cmd/museum/main.go viper.SetDefault), used to compose share links as
   * `<albumsUrl>/?t=<token>` (pkg/repo/public/collection_link.go GetAlbumUrl).
   * Self-hosters point this at wherever their albums build is served.
   */
  albumsUrl: string;
  /**
   * Presign validity for /public-collection/* GETs, seconds. Deliberately much
   * shorter than the authed presignGetExpirySeconds: a public presigned URL is
   * a bearer credential held by an anonymous party, and a short tail is the
   * only revocation margin the protocol allows (plan §4.2/§4.3, D51).
   */
  presignPublicGetExpirySeconds: number;
  /**
   * Per-link daily ceilings (plan §4.1d, D51) — hand-rolled counter rows in
   * the OTT-cap style, 429 once exceeded, 0 disables the ceiling. Museum has
   * no equivalent (it rate-limits per IP at the edge); on a pay-per-request
   * stack a leaked link must not be an unbounded bill.
   */
  publicLinkDailyDownloadLimit: number;
  publicLinkDailyUploadLimit: number;
  /** Daily NEW-device admissions per link (security review P2-1, D53): /info
   * is password-whitelisted and admission fires there, so without a ceiling a
   * token holder cycling User-Agents mints unbounded rows. Same 429 family. */
  publicLinkDailyDeviceLimit: number;
  /**
   * Invite-gated signup (D54). 'open' (default) is today's behaviour — anyone
   * who reaches the server can sign up. 'invite' rejects a signup OTT for any
   * email without an unconsumed INVITE# row (provisioned via `make invite`,
   * tools/invite.ts). Server/CLI-side only — no client-visible surface; login
   * and change-email are NEVER gated, so flipping this on an existing
   * deployment affects nobody already signed up.
   */
  signupMode: 'open' | 'invite';
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
  presignGetExpirySeconds: Number(
    process.env.PRESIGN_GET_EXPIRY_SECONDS ?? process.env.PRESIGN_EXPIRY_SECONDS ?? 7 * 24 * 3600,
  ),
  presignPutExpirySeconds: Number(
    process.env.PRESIGN_PUT_EXPIRY_SECONDS ?? process.env.PRESIGN_EXPIRY_SECONDS ?? 24 * 3600,
  ),
  // 1 GiB by default (D11, revised 2026-08-28): a deliberately SMALL floor, so
  // an open/uninvited signup gets only a minimal allowance on the shared
  // central bucket. Real storage is granted per-user by invite — `make invite
  // --storage-gb N` writes storageLimitBytes, which overrides this floor
  // (userStorageBytes = storageLimitBytes ?? freePlanStorageBytes). Change the
  // global floor with FREE_PLAN_STORAGE_BYTES; increase a person with an invite.
  freePlanStorageBytes: Number(process.env.FREE_PLAN_STORAGE_BYTES ?? 1024 ** 3),
  maxFileSizeBytes: Number(process.env.MAX_FILE_SIZE_BYTES ?? 10 * 1024 * 1024 * 1024),
  port: Number(process.env.PORT ?? 8080),
  logRequests: process.env.LOG_REQUESTS === '1',
  originSecret: process.env.ORIGIN_SECRET || undefined,
  sessionIdleExpirySeconds: Number(process.env.SESSION_IDLE_EXPIRY_SECONDS ?? 0),
  // museum default (cmd/museum/main.go): https://albums.ente.com
  albumsUrl: process.env.ALBUMS_URL ?? 'https://albums.ente.com',
  presignPublicGetExpirySeconds: Number(process.env.PRESIGN_PUBLIC_GET_EXPIRY_SECONDS ?? 3600),
  publicLinkDailyDownloadLimit: Number(process.env.PUBLIC_LINK_DAILY_DOWNLOADS ?? 10_000),
  publicLinkDailyUploadLimit: Number(process.env.PUBLIC_LINK_DAILY_UPLOADS ?? 1_000),
  publicLinkDailyDeviceLimit: Number(process.env.PUBLIC_LINK_DAILY_DEVICES ?? 1_000),
  signupMode: process.env.SIGNUP_MODE === 'invite' ? 'invite' : 'open',
});
