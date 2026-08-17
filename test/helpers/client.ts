/**
 * The synthetic client — the test-suite's "phone". Real libsodium key
 * bundle (kek, master key, keypair, sealed-box open) + the go-srp client
 * math from src/domain/srp.ts. Mirrors what the mobile/web clients do,
 * minus argon2 (the kek is random here; the server never sees it anyway).
 */

import sodium from '../../src/lib/sodium.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { computeVerifier, SrpClient } from '../../src/domain/srp.ts';
import { b64, b64Url, fromB64 } from '../../src/lib/b64.ts';
import type { TestWorld } from './deps.ts';

export interface ClientKeys {
  masterKey: Uint8Array;
  kek: Uint8Array;
  loginSubKey: Uint8Array;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  keyAttributes: Record<string, unknown>;
}

export const makeClientKeys = (): ClientKeys => {
  const masterKey = sodium.crypto_secretbox_keygen();
  const kek = sodium.crypto_secretbox_keygen();
  // web srp.ts: loginSubKey = deriveSubKeyBytes(kek, 32, 1, "loginctx")
  const loginSubKey = sodium.crypto_kdf_derive_from_key(32, 1, 'loginctx', kek);
  const { publicKey, privateKey: secretKey } = sodium.crypto_box_keypair();

  const seal = (data: Uint8Array, key: Uint8Array) => {
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    return {
      cipher: b64(sodium.crypto_secretbox_easy(data, nonce, key)),
      nonce: b64(nonce),
    };
  };

  const encryptedKey = seal(masterKey, kek);
  const encryptedSecretKey = seal(secretKey, masterKey);
  const recoveryKey = sodium.crypto_secretbox_keygen();
  const mkWithRecovery = seal(masterKey, recoveryKey);
  const rkWithMaster = seal(recoveryKey, masterKey);

  return {
    masterKey,
    kek,
    loginSubKey,
    publicKey,
    secretKey,
    keyAttributes: {
      kekSalt: b64(randomBytes(16)),
      encryptedKey: encryptedKey.cipher,
      keyDecryptionNonce: encryptedKey.nonce,
      publicKey: b64(publicKey),
      encryptedSecretKey: encryptedSecretKey.cipher,
      secretKeyDecryptionNonce: encryptedSecretKey.nonce,
      memLimit: 1073741824,
      opsLimit: 4,
      masterKeyEncryptedWithRecoveryKey: mkWithRecovery.cipher,
      masterKeyDecryptionNonce: mkWithRecovery.nonce,
      recoveryKeyEncryptedWithMasterKey: rkWithMaster.cipher,
      recoveryKeyDecryptionNonce: rkWithMaster.nonce,
    },
  };
};

/** Open the sealed-box encryptedToken and re-encode like a real client. */
export const openEncryptedToken = (
  encryptedToken: string,
  keys: ClientKeys,
): string => {
  const opened = sodium.crypto_box_seal_open(fromB64(encryptedToken), keys.publicKey, keys.secretKey);
  return b64Url(opened);
};

export interface Account {
  email: string;
  userId: number;
  token: string;
  keys: ClientKeys;
  srpUserID: string;
  srpSalt: Uint8Array;
}

/** Full signup: OTT -> verify -> keyAttributes -> SRP setup+complete. */
export const signupAccount = async (world: TestWorld, email: string): Promise<Account> => {
  await sodium.ready;
  const keys = makeClientKeys();

  const ott = await world.request('POST', '/users/ott', {
    body: { email, purpose: 'signup', client: 'test' },
  });
  if (ott.status !== 200) throw new Error(`ott failed: ${ott.status}`);
  const code = lastOttCode(world, email);

  const verify = await world.request('POST', '/users/verify-email', {
    body: { email, ott: code },
  });
  const verifyBody = (await verify.json()) as { id: number; token: string };
  const token = verifyBody.token;

  const attrs = await world.request('PUT', '/users/attributes', {
    token,
    body: { keyAttributes: keys.keyAttributes },
  });
  if (attrs.status !== 200) throw new Error(`attributes failed: ${attrs.status}`);

  const { srpUserID, srpSalt } = await setupSrp(world, token, keys);
  return { email, userId: verifyBody.id, token, keys, srpUserID, srpSalt };
};

export const setupSrp = async (
  world: TestWorld,
  token: string,
  keys: ClientKeys,
): Promise<{ srpUserID: string; srpSalt: Uint8Array }> => {
  const srpUserID = randomUUID();
  const srpSalt = new Uint8Array(randomBytes(16));
  const identity = new TextEncoder().encode(srpUserID);
  const verifier = computeVerifier(srpSalt, identity, keys.loginSubKey);

  const client = new SrpClient(srpSalt, identity, keys.loginSubKey, randomBytes(32));
  const setup = await world.request('POST', '/users/srp/setup', {
    token,
    body: {
      srpUserID,
      srpSalt: b64(srpSalt),
      srpVerifier: b64(verifier),
      srpA: b64(client.computeA()),
    },
  });
  if (setup.status !== 200) throw new Error(`srp setup failed: ${setup.status}`);
  const setupBody = (await setup.json()) as { setupID: string; srpB: string };

  client.setB(fromB64(setupBody.srpB));
  const complete = await world.request('POST', '/users/srp/complete', {
    token,
    body: { setupID: setupBody.setupID, srpM1: b64(client.computeM1()) },
  });
  if (complete.status !== 200) throw new Error(`srp complete failed: ${complete.status}`);
  const completeBody = (await complete.json()) as { srpM2: string };
  if (!client.checkM2(fromB64(completeBody.srpM2))) throw new Error('server M2 invalid');
  return { srpUserID, srpSalt };
};

/** SRP login: attributes -> create-session -> verify-session -> unseal token. */
export const srpLogin = async (
  world: TestWorld,
  email: string,
  keys: ClientKeys,
): Promise<{ token: string; response: Record<string, unknown> }> => {
  const attrsRes = await world.request(
    'GET',
    `/users/srp/attributes?email=${encodeURIComponent(email)}`,
  );
  if (attrsRes.status !== 200) throw new Error(`srp attributes failed: ${attrsRes.status}`);
  const { attributes } = (await attrsRes.json()) as {
    attributes: { srpUserID: string; srpSalt: string };
  };

  const identity = new TextEncoder().encode(attributes.srpUserID);
  const salt = fromB64(attributes.srpSalt);
  const client = new SrpClient(salt, identity, keys.loginSubKey, randomBytes(32));

  const create = await world.request('POST', '/users/srp/create-session', {
    body: { srpUserID: attributes.srpUserID, srpA: b64(client.computeA()) },
  });
  if (create.status !== 200) throw new Error(`create-session failed: ${create.status}`);
  const createBody = (await create.json()) as { sessionID: string; srpB: string };

  client.setB(fromB64(createBody.srpB));
  const verify = await world.request('POST', '/users/srp/verify-session', {
    body: {
      sessionID: createBody.sessionID,
      srpUserID: attributes.srpUserID,
      srpM1: b64(client.computeM1()),
    },
  });
  if (verify.status !== 200) throw new Error(`verify-session failed: ${verify.status}`);
  const body = (await verify.json()) as Record<string, unknown>;
  if (!client.checkM2(fromB64(body.srpM2 as string))) throw new Error('server M2 invalid');
  // With 2FA enabled the server returns a twoFactorSessionID and no token at
  // all; callers in that case read `response.twoFactorSessionID` instead.
  const token = body.encryptedToken
    ? openEncryptedToken(body.encryptedToken as string, keys)
    : '';
  return { token, response: body };
};

/** Pull the last OTT code for an email out of the mail spy. */
export const lastOttCode = (world: TestWorld, email: string): string => {
  const sent = world.deps.mail.sent.filter((m) => m.to === email.trim().toLowerCase());
  const last = sent.at(-1);
  if (!last) throw new Error(`no OTT mail for ${email}`);
  return (last.templateData as { VerificationCode: string }).VerificationCode;
};
