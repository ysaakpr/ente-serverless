/**
 * TOTP domain logic (D36) — RFC 6238 reference vectors plus the parameters
 * pinned by the 2026-08-17 oracle capture (SHA1 / 6 digits / 30s / skew 1).
 */

import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUri,
  totpCode,
  verifyTotp,
  TOTP_PERIOD_SECONDS,
} from '../../src/domain/totp.ts';
import { RealRand } from '../../src/adapters/memory/system.memory.ts';
import { MICROS_PER_SECOND } from '../../src/lib/time.ts';

/** RFC 6238 Appendix B, SHA-1 rows: ASCII "12345678901234567890". */
const RFC_SECRET = base32Encode(new TextEncoder().encode('12345678901234567890'));
/** The RFC prints 8 digits; a 6-digit TOTP is that value mod 1e6. */
const RFC_VECTORS: Array<[number, string]> = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    for (const len of [1, 5, 10, 20, 32]) {
      const bytes = new RealRand().bytes(len);
      expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    }
  });

  it('encodes 20 bytes as the 32 unpadded chars museum sends', () => {
    const secret = generateTotpSecret(new RealRand());
    expect(secret).toHaveLength(32);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => base32Decode('ABC!')).toThrow();
  });
});

describe('TOTP against RFC 6238 vectors', () => {
  it('produces the published codes', () => {
    for (const [seconds, expected] of RFC_VECTORS) {
      expect(totpCode(RFC_SECRET, seconds * MICROS_PER_SECOND), `t=${seconds}`).toBe(expected);
    }
  });

  it('verifies its own code at the same instant', () => {
    const at = 1_700_000_000 * MICROS_PER_SECOND;
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, at), at)).toBe(true);
  });
});

describe('skew window (pquerna default: t-1, t, t+1)', () => {
  const at = 1_700_000_000 * MICROS_PER_SECOND;
  const step = TOTP_PERIOD_SECONDS * MICROS_PER_SECOND;

  it('accepts the previous and next windows', () => {
    for (const delta of [-1, 0, 1]) {
      const code = totpCode(RFC_SECRET, at + delta * step);
      expect(verifyTotp(RFC_SECRET, code, at), `delta ${delta}`).toBe(true);
    }
  });

  it('rejects two windows out in either direction', () => {
    for (const delta of [-2, 2]) {
      const code = totpCode(RFC_SECRET, at + delta * step);
      expect(verifyTotp(RFC_SECRET, code, at), `delta ${delta}`).toBe(false);
    }
  });

  it('rejects malformed codes without throwing', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 456']) {
      expect(verifyTotp(RFC_SECRET, bad, at), bad).toBe(false);
    }
  });

  it('rejects rather than throws on a corrupt stored secret', () => {
    expect(verifyTotp('not!base32', '123456', at)).toBe(false);
  });
});

describe('otpauth URI', () => {
  it('matches the captured museum URI byte for byte', () => {
    // Decoded from museum's own QR PNG, 2026-08-17.
    expect(otpauthUri('flow-3b49671d@example.org', '6AY46F3GH2F35UHOTRTHRHGRP5T3T53L')).toBe(
      'otpauth://totp/ente:flow-3b49671d@example.org' +
        '?algorithm=SHA1&digits=6&issuer=ente&period=30&secret=6AY46F3GH2F35UHOTRTHRHGRP5T3T53L',
    );
  });

  it('leaves @ literal but escapes genuinely unsafe characters', () => {
    expect(otpauthUri('a b@example.org', 'AAAA')).toContain('ente:a%20b@example.org');
  });
});
