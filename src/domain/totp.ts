/**
 * TOTP (RFC 6238) for two-factor auth — museum uses github.com/pquerna/otp
 * with its defaults, which the oracle capture pins exactly (2026-08-17):
 *
 *   secretCode  32 chars of RFC 4648 base32, unpadded = 20 random bytes
 *   qrCode      200x200 PNG of
 *               otpauth://totp/ente:<email>?algorithm=SHA1&digits=6
 *                 &issuer=ente&period=30&secret=<secretCode>
 *               (query keys alphabetical — Go's url.Values.Encode sorts them)
 *
 * So: SHA-1, 6 digits, 30-second period. pquerna's totp.Validate defaults to
 * Skew 1, i.e. the previous and next windows are accepted alongside the
 * current one; verified against the oracle in test — see D36.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Rand } from '../ports/system.ts';
import type { Micros } from '../lib/time.ts';
import { MICROS_PER_SECOND } from '../lib/time.ts';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** pquerna's default SecretSize: 20 bytes -> exactly 32 base32 chars. */
export const TOTP_SECRET_BYTES = 20;
/** pquerna totp.Validate default: accept t-1, t, t+1. */
export const TOTP_SKEW_STEPS = 1;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const base32Encode = (bytes: Uint8Array): string => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
};

export const base32Decode = (encoded: string): Uint8Array => {
  const clean = encoded.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
};

export const generateTotpSecret = (rand: Rand): string =>
  base32Encode(rand.bytes(TOTP_SECRET_BYTES));

/** The HOTP value for one counter step. */
const hotp = (key: Uint8Array, counter: number): string => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', Buffer.from(key)).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
};

export const totpCode = (secret: string, at: Micros): string =>
  hotp(base32Decode(secret), Math.floor(at / MICROS_PER_SECOND / TOTP_PERIOD_SECONDS));

/** Constant-time compare so a wrong code leaks nothing through timing. */
const codesMatch = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const verifyTotp = (
  secret: string,
  code: string,
  at: Micros,
  skewSteps = TOTP_SKEW_STEPS,
): boolean => {
  if (!/^\d{6}$/.test(code)) return false;
  let key: Uint8Array;
  try {
    key = base32Decode(secret);
  } catch {
    return false;
  }
  const step = Math.floor(at / MICROS_PER_SECOND / TOTP_PERIOD_SECONDS);
  // Every window is checked even after a hit, so timing does not reveal which.
  let ok = false;
  for (let delta = -skewSteps; delta <= skewSteps; delta++) {
    if (codesMatch(hotp(key, step + delta), code)) ok = true;
  }
  return ok;
};

/** Exactly the URI museum encodes into the QR (capture 2026-08-17). */
export const otpauthUri = (email: string, secret: string): string => {
  const params = new URLSearchParams({
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    issuer: 'ente',
    period: String(TOTP_PERIOD_SECONDS),
    secret,
  });
  // `@` and `:` are legal path characters and Go leaves them literal, so the
  // captured label reads `ente:user@example.org`; anything genuinely unsafe
  // still gets percent-encoded.
  const label = encodeURIComponent(`ente:${email}`)
    .replace(/%40/g, '@')
    .replace(/%3A/gi, ':');
  return `otpauth://totp/${label}?${params.toString()}`;
};
