/**
 * Session tokens + email hashing + the sealed-box encryptedToken —
 * behaviour mirrored from museum (pkg/utils/auth + pkg/utils/crypto).
 *
 * Token string: base64.URLEncoding of 32 random bytes (padding kept — Go's
 * URLEncoding pads, and the stored token must round-trip the client's
 * re-encode of the unsealed bytes).
 *
 * Storage: TOKEN#<sha256(token)> row holding the plaintext token — the
 * plaintext must be retrievable because GET /users/sessions returns it
 * (museum stores it plaintext too; the hash key just avoids a scan).
 */

import { createHash } from 'node:crypto';
import sodium from '../lib/sodium.ts';
import { b64, fromB64 } from '../lib/b64.ts';
import { b64Url, fromB64Url } from '../lib/b64.ts';
import type { Rand } from '../ports/system.ts';

export const generateToken = (rand: Rand): string => b64Url(rand.bytes(32));

export const tokenHash = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** Keyed blake2b-256, like museum crypto.GetHash — call after sodiumReady(). */
export const emailHash = (email: string, hashingKey: Uint8Array): string =>
  b64(sodium.crypto_generichash(32, normalizeEmail(email), hashingKey));

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/**
 * museum crypto.GetEncryptedToken: libsodium sealed box of the DECODED token
 * bytes to the user's publicKey; std-base64 of the result.
 */
export const encryptToken = (token: string, publicKeyB64: string): string => {
  const publicKey = fromB64(publicKeyB64);
  if (publicKey.length !== sodium.crypto_box_PUBLICKEYBYTES) {
    throw new Error('invalid public key length');
  }
  const tokenBytes = fromB64Url(token);
  return b64(sodium.crypto_box_seal(tokenBytes, publicKey));
};

let ready: Promise<void> | undefined;
export const sodiumReady = (): Promise<void> => (ready ??= sodium.ready);
