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

// Structural assertions must read CONFIG, never comments. Without this a rail
// that has been commented out still satisfies a string match — exactly what
// happened when a teardown left `# Was: prevent_destroy = true` behind and the
// guards stayed green anyway. Hash line comments and slash-star block comments
// are stripped; `//` is deliberately left alone, because tf string literals
// legitimately contain `https://`.
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/#.*$/gm, '');

const readTf = (rel: string) => stripComments(readFileSync(join(INFRA, rel), 'utf8'));

const allTf = () =>
  allTfFiles(INFRA).map((f) => ({ file: f, text: stripComments(readFileSync(f, 'utf8')) }));
const dataTf = () => readTf('modules/data/main.tf');

describe('storage-class guards (GIR-only decision, 2026-08-16)', () => {
  it('no DEEP_ARCHIVE anywhere in the infra', () => {
    for (const { file, text } of allTf()) {
      expect(text.includes('DEEP_ARCHIVE'), `${file} mentions DEEP_ARCHIVE`).toBe(false);
    }
  });

  it('originals transition to GLACIER_IR after gir_transition_days, selected by tag tier=original (D59)', () => {
    const text = dataTf();
    expect(text).toContain('GLACIER_IR');
    const rule = text.slice(text.indexOf('originals-to-glacier-ir'));
    const filterBlock = rule.slice(0, rule.indexOf('transition'));
    expect(filterBlock).toMatch(/tag\s*{/);
    expect(filterBlock).toContain('"tier"');
    expect(filterBlock).toContain('"original"');
    // D59: the days are var-driven, never a literal — a hardcoded 0 would
    // silently reinstate day-0 GIR retrieval charges on fresh uploads.
    const transitionBlock = rule.slice(rule.indexOf('transition'), rule.indexOf('}', rule.indexOf('storage_class')));
    expect(transitionBlock).toMatch(/days\s*=\s*var\.gir_transition_days/);
  });

  it('gir_transition_days defaults to 7 with a >= 0 validation (D59)', () => {
    const vars = readTf('modules/data/variables.tf');
    const at = vars.indexOf('variable "gir_transition_days"');
    expect(at, 'no gir_transition_days variable').toBeGreaterThan(-1);
    const block = vars.slice(at);
    expect(block).toMatch(/type\s*=\s*number/);
    // Default 7: fresh uploads are the most-viewed, and day-0 GIR billed
    // $0.03/GB retrieval on exactly those views. Standard's ~$0.023/GB-mo
    // prorated over a week is cheaper than one early full-res view.
    expect(block).toMatch(/default\s*=\s*7/);
    expect(block).toMatch(/condition\s*=\s*var\.gir_transition_days\s*>=\s*0/);
  });

  it('both env layers thread gir_transition_days through, defaulting 7 (D59)', () => {
    for (const env of ['dev', 'test']) {
      const main = readTf(`${env}/main.tf`);
      expect(main, `${env} does not pass gir_transition_days`).toMatch(
        /gir_transition_days\s*=\s*var\.gir_transition_days/,
      );
      const vars = readTf(`${env}/variables.tf`);
      const at = vars.indexOf('variable "gir_transition_days"');
      expect(at, `${env} lacks the variable`).toBeGreaterThan(-1);
      expect(vars.slice(at)).toMatch(/default\s*=\s*7/);
    }
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
 * Versioning is the only thing standing between a bug in the object sweep (D6)
 * and permanently destroyed photos, so it is guarded as tightly as the storage
 * classes. Its paired expiry rule is what stops it costing forever.
 */
describe('bucket versioning guards', () => {
  it('the objects bucket is versioned', () => {
    const text = dataTf();
    const at = text.indexOf('resource "aws_s3_bucket_versioning"');
    expect(at, 'objects bucket is NOT versioned').toBeGreaterThan(-1);
    const block = text.slice(at, text.indexOf('\n}\n', at));
    expect(block).toMatch(/status\s*=\s*"Enabled"/);
  });

  it('noncurrent versions expire, so the safety net cannot bill forever', () => {
    const text = dataTf();
    const rule = text.slice(text.indexOf('expire-noncurrent-versions'));
    expect(rule, 'no expire-noncurrent-versions rule').not.toBe('');
    expect(rule).toContain('noncurrent_version_expiration');
    const days = Number(rule.match(/noncurrent_days\s*=\s*(\d+)/)![1]);
    // Below 30 stops mirroring museum's trash window; above 90 holds deleted
    // bytes longer than GLACIER_IR's minimum duration for no added protection.
    expect(days).toBeGreaterThanOrEqual(30);
    expect(days).toBeLessThanOrEqual(90);
  });

  it('the execution role cannot hard-delete a version', () => {
    // s3:DeleteObject on a versioned bucket only writes a delete marker.
    // DeleteObjectVersion would let the API destroy a photo outright.
    const iam = readTf('modules/compute/iam.tf');
    expect(iam).not.toContain('s3:DeleteObjectVersion');
  });
});

describe('alarm guards', () => {
  const computeTf = () => readTf('modules/compute/main.tf');

  it('both lambdas have an Errors alarm wired to the SNS topic', () => {
    const text = computeTf();
    expect(text).toContain('aws_sns_topic" "alarms');
    const alarms = text.match(/resource "aws_cloudwatch_metric_alarm"/g) ?? [];
    expect(alarms).toHaveLength(2);
    for (const fn of ['aws_lambda_function.api', 'aws_lambda_function.trash_purge']) {
      expect(text, `no alarm references ${fn}`).toContain(`FunctionName = ${fn}.function_name`);
    }
    // Regex, not an exact string: `tofu fmt` realigns this block whenever a
    // longer attribute name is added, and that must not fail the guard.
    expect(text).toMatch(/alarm_actions\s*=\s*\[aws_sns_topic\.alarms\.arn\]/);
  });

  it('the daily cron is evaluated over a daily window, not a 5-minute one', () => {
    const text = computeTf();
    const purge = text.slice(text.indexOf('"trash_purge_errors"'));
    expect(Number(purge.match(/period\s*=\s*(\d+)/)![1])).toBe(86400);
  });

  it('the deployer policy can create the topic and the alarms', () => {
    const policy = JSON.parse(readFileSync(join(INFRA, 'deployer-policy.json'), 'utf8')) as {
      Statement: Array<{ Action: string[] }>;
    };
    const actions = policy.Statement.flatMap((s) => s.Action);
    for (const needed of ['sns:CreateTopic', 'sns:Subscribe', 'cloudwatch:PutMetricAlarm']) {
      expect(actions, `deployer cannot ${needed}`).toContain(needed);
    }
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

  it('every state-mutating target checks the account first', () => {
    // The bucket name embeds the account id, so wrong-account credentials plan a
    // rename, which tofu executes as destroy-and-recreate. prevent_destroy saves
    // the bucket and table; nothing saves the lambdas, role or SNS topic.
    for (const name of ['plan', 'deploy', 'destroy']) {
      expect(target(name), `${name} does not depend on guard-account`).toMatch(
        new RegExp(`^${name}:.*guard-account`),
      );
    }
    expect(target('guard-account')).toContain('ACCOUNT MISMATCH');
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

  it('pricing-plan subscribes THIS distribution + web ACL to the FREE tier (D47)', () => {
    // The subscription is CLI-side (no provider support yet), so the only
    // things holding it together are the two tofu outputs and this target.
    const body = target('pricing-plan');
    expect(body).toMatch(/^pricing-plan:.*guard-account/);
    expect(body).toContain('--plan-tier FREE');
    expect(body).toContain('output -raw distribution_arn');
    expect(body).toContain('output -raw web_acl_arn');
    // FREE means free: the target must never be able to create a paid tier.
    expect(body).not.toMatch(/PRO|BUSINESS|PREMIUM/);
    for (const rel of ['modules/edge/outputs.tf', 'dev/outputs.tf']) {
      const outputs = readTf(rel);
      expect(outputs, `${rel} lost distribution_arn`).toContain('output "distribution_arn"');
      expect(outputs, `${rel} lost web_acl_arn`).toContain('output "web_acl_arn"');
    }
  });

  it('the tofu dir is profile-driven — no target can silently address dev (D57)', () => {
    const text = makefile();
    expect(text).toMatch(/TFDIR\s*=\s*src\/infra\/\$\(PROFILE\)/);
    expect(text).toMatch(/TF\s*=\s*tofu -chdir=\$\(TFDIR\)/);
    expect(text).toMatch(/STATE\s*=\s*\$\(TFDIR\)\/terraform\.tfstate/);
    // dev is PRODUCTION: nothing may hardcode its dir back in.
    expect(text).not.toMatch(/-chdir=src\/infra\/dev/);
    expect(text).not.toMatch(/STATE\s*=\s*src\/infra\/dev/);
    // No profile chosen must refuse, never default.
    expect(text).toMatch(/NO_PROFILE_MSG\s*=\s*no profile chosen/);
    expect(target('require-profile')).toContain('NO_PROFILE_MSG');
    // The labels name what each env IS, not what its folder is called.
    expect(text).toMatch(/PROFILE_LABEL_dev\s*=\s*PRODUCTION/);
    expect(text).toMatch(/PROFILE_LABEL_test\s*=\s*TEST/);
  });

  it('profile-aware targets banner + fail fast; no typed gate, no -auto-approve (D57 addendum)', () => {
    // D57 addendum 2026-08-27: the typed profile confirmation is gone. What
    // stands in for it: the banner (require-profile) on every profile-aware
    // target, the no-profile refusal, guard-account on the mutating path,
    // tofu's own interactive approval on destroy, and deploy applying only a
    // just-reviewed saved plan.
    for (const name of ['plan', 'deploy', 'destroy', 'deploy-web', 'pricing-plan', 'build-web', 'infra-init', 'outputs', 'smoke']) {
      expect(target(name), `${name} lacks require-profile (directly or via guard-account)`).toMatch(
        new RegExp(`^${name}:.*(require-profile|guard-account)`),
      );
    }
    // The banner is the profile visibility mechanism — it must survive.
    expect(target('require-profile')).toContain('>>> profile:');
    // The confirm-profile mechanism must stay gone, not half-removed.
    // Assert over recipe/prerequisite lines only (comments may narrate both).
    const code = makefile()
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).not.toContain('confirm-profile');
    // tofu destroy's native interactive prompt IS the final confirmation:
    // nothing may auto-approve it (and nothing else should auto-approve either).
    expect(code, 'no target may pass -auto-approve').not.toContain('-auto-approve');
  });
});

/**
 * Security review 2026-08-17, findings 4 and 6: spend ceilings (budget page,
 * reserved concurrency, WAF rate rule) and the origin lock + response headers
 * that make the edge controls non-bypassable. Guarded the same way as the
 * FunctionURLAllowPublicAccess statement: structure, not comments.
 */
describe('spend ceiling + edge hardening guards (findings 4/6)', () => {
  const computeTf = () => readTf('modules/compute/main.tf');
  const edgeTf = () => readTf('modules/edge/main.tf');
  const devTf = () => readTf('dev/main.tf');

  it('the API lambda carries the concurrency knob (hard invocation ceiling)', () => {
    const api = computeTf().slice(computeTf().indexOf('resource "aws_lambda_function" "api"'));
    const block = api.slice(0, api.indexOf('resource "', 10));
    expect(block).toMatch(/reserved_concurrent_executions\s*=/);
    const varsTf = readTf('modules/compute/variables.tf');
    const v = varsTf.slice(varsTf.indexOf('variable "api_reserved_concurrency"'));
    const def = Number(v.match(/default\s*=\s*(-?\d+)/)![1]);
    // -1 = unreserved (the only deployable value while the account sits at the
    // default Lambda quota, which is itself a tighter ceiling); positive = the
    // real reservation once the quota is raised. 0 would disable the function.
    expect(def === -1 || def > 0).toBe(true);
    expect(def).not.toBe(0);
  });

  it('an ACTUAL-spend budget pages through the alarms topic', () => {
    const text = computeTf();
    const budget = text.slice(text.indexOf('resource "aws_budgets_budget"'));
    expect(budget, 'no budget resource').not.toBe('');
    const block = budget.slice(0, budget.indexOf('\nresource "'));
    expect(block).toMatch(/notification_type\s*=\s*"ACTUAL"/);
    expect(block).toContain('subscriber_sns_topic_arns = [aws_sns_topic.alarms.arn]');
  });

  it('the topic policy admits Budgets AND restates the CloudWatch grant', () => {
    // aws_sns_topic_policy REPLACES the account-default policy — dropping the
    // CloudWatch principal would silently mute both Errors alarms.
    const text = computeTf();
    const policy = text.slice(text.indexOf('resource "aws_sns_topic_policy"'));
    expect(policy, 'no explicit topic policy').not.toBe('');
    const block = policy.slice(0, policy.indexOf('\nresource "'));
    expect(block).toContain('budgets.amazonaws.com');
    expect(block).toContain('cloudwatch.amazonaws.com');
  });

  it('the origin injects x-origin-secret and the app reads the same header', () => {
    const edge = edgeTf();
    const origin = edge.slice(edge.indexOf('custom_header'));
    expect(origin).toMatch(/name\s*=\s*"x-origin-secret"/);
    expect(origin).toMatch(/value\s*=\s*var\.origin_secret/);

    const compute = computeTf();
    expect(compute).toMatch(/ORIGIN_SECRET\s*=\s*var\.origin_secret/);

    const app = readFileSync(join(import.meta.dirname, '../../src/app.ts'), 'utf8');
    expect(app).toContain("header('x-origin-secret')");
  });

  it('the origin secret is generated, not a tfvars value', () => {
    // A findings doc must never be able to pair the hostname with the secret;
    // random_password keeps it only in state.
    expect(devTf()).toContain('resource "random_password" "origin_secret"');
    expect(devTf()).toMatch(/origin_secret\s*=\s*random_password\.origin_secret\.result/);
  });

  it('a WAF rate rule bounds request floods, in FREE-tier shape (D43, reshaped D47)', () => {
    const edge = edgeTf();
    expect(edge).toContain('resource "aws_wafv2_web_acl"');
    expect(edge).toMatch(/web_acl_id\s*=\s*aws_wafv2_web_acl\.api\.arn/);
    expect(edge).toContain('rate_based_statement');
    // The FREE pricing plan has no byte-match statements: a scope-down here
    // silently disqualifies the distribution from the $0 plan (D47). The
    // brute-force bounds live in the app's atomic caps (D42/D45), so the
    // edge rule is a plain per-IP flood ceiling.
    expect(edge, 'byte match is not in the FREE tier — D47').not.toContain('byte_match_statement');
    expect(edge).toMatch(/limit\s*=\s*2000/);
    expect(edge).toMatch(/aggregate_key_type\s*=\s*"IP"/);
    // CLOUDFRONT scope only exists in us-east-1 — the aliased provider is
    // load-bearing, not decoration.
    expect(edge).toMatch(/scope\s*=\s*"CLOUDFRONT"/);
    expect(edge).toMatch(/provider\s*=\s*aws\.use1/);
    expect(devTf()).toMatch(/alias\s*=\s*"use1"/);
  });

  it('the distribution keeps PriceClass_All — a restricted class disqualifies the FREE plan (D47)', () => {
    // Undocumented gate, learned the hard way: CreateSubscription refuses a
    // PriceClass_200 distribution, and the console flips the class to All
    // when subscribing. Reverting it would break the $0 plan.
    expect(edgeTf()).toMatch(/price_class\s*=\s*"PriceClass_All"/);
  });

  it('the distribution attaches the MANAGED security-headers policy (D43, reshaped D47)', () => {
    const edge = edgeTf();
    // Custom response-headers policies are not in the FREE tier (D47); the
    // AWS managed SecurityHeadersPolicy carries HSTS, nosniff, and
    // strict-origin-when-cross-origin — the last still keeps ?token= URLs
    // (D32) out of cross-origin Referer headers, query string and all.
    expect(edge, 'custom headers policy disqualifies the FREE plan — D47').not.toContain(
      'resource "aws_cloudfront_response_headers_policy"',
    );
    expect(edge).toMatch(
      /response_headers_policy_id\s*=\s*local\.managed_security_headers_policy_id/,
    );
    expect(edge).toContain('"67f7725c-6f97-4210-82d7-5512b31e9d03"');
  });

  it('the deployer policy covers the new resources', () => {
    const policy = JSON.parse(readFileSync(join(INFRA, 'deployer-policy.json'), 'utf8')) as {
      Statement: Array<{ Effect: string; Action: string[] }>;
    };
    const allowed = policy.Statement.filter((s) => s.Effect === 'Allow').flatMap((s) => s.Action);
    for (const action of [
      'budgets:ModifyBudget',
      'wafv2:CreateWebACL',
      'wafv2:ListWebACLs',
      'lambda:PutFunctionConcurrency',
      // still needed: destroying the pre-D47 custom headers policy on apply
      'cloudfront:CreateResponseHeadersPolicy',
      'pricingplanmanager:CreateSubscription',
      'pricingplanmanager:CancelSubscription',
    ]) {
      expect(allowed, `deployer cannot ${action}`).toContain(action);
    }
  });
});

/**
 * BYO storage pools (H2, D55): the one infra change is sts:AssumeRole on the
 * shared execution role (API lambda + trash-purge worker use the same role,
 * asserted here so a future role split cannot silently drop the worker's
 * ability to purge pool objects). Since D56 the resource is SCOPED to the
 * ente-pool-* naming convention, never "*" — a pool role trusted to its
 * account root would otherwise be assumable by anything holding AssumeRole
 * on "*"; the trust policy + ExternalId stays the real per-pool gate.
 */
describe('storage pool guards (H2, D55)', () => {
  const iamTf = () => readTf('modules/compute/iam.tf');

  it('the execution role can assume pool roles — scoped to the naming convention, not "*"', () => {
    const iam = iamTf();
    const at = iam.indexOf('"PoolAssumeRole"');
    expect(at, 'no PoolAssumeRole statement').toBeGreaterThan(-1);
    const block = iam.slice(at, iam.indexOf('}', at));
    expect(block).toContain('"sts:AssumeRole"');
    expect(block).toMatch(/resources\s*=\s*\["arn:aws:iam::\*:role\/ente-pool-\*"\]/);
    expect(block).not.toMatch(/resources\s*=\s*\["\*"\]/);
  });

  it('both lambdas share the one role the statement lands on', () => {
    // If this breaks, the trash-purge worker got its own role — it needs the
    // PoolAssumeRole statement too (it deletes objects from pool buckets).
    const compute = readTf('modules/compute/main.tf');
    const roleRefs = compute.match(/role\s*=\s*aws_iam_role\.api\.arn/g) ?? [];
    expect(roleRefs.length).toBeGreaterThanOrEqual(2);
    expect(compute).not.toContain('resource "aws_iam_role" "trash_purge"');
  });
});

describe('config/tofu default agreement (D11)', () => {
  it('free_plan_storage_bytes matches the config.ts default (1 GiB)', () => {
    const ONE_GIB = 1024 ** 3;

    const tf = readFileSync(join(INFRA, 'modules/compute/variables.tf'), 'utf8');
    const block = tf.slice(tf.indexOf('variable "free_plan_storage_bytes"'));
    const tfDefault = Number(block.match(/default\s*=\s*(\d+)/)![1]);

    const config = readFileSync(join(import.meta.dirname, '../../src/config.ts'), 'utf8');
    const expr = config.match(/FREE_PLAN_STORAGE_BYTES\s*\?\?\s*([0-9*\s.]+)\)/)![1]!;
    // The default is written as an expression (1024 ** 3); evaluate the literal
    // arithmetic rather than duplicating the constant here.
    const configDefault = Number(
      // eslint-disable-next-line no-new-func
      Function(`"use strict";return (${expr})`)(),
    );

    expect(configDefault).toBe(ONE_GIB);
    expect(tfDefault).toBe(configDefault);
  });

  it('signup_mode: tofu default matches config.ts ("open"), validates the enum, reaches the Lambda env (D54/D56)', () => {
    const tf = readTf('modules/compute/variables.tf');
    const block = tf.slice(tf.indexOf('variable "signup_mode"'));
    expect(block).toMatch(/default\s*=\s*"open"/);
    expect(block).toMatch(/contains\(\["open", "invite"\]/);

    // config.ts: anything but the literal 'invite' resolves to 'open'.
    const config = readFileSync(join(import.meta.dirname, '../../src/config.ts'), 'utf8');
    expect(config).toContain("process.env.SIGNUP_MODE === 'invite' ? 'invite' : 'open'");

    // and the var actually lands in the API Lambda's environment + dev passthrough
    expect(readTf('modules/compute/main.tf')).toMatch(/SIGNUP_MODE\s*=\s*var\.signup_mode/);
    expect(readTf('dev/main.tf')).toMatch(/signup_mode\s*=\s*var\.signup_mode/);
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
    expect(readTf('modules/compute/main.tf')).toContain('authorization_type = "NONE"');
  });

  it('the public Function URL also grants anonymous lambda:InvokeFunctionUrl', () => {
    // auth NONE alone 403s every caller, CloudFront included: the resource
    // policy statement is a separate resource that the console adds silently
    // and the API does not. Deleting it would look like a working plan and a
    // dead deployment.
    const compute = readTf('modules/compute/main.tf');
    const stmt = compute.slice(compute.indexOf('resource "aws_lambda_permission" "api_public_url"'));
    expect(stmt, 'no api_public_url permission').not.toBe('');
    const block = stmt.slice(0, stmt.indexOf('\n}'));
    expect(block).toContain('lambda:InvokeFunctionUrl');
    expect(block).toMatch(/principal\s*=\s*"\*"/);
    expect(block).toMatch(/function_url_auth_type\s*=\s*"NONE"/);
  });

  it('delete protection is var-driven and defaults ON (D57)', () => {
    // The rails moved from lifecycle prevent_destroy (a literal tofu cannot
    // parameterize, and one that only ever stopped tofu itself) to API-level
    // equivalents: deletion_protection_enabled blocks DeleteTable for
    // EVERYONE including the console, and !force_destroy makes the bucket
    // destroy refuse while non-empty. Both must follow the one variable.
    const text = dataTf();
    expect(text).toMatch(/deletion_protection_enabled\s*=\s*var\.delete_protection/);
    expect(text).toMatch(/force_destroy\s*=\s*!var\.delete_protection/);

    const vars = readTf('modules/data/variables.tf');
    const block = vars.slice(vars.indexOf('variable "delete_protection"'));
    expect(block, 'no delete_protection variable').not.toBe('');
    expect(block).toMatch(/type\s*=\s*bool/);
    // Default true: an env that forgets to set it gets PROD-grade protection.
    expect(block).toMatch(/default\s*=\s*true/);
  });

  it('no lifecycle prevent_destroy remains in the data module (D57 replaced it)', () => {
    // A leftover block would hard-refuse test-env teardown regardless of the
    // variable — the whole point of the swap is that ONLY delete_protection
    // decides. (stripComments means a commented-out block cannot satisfy or
    // trip this either way.)
    expect(dataTf()).not.toContain('prevent_destroy');
  });

  it('both env layers thread delete_protection through, defaulting ON (D57)', () => {
    for (const env of ['dev', 'test']) {
      const main = readTf(`${env}/main.tf`);
      expect(main, `${env} does not pass delete_protection`).toMatch(
        /delete_protection\s*=\s*var\.delete_protection/,
      );
      const vars = readTf(`${env}/variables.tf`);
      const block = vars.slice(vars.indexOf('variable "delete_protection"'));
      expect(block, `${env} lacks the variable`).not.toBe('');
      expect(block).toMatch(/default\s*=\s*true/);
    }
  });

  it('every deployer-policy statement uses only IAM-recognised keys', () => {
    // IAM rejects a document containing an unknown statement key outright
    // (MalformedPolicyDocument), and JSON has no comment syntax to reach for —
    // so an explanatory key added in good faith breaks the whole policy.
    const allowed = new Set([
      'Sid', 'Effect', 'Principal', 'NotPrincipal',
      'Action', 'NotAction', 'Resource', 'NotResource', 'Condition',
    ]);
    const policy = JSON.parse(readFileSync(join(INFRA, 'deployer-policy.json'), 'utf8')) as {
      Statement: Array<Record<string, unknown>>;
    };
    for (const st of policy.Statement) {
      const extra = Object.keys(st).filter((k) => !allowed.has(k));
      expect(extra, `statement ${String(st.Sid)} has non-IAM keys`).toEqual([]);
    }
  });

  it('the store-delete Deny is load-bearing, not decorative', () => {
    // A Deny stacked on an OMISSION does nothing: the actions were already
    // denied by default, so removing the Deny for a teardown changes nothing and
    // the destroy still 403s (which is exactly what happened on 2026-08-17).
    // So assert BOTH halves: the deletes are allowed, and the Deny is what
    // actually withholds them. Then lifting the Deny genuinely enables teardown.
    const policy = JSON.parse(readFileSync(join(INFRA, 'deployer-policy.json'), 'utf8')) as {
      Statement: Array<{ Effect: string; Action: string[] }>;
    };
    const acts = (effect: string) =>
      policy.Statement.filter((s) => s.Effect === effect).flatMap((s) => s.Action);
    const allowed = acts('Allow');
    // Wildcards count: s3:Delete* covers s3:DeleteBucket.
    const covers = (list: string[], action: string) =>
      list.some((a) => a === action || (a.endsWith('*') && action.startsWith(a.slice(0, -1))));

    for (const action of ['s3:DeleteBucket', 'dynamodb:DeleteTable']) {
      expect(covers(allowed, action), `${action} is not Allowed — the Deny would be decorative`).toBe(true);
      expect(acts('Deny'), `${action} is not Denied — the rail is missing`).toContain(action);
    }
  });

  it('listing actions are granted on * — resource-scoping them silently 403s', () => {
    // logs:DescribeLogGroups is a LIST call: AWS authorises it against a
    // placeholder ARN with an EMPTY name
    // (arn:aws:logs:...:log-group::log-stream:), which can never match a scoped
    // pattern like log-group:/aws/lambda/ente-sl-*. Scoping it looks correct,
    // reads correct, and fails mid-apply — it cost one apply on 2026-08-17.
    // cloudwatch:DescribeAlarms is here defensively, not from observation: the
    // alarms did read fine under a scoped ARN, but AWS's service authorization
    // reference lists DescribeAlarms with no resource types, so relying on that
    // leniency is not worth another mid-apply failure.
    const policy = JSON.parse(readFileSync(join(INFRA, 'deployer-policy.json'), 'utf8')) as {
      Statement: Array<{ Effect: string; Action: string[]; Resource: string | string[] }>;
    };
    for (const action of ['logs:DescribeLogGroups', 'cloudwatch:DescribeAlarms']) {
      const ok = policy.Statement.some(
        (s) => s.Effect === 'Allow' && s.Action.includes(action) && s.Resource === '*',
      );
      expect(ok, `${action} must be Allowed on Resource "*", not a scoped ARN`).toBe(true);
    }
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
