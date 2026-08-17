/**
 * Integration world: the REAL adapters (DynamoDB/S3/SES on LocalStack), the
 * real app, and an http-capable synthetic client. Requires `make up` +
 * `make bootstrap` (test-int does the bootstrap itself).
 */

import { execFileSync } from 'node:child_process';
import type { Deps } from '../../src/deps.ts';
import { DynamoDb } from '../../src/adapters/aws/db.dynamo.ts';
import { S3Blobs } from '../../src/adapters/aws/blobs.s3.ts';
import { SesMail } from '../../src/adapters/aws/mail.ses.ts';
import { RealRand, SystemClock } from '../../src/adapters/memory/system.memory.ts';
import { configFromEnv } from '../../src/config.ts';
import { IdGenerator } from '../../src/domain/ids.ts';
import { buildApp } from '../../src/app.ts';
import { sodiumReady } from '../../src/domain/tokens.ts';

export const LOCALSTACK = process.env.AWS_ENDPOINT_URL ?? 'http://127.0.0.1:4567';

export interface IntWorld {
  deps: Deps;
  request: (
    method: string,
    path: string,
    opts?: { body?: unknown; token?: string; headers?: Record<string, string> },
  ) => Promise<Response>;
}

export const makeIntWorld = async (): Promise<IntWorld> => {
  await sodiumReady();
  execFileSync('node', ['--experimental-transform-types', 'scripts/bootstrap-local.ts'], {
    stdio: 'ignore',
    env: { ...process.env, AWS_ENDPOINT_URL: LOCALSTACK },
  });

  const config = {
    ...configFromEnv(),
    awsEndpoint: LOCALSTACK,
    hardcodedOttSuffix: '@example.org',
    hardcodedOttValue: '123456',
  };
  const clock = new SystemClock();
  const deps: Deps = {
    db: new DynamoDb(config),
    blobs: new S3Blobs(config),
    mail: new SesMail(config),
    clock,
    rand: new RealRand(),
    config,
    ids: new IdGenerator(clock),
    hashingKey: new Uint8Array(32).fill(7),
  };
  const app = buildApp(deps);

  const request: IntWorld['request'] = async (method, path, opts = {}) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-client-package': 'io.ente.photos',
      ...opts.headers,
    };
    if (opts.token) headers['x-auth-token'] = opts.token;
    return app.request(path, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  };

  return { deps, request };
};
