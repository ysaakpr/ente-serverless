/** Test bootstrap: memory adapters, controllable clock, the assembled app. */

import type { Deps } from '../../src/deps.ts';
import { MemoryDb } from '../../src/adapters/memory/db.memory.ts';
import { MemoryBlobs, MemoryBlobsResolver } from '../../src/adapters/memory/blobs.memory.ts';
import { MemoryMail } from '../../src/adapters/memory/mail.memory.ts';
import { RealRand, TestClock } from '../../src/adapters/memory/system.memory.ts';
import { configFromEnv, type Config } from '../../src/config.ts';
import { IdGenerator } from '../../src/domain/ids.ts';
import { buildApp } from '../../src/app.ts';
import { sodiumReady } from '../../src/domain/tokens.ts';

export interface TestWorld {
  deps: Deps & { db: MemoryDb; blobs: MemoryBlobs; mail: MemoryMail; clock: TestClock };
  app: ReturnType<typeof buildApp>;
  request: (
    method: string,
    path: string,
    opts?: { body?: unknown; token?: string; headers?: Record<string, string> },
  ) => Promise<Response>;
}

/**
 * `config` overrides are applied BEFORE buildApp, which matters for the knobs
 * read at wiring time rather than per request — `logRequests` registers the
 * access-log middleware or does not. Anything read per request can just be
 * mutated on `world.deps.config` afterwards.
 */
export const makeWorld = async (
  configOverrides: Partial<Config> = {},
): Promise<TestWorld> => {
  await sodiumReady();
  const clock = new TestClock();
  const blobs = new MemoryBlobs();
  const deps = {
    db: new MemoryDb(),
    blobs,
    blobsResolver: new MemoryBlobsResolver(blobs),
    mail: new MemoryMail(),
    clock,
    rand: new RealRand(),
    config: {
      ...configFromEnv(),
      hardcodedOttSuffix: undefined,
      hardcodedOttValue: undefined,
      ...configOverrides,
    },
    ids: new IdGenerator(clock),
    hashingKey: new Uint8Array(32).fill(7),
  };
  const app = buildApp(deps);

  const request: TestWorld['request'] = async (method, path, opts = {}) => {
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

  return { deps, app, request };
};
