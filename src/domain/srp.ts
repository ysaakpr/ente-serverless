/**
 * SRP-6a, ported EXACTLY from github.com/ente/go-srp (node-srp conventions),
 * which is what museum uses. Verified against the source 2026-08-16:
 *
 *   group   : RFC 5054 4096-bit, g = 5, SHA-256          (params.go)
 *   k       : H(pad(N) | pad(g))                          (getMultiplier)
 *   x       : H(salt | H(I ":" P))                        (getx — identity IS folded in)
 *   v       : pad(g^x mod N)                              (ComputeVerifier)
 *   B       : pad((k*v + g^b) mod N)                      (getB)
 *   u       : H(pad(A) | pad(B))                          (getu)
 *   S(srv)  : pad((A * v^u)^b mod N)                      (serverGetS)
 *   S(cli)  : pad((B - k*g^x)^(a + u*x) mod N)            (clientGetS)
 *   K       : H(S)                                        (getK)
 *   M1      : H(pad(A) | pad(B) | pad(S))                 (getM1 — unpadded concat of already-padded values)
 *   M2      : H(A | M1 | K)                               (getM2)
 *
 * All wire values are std base64 of 512-byte (N-length) buffers; M1/M2 are 32 bytes.
 */

import { createHash } from 'node:crypto';

// RFC 5054 4096-bit group (params.go knownGroups[4096]); g = 5.
const N_HEX = (
  'FFFFFFFF FFFFFFFF C90FDAA2 2168C234 C4C6628B 80DC1CD1 29024E08' +
  '8A67CC74 020BBEA6 3B139B22 514A0879 8E3404DD EF9519B3 CD3A431B' +
  '302B0A6D F25F1437 4FE1356D 6D51C245 E485B576 625E7EC6 F44C42E9' +
  'A637ED6B 0BFF5CB6 F406B7ED EE386BFB 5A899FA5 AE9F2411 7C4B1FE6' +
  '49286651 ECE45B3D C2007CB8 A163BF05 98DA4836 1C55D39A 69163FA8' +
  'FD24CF5F 83655D23 DCA3AD96 1C62F356 208552BB 9ED52907 7096966D' +
  '670C354E 4ABC9804 F1746C08 CA18217C 32905E46 2E36CE3B E39E772C' +
  '180E8603 9B2783A2 EC07A28F B5C55DF0 6F4C52C9 DE2BCBF6 95581718' +
  '3995497C EA956AE5 15D22618 98FA0510 15728E5A 8AAAC42D AD33170D' +
  '04507A33 A85521AB DF1CBA64 ECFB8504 58DBEF0A 8AEA7157 5D060C7D' +
  'B3970F85 A6E1E4C7 ABF5AE8C DB0933D7 1E8C94E0 4A25619D CEE3D226' +
  '1AD2EE6B F12FFA06 D98A0864 D8760273 3EC86A64 521F2B18 177B200C' +
  'BBE11757 7A615D6C 770988C0 BAD946E2 08E24FA0 74E5AB31 43DB5BFC' +
  'E0FD108E 4B82D120 A9210801 1A723C12 A787E6D7 88719A10 BDBA5B26' +
  '99C32718 6AF4E23C 1A946834 B6150BDA 2583E9CA 2AD44CE8 DBBBC2DB' +
  '04DE8EF9 2E8EFC14 1FBECAA6 287C5947 4E6BC05D 99B2964F A090C3A2' +
  '233BA186 515BE7ED 1F612970 CEE2D7AF B81BDD76 2170481C D0069127' +
  'D5B05AA9 93B4EA98 8D8FDDC1 86FFB7DC 90A6C08F 4DF435C9 34063199' +
  'FFFFFFFF FFFFFFFF'
).replaceAll(' ', '');

export const N = BigInt('0x' + N_HEX);
export const G = 5n;
export const N_BYTES = 512;

const toBigInt = (bytes: Uint8Array): bigint => {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex === '' ? 0n : BigInt('0x' + hex);
};

/** big-endian bytes, left-padded to N's length (util.go padToN). */
export const padToN = (n: bigint): Uint8Array => {
  let hex = n.toString(16);
  if (hex.length % 2 === 1) hex = '0' + hex;
  const raw = Buffer.from(hex, 'hex');
  if (raw.length > N_BYTES) throw new Error('number too large for group');
  const out = Buffer.alloc(N_BYTES);
  raw.copy(out, N_BYTES - raw.length);
  return new Uint8Array(out);
};

const sha256 = (...parts: Uint8Array[]): Uint8Array => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

export const modPow = (base: bigint, exp: bigint, mod: bigint): bigint => {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
};

const k = (): bigint => toBigInt(sha256(padToN(N), padToN(G)));

const getU = (A: bigint, B: bigint): bigint => toBigInt(sha256(padToN(A), padToN(B)));

/** x = H(salt | H(I ":" P)) — client.go getx. */
export const getX = (salt: Uint8Array, identity: Uint8Array, password: Uint8Array): bigint => {
  const colon = new TextEncoder().encode(':');
  const ip = new Uint8Array([...identity, ...colon, ...password]);
  return toBigInt(sha256(salt, sha256(ip)));
};

/** v = pad(g^x mod N) — client.go ComputeVerifier. */
export const computeVerifier = (
  salt: Uint8Array,
  identity: Uint8Array,
  password: Uint8Array,
): Uint8Array => padToN(modPow(G, getX(salt, identity, password), N));

/**
 * Server side of one SRP handshake (server.go). Construct with the stored
 * verifier and a persisted secret b; A arrives from the client.
 */
export class SrpServer {
  readonly B: bigint;
  private readonly v: bigint;
  private readonly b: bigint;

  constructor(verifier: Uint8Array, secretB: Uint8Array) {
    this.v = toBigInt(verifier);
    this.b = toBigInt(secretB);
    this.B = (k() * this.v + modPow(G, this.b, N)) % N;
  }

  computeB(): Uint8Array {
    return padToN(this.B);
  }

  /**
   * Returns {m1, m2} for the supplied client A; the caller compares m1 in
   * constant time. Throws on A outside (0, N) — go-srp panics there.
   */
  proofs(aBytes: Uint8Array): { m1: Uint8Array; m2: Uint8Array } {
    const A = toBigInt(aBytes);
    if (A <= 0n || N <= A) throw new Error("invalid client-supplied 'A', must be 1..N-1");
    const u = getU(A, this.B);
    const S = padToN(modPow((A * modPow(this.v, u, N)) % N, this.b, N));
    const K = sha256(S);
    // server getM1 uses the RAW client-supplied A bytes (server.go SetA).
    const m1 = sha256(aBytes, padToN(this.B), S);
    const m2 = sha256(aBytes, m1, K);
    return { m1, m2 };
  }
}

/** Client side (client.go) — used by the synthetic test client. */
export class SrpClient {
  readonly A: bigint;
  private readonly a: bigint;
  private readonly x: bigint;
  m1?: Uint8Array;
  m2?: Uint8Array;

  constructor(salt: Uint8Array, identity: Uint8Array, password: Uint8Array, secretA: Uint8Array) {
    this.a = toBigInt(secretA);
    this.x = getX(salt, identity, password);
    this.A = modPow(G, this.a, N);
  }

  computeA(): Uint8Array {
    return padToN(this.A);
  }

  setB(bBytes: Uint8Array): void {
    const B = toBigInt(bBytes);
    if (B <= 0n || N <= B) throw new Error("invalid server-supplied 'B', must be 1..N-1");
    const u = getU(this.A, B);
    const base = (((B - ((k() * modPow(G, this.x, N)) % N)) % N) + N) % N;
    const S = padToN(modPow(base, this.a + u * this.x, N));
    const K = sha256(S);
    this.m1 = sha256(padToN(this.A), bBytes, S);
    this.m2 = sha256(padToN(this.A), this.m1, K);
  }

  computeM1(): Uint8Array {
    if (!this.m1) throw new Error('incomplete protocol');
    return this.m1;
  }

  checkM2(m2: Uint8Array): boolean {
    return !!this.m2 && Buffer.from(this.m2).equals(Buffer.from(m2));
  }
}

/**
 * Museum's FakeVerifier (pkg/controller/user/srp.go) — used for unknown
 * srpUserIDs so enumeration probes get a full-shaped, always-failing handshake.
 */
export const FAKE_VERIFIER_B64 =
  'RNYLOgdzKsbhRWN8OoD05kNpfbqb9uASHYpaLrYLYVemCV0pf4fBgo+25jeu8SaVMQhlkyIF2BgGXX4uzy8Pmwq1ocqt8DsGk0DrlOE1AV9ogaY3myoTjXTQG5dU/hTywylKJYdpWSEyzMMLbWcuO8ldS6uzYXqK+jbfEDDj8k4PqLx1715BPgigNydCbD7/VtwaMhQ8MEygiW/2PbieeqUzuCqEWfwu0uytPM9LiuHH7DT3k2fELFOoPWs3KQAhk6rmM17JOLm8Qvt+xGU6nJZKzTNPxw9o4H4FvlGmsEYUdTP+WPdWpzcton6BowCXKN9G3hZx10OUzBuePHFNKjDlaSLpJXVclLWmza6aDBpjKahayW2UvdQw1tSonyFUjJOanocrPEoHthHUjUGXkeRqcaU4CV9KLQFaHqnHTYc9uJKuYl/tcYoWXuHrZ0cFYRpc6qf/gBCuuwkhTXXsJxTlepe5x0gqgQb7mD5y+dvINks/gpO/3x4T4RkQcyoonsOZv2uLIBr3D6Ede9/aJstIkMh3dTEpDWdw8tEaO7ZjqEwKXVA+/fquJ7P8B3fcIvPy8UZOpwAYtWSPh3OYzijG7WFXu+ajPBqkVI1OBSCYOlTQlPXyrv7myiD8/FXJep5IDPeuJsmGrLPJXBZjPKWR0ISBWol5KTYWE2EllYQ=';
