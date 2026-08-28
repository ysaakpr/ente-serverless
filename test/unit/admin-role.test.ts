/**
 * [D63] ADMIN sharee role — the app's "add admin" / role-change UI drives
 * everything through POST /collections/share with role strings, and museum's
 * capability matrix (oracle-verified 2026-08-28 against the pinned image):
 *  - owner OR ADMIN sharee may share/unshare/change roles
 *    (collectionForShareMutation, share.go); COLLABORATOR/VIEWER 403;
 *  - CanAdd (add-files) includes ADMIN (ente/access.go);
 *  - remove-files v3: owner and ADMIN remove sharee-owned files; an ADMIN's
 *    request for OWNER-owned files is the remove-suggestion branch — 200,
 *    links untouched (our suggestion store is the empty stub);
 *  - public-link ops stay OWNER-only (museum 403s an admin on
 *    mint/update/disable);
 *  - unshare of self/owner stays 403 even for an ADMIN.
 */

import { beforeEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { createAlbum, uploadAndCommit } from '../helpers/upload.ts';
import { b64 } from '../../src/lib/b64.ts';

let world: TestWorld;
let O: Account; // owner
let B: Account; // the admin
let C: Account; // collaborator/viewer
let album: number;

const share = (actor: Account, collectionID: number, email: string, role?: string) =>
  world.request('POST', '/collections/share', {
    token: actor.token,
    body: { collectionID, email, encryptedKey: b64(randomBytes(80)), ...(role ? { role } : {}) },
  });

const sharees = async (collectionID: number, viewer: Account) => {
  const res = await world.request('GET', `/collections/sharees?collectionID=${collectionID}`, {
    token: viewer.token,
  });
  return ((await res.json()) as { sharees: Array<{ id: number; email: string; role: string }> }).sharees;
};

const addFiles = (actor: Account, collectionID: number, id: number) =>
  world.request('POST', '/collections/add-files', {
    token: actor.token,
    body: { collectionID, files: [{ id, encryptedKey: b64(randomBytes(48)), keyDecryptionNonce: b64(randomBytes(24)) }] },
  });

const removeV3 = (actor: Account, collectionID: number, fileIDs: number[]) =>
  world.request('POST', '/collections/v3/remove-files', {
    token: actor.token,
    body: { collectionID, fileIDs },
  });

const liveLink = async (collectionID: number, fileId: number, viewer: Account) => {
  const res = await world.request('GET', `/collections/v2/diff?collectionID=${collectionID}&sinceTime=0`, {
    token: viewer.token,
  });
  const { diff } = (await res.json()) as { diff: Array<{ id: number; isDeleted: boolean }> };
  return diff.some((f) => f.id === fileId && !f.isDeleted);
};

const seed = () => new Uint8Array(randomBytes(64));

beforeEach(async () => {
  world = await makeWorld();
  O = await signupAccount(world, 'adm-owner@b.c');
  B = await signupAccount(world, 'adm-admin@b.c');
  C = await signupAccount(world, 'adm-collab@b.c');
  album = await createAlbum(world, O, 'admin-album');
  const grant = await share(O, album, B.email, 'ADMIN');
  expect(grant.status).toBe(200);
});

it('owner grants ADMIN; the sharees list carries the role', async () => {
  const list = await sharees(album, O);
  expect(list.find((s) => s.id === B.userId)?.role).toBe('ADMIN');
});

it('an ADMIN shares, changes roles via re-share, and unshares; self-unshare stays 403', async () => {
  // admin adds C as VIEWER
  const add = await share(B, album, C.email, 'VIEWER');
  expect(add.status).toBe(200);
  expect((await sharees(album, O)).find((s) => s.id === C.userId)?.role).toBe('VIEWER');

  // admin promotes C to COLLABORATOR (role change = re-share, museum upsert)
  const promote = await share(B, album, C.email, 'COLLABORATOR');
  expect(promote.status).toBe(200);
  expect((await sharees(album, O)).find((s) => s.id === C.userId)?.role).toBe('COLLABORATOR');

  // admin cannot unshare themselves (museum 403) or the owner
  const self = await world.request('POST', '/collections/unshare', {
    token: B.token, body: { collectionID: album, email: B.email },
  });
  expect(self.status).toBe(403);

  // admin unshares C
  const un = await world.request('POST', '/collections/unshare', {
    token: B.token, body: { collectionID: album, email: C.email },
  });
  expect(un.status).toBe(200);
  expect((await sharees(album, O)).some((s) => s.id === C.userId)).toBe(false);
});

it('COLLABORATOR and VIEWER cannot share or unshare (403)', async () => {
  await share(O, album, C.email, 'COLLABORATOR');
  const asCollab = await share(C, album, 'nobody@b.c', 'VIEWER');
  expect(asCollab.status).toBe(403);
  await share(O, album, C.email, 'VIEWER');
  const asViewer = await share(C, album, 'nobody@b.c', 'VIEWER');
  expect(asViewer.status).toBe(403);
  const unshare = await world.request('POST', '/collections/unshare', {
    token: C.token, body: { collectionID: album, email: B.email },
  });
  expect(unshare.status).toBe(403);
});

it('owner demotes the ADMIN; the demoted sharee loses share rights', async () => {
  const demote = await share(O, album, B.email, 'VIEWER');
  expect(demote.status).toBe(200);
  expect((await sharees(album, O)).find((s) => s.id === B.userId)?.role).toBe('VIEWER');
  const denied = await share(B, album, C.email, 'VIEWER');
  expect(denied.status).toBe(403);
});

it('an ADMIN can add-files (CanAdd) — own files only, like a collaborator', async () => {
  const bAlbum = await createAlbum(world, B, 'b-own');
  const up = await uploadAndCommit(world, B, bAlbum, seed(), seed());
  const add = await addFiles(B, album, up.fileId);
  expect(add.status).toBe(200);
  expect(await liveLink(album, up.fileId, O)).toBe(true);
});

it('remove-files v3: ADMIN removes sharee-owned files; owner-owned files survive as the suggestion no-op', async () => {
  // C (collaborator) contributes a file; O owns one too
  await share(O, album, C.email, 'COLLABORATOR');
  const cAlbum = await createAlbum(world, C, 'c-own');
  const cUp = await uploadAndCommit(world, C, cAlbum, seed(), seed());
  await addFiles(C, album, cUp.fileId);
  const oUp = await uploadAndCommit(world, O, album, seed(), seed());

  // admin removes both in one batch: sharee file goes, owner file stays (200)
  const rm = await removeV3(B, album, [cUp.fileId, oUp.fileId]);
  expect(rm.status).toBe(200);
  expect(await liveLink(album, cUp.fileId, O)).toBe(false);
  expect(await liveLink(album, oUp.fileId, O)).toBe(true);

  // the stubbed suggestions inbox keeps its museum envelope
  const inbox = await world.request('GET', '/collection-actions/delete-suggestions', { token: O.token });
  expect(inbox.status).toBe(200);
  expect(await inbox.json()).toEqual({ actions: [], hasMore: false });

  // owner asking to remove their own files is still the 400 with museum's text
  const ownerRm = await removeV3(O, album, [oUp.fileId]);
  expect(ownerRm.status).toBe(400);

  // a collaborator still cannot remove other sharees' files
  const bAlbum = await createAlbum(world, B, 'b-own-2');
  const bUp = await uploadAndCommit(world, B, bAlbum, seed(), seed());
  await addFiles(B, album, bUp.fileId);
  const collabRm = await removeV3(C, album, [bUp.fileId]);
  expect(collabRm.status).toBe(403);
});

it('public-link ops stay OWNER-only: an ADMIN reads 403 on mint/update/disable', async () => {
  const mint = await world.request('POST', '/collections/share-url', {
    token: B.token, body: { collectionID: album },
  });
  expect(mint.status).toBe(403);
  await world.request('POST', '/collections/share-url', { token: O.token, body: { collectionID: album } });
  const upd = await world.request('PUT', '/collections/share-url', {
    token: B.token, body: { collectionID: album, enableDownload: false },
  });
  expect(upd.status).toBe(403);
  const del = await world.request('DELETE', `/collections/share-url/${album}`, { token: B.token });
  expect(del.status).toBe(403);
});

it('ADMIN grant re-emits the collection in both feeds (D62 bump rides the share restamp)', async () => {
  const album2 = await createAlbum(world, O, 'feed-check');
  const feed = async (who: Account, since: number) =>
    (((await (await world.request('GET', `/collections/v2?sinceTime=${since}`, { token: who.token })).json()) as any)
      .collections as any[]);
  const since = Math.max(...(await feed(O, 0)).map((c) => c.updationTime));
  const res = await share(O, album2, B.email, 'ADMIN');
  expect(res.status).toBe(200);
  expect((await feed(O, since)).some((c) => c.id === album2)).toBe(true);
  const bEntry = (await feed(B, 0)).find((c) => c.id === album2);
  expect(bEntry).toBeDefined();
  expect(bEntry.sharees.find((s: any) => s.id === B.userId)?.role).toBe('ADMIN');
});

it('an unknown role string stays a 400 (documented divergence: museum 500s)', async () => {
  const res = await share(O, album, C.email, 'BANANA');
  expect(res.status).toBe(400);
});
