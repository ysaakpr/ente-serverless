/**
 * Plan-time guard tests over the tofu config (build plan: land with the infra
 * milestone): GLACIER_IR — never DEEP_ARCHIVE — and only via the tier=original
 * tag; thumbs/file-data (untagged) must have NO transition rule; multipart
 * abort sweep exists; TTL enabled; Function URL auth NONE.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const INFRA = join(import.meta.dirname, '../../src/infra');

const allTfFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...allTfFiles(full));
    else if (entry.endsWith('.tf')) out.push(full);
  }
  return out;
};

const allTf = () => allTfFiles(INFRA).map((f) => ({ file: f, text: readFileSync(f, 'utf8') }));
const dataTf = () => readFileSync(join(INFRA, 'modules/data/main.tf'), 'utf8');

describe('storage-class guards (GIR-only decision, 2026-08-16)', () => {
  it('no DEEP_ARCHIVE anywhere in the infra', () => {
    for (const { file, text } of allTf()) {
      expect(text.includes('DEEP_ARCHIVE'), `${file} mentions DEEP_ARCHIVE`).toBe(false);
    }
  });

  it('originals transition to GLACIER_IR at day 0, selected by tag tier=original', () => {
    const text = dataTf();
    expect(text).toContain('GLACIER_IR');
    const rule = text.slice(text.indexOf('originals-to-glacier-ir'));
    const filterBlock = rule.slice(0, rule.indexOf('transition'));
    expect(filterBlock).toMatch(/tag\s*{/);
    expect(filterBlock).toContain('"tier"');
    expect(filterBlock).toContain('"original"');
    const transitionBlock = rule.slice(rule.indexOf('transition'), rule.indexOf('}', rule.indexOf('storage_class')));
    expect(transitionBlock).toMatch(/days\s*=\s*0/);
  });

  it('exactly one transition rule — untagged thumbs/file-data stay Standard', () => {
    const matches = dataTf().match(/storage_class\s*=/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('abandoned multipart uploads are swept', () => {
    expect(dataTf()).toContain('abort_incomplete_multipart_upload');
  });
});

describe('table + compute guards', () => {
  it('DynamoDB TTL is enabled on the ttl attribute (OTT/session expiry)', () => {
    const text = dataTf();
    expect(text).toMatch(/ttl\s*{[^}]*attribute_name\s*=\s*"ttl"[^}]*enabled\s*=\s*true/s);
  });

  it('the Function URL uses auth NONE (CloudFront is the canonical path)', () => {
    const compute = readFileSync(join(INFRA, 'modules/compute/main.tf'), 'utf8');
    expect(compute).toContain('authorization_type = "NONE"');
  });

  it('stateful resources carry prevent_destroy', () => {
    const text = dataTf();
    const count = (text.match(/prevent_destroy = true/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2); // table + objects bucket
  });

  it('deployer policy is valid JSON scoped to ente-sl-*', () => {
    const policy = JSON.parse(readFileSync(join(INFRA, 'deployer-policy.json'), 'utf8')) as {
      Statement: Array<{ Resource: string | string[] }>;
    };
    expect(policy.Statement.length).toBeGreaterThan(4);
    const resources = policy.Statement.flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]));
    expect(resources.some((r) => r.includes('ente-sl-'))).toBe(true);
  });
});
