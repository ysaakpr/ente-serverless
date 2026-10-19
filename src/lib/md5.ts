/**
 * museum ente/upload.go NormalizeMD5 (upstream 2026-09): trim, require a
 * padded standard-base64 encoding of exactly 16 bytes, return the canonical
 * re-encoding — which is what gets bound into the presigned Content-MD5.
 * Anything else is museum's bare-{} ErrBadRequest.
 */

import { errBadRequestSentinel } from './errors.ts';

const MD5_B64 = /^[A-Za-z0-9+/]{22}==$/;

export const normalizeMd5 = (value: string): string => {
  const trimmed = value.trim();
  if (!MD5_B64.test(trimmed)) throw errBadRequestSentinel();
  return Buffer.from(trimmed, 'base64').toString('base64');
};
