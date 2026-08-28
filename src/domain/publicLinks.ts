/**
 * Public-link serving logic — Phase D (PENDING-FEATURES-PLAN §2.D, D51).
 * Everything here is pinned against museum source fetched 2026-08-27:
 * pkg/controller/public/collection_link.go + link_common.go +
 * link_device_token.go, pkg/repo/public/collection_link.go,
 * pkg/middleware/collection_link.go, ente/public_collection.go,
 * ente/access.go. The middleware half lives in src/middleware/publicAccess.ts;
 * this file owns URL/JSON composition, token generation, the password JWT,
 * device admission, and the abuse-control counters (plan §4.1).
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import sodium from '../lib/sodium.ts';
import type { Deps } from '../deps.ts';
import { ConditionFailedError } from '../ports/db.ts';
import { keys } from './model.ts';
import { getLinkForCollection, type PublicLinkRow } from './sharing.ts';
import { getCollection, type CollectionRole, type CollectionRow } from './collections.ts';
import { getFile, type FileRow, type LinkRow } from './files.ts';
import { signJwtHS256, verifyJwtHS256, JwtError } from '../lib/jwt.ts';
import { errNotFound, errTooManyBadRequest, publicCollectDisabled } from '../lib/errors.ts';
import { MICROS_PER_HOUR, MICROS_PER_SECOND } from '../lib/time.ts';

// --- Token generation ------------------------------------------------------

/**
 * museum CreateLink: strings.ToUpper(shortuuid.New()[0:10]) — 10 chars whose
 * alphabet, after the uppercase fold of shortuuid's base57, is digits 2-9 plus
 * A-Z. This generates 10 uniform chars over the unambiguous 32-char subset
 * (2-9, A-Z minus I/L/O/U... museum's own base57 set uppercased), 5 bits each
 * = 50 bits — the same format and at least museum's effective entropy, from
 * crypto-grade rand (deps.rand.int).
 */
const TOKEN_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ACCESS_TOKEN_LENGTH = 10; // museum public.AccessTokenLength

export const generateAccessToken = (deps: Deps): string =>
  Array.from(
    { length: ACCESS_TOKEN_LENGTH },
    () => TOKEN_ALPHABET[deps.rand.int(TOKEN_ALPHABET.length)],
  ).join('');

// --- PublicURL JSON (museum ente.PublicURL) --------------------------------

/**
 * museum GetAlbumUrl (repo/public/collection_link.go): `<albums>/?t=<token>`.
 * The collection key never reaches the server — clients append it as a URL
 * fragment. Only the Photos app shape is composed (no Locker here).
 */
export const albumUrl = (deps: Deps, token: string): string =>
  `${deps.config.albumsUrl}/?t=${token}`;

/**
 * ente.PublicURL, field for field (ente/public_collection.go): url/deviceLimit/
 * validTill/enableDownload/enableCollect/enableComment/passwordEnabled/
 * enableJoin always emitted; nonce/memLimit/opsLimit ride only on passworded
 * links; minRole is omitempty. passwordEnabled follows the repo scans:
 * pw_nonce presence (GetCollectionToActivePublicURLMap and the owned-feed
 * join both key on the nonce column).
 */
export const publicUrlJson = (deps: Deps, link: PublicLinkRow): Record<string, unknown> => ({
  url: albumUrl(deps, link.token),
  deviceLimit: link.deviceLimit,
  validTill: link.validTill,
  enableDownload: link.enableDownload,
  enableCollect: link.enableCollect,
  enableComment: link.enableComment,
  passwordEnabled: link.nonce !== undefined && link.nonce !== '',
  ...(link.nonce !== undefined && link.nonce !== ''
    ? { nonce: link.nonce, memLimit: link.memLimit ?? 0, opsLimit: link.opsLimit ?? 0 }
    : {}),
  enableJoin: link.enableJoin,
  ...(link.minRole !== undefined ? { minRole: link.minRole } : {}),
});

/** The collection's publicURLs array for feeds/getById — [] or [one link]
 * (museum's map initializes every requested id to an empty slice, and its
 * unique index caps active links at one per collection). "Active" only means
 * not disabled: an EXPIRED link still emits, exactly as upstream. */
export const publicURLsForCollection = async (
  deps: Deps,
  collectionID: number,
): Promise<Record<string, unknown>[]> => {
  const link = await getLinkForCollection(deps, collectionID);
  return link ? [publicUrlJson(deps, link)] : [];
};

/** ente/access.go roleRank; UNKNOWN ranks 0. */
const roleRank = (role: string): number =>
  ({ VIEWER: 1, COLLABORATOR: 2, ADMIN: 3, OWNER: 4 })[role] ?? 0;

/** museum FilterPublicURLsForRole: a sharee sees a URL only when their role
 * satisfies its minRole; URLs with no minRole are visible to everyone. */
export const filterPublicURLsForRole = (
  urls: Record<string, unknown>[],
  role: CollectionRole | 'UNKNOWN',
): Record<string, unknown>[] => {
  const effective = role === 'UNKNOWN' ? 'VIEWER' : role;
  return urls.filter((u) => {
    const min = u.minRole as string | undefined;
    return min === undefined || roleRank(effective) >= roleRank(min);
  });
};

// --- Password JWT (museum link_common.go) ----------------------------------

/**
 * Museum signs public-link JWTs with its own `jwt.secret` config; this repo
 * derives an equivalent from the one secret it already requires: keyed
 * blake2b of a fixed context over HASHING_KEY. Deriving (rather than reusing
 * the key raw) keeps the email-hash and JWT domains cryptographically
 * separate. D51.
 */
export const publicLinkJwtSecret = (deps: Deps): Uint8Array =>
  sodium.crypto_generichash(32, 'ente-serverless:public-link-jwt:v1', deps.hashingKey);

const JWT_VALIDITY_MICROS = 30 * 24 * 3600 * MICROS_PER_SECOND; // museum: NDaysFromNow(30)

/** museum verifyPassword's success half: LinkPasswordClaim {passKey, expiryTime}. */
export const issuePasswordJwt = (deps: Deps, passHash: string): string =>
  signJwtHS256(
    { passKey: passHash, expiryTime: deps.clock.nowMicros() + JWT_VALIDITY_MICROS },
    publicLinkJwtSecret(deps),
  );

/** museum validateJWTToken: signature valid AND claims.passKey equals the
 * link's current passHash AND expiryTime unexpired. Distinguishes museum's
 * two failure modes: a parse/signature failure surfaces as a plain Go error
 * (bare 500 via handler.go) while a valid token with the wrong passKey is
 * ErrInvalidPassword (401) — callers map `parseFailed`. */
export const validatePasswordJwt = (
  deps: Deps,
  jwt: string,
  passHash: string,
): 'ok' | 'parseFailed' | 'invalid' => {
  let claims: Record<string, unknown>;
  try {
    claims = verifyJwtHS256(jwt, publicLinkJwtSecret(deps));
  } catch (err) {
    if (err instanceof JwtError) return 'parseFailed';
    throw err;
  }
  // golang-jwt runs Claims.Valid() during parse: an expired claim is a parse
  // error upstream, not an ErrInvalidPassword.
  if ((claims.expiryTime as number ?? 0) < deps.clock.nowMicros()) return 'parseFailed';
  const got = String(claims.passKey ?? '');
  const a = Buffer.from(got);
  const b = Buffer.from(passHash);
  return a.length === b.length && timingSafeEqual(a, b) ? 'ok' : 'invalid';
};

/** Constant-time passHash comparison for verify-password itself. */
export const passHashEquals = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

// --- Device admission (museum middleware checkDeviceLimit) ------------------

/** museum: "A device is identified by its IP and user agent." */
export const deviceHash = (ip: string, ua: string): string =>
  createHash('sha256').update(ip).update('\u0000').update(ua).digest('hex');

/** museum DeviceLimitThreshold(50) * DeviceLimitThresholdMultiplier(10): a
 * link saved with the maximum settable limit of 50 is actually enforced at
 * 500 — upstream quirk, reproduced. */
export const effectiveDeviceLimit = (deviceLimit: number): number =>
  deviceLimit === 50 ? 500 : deviceLimit;

/** Rolling TTL backstop on admission rows (security review P2-1, D53): 90
 * days, the link-META validTill+90d margin. Reaped rows just get re-admitted
 * later — museum keeps access_history forever, so "admitted stays admitted"
 * drifting back to "re-admitted" is the accepted delta (D53). */
const DEVICE_ROW_TTL_SECONDS = 90 * 24 * 3600;

/**
 * Admit (ip, ua) against the link's device limit — museum isDeviceLimitReached:
 * a device that ever got in stays in regardless of the current limit; new
 * devices are admitted (and recorded) only under the limit. The record + count
 * ride one transactWrite: the DEVICE# put is CONDITIONED on not-exists, so a
 * concurrent admit of the same device loses the whole transaction (mapped to
 * admitted — it is already recorded and counted once) and can never
 * double-increment DEVICES (P3-1). Two DIFFERENT devices racing under the
 * last slot can still both land — museum's SELECT-then-INSERT is racier, so
 * that over-admission is accepted drift (D53). Both rows carry the rolling
 * TTL backstop, and every NEW admission burns the per-link daily ceiling
 * first (429 once over) — /info is password-whitelisted, so admission there
 * must not be an unbounded write amplifier (P2-1).
 */
export const admitDevice = async (
  deps: Deps,
  link: PublicLinkRow,
  ip: string,
  ua: string,
): Promise<{ admitted: boolean }> => {
  const dev = deviceHash(ip, ua);
  const row = keys.publicLinkDevice(link.tokenHash, dev);
  if (await deps.db.get(row.pk, row.sk)) return { admitted: true }; // AccessedInPast
  const limit = effectiveDeviceLimit(link.deviceLimit);
  if (limit > 0) {
    const counter = keys.publicLinkDeviceCount(link.tokenHash);
    const count = ((await deps.db.get(counter.pk, counter.sk))?.count as number) ?? 0;
    if (count >= limit) return { admitted: false };
  }
  await bumpDailyCeiling(deps, link.tokenHash, 'devices', deps.config.publicLinkDailyDeviceLimit);
  const now = deps.clock.nowMicros();
  const ttl = Math.ceil(now / MICROS_PER_SECOND) + DEVICE_ROW_TTL_SECONDS;
  try {
    await deps.db.transactWrite([
      { kind: 'put', item: { ...row, admittedAt: now, ttl }, ifNotExists: true },
      {
        kind: 'counter',
        key: keys.publicLinkDeviceCount(link.tokenHash),
        deltas: { count: 1 },
        set: { ttl },
      },
    ]);
  } catch (err) {
    // Lost a same-device race: the winner already recorded AND counted it.
    if (err instanceof ConditionFailedError) return { admitted: true };
    throw err;
  }
  return { admitted: true };
};

// --- Link-device JWT (museum link_device_token.go) --------------------------
// Lets an admitted browser refresh /info + /diff without burning device slots.
// Claim shape is museum's LinkDeviceClaim; linkID here is the tokenHash (the
// row has no serial id — the claim is opaque to clients either way).

const LINK_DEVICE_TTL_MICROS = 365 * 24 * 3600 * MICROS_PER_SECOND;
export const LINK_DEVICE_REFRESH_BEFORE_MICROS = 30 * 24 * 3600 * MICROS_PER_SECOND;

const deviceTokenAth = (deps: Deps, accessToken: string): string =>
  Buffer.from(
    sodium.crypto_generichash(
      32,
      `ente:public-link-device-token:access-token:v1\u0000${accessToken}`,
      publicLinkJwtSecret(deps),
    ),
  ).toString('base64url');

export const newLinkDeviceToken = (
  deps: Deps,
  link: PublicLinkRow,
): string => {
  const now = deps.clock.nowMicros();
  let exp = now + LINK_DEVICE_TTL_MICROS;
  if (link.validTill > 0 && link.validTill < exp) exp = link.validTill;
  return signJwtHS256(
    {
      typ: 'link-device',
      scope: 'collection',
      linkID: link.tokenHash,
      ath: deviceTokenAth(deps, link.token),
      iat: now,
      exp,
      iss: 'museum',
      aud: 'public-link-device',
    },
    publicLinkJwtSecret(deps),
  );
};

/** null = invalid; otherwise the expiry (micros) so the caller can refresh. */
export const validateLinkDeviceToken = (
  deps: Deps,
  token: string,
  link: PublicLinkRow,
): number | null => {
  let claims: Record<string, unknown>;
  try {
    claims = verifyJwtHS256(token, publicLinkJwtSecret(deps));
  } catch {
    return null;
  }
  const exp = (claims.exp as number) ?? 0;
  if (exp < deps.clock.nowMicros()) return null;
  if (
    claims.typ !== 'link-device' ||
    claims.scope !== 'collection' ||
    claims.linkID !== link.tokenHash ||
    claims.iss !== 'museum' ||
    claims.aud !== 'public-link-device'
  ) {
    return null;
  }
  const expectedAth = Buffer.from(deviceTokenAth(deps, link.token));
  const gotAth = Buffer.from(String(claims.ath ?? ''));
  if (gotAth.length !== expectedAth.length || !timingSafeEqual(gotAth, expectedAth)) return null;
  return exp;
};

// --- Linked-collection helpers for the /public-collection handlers ----------

/** The link's collection — museum GetPublicCollection: deleted reads 404
 * (unreachable in practice, deleteCollectionV3 disables the link first). */
export const getPublicCollectionRow = async (
  deps: Deps,
  link: PublicLinkRow,
): Promise<CollectionRow> => {
  const collection = await getCollection(deps, link.collectionID);
  if (!collection || collection.isDeleted) throw errNotFound();
  return collection;
};

/** museum GetPublicCollection(mustAllowCollect=true): collect disabled ->
 * 405 {"code":"PUBLIC_COLLECT_DISABLED",...}. */
export const assertCollectEnabled = (link: PublicLinkRow): void => {
  if (!link.enableCollect) throw publicCollectDisabled();
};

/** File served through a public link must be LIVE-linked to THAT collection —
 * museum GetCollectionObject / GetCollectionFileState (sql.ErrNoRows -> 404,
 * membership never disclosed otherwise). */
export const getPublicLinkedFile = async (
  deps: Deps,
  link: PublicLinkRow,
  fileId: number,
): Promise<FileRow> => {
  const { pk, sk } = keys.collectionFile(link.collectionID, fileId);
  const linkRow = await deps.db.get<LinkRow>(pk, sk);
  if (!linkRow || linkRow.isDeleted) throw errNotFound();
  const file = await getFile(deps, fileId);
  if (!file) throw errNotFound();
  return file;
};

// --- Abuse-control counters (plan §4.1, no museum equivalent — D51) ---------

const PW_ATTEMPT_LIMIT = 20; // the OTT wrong-attempt cap, reused deliberately
const PW_ATTEMPT_WINDOW_MICROS = MICROS_PER_HOUR;

/** 429 once (tokenHash, ip) has burned the cap inside the sliding window —
 * the ott.ts consumeOtt pattern: atomic ADD first, judge the returned value,
 * TTL bounds the row. Call AFTER a failed compare; `assertPasswordAttempts`
 * cheap-fails before doing any work. */
export const assertPasswordAttempts = async (
  deps: Deps,
  tokenHashHex: string,
  ip: string,
): Promise<void> => {
  const { pk, sk } = keys.publicLinkPwAttempts(tokenHashHex, createHash('sha256').update(ip).digest('hex'));
  const row = await deps.db.get(pk, sk);
  const now = deps.clock.nowMicros();
  const live = row !== null && (row.expiresAt as number) > now;
  if (live && (row!.count as number) >= PW_ATTEMPT_LIMIT) throw errTooManyBadRequest();
  if (row && !live) await deps.db.delete(pk, sk); // stale window: reset before the next ADD
};

export const recordPasswordAttempt = async (
  deps: Deps,
  tokenHashHex: string,
  ip: string,
): Promise<void> => {
  const { pk, sk } = keys.publicLinkPwAttempts(tokenHashHex, createHash('sha256').update(ip).digest('hex'));
  const expiresAt = deps.clock.nowMicros() + PW_ATTEMPT_WINDOW_MICROS;
  const { count } = await deps.db.addToCountersReturning(
    pk,
    sk,
    { count: 1 },
    { expiresAt, ttl: Math.ceil(expiresAt / MICROS_PER_SECOND) },
  );
  if (count! > PW_ATTEMPT_LIMIT) throw errTooManyBadRequest();
};

/** Per-link daily ceiling (plan §4.1d): one counter row per UTC day, TTL'd
 * two days out; increment-then-judge so the cap binds under concurrency.
 * kind 'downloads' covers presigned GET issuance; 'uploads' covers upload-url
 * mints AND commits (each counts 1 against the same daily limit); 'devices'
 * covers NEW device admissions (P2-1, D53). 429 over. */
export const bumpDailyCeiling = async (
  deps: Deps,
  tokenHashHex: string,
  kind: 'downloads' | 'uploads' | 'devices',
  limit: number,
): Promise<void> => {
  if (limit <= 0) return;
  const day = new Date(deps.clock.nowMicros() / 1000).toISOString().slice(0, 10);
  const { pk, sk } = keys.publicLinkCeiling(tokenHashHex, day);
  const ttl = Math.ceil(deps.clock.nowMicros() / MICROS_PER_SECOND) + 2 * 24 * 3600;
  const out = await deps.db.addToCountersReturning(pk, sk, { [kind]: 1 }, { ttl });
  if (out[kind]! > limit) throw errTooManyBadRequest();
};
