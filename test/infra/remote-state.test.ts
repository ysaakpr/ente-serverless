/**
 * Remote state + split tfvars (D67). The repo is public: these guards keep
 * every private value out of git and keep the S3 backend wiring intact.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PRIVATE_KEYS,
  checkCommittedTfvars,
  parseTfvars,
  splitTfvars,
} from '../../tools/tfstate.ts';

const ROOT = join(import.meta.dirname, '../..');
const INFRA = join(ROOT, 'src/infra');
const ENVS = ['dev', 'test'];
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const makefile = () => read('Makefile');
const target = (name: string) => {
  const text = makefile().replace(/\\\n\s*/g, ' ');
  const at = text.search(new RegExp(`\\n${name}:(?!\\s*(?:export\\s+)?[A-Za-z_]+\\s*[:+?]?=)`));
  expect(at, `no ${name} target`).toBeGreaterThan(-1);
  const body = text.slice(at + 1);
  const end = body.search(/\n[a-z][a-z-]*:(?!\s*(?:export\s+)?[A-Za-z_]+\s*[:+?]?=)/);
  return end === -1 ? body : body.slice(0, end);
};

const variables = (env: string) => {
  const text = readFileSync(join(INFRA, env, 'variables.tf'), 'utf8');
  return [...text.matchAll(/variable "(\w+)" \{([\s\S]*?)\n\}/g)].map((m) => ({
    name: m[1]!,
    sensitive: /\n\s*sensitive\s*=\s*true/.test(m[2]!),
  }));
};

describe('tfvars split (tools/tfstate.ts)', () => {
  const sample = [
    '# header',
    'hashing_key = "abc=="',
    'mail_from = "me@example.com" # inline',
    '',
    'region = "ap-south-1"',
    'operator_principal_arns = [',
    '  "arn:aws:iam::123456789012:user/ops", # a ] in a comment',
    ']',
    'tags = { a = "b]", c = ["d"] }',
    '# trailing',
  ].join('\n');

  it('moves exactly the private assignments, keeps comments and order in config', () => {
    const { config, secrets, privateKeys } = splitTfvars(sample);
    expect(privateKeys).toEqual(['hashing_key', 'mail_from', 'operator_principal_arns']);
    expect(secrets).toBe(
      [
        'hashing_key = "abc=="',
        'mail_from = "me@example.com" # inline',
        'operator_principal_arns = [',
        '  "arn:aws:iam::123456789012:user/ops", # a ] in a comment',
        ']',
        '',
      ].join('\n'),
    );
    expect(config).toContain('# header');
    expect(config).toContain('region = "ap-south-1"');
    expect(config).toContain('tags = { a = "b]", c = ["d"] }');
    expect(config.trimEnd().endsWith('# trailing')).toBe(true);
    expect(checkCommittedTfvars(config)).toEqual([]);
  });

  it('round-trips: config + secrets parse back to the original assignments', () => {
    const { config, secrets } = splitTfvars(sample);
    const keys = (t: string) => parseTfvars(t).flatMap((b) => (b.key ? [b.key] : []));
    expect([...keys(config), ...keys(secrets)].sort()).toEqual(keys(sample).sort());
  });

  it('flags private values a committed file must never carry', () => {
    expect(checkCommittedTfvars('hashing_key = "x"')).toContain('assigns private variable hashing_key');
    expect(checkCommittedTfvars('albums_url = "https://a@b.com"')).toContain('contains an email address');
    expect(checkCommittedTfvars('x = "123456789012"')).toContain('contains a 12-digit AWS account id');
    expect(checkCommittedTfvars('x = ["arn:aws:iam::1:user/a"]')).toContain('contains an IAM ARN');
    // Prose in comments is fine — only assignments are scanned.
    expect(checkCommittedTfvars('# mail me@example.com\nregion = "x"')).toEqual([]);
  });

  it('refuses input it cannot split safely', () => {
    expect(() => parseTfvars('a = <<EOT\nx\nEOT')).toThrow(/heredoc/);
    expect(() => parseTfvars('a = [\n"x"')).toThrow(/unterminated/);
    expect(() => parseTfvars('a = 1\na = 2')).toThrow(/duplicate/);
    expect(() => parseTfvars('not an assignment')).toThrow(/expected an assignment/);
  });
});

describe('committed tfvars (public repo)', () => {
  for (const env of ENVS) {
    it(`${env}/config.tfvars is committable and only sets declared variables`, () => {
      const text = readFileSync(join(INFRA, env, 'config.tfvars'), 'utf8');
      expect(checkCommittedTfvars(text)).toEqual([]);
      const declared = new Set(variables(env).map((v) => v.name));
      for (const b of parseTfvars(text)) {
        if (b.key) expect(declared.has(b.key), `${env}: ${b.key} is not a declared variable`).toBe(true);
      }
      const keys = parseTfvars(text).map((b) => b.key);
      expect(keys).toContain('region');
      expect(keys).toContain('env_name');
    });
  }

  it('dev/config.tfvars is PRODUCTION (env_name prod), never with protection off', () => {
    const text = readFileSync(join(INFRA, 'dev', 'config.tfvars'), 'utf8');
    expect(text).toMatch(/^env_name = "prod"$/m);
    expect(text).not.toMatch(/^delete_protection\s*=\s*false/m);
  });

  it('every sensitive variable is in PRIVATE_KEYS', () => {
    for (const env of ENVS) {
      for (const v of variables(env).filter((x) => x.sensitive)) {
        expect(PRIVATE_KEYS as readonly string[], `${env}: ${v.name} is sensitive`).toContain(v.name);
      }
    }
  });

  it('gitignore: config.tfvars is trackable; secrets, legacy tfvars and state copies are not', () => {
    const ignored = (rel: string) => {
      try {
        execFileSync('git', ['check-ignore', '-q', rel], { cwd: ROOT });
        return true;
      } catch {
        return false;
      }
    };
    for (const env of ENVS) {
      expect(ignored(`src/infra/${env}/config.tfvars`)).toBe(false);
      for (const f of [
        'ente-sl.tfvars',
        'secrets.tfvars',
        '.secrets.tfvars',
        'terraform.tfstate',
        'terraform.tfstate.pre-s3-20261019000000',
        'terraform.tfstate.migrated-to-s3',
      ]) {
        expect(ignored(`src/infra/${env}/${f}`), `${env}/${f} must be gitignored`).toBe(true);
      }
    }
  });
});

describe('S3 backend wiring', () => {
  for (const env of ENVS) {
    it(`${env}/versions.tf declares a partial S3 backend and tofu >= 1.10 (use_lockfile)`, () => {
      const text = readFileSync(join(INFRA, env, 'versions.tf'), 'utf8');
      expect(text).toMatch(/backend "s3" \{\}/);
      expect(text).toMatch(/required_version = ">= 1\.10\.0"/);
      // Partial on purpose: no bucket/account committed.
      expect(text).not.toMatch(/bucket\s*=/);
    });
  }

  it('backend args lock natively and key the state by profile', () => {
    const text = makefile();
    expect(text).toMatch(/key=state\/\$\(PROFILE\)\/terraform\.tfstate/);
    expect(text).toContain('use_lockfile=true');
    expect(text).toContain('encrypt=true');
  });

  it('infra-init never -reconfigures and refuses while a local state file exists', () => {
    const body = target('infra-init');
    expect(body).not.toContain('-reconfigure');
    expect(body).toContain('make state-migrate');
  });

  it('plan and destroy read config + per-run secrets, never the legacy tfvars', () => {
    for (const name of ['plan', 'destroy']) {
      const body = target(name);
      expect(body, `${name} lacks WITH_SECRETS`).toContain('$(WITH_SECRETS)');
      expect(body, `${name} lacks VARFILES`).toContain('$(VARFILES)');
      expect(body).not.toMatch(/-var-file=\$\(LEGACY_TFVARS\)|-var-file=ente-sl\.tfvars/);
    }
    expect(target('plan')).toContain('check $(TFDIR)/$(TFCONFIG)');
    const text = makefile();
    expect(text).toMatch(/VARFILES\s*=\s*-var-file=\$\(TFCONFIG\) -var-file=\$\(TFSECRETS\)/);
    // The per-run secrets file is removed on exit, success or failure.
    expect(text).toMatch(/WITH_SECRETS = trap 'rm -f \$\(TFDIR\)\/\$\(TFSECRETS\)' EXIT/);
  });

  it('state-migrate is guarded and verifies the copy before parking the local file', () => {
    const body = target('state-migrate');
    expect(body).toMatch(/^state-migrate:.*guard-account/);
    expect(body).toContain('-migrate-state');
    expect(body).toContain('hashlib.sha256');
    expect(body).toContain('"resources"');
    expect(body.indexOf('test "$$WANT" = "$$HAVE"')).toBeLessThan(body.indexOf('mv $(LOCAL_STATE)'));
  });

  it('guard-account reads remote state, or the local file while one still exists', () => {
    const body = target('guard-account');
    expect(body).toContain('state pull');
    expect(body).toContain('$(LOCAL_STATE)');
    expect(body).toContain('ACCOUNT MISMATCH');
  });
});
