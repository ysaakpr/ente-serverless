/**
 * Minimal HS256 JWT — the repo's first JWT need (Phase D public links).
 * Structurally mirrors golang-jwt/v4 as museum uses it (pkg/controller/public/
 * link_common.go + link_device_token.go): compact JWS, HMAC-SHA256, and — this
 * is the museum quirk to preserve — NO standard `exp`/`iat` registered-claim
 * handling. Museum's claims are plain structs with custom `Valid()` methods
 * reading an `expiryTime` field in EPOCH MICROSECONDS, so expiry checks are the
 * CALLER's job here too; this file only signs and verifies signatures.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const b64uJson = (obj: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(obj)).toString('base64url');

const hs256 = (signingInput: string, secret: Uint8Array): Buffer =>
  createHmac('sha256', secret).update(signingInput).digest();

/** Compact HS256 JWT over the given claims (golang-jwt header order). */
export const signJwtHS256 = (claims: Record<string, unknown>, secret: Uint8Array): string => {
  const signingInput = `${b64uJson({ alg: 'HS256', typ: 'JWT' })}.${b64uJson(claims)}`;
  return `${signingInput}.${hs256(signingInput, secret).toString('base64url')}`;
};

export class JwtError extends Error {}

/**
 * Verify signature + structure, return the claims. Only HS256 is accepted
 * (museum's SigningMethodHMAC gate rejects everything else, including `none`).
 * Throws JwtError on any failure; claim semantics (expiryTime, passKey, ...)
 * are checked by the caller, as in museum.
 */
export const verifyJwtHS256 = (token: string, secret: Uint8Array): Record<string, unknown> => {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed token');
  const [headerB64, claimsB64, sigB64] = parts as [string, string, string];
  let header: { alg?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
    claims = JSON.parse(Buffer.from(claimsB64, 'base64url').toString());
  } catch {
    throw new JwtError('malformed token');
  }
  if (header.alg !== 'HS256') throw new JwtError(`unexpected signing method: ${header.alg}`);
  const expected = hs256(`${headerB64}.${claimsB64}`, secret);
  const got = Buffer.from(sigB64, 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    throw new JwtError('signature verification failed');
  }
  if (claims === null || typeof claims !== 'object') throw new JwtError('no claims');
  return claims;
};
