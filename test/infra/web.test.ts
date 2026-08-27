/**
 * Plan-time guards for the albums web hosting (Phase F, D52): the static
 * bucket must stay private behind OAC, the SPA fallback must exist (a broken
 * fallback renders every deep link as XML AccessDenied), the Lambda must
 * carry ALBUMS_URL (or minted share links point at ente's own albums.ente.com),
 * and the pinned albums release must agree between the Makefile and
 * ORACLE-VERSION. Same conventions as lifecycle.test.ts: structure, never
 * comments.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../..');
const INFRA = join(ROOT, 'src/infra');

// Like lifecycle.test.ts's stripper, with one refinement: block comments are
// matched on the `/**` doc-comment opener this repo's tf uses, never bare
// `/*` — the web module's bucket policy contains the STRING "…arn}/*", which
// a bare-/* rule reads as a comment opener and then swallows the file up to
// the next real comment's closer.
const stripComments = (text: string): string =>
  text.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/#.*$/gm, '');

const readTf = (rel: string) => stripComments(readFileSync(join(INFRA, rel), 'utf8'));
const webTf = () => readTf('modules/web/main.tf');
const computeTf = () => readTf('modules/compute/main.tf');
const devTf = () => readTf('dev/main.tf');
const makefile = () => readFileSync(join(ROOT, 'Makefile'), 'utf8');

describe('web bucket privacy guards (D52)', () => {
  it('the web bucket blocks all public access', () => {
    const text = webTf();
    const at = text.indexOf('resource "aws_s3_bucket_public_access_block" "web"');
    expect(at, 'web bucket has no public access block').toBeGreaterThan(-1);
    const block = text.slice(at, text.indexOf('\n}', at));
    for (const key of [
      'block_public_acls',
      'block_public_policy',
      'ignore_public_acls',
      'restrict_public_buckets',
    ]) {
      expect(block).toMatch(new RegExp(`${key}\\s*=\\s*true`));
    }
  });

  it('no public-read ACL and no website hosting anywhere in the web module', () => {
    // The pre-OAC S3 static-site pattern (public-read + website endpoint) is
    // exactly what this module exists to avoid: the bucket must be reachable
    // only through the distribution.
    const text = webTf();
    expect(text).not.toContain('public-read');
    expect(text).not.toContain('aws_s3_bucket_website_configuration');
    expect(text).not.toContain('aws_s3_bucket_acl');
  });

  it('the bucket policy admits ONLY CloudFront, pinned to this distribution by SourceArn', () => {
    const text = webTf();
    const at = text.indexOf('resource "aws_s3_bucket_policy" "web"');
    expect(at, 'no bucket policy — OAC alone grants nothing').toBeGreaterThan(-1);
    const policy = text.slice(at);
    expect(policy).toContain('cloudfront.amazonaws.com');
    expect(policy).toContain('"AWS:SourceArn"');
    expect(policy).toContain('aws_cloudfront_distribution.web.arn');
    // Read-only: GetObject and nothing else.
    expect(policy).toContain('"s3:GetObject"');
    expect(policy).not.toMatch(/"s3:(Put|Delete|List)[A-Za-z]*"/);
  });

  it('the distribution reaches the bucket via OAC (sigv4, always signed)', () => {
    const text = webTf();
    const oac = text.slice(text.indexOf('resource "aws_cloudfront_origin_access_control"'));
    expect(oac, 'no OAC resource').not.toBe('');
    const oacBlock = oac.slice(0, oac.indexOf('\n}'));
    expect(oacBlock).toMatch(/origin_access_control_origin_type\s*=\s*"s3"/);
    expect(oacBlock).toMatch(/signing_behavior\s*=\s*"always"/);
    expect(oacBlock).toMatch(/signing_protocol\s*=\s*"sigv4"/);

    const origin = text.slice(text.indexOf('origin {'));
    expect(origin).toMatch(
      /origin_access_control_id\s*=\s*aws_cloudfront_origin_access_control\.web\.id/,
    );
    // The API distribution's no-OAC rationale (POST body hash) is about the
    // LAMBDA origin — an S3 origin must never ship without OAC.
    expect(origin).not.toContain('custom_origin_config');
  });

  it('the web bucket is the destroyable kind — never the objects bucket pattern', () => {
    // Build artifacts only: force_destroy so `make destroy` works, and
    // certainly no prevent_destroy. The inverse guard (objects bucket HAS
    // prevent_destroy) lives in lifecycle.test.ts.
    const text = webTf();
    expect(text).toMatch(/force_destroy\s*=\s*true/);
    expect(text).not.toContain('prevent_destroy');
  });
});

describe('SPA routing + cache split guards (D52)', () => {
  it('403 AND 404 fall back to /index.html with a 200 (uncached)', () => {
    // OAC without ListBucket surfaces a missing key as 403, so both codes
    // must map or deep links break depending on an IAM detail.
    const text = webTf();
    for (const code of [403, 404]) {
      const at = text.indexOf(`error_code            = ${code}`);
      const loose = text.search(new RegExp(`error_code\\s*=\\s*${code}`));
      expect(loose, `no custom_error_response for ${code}`).toBeGreaterThan(-1);
      const block = text.slice(loose === -1 ? at : loose, text.indexOf('}', loose));
      expect(block).toMatch(/response_code\s*=\s*200/);
      expect(block).toMatch(/response_page_path\s*=\s*"\/index\.html"/);
      expect(block).toMatch(/error_caching_min_ttl\s*=\s*0/);
    }
  });

  it('hashed assets cache long, index.html does not', () => {
    const text = webTf();
    // Managed CachingOptimized on the default behavior…
    expect(text).toContain('"658327ea-f89d-4fab-a63d-7e88639e58f6"');
    const def = text.slice(text.indexOf('default_cache_behavior'));
    expect(def.slice(0, def.indexOf('ordered_cache_behavior'))).toMatch(
      /cache_policy_id\s*=\s*local\.managed_caching_optimized/,
    );
    // …and Managed CachingDisabled pinned to /index.html, which names the
    // current hashed assets: a stale copy 404s everything it references.
    expect(text).toContain('"4135ea2d-6df8-44a3-9df3-4b5a84be39ad"');
    const ordered = text.slice(text.indexOf('ordered_cache_behavior'));
    expect(ordered).toMatch(/path_pattern\s*=\s*"\/index\.html"/);
    expect(ordered).toMatch(/cache_policy_id\s*=\s*local\.managed_caching_disabled/);
  });

  it('the distribution serves index.html at the root and only ever GET/HEAD/OPTIONS', () => {
    const text = webTf();
    expect(text).toMatch(/default_root_object\s*=\s*"index\.html"/);
    expect(text).not.toMatch(/"(POST|PUT|PATCH|DELETE)"/);
  });
});

describe('lambda env carries the Phase D/F knobs (D51/D52)', () => {
  it('ALBUMS_URL reaches the API lambda from a required variable', () => {
    expect(computeTf()).toMatch(/ALBUMS_URL\s*=\s*var\.albums_url/);
    const vars = readTf('modules/compute/variables.tf');
    const decl = vars.slice(vars.indexOf('variable "albums_url"'));
    expect(decl, 'compute has no albums_url variable').not.toBe('');
    // No default, deliberately: a silently-wrong fallback would mint share
    // links pointing at ente's own albums.ente.com (config.ts's default).
    expect(decl.slice(0, decl.indexOf('\n}'))).not.toContain('default');
  });

  it('the dev env wires the web module distribution into ALBUMS_URL (tfvars can override)', () => {
    const dev = devTf();
    expect(dev).toContain('module "web"');
    expect(dev).toMatch(/albums_url\s*=\s*coalesce\(var\.albums_url,\s*module\.web\.albums_url\)/);
    const devVars = readTf('dev/variables.tf');
    expect(devVars).toContain('variable "albums_url"');
  });

  it('the public presign knob and both per-link ceilings reach the lambda env', () => {
    const text = computeTf();
    expect(text).toMatch(
      /PRESIGN_PUBLIC_GET_EXPIRY_SECONDS\s*=\s*tostring\(var\.presign_public_get_expiry_seconds\)/,
    );
    expect(text).toMatch(
      /PUBLIC_LINK_DAILY_DOWNLOADS\s*=\s*tostring\(var\.public_link_daily_downloads\)/,
    );
    expect(text).toMatch(
      /PUBLIC_LINK_DAILY_UPLOADS\s*=\s*tostring\(var\.public_link_daily_uploads\)/,
    );
    expect(text).toMatch(
      /PUBLIC_LINK_DAILY_DEVICES\s*=\s*tostring\(var\.public_link_daily_devices\)/,
    );
  });

  it('tofu defaults agree with config.ts (the D11 discipline)', () => {
    const config = readFileSync(join(ROOT, 'src/config.ts'), 'utf8');
    const configDefault = (envName: string): number => {
      const m = config.match(new RegExp(`${envName}\\s*\\?\\?\\s*([0-9_]+)`));
      expect(m, `config.ts has no ${envName} default`).not.toBeNull();
      return Number(m![1]!.replace(/_/g, ''));
    };
    const tfDefault = (rel: string, name: string): number => {
      const tf = readTf(rel);
      const decl = tf.slice(tf.indexOf(`variable "${name}"`));
      expect(decl, `${rel} has no variable ${name}`).not.toBe('');
      return Number(decl.match(/default\s*=\s*(\d+)/)![1]);
    };
    for (const [env, name] of [
      ['PRESIGN_PUBLIC_GET_EXPIRY_SECONDS', 'presign_public_get_expiry_seconds'],
      ['PUBLIC_LINK_DAILY_DOWNLOADS', 'public_link_daily_downloads'],
      ['PUBLIC_LINK_DAILY_UPLOADS', 'public_link_daily_uploads'],
      ['PUBLIC_LINK_DAILY_DEVICES', 'public_link_daily_devices'],
    ] as const) {
      const want = configDefault(env);
      // Both declarations must agree: dev/variables.tf is the tfvars
      // pass-through, compute/variables.tf is what actually deploys.
      expect(tfDefault('modules/compute/variables.tf', name), `compute ${name}`).toBe(want);
      expect(tfDefault('dev/variables.tf', name), `dev ${name}`).toBe(want);
    }
  });
});

describe('/public-collection edge posture (plan §4.1a, D52)', () => {
  it('the anonymous surface sits behind the (unscoped, FREE-tier) WAF rate rule', () => {
    // A path-scoped rate rule needs a byte-match scope-down, which the D47
    // FREE pricing plan gates — so the guarantee is: ONE distribution, ONE
    // web ACL, rate rule present, nothing byte-matched. The per-link bounds
    // live in the app (D51 ceilings), not here.
    const edge = readTf('modules/edge/main.tf');
    expect(edge).toContain('rate_based_statement');
    expect(edge).not.toContain('byte_match_statement');
    expect(edge).toMatch(/web_acl_id\s*=\s*aws_wafv2_web_acl\.api\.arn/);
    // The public routes must ride the API distribution — the web module must
    // NOT grow an API origin that would bypass the ACL.
    expect(webTf()).not.toContain('lambda');
  });

  it('the FREE-plan constraint is documented where the operator reads costs', () => {
    const doc = readFileSync(join(ROOT, 'AWS-RESOURCES.md'), 'utf8');
    expect(doc).toContain('/public-collection');
  });
});

describe('albums build pin + deploy target guards (D52)', () => {
  const target = (name: string) => {
    const text = makefile().replace(/\\\n\s*/g, ' ');
    const at = text.indexOf(`\n${name}:`);
    expect(at, `no ${name} target`).toBeGreaterThan(-1);
    const body = text.slice(at + 1);
    const end = body.search(/\n[a-z][a-z-]*:/);
    return end === -1 ? body : body.slice(0, end);
  };

  it('the albums release is pinned, and Makefile + ORACLE-VERSION agree on the tag', () => {
    const tag = makefile().match(/^ALBUMS_WEB_TAG\s*=\s*(\S+)/m)?.[1];
    expect(tag, 'Makefile has no ALBUMS_WEB_TAG pin').toBeTruthy();
    // photos-v* is the tag family that carries the albums app (it has none of
    // its own); "main" or a bare version here would un-pin the second client.
    expect(tag).toMatch(/^photos-v\d+\.\d+\.\d+$/);
    const oracle = readFileSync(join(ROOT, 'ORACLE-VERSION'), 'utf8');
    expect(oracle, `ORACLE-VERSION does not record ${tag!}`).toContain(tag!);
  });

  it('build-web builds AT the pin and bakes the endpoint in at build time', () => {
    const body = target('build-web');
    expect(body).toContain('--branch $(ALBUMS_WEB_TAG)');
    expect(body).toContain('NEXT_PUBLIC_ENTE_ENDPOINT');
    expect(body).toContain('build:albums');
    expect(body).toContain('dist/web-albums');
  });

  it('deploy-web is guarded like every other state-mutating target', () => {
    const body = target('deploy-web');
    expect(body).toMatch(/^deploy-web:.*guard-account/);
    expect(body).toContain('s3 sync');
    expect(body).toContain('create-invalidation');
    // The sync must address outputs, never a hardcoded bucket/distribution.
    expect(body).toContain('output -raw web_bucket');
    expect(body).toContain('output -raw web_distribution_id');
  });

  it('destroy covers module.web (rebuildable) and still never module.data', () => {
    const body = target('destroy');
    expect(body).toContain('-target=module.web');
    expect(body).not.toContain('-target=module.data');
  });

  it('the deployer policy can create the OAC and run the invalidation', () => {
    const policy = JSON.parse(readFileSync(join(INFRA, 'deployer-policy.json'), 'utf8')) as {
      Statement: Array<{ Effect: string; Action: string[] }>;
    };
    const allowed = policy.Statement.filter((s) => s.Effect === 'Allow').flatMap((s) => s.Action);
    for (const action of [
      'cloudfront:CreateOriginAccessControl',
      'cloudfront:DeleteOriginAccessControl',
      'cloudfront:CreateInvalidation',
    ]) {
      expect(allowed, `deployer cannot ${action}`).toContain(action);
    }
  });

  it('dist/ (and so dist/web-albums) stays out of git', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    expect(ignore).toMatch(/^dist\/$/m);
  });
});
