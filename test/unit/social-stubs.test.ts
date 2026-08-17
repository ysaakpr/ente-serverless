/** Social/sharing sync probes (gate finding D27) — shape + auth. */

import { beforeEach, describe, expect, it } from 'vitest';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';

let world: TestWorld;
let account: Account;

beforeEach(async () => {
  world = await makeWorld();
  account = await signupAccount(world, 'social@b.c');
});

const ROUTES: Array<[string, Record<string, unknown>]> = [
  ['/comments-reactions/updated-at', { updates: [] }],
  ['/comments-reactions/counts', { counts: [] }],
  ['/collection-actions/pending-remove', { actions: [], hasMore: false }],
  ['/collection-actions/delete-suggestions', { actions: [], hasMore: false }],
  ['/contacts/diff', { diff: [] }],
];

describe('social/sharing sync probes', () => {
  it('every probe answers 200 with its empty envelope', async () => {
    for (const [path, expected] of ROUTES) {
      const res = await world.request('GET', `${path}?sinceTime=0`, { token: account.token });
      expect(res.status, path).toBe(200);
      expect(await res.json(), path).toEqual(expected);
    }
  });

  it('all require auth', async () => {
    for (const [path] of ROUTES) {
      expect((await world.request('GET', path)).status, path).toBe(401);
    }
  });
});
