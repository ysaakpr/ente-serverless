/**
 * [SHARING] [AUTHZ] — the Phase B seam (resolveCollectionAccess + the sharee
 * branch of getAccessibleFile), exercised over the wire. No share endpoint
 * exists yet (Phase C), so participant rows are seeded directly through the
 * Phase A data layer (addSharee/removeSharee). Covers: viewer read-only,
 * collaborator add-own-files, the remove-files v3 role matrix, sharee
 * download/preview + revocation, commit staying owner-only, and /files/info
 * staying strict-ownership (all per museum source — citations in handlers).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeWorld, type TestWorld } from '../helpers/deps.ts';
import { signupAccount, type Account } from '../helpers/client.ts';
import { createAlbum, uploadAndCommit, type UploadedFile } from '../helpers/upload.ts';
import { addSharee, removeSharee, type ShareeRole } from '../../src/domain/sharing.ts';
import { b64 } from '../../src/lib/b64.ts';

let world: TestWorld;
let owner: Account;
let mate: Account;
let album: number; // owner's shared album
let ownerFile: UploadedFile;

const share = (userID: number, role: ShareeRole) =>
  addSharee(world.deps, {
    collectionID: album,
    userID,
    role,
    encryptedKey: b64(randomBytes(48)),
    sharedBy: owner.userId,
  });

const item = (id: number) => ({
  id,
  encryptedKey: b64(randomBytes(48)),
  keyDecryptionNonce: b64(randomBytes(24)),
});

const getDiff = async (token: string, collectionId = album) =>
  world.request('GET', `/collections/v2/diff?collectionID=${collectionId}&sinceTime=0`, { token });

const rename = (token: string) =>
  world.request('POST', '/collections/rename', {
    token,
    body: { collectionID: album, encryptedName: b64(randomBytes(12)), nameDecryptionNonce: b64(randomBytes(24)) },
  });

/** Upload a file the sharee OWNS (committed into their own album — commit
 * into a shared collection is owner-only) and add it to the shared album. */
const addOwnFileToShared = async (account: Account) => {
  const ownAlbum = await createAlbum(world, account, 'own');
  const up = await uploadAndCommit(world, account, ownAlbum, new Uint8Array(randomBytes(96)), new Uint8Array(randomBytes(16)));
  const res = await world.request('POST', '/collections/add-files', {
    token: account.token,
    body: { collectionID: album, files: [item(up.fileId)] },
  });
  return { up, res };
};

beforeEach(async () => {
  world = await makeWorld();
  owner = await signupAccount(world, 'share-owner@b.c');
  mate = await signupAccount(world, 'share-mate@b.c');
  album = await createAlbum(world, owner, 'shared');
  ownerFile = await uploadAndCommit(world, owner, album, new Uint8Array(randomBytes(128)), new Uint8Array(randomBytes(16)));
});

describe('role gates on collection endpoints', () => {
  it('non-member reads 403; VIEWER can getById + diff but cannot add/rename/meta/delete', async () => {
    // Before the share: mate is a non-member.
    expect((await world.request('GET', `/collections/${album}`, { token: mate.token })).status).toBe(403);
    expect((await getDiff(mate.token)).status).toBe(403);

    await share(mate.userId, 'VIEWER');

    const byId = await world.request('GET', `/collections/${album}`, { token: mate.token });
    expect(byId.status).toBe(200);
    expect(((await byId.json()) as { collection: { id: number } }).collection.id).toBe(album);

    const diff = await getDiff(mate.token);
    expect(diff.status).toBe(200);
    const { diff: files } = (await diff.json()) as { diff: Array<{ id: number }> };
    expect(files.map((f) => f.id)).toContain(ownerFile.fileId);

    // Writes stay closed: add-files (even of a file the viewer owns), rename,
    // magic-metadata, delete v3, move-files, restore-files.
    const { res: add } = await addOwnFileToShared(mate);
    expect(add.status).toBe(403);
    expect((await rename(mate.token)).status).toBe(403);
    const meta = await world.request('PUT', '/collections/magic-metadata', {
      token: mate.token,
      body: { id: album, magicMetadata: { version: 0, count: 1, data: 'ZA==', header: 'aA==' } },
    });
    expect(meta.status).toBe(403);
    const del = await world.request('DELETE', `/collections/v3/${album}?collectionID=${album}&keepFiles=false`, {
      token: mate.token,
    });
    expect(del.status).toBe(403);
    const mateAlbum = await createAlbum(world, mate, 'mine');
    const move = await world.request('POST', '/collections/move-files', {
      token: mate.token,
      body: { fromCollectionID: album, toCollectionID: mateAlbum, files: [item(ownerFile.fileId)] },
    });
    expect(move.status).toBe(403);
    const restore = await world.request('POST', '/collections/restore-files', {
      token: mate.token,
      body: { collectionID: album, files: [item(ownerFile.fileId)] },
    });
    expect(restore.status).toBe(403);
  });

  it('COLLABORATOR adds own files (not the owner\'s, not via direct commit); owner-only mutations stay 403', async () => {
    await share(mate.userId, 'COLLABORATOR');

    // Direct commit into the shared collection is owner-only (museum
    // validateFileCreateOrUpdateReq) — the collaborator path is
    // commit-into-own-collection + add-files.
    const urls = await world.request('GET', '/files/upload-urls?count=2', { token: mate.token });
    const { urls: presigned } = (await urls.json()) as { urls: Array<{ objectKey: string; url: string }> };
    await world.deps.blobs.uploadViaUrl(presigned[0]!.url, randomBytes(64));
    await world.deps.blobs.uploadViaUrl(presigned[1]!.url, randomBytes(16));
    const commit = await world.request('POST', '/files', {
      token: mate.token,
      body: {
        id: 0,
        collectionID: album,
        encryptedKey: b64(randomBytes(48)),
        keyDecryptionNonce: b64(randomBytes(24)),
        file: { objectKey: presigned[0]!.objectKey, decryptionHeader: b64(randomBytes(24)) },
        thumbnail: { objectKey: presigned[1]!.objectKey, decryptionHeader: b64(randomBytes(24)) },
        metadata: { encryptedData: b64(randomBytes(64)), decryptionHeader: b64(randomBytes(24)) },
      },
    });
    expect(commit.status).toBe(403);

    const { up, res: add } = await addOwnFileToShared(mate);
    expect(add.status).toBe(200);

    // The collaborator-owned file lands in the shared diff, attribution kept.
    const diff = await getDiff(owner.token);
    const { diff: files } = (await diff.json()) as { diff: Array<{ id: number; ownerID: number; collectionOwnerID: number }> };
    const added = files.find((f) => f.id === up.fileId)!;
    expect(added.ownerID).toBe(mate.userId);
    expect(added.collectionOwnerID).toBe(owner.userId);

    // Adding a file the collaborator does NOT own is refused (VerifyFileOwnership).
    const foreign = await world.request('POST', '/collections/add-files', {
      token: mate.token,
      body: { collectionID: album, files: [item(ownerFile.fileId)] },
    });
    expect(foreign.status).toBe(403);

    // Owner-only mutations stay closed to collaborators.
    expect((await rename(mate.token)).status).toBe(403);
    const del = await world.request('DELETE', `/collections/v3/${album}?collectionID=${album}&keepFiles=false`, {
      token: mate.token,
    });
    expect(del.status).toBe(403);
  });
});

describe('remove-files v3 role matrix (museum isRemoveAllowed)', () => {
  it('owner removes sharee-owned files; sharees remove only their own', async () => {
    await share(mate.userId, 'COLLABORATOR');
    const viewer = await signupAccount(world, 'share-viewer@b.c');
    await share(viewer.userId, 'VIEWER');

    const { up: mateFile } = await addOwnFileToShared(mate);
    const remove = (token: string, fileIDs: number[]) =>
      world.request('POST', '/collections/v3/remove-files', {
        token,
        body: { collectionID: album, fileIDs },
      });

    // A sharee can never remove the collection owner's files (museum 400,
    // "can not remove files owned by album owner").
    expect((await remove(mate.token, [ownerFile.fileId])).status).toBe(400);
    // Nor another sharee's files (403, "can not remove files owned by others").
    expect((await remove(viewer.token, [mateFile.fileId])).status).toBe(403);
    // A mixed batch containing the owner's files still 400s as a whole.
    expect((await remove(mate.token, [ownerFile.fileId, mateFile.fileId])).status).toBe(400);

    // The collection owner removes sharee-owned files.
    expect((await remove(owner.token, [mateFile.fileId])).status).toBe(200);
    const afterOwnerRemove = await getDiff(mate.token);
    const { diff: files } = (await afterOwnerRemove.json()) as { diff: Array<{ id: number; isDeleted: boolean }> };
    expect(files.find((f) => f.id === mateFile.fileId)!.isDeleted).toBe(true);

    // A sharee removes files they own (re-add, then self-remove).
    const readd = await world.request('POST', '/collections/add-files', {
      token: mate.token,
      body: { collectionID: album, files: [item(mateFile.fileId)] },
    });
    expect(readd.status).toBe(200);
    expect((await remove(mate.token, [mateFile.fileId])).status).toBe(200);
  });
});

describe('sharee file access (getAccessibleFile sharee branch)', () => {
  it('sharee downloads + previews a shared file; unshare revokes back to 404', async () => {
    // Not shared yet: enumeration-resistant 404, not 403.
    expect((await world.request('GET', `/files/download/v2/${ownerFile.fileId}`, { token: mate.token })).status).toBe(404);

    await share(mate.userId, 'VIEWER');
    const download = await world.request('GET', `/files/download/v2/${ownerFile.fileId}`, { token: mate.token });
    expect(download.status).toBe(200);
    const { url } = (await download.json()) as { url: string };
    expect(Buffer.from(await world.deps.blobs.downloadViaUrl(url))).toEqual(Buffer.from(ownerFile.file.cipher));
    expect((await world.request('GET', `/files/preview/v2/${ownerFile.fileId}`, { token: mate.token })).status).toBe(200);

    await removeSharee(world.deps, album, mate.userId);
    expect((await world.request('GET', `/files/download/v2/${ownerFile.fileId}`, { token: mate.token })).status).toBe(404);
  });

  it('collection owner reads a collaborator-owned file; removal revokes the sharee path', async () => {
    await share(mate.userId, 'COLLABORATOR');
    const { up: mateFile } = await addOwnFileToShared(mate);

    // Owner branch of museum's accessible-object SQL: the file lives in a
    // collection the owner owns, so the owner can fetch it.
    expect((await world.request('GET', `/files/download/v2/${mateFile.fileId}`, { token: owner.token })).status).toBe(200);

    // Once the link is tombstoned the file is the collaborator's alone again.
    await world.request('POST', '/collections/v3/remove-files', {
      token: owner.token,
      body: { collectionID: album, fileIDs: [mateFile.fileId] },
    });
    expect((await world.request('GET', `/files/download/v2/${mateFile.fileId}`, { token: owner.token })).status).toBe(404);
    expect((await world.request('GET', `/files/download/v2/${mateFile.fileId}`, { token: mate.token })).status).toBe(200);
  });

  it('/files/info stays strict-ownership: a sharee still 403s on a shared file (museum parity)', async () => {
    await share(mate.userId, 'VIEWER');
    const info = await world.request('POST', '/files/info', {
      token: mate.token,
      body: { fileIDs: [ownerFile.fileId] },
    });
    expect(info.status).toBe(403); // museum GetFileInfo -> VerifyFileOwner (D49)
  });
});
