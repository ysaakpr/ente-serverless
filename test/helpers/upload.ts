/**
 * Upload-side of the synthetic client: encrypt real bytes (secretbox with a
 * per-file key), PUT via presigned URLs, commit, and decrypt on download —
 * proving the byte path end to end.
 */

import sodium from '../../src/lib/sodium.ts';
import { randomBytes } from 'node:crypto';
import { b64 } from '../../src/lib/b64.ts';
import type { TestWorld } from './deps.ts';
import type { Account } from './client.ts';

export interface EncryptedBlob {
  key: Uint8Array;
  nonce: Uint8Array;
  cipher: Uint8Array;
  decryptionHeader: string;
}

export const encryptBlob = (plain: Uint8Array): EncryptedBlob => {
  const key = sodium.crypto_secretbox_keygen();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  return {
    key,
    nonce,
    cipher: sodium.crypto_secretbox_easy(plain, nonce, key),
    decryptionHeader: b64(nonce),
  };
};

export const decryptBlob = (cipher: Uint8Array, blob: EncryptedBlob): Uint8Array =>
  sodium.crypto_secretbox_open_easy(cipher, blob.nonce, blob.key);

export interface UploadedFile {
  fileId: number;
  collectionID: number;
  file: EncryptedBlob;
  thumb: EncryptedBlob;
  fileObjectKey: string;
  thumbObjectKey: string;
  response: Record<string, unknown>;
}

export const createAlbum = async (world: TestWorld, account: Account, name = 'album'): Promise<number> => {
  const res = await world.request('POST', '/collections', {
    token: account.token,
    body: {
      encryptedKey: b64(randomBytes(48)),
      keyDecryptionNonce: b64(randomBytes(24)),
      encryptedName: b64(new TextEncoder().encode(name)),
      nameDecryptionNonce: b64(randomBytes(24)),
      type: 'album',
      attributes: { version: 0 },
    },
  });
  if (res.status !== 200) throw new Error(`collection create failed: ${res.status}`);
  const { collection } = (await res.json()) as { collection: { id: number } };
  return collection.id;
};

export const uploadAndCommit = async (
  world: TestWorld,
  account: Account,
  collectionID: number,
  plainFile: Uint8Array,
  plainThumb: Uint8Array,
  opts: { multipartParts?: number } = {},
): Promise<UploadedFile> => {
  const file = encryptBlob(plainFile);
  const thumb = encryptBlob(plainThumb);

  let fileObjectKey: string;
  if (opts.multipartParts) {
    const mpu = await world.request(
      'GET',
      `/files/multipart-upload-urls?count=${opts.multipartParts}`,
      { token: account.token },
    );
    if (mpu.status !== 200) throw new Error(`multipart urls failed: ${mpu.status}`);
    const { urls } = (await mpu.json()) as {
      urls: { objectKey: string; partURLs: string[]; completeURL: string };
    };
    fileObjectKey = urls.objectKey;
    const partSize = Math.ceil(file.cipher.length / opts.multipartParts);
    for (let i = 0; i < opts.multipartParts; i++) {
      const part = file.cipher.slice(i * partSize, (i + 1) * partSize);
      await world.deps.blobs.uploadViaUrl(urls.partURLs[i]!, part);
    }
    await world.deps.blobs.completeViaUrl(urls.completeURL);
  } else {
    const res = await world.request('GET', '/files/upload-urls?count=1', { token: account.token });
    if (res.status !== 200) throw new Error(`upload-urls failed: ${res.status}`);
    const { urls } = (await res.json()) as { urls: Array<{ objectKey: string; url: string }> };
    fileObjectKey = urls[0]!.objectKey;
    await world.deps.blobs.uploadViaUrl(urls[0]!.url, file.cipher);
  }

  const thumbRes = await world.request('GET', '/files/upload-urls?count=1', { token: account.token });
  const thumbUrls = ((await thumbRes.json()) as { urls: Array<{ objectKey: string; url: string }> }).urls;
  const thumbObjectKey = thumbUrls[0]!.objectKey;
  await world.deps.blobs.uploadViaUrl(thumbUrls[0]!.url, thumb.cipher);

  const commit = await world.request('POST', '/files', {
    token: account.token,
    body: {
      id: 0,
      collectionID,
      encryptedKey: b64(randomBytes(48)),
      keyDecryptionNonce: b64(randomBytes(24)),
      file: { objectKey: fileObjectKey, decryptionHeader: file.decryptionHeader },
      thumbnail: { objectKey: thumbObjectKey, decryptionHeader: thumb.decryptionHeader },
      metadata: { encryptedData: b64(randomBytes(64)), decryptionHeader: b64(randomBytes(24)) },
      updationTime: Date.now() * 1000,
    },
  });
  if (commit.status !== 200) throw new Error(`commit failed: ${commit.status} ${await commit.text()}`);
  const response = (await commit.json()) as Record<string, unknown>;
  return {
    fileId: response.id as number,
    collectionID,
    file,
    thumb,
    fileObjectKey,
    thumbObjectKey,
    response,
  };
};
