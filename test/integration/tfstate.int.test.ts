/**
 * tools/tfstate.ts against LocalStack (D67): the wrong-account guards with the
 * real bucket calls. The bucket name is derived from the caller's account;
 * LocalStack here runs without STS, so only that answer is faked — every S3
 * request is real.
 */

import { describe, expect, it, vi } from 'vitest';
import { randomInt } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { bootstrap, secretsPull, secretsPush, secretsStatus } from '../../tools/tfstate.ts';

const sts = vi.hoisted(() => {
  // tools/tfstate.ts reads the environment once, at import. Pin LocalStack and
  // dummy keys first: run outside `make test-int` (e.g. by `make ledger`), this
  // file once sent its calls — bootstrap's CreateBucket included — to real AWS
  // under the machine's default credentials. With these keys real AWS rejects
  // every request, so a wrong endpoint fails the test instead of acting.
  process.env.AWS_ENDPOINT_URL ??= 'http://127.0.0.1:4567';
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_PROFILE;
  return { account: '' };
});
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    send = async () => ({ Account: sts.account });
  },
  GetCallerIdentityCommand: class {},
}));

const s3 = new S3Client({
  region: process.env.STATE_REGION ?? 'ap-south-1',
  endpoint: process.env.AWS_ENDPOINT_URL,
  forcePathStyle: true,
});
const bucketExists = (bucket: string) =>
  s3.send(new HeadBucketCommand({ Bucket: bucket })).then(
    () => true,
    () => false,
  );
const freshAccount = () => String(randomInt(100_000_000_000, 999_999_999_999));

describe('tools/tfstate.ts wrong-account guards (LocalStack)', () => {
  it('a missing bucket stops every command with the account named, and bootstrap will not create it unconfirmed', async () => {
    delete process.env.STATE_BUCKET;
    delete process.env.CONFIRM_ACCOUNT;
    sts.account = freshAccount();
    const bucket = `ente-sl-tfstate-${sts.account}`;
    const missing = `state bucket s3://${bucket} does not exist (running as account ${sts.account} via`;

    await expect(secretsStatus('dev')).rejects.toThrow(missing);
    // The bucket check runs before the local file is read, so the bucket — not
    // a missing file — is what a wrong-account push reports.
    await expect(secretsPush('dev', '/nonexistent/secrets.tfvars')).rejects.toThrow(missing);
    await expect(secretsPull('dev', join(tmpdir(), 'never-written.tfvars'))).rejects.toThrow(missing);

    await expect(bootstrap()).rejects.toThrow(`make state-bootstrap CONFIRM_ACCOUNT=${sts.account}`);
    process.env.CONFIRM_ACCOUNT = freshAccount(); // some other account's id
    await expect(bootstrap()).rejects.toThrow('does not exist yet');
    delete process.env.CONFIRM_ACCOUNT;
    expect(await bucketExists(bucket)).toBe(false);
  });

  it('with the account confirmed it creates the bucket; secrets then round-trip', async () => {
    delete process.env.STATE_BUCKET;
    sts.account = freshAccount();
    const bucket = `ente-sl-tfstate-${sts.account}`;
    process.env.CONFIRM_ACCOUNT = sts.account;
    try {
      expect(await bootstrap()).toBe(bucket);
    } finally {
      delete process.env.CONFIRM_ACCOUNT;
    }
    expect(await bucketExists(bucket)).toBe(true);
    // Re-applying settings to an existing bucket needs no confirmation.
    expect(await bootstrap()).toBe(bucket);

    const dir = mkdtempSync(join(tmpdir(), 'tfstate-int-'));
    const secrets = 'hashing_key = "a2V5LWZvci10aGUtaW50ZWdyYXRpb24tdGVzdC1vbmx5"\nmail_from = "ops@example.org"\n';
    writeFileSync(join(dir, 'secrets.tfvars'), secrets);
    await secretsPush('test', join(dir, 'secrets.tfvars'));
    expect(await secretsStatus('test')).toBe(true);
    expect(await secretsStatus('dev')).toBe(false); // bucket fine, that env's secrets not pushed
    await secretsPull('test', join(dir, 'pulled.tfvars'));
    expect(readFileSync(join(dir, 'pulled.tfvars'), 'utf8')).toBe(secrets);
    expect(statSync(join(dir, 'pulled.tfvars')).mode & 0o777).toBe(0o600);
  });
});
