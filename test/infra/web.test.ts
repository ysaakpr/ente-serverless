/**
 * Plan-time guards for the consolidated distribution (Phase F D52,
 * consolidated D58, layout inverted D60): ONE CloudFront distribution serves
 * both the API (the DEFAULT behavior — its domain is the server_url real
 * devices are configured with) and the albums web app (the single /albums*
 * ordered behavior, private bucket behind OAC, assets under the albums/ key
 * prefix).
 *
 * The guards that carry the design:
 *   1. FREE-TIER BEHAVIOR CEILING — the CloudFront flat-rate FREE pricing
 *      plan allows AT MOST 5 cache behaviors per distribution. The first
 *      D58 cut (17 behaviors: web default + /index.html + 15 API prefixes)
 *      was refused at subscription time with the exact error:
 *      "You're using configuration not available in this tier:
 *       17 cache behaviors (limit 5)".
 *      Hence the inversion: API on the default behavior (new route groups
 *      need NO edge change, unknown paths 404 museum-shaped from the app),
 *      /albums* as the one web-facing pattern. Total here: 2.
 *   2. NAMESPACE — /albums* is the only pattern the web bucket owns, so
 *      src/app.ts must never register an /albums route group (museum has
 *      none): the ordered behavior would shadow it.
 *   3. NO custom_error_response — error responses are DISTRIBUTION-WIDE, so
 *      the old SPA 403/404→index.html mapping would rewrite the API's
 *      museum-shaped 404/403 JSON into HTML for every client. SPA fallback
 *      must stay a viewer-request CloudFront function on /albums* only.
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

/** Every route path registered in src/app.ts. */
const appRoutes = (): string[] => {
  const app = readFileSync(join(ROOT, 'src/app.ts'), 'utf8');
  const routes = [...app.matchAll(/app\.(?:get|post|put|delete|patch|options)\(\s*'([^']+)'/g)];
  expect(routes.length, 'route regex matched nothing — app.ts changed shape').toBeGreaterThan(30);
  return routes.map((m) => m[1]!);
};

/** The default_cache_behavior block of the one distribution. */
const defaultBehavior = (): string => {
  const text = edgeTf();
  const at = text.indexOf('default_cache_behavior');
  expect(at, 'no default_cache_behavior').toBeGreaterThan(-1);
  return text.slice(at, text.indexOf('\n  }', at));
};

/** Every ordered_cache_behavior block (there should be exactly one). */
const orderedBehaviors = (): string[] => {
  const text = edgeTf();
  const out: string[] = [];
  let at = text.indexOf('ordered_cache_behavior');
  while (at !== -1) {
    out.push(text.slice(at, text.indexOf('\n  }\n', at)));
    at = text.indexOf('ordered_cache_behavior', at + 1);
  }
  return out;
};

describe('FREE-tier behavior ceiling (THE D60 constraint)', () => {
  it('total cache behaviors (default + ordered) stay at or under the FREE-plan limit of 5', () => {
    // The pricing-plan subscription refuses more, verbatim: "You're using
    // configuration not available in this tier: 17 cache behaviors
    // (limit 5)". This is a HARD ceiling for the $0 plan (D47/D60), not the
    // 25-behavior soft quota.
    const text = edgeTf();
    const ordered = (text.match(/ordered_cache_behavior/g) ?? []).length;
    const defaults = (text.match(/default_cache_behavior/g) ?? []).length;
    expect(defaults, 'exactly one default behavior').toBe(1);
    expect(
      ordered + defaults,
      'behavior count exceeds the FREE pricing-plan ceiling of 5 — the subscription will refuse',
    ).toBeLessThanOrEqual(5);
    // Target shape is 2 (default → API, /albums* → web); growing past that
    // should be a conscious decision, not drift.
    expect(ordered + defaults).toBe(2);
    // The route table must stay decoupled from the edge: no dynamic
    // per-prefix behaviors may reappear (that is what hit the ceiling).
    expect(text).not.toContain('api_path_patterns');
  });

  it('the DEFAULT behavior is the API, byte-identical to the pre-D58 API edge settings', () => {
    const def = defaultBehavior();
    expect(def).toMatch(/target_origin_id\s*=\s*"api"/);
    expect(def).toMatch(/viewer_protocol_policy\s*=\s*"https-only"/);
    // All 7 methods — the API takes writes; the web behavior never does.
    expect(def).toContain('"GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"');
    // CachingDisabled + AllViewerExceptHostHeader (a Function URL origin
    // must not receive the viewer Host) + managed security headers.
    expect(def).toMatch(/cache_policy_id\s*=\s*local\.managed_caching_disabled/);
    expect(def).toMatch(/origin_request_policy_id\s*=\s*local\.managed_all_viewer_except_host_header/);
    expect(def).toMatch(/response_headers_policy_id\s*=\s*local\.managed_security_headers_policy_id/);
    const edge = edgeTf();
    expect(edge).toContain('"4135ea2d-6df8-44a3-9df3-4b5a84be39ad"');
    expect(edge).toContain('"b689b0a8-53d0-40ab-baf2-68738e2966ac"');
    // The API must sit on the DEFAULT behavior so unknown paths reach the
    // Lambda and 404 museum-shaped — never the web bucket.
    expect(def).not.toContain('function_association');
  });

  it('/albums* is the ONLY web-facing pattern, GET/HEAD, CachingOptimized, compressed', () => {
    const ordered = orderedBehaviors();
    expect(ordered, 'exactly one ordered behavior — /albums*').toHaveLength(1);
    const web = ordered[0]!;
    expect(web).toMatch(/path_pattern\s*=\s*"\/albums\*"/);
    expect(web).toMatch(/target_origin_id\s*=\s*"web-albums"/);
    expect(web).toMatch(/cache_policy_id\s*=\s*local\.managed_caching_optimized/);
    expect(web).toMatch(/response_headers_policy_id\s*=\s*local\.managed_security_headers_policy_id/);
    expect(web).toMatch(/compress\s*=\s*true/);
    expect(web).not.toMatch(/"(POST|PUT|PATCH|DELETE)"/);
    expect(edgeTf()).toContain('"658327ea-f89d-4fab-a63d-7e88639e58f6"');
  });

  it('src/app.ts registers NO route under /albums — the ordered behavior would shadow it', () => {
    // Museum has no /albums route group today; this keeps it that way. If
    // one ever appears upstream, the web app needs a different base path —
    // an explicit decision, not a silent shadowing.
    for (const route of appRoutes()) {
      expect(
        route === '/albums' || route.startsWith('/albums/'),
        `app.ts route ${route} collides with the /albums* web behavior — CloudFront would never send it to the Lambda`,
      ).toBe(false);
    }
  });

  it('no default_root_object — `/` belongs to the API (museum-shaped 404), not the web bucket', () => {
    expect(edgeTf()).not.toContain('default_root_object');
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
    // index.html mapping applies to EVERY behavior, so museum-shaped API
    // errors would come back as 200 HTML. SPA fallback must stay in the
    // viewer-request function instead.
    for (const file of allTfFiles(INFRA)) {
      const text = stripComments(readFileSync(file, 'utf8'));
      expect(text.includes('custom_error_response'), `${file} has custom_error_response`).toBe(
        false,
      );
    }
  });

  it('the SPA rewrite function exists, rewrites extensionless URIs to /albums/index.html, and is published', () => {
    const text = edgeTf();
    const fn = text.slice(text.indexOf('resource "aws_cloudfront_function"'));
    expect(fn, 'no aws_cloudfront_function').not.toBe('');
    const block = fn.slice(0, fn.indexOf('\nresource "'));
    expect(block).toMatch(/runtime\s*=\s*"cloudfront-js-2\.0"/);
    expect(block).toMatch(/publish\s*=\s*true/);
    expect(block).toContain("indexOf('.')");
    // The rewrite target carries the albums/ key prefix (bare /albums and
    // /albums/ are extensionless too, so both land on the app shell).
    expect(block).toContain("event.request.uri = '/albums/index.html'");
    expect(block).not.toContain("= '/index.html'");
  });

  it('the SPA function is attached to the /albums* behavior ONLY, as viewer-request', () => {
    const text = edgeTf();
    const associations = text.match(/function_association/g) ?? [];
    expect(associations, 'the SPA function must associate exactly once').toHaveLength(1);
    const web = orderedBehaviors()[0]!;
    expect(web, 'the association must live in the /albums* ordered behavior').toContain(
      'function_association',
    );
    expect(web).toMatch(/event_type\s*=\s*"viewer-request"/);
    expect(web).toMatch(/function_arn\s*=\s*aws_cloudfront_function\.spa_rewrite\.arn/);
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
    // Read-only: GetObject and nothing else. The grant covers the whole
    // bucket, so the albums/ key prefix (D60) needs no policy change.
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

    // The web origin: OAC, no custom_origin_config, and no origin_path — the
    // /albums* URI maps onto the albums/ KEY PREFIX verbatim (deploy-web
    // syncs there), so a path rewrite has nowhere to drift.
    const web = text.slice(text.indexOf('origin_id                = "web-albums"'));
    const webBlock = web.slice(0, web.indexOf('\n  }'));
    expect(webBlock).toMatch(
      /origin_access_control_id\s*=\s*aws_cloudfront_origin_access_control\.web\.id/,
    );
    expect(webBlock).not.toContain('custom_origin_config');
    expect(webBlock).not.toContain('origin_path');
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

describe('ALBUMS_URL wiring (D51/D52, consolidated D58, /albums suffix D60)', () => {
  it('ALBUMS_URL reaches the API lambda from a required variable', () => {
    expect(computeTf()).toMatch(/ALBUMS_URL\s*=\s*var\.albums_url/);
    const vars = readTf('modules/compute/variables.tf');
    const decl = vars.slice(vars.indexOf('variable "albums_url"'));
    expect(decl, 'compute has no albums_url variable').not.toBe('');
    // No default, deliberately: a silently-wrong fallback would mint share
    // links pointing at ente's own albums.ente.com (config.ts's default).
    expect(decl.slice(0, decl.indexOf('\n}'))).not.toContain('default');
  });

  it('both envs wire ALBUMS_URL as tfvars-override -> hint + /albums -> loud sentinel', () => {
    // The albums app rides the SAME distribution as the API under /albums*
    // (D60), so the right value is the distribution's own URL + /albums —
    // tofu cannot reference the domain from the lambda env (lambda ->
    // distribution -> function URL -> lambda is a cycle), so `make plan`
    // injects the previous apply's server_url as albums_url_hint and the
    // /albums suffix is appended HERE, where the value is composed. The
    // fallback must be LOUDLY broken (.invalid), never a silently-wrong
    // host; the tfvars albums_url (custom domain) passes through VERBATIM —
    // no suffix.
    for (const env of ['dev', 'test']) {
      const main = readTf(`${env}/main.tf`);
      expect(main, `${env} lost the albums_url coalesce`).toMatch(
        /albums_url\s*=\s*coalesce\(\s*var\.albums_url,\s*var\.albums_url_hint != "" \? "\$\{var\.albums_url_hint\}\/albums" : "",\s*"https:\/\/albums-url-pending\.invalid\/albums",?\s*\)/,
      );
      expect(main).toMatch(/albums_url\s*=\s*local\.albums_url/);
      const vars = readTf(`${env}/variables.tf`);
      const hint = vars.slice(vars.indexOf('variable "albums_url_hint"'));
      expect(hint, `${env} lacks the albums_url_hint variable`).not.toBe('');
      expect(hint.slice(0, hint.indexOf('\n}'))).toMatch(/default\s*=\s*""/);
      expect(vars).toContain('variable "albums_url"');
    }
  });

  it("the edge module's albums_url output carries the /albums suffix too", () => {
    const outputs = readFileSync(join(INFRA, 'modules/edge/outputs.tf'), 'utf8');
    expect(outputs).toContain(
      '"https://${aws_cloudfront_distribution.api.domain_name}/albums"',
    );
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
    // OAC moved from the deleted modules/web into modules/edge (D58).
    // Without the moved blocks the plan destroys and recreates them —
    // same-name bucket churn and an albums outage for nothing.
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

describe('/public-collection edge posture (plan §4.1a, D52/D60)', () => {
  it('the anonymous surface sits behind the (unscoped, FREE-tier) WAF rate rule', () => {
    // A path-scoped rate rule needs a byte-match scope-down, which the D47
    // FREE pricing plan gates — so the guarantee is: ONE distribution, ONE
    // web ACL, rate rule present, nothing byte-matched, and the
    // /public-collection routes riding the DEFAULT (API) behavior of THAT
    // distribution (D60 — no per-prefix behaviors anymore). The per-link
    // bounds live in the app (D51 ceilings), not here.
    const edge = edgeTf();
    expect(edge).toContain('rate_based_statement');
    expect(edge).not.toContain('byte_match_statement');
    expect(edge).toMatch(/web_acl_id\s*=\s*aws_wafv2_web_acl\.api\.arn/);
    expect(appRoutes().some((r) => r.startsWith('/public-collection'))).toBe(true);
    expect(defaultBehavior()).toMatch(/target_origin_id\s*=\s*"api"/);
  });

  it('the FREE-plan constraint is documented where the operator reads costs', () => {
    const doc = readFileSync(join(ROOT, 'AWS-RESOURCES.md'), 'utf8');
    expect(doc).toContain('/public-collection');
  });
});

describe('albums build pin + deploy target guards (D52/D58/D60)', () => {
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

  it('build-web builds AT the pin, bakes the endpoint in, and patches basePath=/albums (D60)', () => {
    const body = target('build-web');
    expect(body).toContain('--branch $(ALBUMS_WEB_TAG)');
    expect(body).toContain('NEXT_PUBLIC_ENTE_ENDPOINT');
    expect(body).toContain('build:albums');
    expect(body).toContain('dist/web-albums');
    // The pinned tag has no env-based basePath support, so the patch script
    // must run against the sparse clone BEFORE the build — and it anchors on
    // the pinned config's shape, failing loudly on a tag bump that changes
    // it (an unpatched export 404s behind /albums*).
    expect(body).toContain('scripts/patch-albums-basepath.ts');
    expect(body.indexOf('patch-albums-basepath.ts')).toBeLessThan(body.indexOf('npm ci'));
  });

  it('deploy-web syncs to the albums/ prefix with the D60 cache metadata and invalidates the ONE distribution', () => {
    const body = target('deploy-web');
    expect(body).toMatch(/^deploy-web:.*guard-account/);
    expect(body).toContain('s3 sync');
    expect(body).toContain('create-invalidation');
    // The sync must address outputs, never a hardcoded bucket/distribution —
    // and since D58 the invalidation targets the consolidated distribution.
    expect(body).toContain('output -raw web_bucket');
    expect(body).toContain('output -raw distribution_id');
    expect(body).not.toContain('web_distribution_id');
    // D60: assets live under the albums/ KEY PREFIX (the /albums* URI is the
    // object key), index.html freshness is ORIGIN METADATA (no-cache; there
    // is no /index.html behavior — the FREE plan's 5-behavior ceiling), and
    // the hashed /_next assets pin a 1y immutable max-age. index.html
    // uploads LAST so a live index never names not-yet-uploaded assets.
    expect(body).toContain('s3://$$BUCKET/albums/_next');
    expect(body).toContain('s3://$$BUCKET/albums"');
    expect(body).toContain('max-age=31536000, immutable');
    expect(body).toContain('"no-cache"');
    expect(body.indexOf('no-cache')).toBeGreaterThan(body.indexOf('immutable'));
    expect(body.indexOf('create-invalidation')).toBeGreaterThan(body.indexOf('no-cache'));
    // The stale-build tripwire: a pre-D60 (unprefixed) build must refuse to
    // sync — its assets would 404 behind /albums*.
    expect(body).toContain('/albums/_next');
  });

  it('deploy chains the pricing-plan subscription post-apply, non-fatally (D60)', () => {
    const body = target('deploy');
    // Idempotent subscribe-if-needed after every apply, so a fresh env (or a
    // post-destroy re-apply) cannot forget the $0 plan. A failure must WARN,
    // never fail the deploy: IAM propagation and the account's
    // 3-distribution FREE budget can transiently refuse.
    expect(body).toContain('pricing-plan');
    expect(body).toMatch(/pricing-plan\s*\|\|\s*\{/);
    expect(body).toContain('WARNING');
    expect(body).toContain('make pricing-plan');
    // The standalone target stays for the manual re-run the warning names.
    expect(target('pricing-plan')).toContain('create-subscription');
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
