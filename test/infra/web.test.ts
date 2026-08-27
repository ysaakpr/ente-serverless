/**
 * Plan-time guards for the consolidated distribution (Phase F D52,
 * consolidated D58): ONE CloudFront distribution serves both the API (at the
 * ROOT — its domain is the server_url real devices are configured with) and
 * the albums web app (default behavior, private bucket behind OAC).
 *
 * The two guards that carry the design:
 *   1. ROUTE COVERAGE — every top-level path prefix registered in src/app.ts
 *      must have a matching ordered behavior pointing at the Lambda origin,
 *      and no stale pattern may linger. A new route group added without a
 *      behavior would silently fall through to the web bucket and 200 as
 *      HTML.
 *   2. NO custom_error_response — error responses are DISTRIBUTION-WIDE, so
 *      the old SPA 403/404→index.html mapping would rewrite the API's
 *      museum-shaped 404/403 JSON into HTML for every client. SPA fallback
 *      must stay a viewer-request CloudFront function on the web behaviors
 *      only.
 *
 * Same conventions as lifecycle.test.ts: structure, never comments.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../..');
const INFRA = join(ROOT, 'src/infra');

// Like lifecycle.test.ts's stripper, with one refinement: block comments are
// matched on the `/**` doc-comment opener this repo's tf uses, never bare
// `/*` — the edge module's bucket policy contains the STRING "…arn}/*", which
// a bare-/* rule reads as a comment opener and then swallows the file up to
// the next real comment's closer.
const stripComments = (text: string): string =>
  text.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/#.*$/gm, '');

const readTf = (rel: string) => stripComments(readFileSync(join(INFRA, rel), 'utf8'));
const edgeTf = () => readTf('modules/edge/main.tf');
const computeTf = () => readTf('modules/compute/main.tf');
const makefile = () => readFileSync(join(ROOT, 'Makefile'), 'utf8');

const allTfFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === '.terraform') continue;
    if (statSync(full).isDirectory()) out.push(...allTfFiles(full));
    else if (entry.endsWith('.tf')) out.push(full);
  }
  return out;
};

/** Top-level path prefixes actually registered in src/app.ts. */
const appPrefixes = (): Set<string> => {
  const app = readFileSync(join(ROOT, 'src/app.ts'), 'utf8');
  const routes = [...app.matchAll(/app\.(?:get|post|put|delete|patch|options)\(\s*'([^']+)'/g)];
  expect(routes.length, 'route regex matched nothing — app.ts changed shape').toBeGreaterThan(30);
  return new Set(routes.map((m) => m[1]!.split('/')[1]!));
};

/** The api_path_patterns list from the edge module. */
const edgePatterns = (): string[] => {
  const text = edgeTf();
  const at = text.indexOf('api_path_patterns');
  expect(at, 'edge module has no api_path_patterns local').toBeGreaterThan(-1);
  const open = text.indexOf('[', at);
  const close = text.indexOf(']', open);
  return text
    .slice(open + 1, close)
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
};

describe('route -> behavior coverage (THE consolidation drift guard, D58)', () => {
  it('every top-level app.ts prefix has an ordered behavior pattern, and none is stale', () => {
    const prefixes = appPrefixes();
    const patterns = new Set(edgePatterns());
    for (const prefix of prefixes) {
      const want = prefix === 'ping' ? '/ping' : `/${prefix}*`;
      expect(
        patterns.has(want),
        `app.ts serves /${prefix}/* but the edge module has no "${want}" behavior — those requests would fall through to the WEB BUCKET`,
      ).toBe(true);
    }
    // The other direction: a pattern with no app.ts routes steals a slice of
    // the web app's URL space and masks the mistake as API 404s.
    for (const pattern of patterns) {
      const prefix = pattern.replace(/^\//, '').replace(/\*$/, '');
      expect(
        prefixes.has(prefix),
        `edge pattern "${pattern}" matches no app.ts route group — remove it or add the routes`,
      ).toBe(true);
    }
  });

  it('/ping is the exact match; every other pattern is the bare-prefix wildcard', () => {
    // `<prefix>*` (no slash before the star) so bare-prefix routes — POST
    // /files, POST /collections, GET /remote-store — ride the same behavior
    // as their subpaths. `/<prefix>/*` would send them to the web bucket.
    for (const pattern of edgePatterns()) {
      if (pattern === '/ping') continue;
      expect(pattern, `${pattern} must end in * (bare-prefix wildcard)`).toMatch(/^\/[a-z-]+\*$/);
    }
    expect(edgePatterns()).toContain('/ping');
  });

  it('behavior count stays comfortably under the 25-behavior default quota', () => {
    // api patterns + /index.html = all ordered behaviors; +1 default.
    expect(edgePatterns().length + 1).toBeLessThanOrEqual(20);
  });

  it('the API behaviors keep the pre-D58 API edge settings, via the one dynamic block', () => {
    const text = edgeTf();
    const dyn = text.slice(text.indexOf('dynamic "ordered_cache_behavior"'));
    expect(dyn, 'no dynamic ordered_cache_behavior block').not.toBe('');
    expect(dyn).toMatch(/for_each\s*=\s*local\.api_path_patterns/);
    const block = dyn.slice(0, dyn.indexOf('\n  }'));
    expect(block).toMatch(/target_origin_id\s*=\s*"api"/);
    expect(block).toMatch(/viewer_protocol_policy\s*=\s*"https-only"/);
    // All 7 methods — the API takes writes; the web behaviors never do.
    expect(block).toContain('"GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"');
    // CachingDisabled + AllViewerExceptHostHeader (a Function URL origin
    // must not receive the viewer Host) + managed security headers.
    expect(block).toMatch(/cache_policy_id\s*=\s*local\.managed_caching_disabled/);
    expect(block).toMatch(
      /origin_request_policy_id\s*=\s*local\.managed_all_viewer_except_host_header/,
    );
    expect(block).toMatch(
      /response_headers_policy_id\s*=\s*local\.managed_security_headers_policy_id/,
    );
    const edge = text;
    expect(edge).toContain('"4135ea2d-6df8-44a3-9df3-4b5a84be39ad"');
    expect(edge).toContain('"b689b0a8-53d0-40ab-baf2-68738e2966ac"');
  });
});

describe('one-distribution invariants (D58)', () => {
  it('exactly ONE aws_cloudfront_distribution across the entire infra', () => {
    let count = 0;
    for (const file of allTfFiles(INFRA)) {
      const text = stripComments(readFileSync(file, 'utf8'));
      count += (text.match(/resource "aws_cloudfront_distribution"/g) ?? []).length;
    }
    expect(count, 'a second distribution re-appeared — D58 consolidated to one').toBe(1);
    expect(existsSync(join(INFRA, 'modules/web')), 'modules/web is back from the dead').toBe(
      false,
    );
  });

  it('NO custom_error_response anywhere — it is distribution-wide and corrupts API 404/403 JSON', () => {
    // The load-bearing constraint of the whole consolidation: a 403/404 ->
    // /index.html mapping applies to EVERY behavior, so museum-shaped API
    // errors would come back as 200 HTML. SPA fallback must stay in the
    // viewer-request function instead.
    for (const file of allTfFiles(INFRA)) {
      const text = stripComments(readFileSync(file, 'utf8'));
      expect(text.includes('custom_error_response'), `${file} has custom_error_response`).toBe(
        false,
      );
    }
  });

  it('the SPA rewrite function exists, rewrites extensionless URIs to /index.html, and is published', () => {
    const text = edgeTf();
    const fn = text.slice(text.indexOf('resource "aws_cloudfront_function"'));
    expect(fn, 'no aws_cloudfront_function').not.toBe('');
    const block = fn.slice(0, fn.indexOf('\nresource "'));
    expect(block).toMatch(/runtime\s*=\s*"cloudfront-js-2\.0"/);
    expect(block).toMatch(/publish\s*=\s*true/);
    expect(block).toContain("indexOf('.')");
    expect(block).toContain("event.request.uri = '/index.html'");
  });

  it('the SPA function is attached to the DEFAULT behavior only, as viewer-request', () => {
    const text = edgeTf();
    const associations = text.match(/function_association/g) ?? [];
    expect(associations, 'the SPA function must associate exactly once').toHaveLength(1);
    const def = text.slice(
      text.indexOf('default_cache_behavior'),
      text.indexOf('ordered_cache_behavior'),
    );
    expect(def, 'the association must live in default_cache_behavior').toContain(
      'function_association',
    );
    expect(def).toMatch(/event_type\s*=\s*"viewer-request"/);
    expect(def).toMatch(/function_arn\s*=\s*aws_cloudfront_function\.spa_rewrite\.arn/);
  });

  it('default behavior serves the web origin with CachingOptimized; /index.html is CachingDisabled', () => {
    const text = edgeTf();
    expect(text).toMatch(/default_root_object\s*=\s*"index\.html"/);
    const def = text.slice(
      text.indexOf('default_cache_behavior'),
      text.indexOf('ordered_cache_behavior'),
    );
    expect(def).toMatch(/target_origin_id\s*=\s*"web-albums"/);
    expect(def).toMatch(/cache_policy_id\s*=\s*local\.managed_caching_optimized/);
    expect(text).toContain('"658327ea-f89d-4fab-a63d-7e88639e58f6"');
    // index.html names the current hashed assets — a stale copy 404s every
    // asset it references, so it must never cache long.
    const idx = text.slice(text.indexOf('path_pattern           = "/index.html"'));
    const idxBlock = idx.slice(0, idx.indexOf('\n  }'));
    expect(idxBlock).toMatch(/target_origin_id\s*=\s*"web-albums"/);
    expect(idxBlock).toMatch(/cache_policy_id\s*=\s*local\.managed_caching_disabled/);
  });

  it('web behaviors never expose write methods', () => {
    const text = edgeTf();
    const def = text.slice(
      text.indexOf('default_cache_behavior'),
      text.indexOf('ordered_cache_behavior'),
    );
    expect(def).not.toMatch(/"(POST|PUT|PATCH|DELETE)"/);
    const idx = text.slice(text.indexOf('path_pattern           = "/index.html"'));
    expect(idx.slice(0, idx.indexOf('\n  }'))).not.toMatch(/"(POST|PUT|PATCH|DELETE)"/);
  });
});

describe('web bucket privacy guards (D52, folded into edge by D58)', () => {
  it('the web bucket blocks all public access', () => {
    const text = edgeTf();
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

  it('no public-read ACL and no website hosting anywhere in the edge module', () => {
    // The pre-OAC S3 static-site pattern (public-read + website endpoint) is
    // exactly what OAC exists to avoid: the bucket must be reachable only
    // through the distribution.
    const text = edgeTf();
    expect(text).not.toContain('public-read');
    expect(text).not.toContain('aws_s3_bucket_website_configuration');
    expect(text).not.toContain('aws_s3_bucket_acl');
  });

  it('the bucket policy admits ONLY CloudFront, pinned to THE distribution by SourceArn', () => {
    const text = edgeTf();
    const at = text.indexOf('resource "aws_s3_bucket_policy" "web"');
    expect(at, 'no bucket policy — OAC alone grants nothing').toBeGreaterThan(-1);
    const policy = text.slice(at, text.indexOf('\n}\n', at));
    expect(policy).toContain('cloudfront.amazonaws.com');
    expect(policy).toContain('"AWS:SourceArn"');
    expect(policy).toContain('aws_cloudfront_distribution.api.arn');
    // Read-only: GetObject and nothing else.
    expect(policy).toContain('"s3:GetObject"');
    expect(policy).not.toMatch(/"s3:(Put|Delete|List)[A-Za-z]*"/);
  });

  it('the distribution reaches the bucket via OAC (sigv4, always signed); the Lambda origin never has one', () => {
    const text = edgeTf();
    const oac = text.slice(text.indexOf('resource "aws_cloudfront_origin_access_control"'));
    expect(oac, 'no OAC resource').not.toBe('');
    const oacBlock = oac.slice(0, oac.indexOf('\n}'));
    expect(oacBlock).toMatch(/origin_access_control_origin_type\s*=\s*"s3"/);
    expect(oacBlock).toMatch(/signing_behavior\s*=\s*"always"/);
    expect(oacBlock).toMatch(/signing_protocol\s*=\s*"sigv4"/);

    // The web origin: OAC, no custom_origin_config. The api origin keeps the
    // documented no-OAC posture (IAM auth breaks the POST body hash).
    const web = text.slice(text.indexOf('origin_id                = "web-albums"'));
    const webBlock = web.slice(0, web.indexOf('\n  }'));
    expect(webBlock).toMatch(
      /origin_access_control_id\s*=\s*aws_cloudfront_origin_access_control\.web\.id/,
    );
    expect(webBlock).not.toContain('custom_origin_config');
  });

  it('the web bucket is the destroyable kind — never the objects bucket pattern', () => {
    // Build artifacts only: force_destroy so `make destroy` works, and
    // certainly no prevent_destroy. The inverse guard (objects bucket HAS
    // delete protection) lives in lifecycle.test.ts.
    const text = edgeTf();
    const at = text.indexOf('resource "aws_s3_bucket" "web"');
    expect(at, 'no web bucket in the edge module').toBeGreaterThan(-1);
    const block = text.slice(at, text.indexOf('\n}', at));
    expect(block).toMatch(/force_destroy\s*=\s*true/);
    expect(text).not.toContain('prevent_destroy');
  });
});

describe('ALBUMS_URL wiring (D51/D52, consolidated D58)', () => {
  it('ALBUMS_URL reaches the API lambda from a required variable', () => {
    expect(computeTf()).toMatch(/ALBUMS_URL\s*=\s*var\.albums_url/);
    const vars = readTf('modules/compute/variables.tf');
    const decl = vars.slice(vars.indexOf('variable "albums_url"'));
    expect(decl, 'compute has no albums_url variable').not.toBe('');
    // No default, deliberately: a silently-wrong fallback would mint share
    // links pointing at ente's own albums.ente.com (config.ts's default).
    expect(decl.slice(0, decl.indexOf('\n}'))).not.toContain('default');
  });

  it('both envs wire ALBUMS_URL as tfvars-override -> make-injected hint -> loud sentinel', () => {
    // The albums app rides the SAME distribution as the API, so the right
    // value is the distribution's own URL — which tofu cannot reference from
    // the lambda env (lambda -> distribution -> function URL -> lambda is a
    // cycle). `make plan` injects the previous apply's server_url as
    // albums_url_hint; the fallback must be LOUDLY broken (.invalid), never
    // a silently-wrong host.
    for (const env of ['dev', 'test']) {
      const main = readTf(`${env}/main.tf`);
      expect(main, `${env} lost the albums_url coalesce`).toMatch(
        /albums_url\s*=\s*coalesce\(\s*var\.albums_url,\s*var\.albums_url_hint,\s*"https:\/\/albums-url-pending\.invalid",?\s*\)/,
      );
      expect(main).toMatch(/albums_url\s*=\s*local\.albums_url/);
      const vars = readTf(`${env}/variables.tf`);
      const hint = vars.slice(vars.indexOf('variable "albums_url_hint"'));
      expect(hint, `${env} lacks the albums_url_hint variable`).not.toBe('');
      expect(hint.slice(0, hint.indexOf('\n}'))).toMatch(/default\s*=\s*""/);
      expect(vars).toContain('variable "albums_url"');
    }
  });

  it('make plan injects the hint from the profile state server_url output', () => {
    const text = makefile().replace(/\\\n\s*/g, ' ');
    const at = text.indexOf('\nplan:');
    const body = text.slice(at + 1, at + text.slice(at + 1).search(/\n[a-z][a-z-]*:/) + 1);
    expect(body).toContain('output -raw server_url');
    expect(body).toContain('albums_url_hint=');
  });

  it('the env roots stay verbatim-identical (D57 discipline)', () => {
    for (const file of ['main.tf', 'variables.tf', 'outputs.tf', 'versions.tf']) {
      const dev = readFileSync(join(INFRA, 'dev', file), 'utf8');
      const test = readFileSync(join(INFRA, 'test', file), 'utf8');
      expect(dev, `${file} drifted between dev and test`).toBe(test);
    }
  });

  it('the module-move is a moved-block refactor, never destroy-and-recreate', () => {
    // The bucket (and its synced content), its policy/access block, and the
    // OAC moved from the deleted modules/web into modules/edge. Without the
    // moved blocks the plan destroys and recreates them — same-name bucket
    // churn and an albums outage for nothing.
    const main = readFileSync(join(INFRA, 'dev/main.tf'), 'utf8');
    for (const res of [
      'aws_s3_bucket.web',
      'aws_s3_bucket_public_access_block.web',
      'aws_s3_bucket_policy.web',
      'aws_cloudfront_origin_access_control.web',
    ]) {
      expect(main, `no moved block for ${res}`).toMatch(
        new RegExp(
          `moved\\s*{\\s*from\\s*=\\s*module\\.web\\.${res.replace(/\./g, '\\.')}\\s*to\\s*=\\s*module\\.edge\\.${res.replace(/\./g, '\\.')}`,
        ),
      );
    }
  });

  it('the public presign knob and the per-link ceilings reach the lambda env', () => {
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
    // web ACL, rate rule present, nothing byte-matched, and the
    // /public-collection prefix riding an API behavior of THAT distribution.
    // The per-link bounds live in the app (D51 ceilings), not here.
    const edge = edgeTf();
    expect(edge).toContain('rate_based_statement');
    expect(edge).not.toContain('byte_match_statement');
    expect(edge).toMatch(/web_acl_id\s*=\s*aws_wafv2_web_acl\.api\.arn/);
    expect(edgePatterns()).toContain('/public-collection*');
  });

  it('the FREE-plan constraint is documented where the operator reads costs', () => {
    const doc = readFileSync(join(ROOT, 'AWS-RESOURCES.md'), 'utf8');
    expect(doc).toContain('/public-collection');
  });
});

describe('albums build pin + deploy target guards (D52/D58)', () => {
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

  it('deploy-web is guarded and invalidates the ONE consolidated distribution', () => {
    const body = target('deploy-web');
    expect(body).toMatch(/^deploy-web:.*guard-account/);
    expect(body).toContain('s3 sync');
    expect(body).toContain('create-invalidation');
    // The sync must address outputs, never a hardcoded bucket/distribution —
    // and since D58 the invalidation targets the consolidated distribution.
    expect(body).toContain('output -raw web_bucket');
    expect(body).toContain('output -raw distribution_id');
    expect(body).not.toContain('web_distribution_id');
  });

  it('destroy covers the consolidated stateless modules and still never module.data', () => {
    const body = target('destroy');
    expect(body).toContain('-target=module.compute');
    expect(body).toContain('-target=module.edge');
    expect(body).not.toContain('module.web');
    expect(body).not.toContain('-target=module.data');
  });

  it('the deployer policy can manage the OAC, the SPA function, and the invalidation', () => {
    const policy = JSON.parse(readFileSync(join(INFRA, 'deployer-policy.json'), 'utf8')) as {
      Statement: Array<{ Effect: string; Action: string[] }>;
    };
    const allowed = policy.Statement.filter((s) => s.Effect === 'Allow').flatMap((s) => s.Action);
    for (const action of [
      'cloudfront:CreateOriginAccessControl',
      'cloudfront:DeleteOriginAccessControl',
      'cloudfront:CreateInvalidation',
      'cloudfront:CreateFunction',
      'cloudfront:UpdateFunction',
      'cloudfront:DeleteFunction',
      'cloudfront:PublishFunction',
      'cloudfront:DescribeFunction',
    ]) {
      expect(allowed, `deployer cannot ${action}`).toContain(action);
    }
  });

  it('dist/ (and so dist/web-albums) stays out of git', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    expect(ignore).toMatch(/^dist\/$/m);
  });
});
