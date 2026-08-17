/** [HEALTH] GET /ping — 2 scenarios. */

import { beforeAll, describe, expect, it } from 'vitest';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';

describe('GET /ping', () => {
  let world: TestWorld;
  beforeAll(async () => {
    world = await makeWorld();
  });

  it('returns 200 with the expected shape', async () => {
    const res = await world.request('GET', '/ping');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ message: 'pong', id: world.deps.config.instanceId });
  });

  it('is reachable without any headers', async () => {
    const res = await world.app.request('/ping');
    expect(res.status).toBe(200);
  });
});
