/**
 * Sharing/link data layer (Phase A, D48) — the invariants Phase B+ will lean
 * on: participant dual-writes never half-apply, the reverse partition tracks
 * add/remove exactly, link tokens are hash-only at rest, and none of the new
 * rows leak into the sparse GSIs (the rollback-safety property).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import {
  addSharee,
  createPublicLink,
  disableLink,
  getLinkByTokenHash,
  getLinkForCollection,
  getSharee,
  listSharedCollectionIds,
  listSharees,
  removeSharee,
} from '../../src/domain/sharing.ts';
import { generateToken, tokenHash } from '../../src/domain/tokens.ts';
import { gsi } from '../../src/domain/model.ts';
import { ConditionFailedError } from '../../src/ports/db.ts';

let world: TestWorld;
beforeEach(async () => {
  world = await makeWorld();
});

const share = (collectionID: number, userID: number, role: 'VIEWER' | 'COLLABORATOR' = 'VIEWER') =>
  addSharee(world.deps, {
    collectionID,
    userID,
    role,
    encryptedKey: `sealed-key-${collectionID}-${userID}`,
    sharedBy: 1,
  });

describe('participant rows (dual-write)', () => {
  it('addSharee writes BOTH sides in one transaction', async () => {
    await share(100, 2, 'COLLABORATOR');
    const rows = world.deps.db.dump();
    const colSide = rows.find((r) => r.pk === 'COL#100' && r.sk === 'SHAREE#2');
    const userSide = rows.find((r) => r.pk === 'USER#2' && r.sk === 'SHARED#100');
    expect(colSide).toMatchObject({ collectionID: 100, userID: 2, role: 'COLLABORATOR' });
    expect(userSide).toMatchObject({ collectionID: 100, userID: 2, role: 'COLLABORATOR' });
  });

  it('removeSharee removes BOTH rows, and is idempotent', async () => {
    await share(100, 2);
    await removeSharee(world.deps, 100, 2);
    const rows = world.deps.db.dump();
    expect(rows.some((r) => r.sk === 'SHAREE#2' || r.sk === 'SHARED#100')).toBe(false);
    await removeSharee(world.deps, 100, 2); // second remove: no throw
  });

  it('listSharedCollectionIds reflects add and remove', async () => {
    await share(100, 2);
    await share(200, 2);
    await share(300, 9); // different user — must not bleed in
    expect((await listSharedCollectionIds(world.deps, 2)).sort()).toEqual([100, 200]);
    await removeSharee(world.deps, 100, 2);
    expect(await listSharedCollectionIds(world.deps, 2)).toEqual([200]);
  });

  it('listSharees lists a collection\'s participants with roles', async () => {
    await share(100, 2, 'VIEWER');
    await share(100, 3, 'COLLABORATOR');
    const sharees = await listSharees(world.deps, 100);
    expect(sharees.map((s) => [s.userID, s.role]).sort()).toEqual([
      [2, 'VIEWER'],
      [3, 'COLLABORATOR'],
    ]);
    expect((await getSharee(world.deps, 100, 3))?.role).toBe('COLLABORATOR');
  });

  it('re-sharing upserts role + wrapped key on both sides together', async () => {
    await share(100, 2, 'VIEWER');
    await share(100, 2, 'COLLABORATOR');
    const rows = world.deps.db.dump().filter((r) => r.userID === 2);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.role === 'COLLABORATOR')).toBe(true);
  });

  it('rollback rule: new rows set NO gsi attributes and stay out of old feeds', async () => {
    await share(100, 2);
    const token = generateToken(world.deps.rand);
    await createPublicLink(world.deps, { collectionID: 100, token, createdBy: 1 });
    const newRows = world.deps.db
      .dump()
      .filter((r) => r.sk === 'SHAREE#2' || r.sk === 'SHARED#100' || r.sk === 'LINK' || r.pk.startsWith('PUBTOKEN#'));
    expect(newRows).toHaveLength(4);
    for (const row of newRows) {
      expect(Object.keys(row).filter((k) => k.startsWith('gsi'))).toEqual([]);
    }
    // Sharee 2's owned-collections feed (gsi2) must not see the shared rows.
    expect(await world.deps.db.query(gsi.userCollections(2), { index: 'gsi2' })).toEqual([]);
  });
});

describe('public link rows', () => {
  it('keys the row by token hash, plaintext alongside (the session-token discipline)', async () => {
    // Phase D reversed D48's hash-only storage: museum re-emits the full
    // token-bearing URL in publicURLs on every owner feed, so the plaintext
    // must be retrievable — stored on the hash-keyed row exactly like session
    // tokens (tokens.ts), never derivable from the key itself. D51.
    const token = generateToken(world.deps.rand);
    const link = await createPublicLink(world.deps, { collectionID: 100, token, createdBy: 1 });
    expect(link.pk).toBe(`PUBTOKEN#${tokenHash(token)}`);
    const rows = world.deps.db.dump();
    // The plaintext lives ONLY as an attribute of the hash-keyed link row —
    // no key (pk/sk/gsi) anywhere embeds it.
    for (const row of rows) {
      for (const attr of Object.keys(row)) {
        if (attr === 'token') continue;
        expect(String(row[attr])).not.toContain(token);
      }
    }
    expect(await getLinkByTokenHash(world.deps, tokenHash(token))).toMatchObject({
      token,
      collectionID: 100,
      isDisabled: false,
      // museum defaults: download + join on, collect off, no expiry/limit
      enableDownload: true,
      enableJoin: true,
      enableCollect: false,
      validTill: 0,
      deviceLimit: 0,
    });
  });

  it('getLinkForCollection resolves via the COL#/LINK pointer', async () => {
    const token = generateToken(world.deps.rand);
    await createPublicLink(world.deps, {
      collectionID: 100,
      token,
      createdBy: 1,
      validTill: 42,
      deviceLimit: 5,
      passHash: 'ph',
      nonce: 'n',
      opsLimit: 4,
      memLimit: 1024,
    });
    const link = await getLinkForCollection(world.deps, 100);
    expect(link).toMatchObject({
      tokenHash: tokenHash(token),
      validTill: 42,
      deviceLimit: 5,
      passHash: 'ph',
      nonce: 'n',
      opsLimit: 4,
      memLimit: 1024,
    });
  });

  it('one active link per collection: a second create fails atomically', async () => {
    await createPublicLink(world.deps, {
      collectionID: 100,
      token: generateToken(world.deps.rand),
      createdBy: 1,
    });
    const second = generateToken(world.deps.rand);
    await expect(
      createPublicLink(world.deps, { collectionID: 100, token: second, createdBy: 1 }),
    ).rejects.toThrow(ConditionFailedError);
    // The loser's PUBTOKEN row must not exist either (all-or-nothing).
    expect(await getLinkByTokenHash(world.deps, tokenHash(second))).toBeNull();
  });

  it('disableLink kills the token at rest and frees the collection for a NEW token', async () => {
    const first = generateToken(world.deps.rand);
    await createPublicLink(world.deps, { collectionID: 100, token: first, createdBy: 1 });
    const disabled = await disableLink(world.deps, 100);
    expect(disabled?.isDisabled).toBe(true);
    expect(await getLinkForCollection(world.deps, 100)).toBeNull();
    // Dead token stays dead at rest for the middleware's isDisabled check.
    expect((await getLinkByTokenHash(world.deps, tokenHash(first)))?.isDisabled).toBe(true);
    // Re-enable mints a NEW token; the old row is never resurrected.
    const second = generateToken(world.deps.rand);
    await createPublicLink(world.deps, { collectionID: 100, token: second, createdBy: 1 });
    expect((await getLinkForCollection(world.deps, 100))?.tokenHash).toBe(tokenHash(second));
    // No active link -> null, not a throw.
    expect(await disableLink(world.deps, 999)).toBeNull();
  });
});
