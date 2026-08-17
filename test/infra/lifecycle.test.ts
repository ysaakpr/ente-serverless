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

/**
 * D33: prod had bucket CORS, LocalStack did not, so thumbnails rendered in the
 * cloud and silently failed locally. These two must not drift again.
 */
describe('bucket CORS guards (D33)', () => {
  /** Pull a bracketed string list that follows `key` (works for tf and TS). */
  const listAfter = (text: string, key: string): string[] => {
    const at = text.indexOf(key);
    expect(at, `missing ${key}`).toBeGreaterThan(-1);
    const open = text.indexOf('[', at);
    const close = text.indexOf(']', open);
    return text
      .slice(open + 1, close)
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  };

  const bootstrapTs = () =>
    readFileSync(join(import.meta.dirname, '../../scripts/bootstrap-local.ts'), 'utf8');

  it('the objects bucket has a CORS rule that exposes ETag (multipart needs it)', () => {
    const text = dataTf();
    expect(text).toContain('aws_s3_bucket_cors_configuration');
    expect(listAfter(text, 'expose_headers')).toEqual(['ETag']);
    expect(listAfter(text, 'allowed_methods')).toContain('GET');
  });

  it('the LocalStack bootstrap applies the SAME rule as the tofu', () => {
    const tf = dataTf();
    const ts = bootstrapTs();
    expect(listAfter(ts, 'AllowedMethods')).toEqual(listAfter(tf, 'allowed_methods'));
    expect(listAfter(ts, 'AllowedOrigins')).toEqual(listAfter(tf, 'allowed_origins'));
    expect(listAfter(ts, 'AllowedHeaders')).toEqual(listAfter(tf, 'allowed_headers'));
    expect(listAfter(ts, 'ExposeHeaders')).toEqual(listAfter(tf, 'expose_headers'));
    const maxAge = (t: string, k: string) => Number(t.match(new RegExp(`${k}:?\\s*=?\\s*(\\d+)`))![1]);
    expect(maxAge(ts, 'MaxAgeSeconds')).toBe(maxAge(tf, 'max_age_seconds'));
  });
});

/**
 * The deploy targets encode two things that are cheap to guard and expensive to
 * get wrong: plan must never run against stale bundles, and `make destroy` must
 * never be able to reach the photos.
 */
describe('deploy target guards', () => {
  const makefile = () => readFileSync(join(import.meta.dirname, '../../Makefile'), 'utf8');
  const target = (name: string) => {
    const text = makefile().replace(/\\\n\s*/g, ' ');
    const at = text.indexOf(`\n${name}:`);
    expect(at, `no ${name} target`).toBeGreaterThan(-1);
    const body = text.slice(at + 1);
    const end = body.search(/\n[a-z][a-z-]*:/);
    return end === -1 ? body : body.slice(0, end);
  };

  it('plan rebuilds the bundles first (archive_file reads dist/ at plan time)', () => {
    expect(target('plan')).toMatch(/^plan:.*build-lambda/);
  });

  it('destroy is scoped to the stateless modules only — never a bare destroy', () => {
    const body = target('destroy');
    expect(body).toContain('-target=module.compute');
    expect(body).toContain('-target=module.edge');
    expect(body, 'destroy must not touch module.data').not.toContain('-target=module.data');
  });

  it('no deploy target hardcodes a region — the tfvars file is the only source', () => {
    for (const name of ['plan', 'deploy', 'destroy']) {
      expect(target(name), `${name} hardcodes -var region=`).not.toMatch(/-var\s+region=/);
    }
  });
});

describe('lambda bundle guards (D36)', () => {
  const makefile = () => readFileSync(join(import.meta.dirname, '../../Makefile'), 'utf8');

  it('both esbuild bundles carry the createRequire shim', () => {
    // qrcode's PNG renderer calls require("fs") at runtime. Without the shim
    // the ESM bundle throws "Dynamic require of fs is not supported" — and
    // ONLY in the deployed Lambda, since local dev runs the TS directly.
    // Join make's backslash continuations so each command is one line.
    const joined = makefile().replace(/\\\n\s*/g, ' ');
    const build = joined.slice(joined.indexOf('build-lambda:'));
    const esbuildLines = build.split('\n').filter((l) => l.includes('npx esbuild'));
    expect(esbuildLines).toHaveLength(2);
    for (const line of esbuildLines) {
      expect(line, line).toContain('--banner:js=');
    }
    expect(makefile()).toMatch(/ESM_REQUIRE_SHIM\s*=.*createRequire/);
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

  it('the public Function URL also grants anonymous lambda:InvokeFunctionUrl', () => {
    // auth NONE alone 403s every caller, CloudFront included: the resource
    // policy statement is a separate resource that the console adds silently
    // and the API does not. Deleting it would look like a working plan and a
    // dead deployment.
    const compute = readFileSync(join(INFRA, 'modules/compute/main.tf'), 'utf8');
    const stmt = compute.slice(compute.indexOf('resource "aws_lambda_permission" "api_public_url"'));
    expect(stmt, 'no api_public_url permission').not.toBe('');
    const block = stmt.slice(0, stmt.indexOf('\n}'));
    expect(block).toContain('lambda:InvokeFunctionUrl');
    expect(block).toMatch(/principal\s*=\s*"\*"/);
    expect(block).toMatch(/function_url_auth_type\s*=\s*"NONE"/);
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
