/**
 * SRP engine self-consistency + go-srp convention checks.
 * Oracle cross-vector test (build plan §4.3 group gate) is pending capture —
 * tracked in DECISIONS.md D2.
 */

import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  computeVerifier,
  FAKE_VERIFIER_B64,
  N_BYTES,
  SrpClient,
  SrpServer,
} from '../../src/domain/srp.ts';
import { fromB64 } from '../../src/lib/b64.ts';

const enc = new TextEncoder();

describe('srp math (go-srp port)', () => {
  it('full client/server round-trip agrees on M1 and M2', () => {
    const salt = randomBytes(16);
    const identity = enc.encode('9f4a8a4e-1111-2222-3333-444455556666');
    const password = randomBytes(32);

    const verifier = computeVerifier(salt, identity, password);
    expect(verifier.length).toBe(N_BYTES);

    const client = new SrpClient(salt, identity, password, randomBytes(32));
    const server = new SrpServer(verifier, randomBytes(32));

    const A = client.computeA();
    const B = server.computeB();
    expect(A.length).toBe(N_BYTES);
    expect(B.length).toBe(N_BYTES);

    client.setB(B);
    const { m1, m2 } = server.proofs(A);
    expect(Buffer.from(client.computeM1()).equals(Buffer.from(m1))).toBe(true);
    expect(m1.length).toBe(32);
    expect(client.checkM2(m2)).toBe(true);
  });

  it('wrong password fails M1', () => {
    const salt = randomBytes(16);
    const identity = enc.encode('user-id');
    const verifier = computeVerifier(salt, identity, enc.encode('right'));
    const client = new SrpClient(salt, identity, enc.encode('wrong'), randomBytes(32));
    const server = new SrpServer(verifier, randomBytes(32));
    client.setB(server.computeB());
    const { m1 } = server.proofs(client.computeA());
    expect(Buffer.from(client.computeM1()).equals(Buffer.from(m1))).toBe(false);
  });

  it('identity is folded into x — different identity, same password fails', () => {
    const salt = randomBytes(16);
    const password = enc.encode('secret');
    const verifier = computeVerifier(salt, enc.encode('id-a'), password);
    const client = new SrpClient(salt, enc.encode('id-b'), password, randomBytes(32));
    const server = new SrpServer(verifier, randomBytes(32));
    client.setB(server.computeB());
    const { m1 } = server.proofs(client.computeA());
    expect(Buffer.from(client.computeM1()).equals(Buffer.from(m1))).toBe(false);
  });

  it('A = 0 mod N is rejected by the server', () => {
    const server = new SrpServer(fromB64(FAKE_VERIFIER_B64), randomBytes(32));
    expect(() => server.proofs(new Uint8Array(N_BYTES))).toThrow();
  });

  it('FakeVerifier produces a full-size B (anti-enumeration shape)', () => {
    const server = new SrpServer(fromB64(FAKE_VERIFIER_B64), randomBytes(32));
    expect(server.computeB().length).toBe(N_BYTES);
  });
});
