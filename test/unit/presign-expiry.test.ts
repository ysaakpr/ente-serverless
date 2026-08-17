/**
 * Finding 5 of the 2026-08-17 security review: one knob served both presign
 * verbs. GET keeps museum's 7 days until an M5 device gate proves clients
 * re-fetch rather than cache; PUT (a write grant) drops to 24 hours. The old
 * PRESIGN_EXPIRY_SECONDS must keep overriding both, so nothing breaks
 * mid-deploy on an env that still sets it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config.ts';

const KEYS = ['PRESIGN_EXPIRY_SECONDS', 'PRESIGN_GET_EXPIRY_SECONDS', 'PRESIGN_PUT_EXPIRY_SECONDS'];

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe('presign expiry config', () => {
  it('defaults: GET 7 days (museum parity, pending M5), PUT 24 hours', () => {
    const config = configFromEnv();
    expect(config.presignGetExpirySeconds).toBe(7 * 24 * 3600);
    expect(config.presignPutExpirySeconds).toBe(24 * 3600);
  });

  it('the legacy PRESIGN_EXPIRY_SECONDS still overrides both', () => {
    process.env.PRESIGN_EXPIRY_SECONDS = '1234';
    const config = configFromEnv();
    expect(config.presignGetExpirySeconds).toBe(1234);
    expect(config.presignPutExpirySeconds).toBe(1234);
  });

  it('the split knobs win over the legacy one', () => {
    process.env.PRESIGN_EXPIRY_SECONDS = '1234';
    process.env.PRESIGN_GET_EXPIRY_SECONDS = '3600';
    process.env.PRESIGN_PUT_EXPIRY_SECONDS = '7200';
    const config = configFromEnv();
    expect(config.presignGetExpirySeconds).toBe(3600);
    expect(config.presignPutExpirySeconds).toBe(7200);
  });
});
