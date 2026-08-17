/** Base64 helpers matching museum's conventions (std for SRP/keys, url-safe for tokens). */

export const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

export const fromB64 = (s: string): Uint8Array => {
  // Node tolerates url-safe chars and missing padding; museum's
  // base64.StdEncoding does not. Reject what Go would reject.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) {
    throw new Error('invalid base64 encoding');
  }
  return new Uint8Array(Buffer.from(s, 'base64'));
};

/** Go base64.URLEncoding — url-safe WITH padding (museum token strings). */
export const b64Url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64').replaceAll('+', '-').replaceAll('/', '_');

export const fromB64Url = (s: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(s) || s.length % 4 !== 0) {
    throw new Error('invalid base64url encoding');
  }
  return new Uint8Array(Buffer.from(s.replaceAll('-', '+').replaceAll('_', '/'), 'base64'));
};
