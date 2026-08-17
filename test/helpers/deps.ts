/** Test bootstrap: memory adapters, controllable clock, the assembled app. */

import type { Deps } from '../../src/deps.ts';
import { MemoryDb } from '../../src/adapters/memory/db.memory.ts';
import { MemoryBlobs } from '../../src/adapters/memory/blobs.memory.ts';
import { MemoryMail } from '../../src/adapters/memory/mail.memory.ts';
import { RealRand, TestClock } from '../../src/adapters/memory/system.memory.ts';
import { configFromEnv } from '../../src/config.ts';
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

export const makeWorld = async (): Promise<TestWorld> => {
  await sodiumReady();
  const clock = new TestClock();
  const deps = {
    db: new MemoryDb(),
    blobs: new MemoryBlobs(),
    mail: new MemoryMail(),
    clock,
    rand: new RealRand(),
    config: {
      ...configFromEnv(),
      hardcodedOttSuffix: undefined,
      hardcodedOttValue: undefined,
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
