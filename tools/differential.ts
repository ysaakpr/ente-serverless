/**
 * Differential API runner — drives the SAME scenario list against a live
 * museum and against our server, and diffs status + response shape per step.
 *
 * Usage (both servers must accept the hardcoded OTT 123456 for @example.org):
 *   node --experimental-transform-types tools/differential.ts \
 *     [--museum http://127.0.0.1:8590] [--ours http://127.0.0.1:8581] \
 *     [--minio-container ente-upstream-museum-minio] [--only <prefix>]
 *
 * Museum presigns uploads for its in-network MinIO host, which the host
 * cannot reach (ORACLE-VERSION capture 6 note), so museum-side object bytes
 * are written with `docker exec <minio> mc pipe` instead of the presigned PUT.
 *
 * Exit code: 0 when every step matches or is listed in EXPECTED_DIVERGENCES,
 * 1 otherwise. Museum rate-limits POST /users/ott per IP (~10 accounts);
 * `docker restart <museum>` resets it.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import sodium from '../src/lib/sodium.ts';
import { computeVerifier, SrpClient } from '../src/domain/srp.ts';
import { b64, fromB64 } from '../src/lib/b64.ts';
import { makeClientKeys, type ClientKeys } from '../test/helpers/client.ts';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1]! : fallback;
};
const MUSEUM = arg('museum', 'http://127.0.0.1:8590');
const OURS = arg('ours', 'http://127.0.0.1:8581');
const MINIO = arg('minio-container', 'ente-upstream-minio');
const MINIO_BUCKET = arg('minio-bucket', 'b2-eu-cen');
const ONLY = arg('only', '');

// Steps whose divergence is known and deliberate — reason recorded in
// DECISIONS.md. Anything else that differs fails the run.
const EXPECTED_DIVERGENCES: Record<string, string> = {
  'flags.serverApiFlag': 'D66: we advertise only the bits we implement (13), museum advertises 239',
  'core.preview-upload-url-v2': 'D66: POST preview upload is gated client-side by serverApiFlag bit 8, which we keep off; v1 GET serves',
  'core.deletion-summary': 'D66: not implemented; web + mobile treat 404 as "unsupported" (DeleteAccount.tsx, delete_account_page.dart)',
  'core.unknown-route': "D66: plain-text 404 kept on purpose — mobile's share/batch fallback needs a non-JSON 404 body",
};

interface Res {
  status: number;
  headers: Headers;
  body: unknown;
}

class Target {
  readonly runId = randomBytes(3).toString('hex');
  constructor(
    readonly name: 'museum' | 'ours',
    readonly base: string,
  ) {}

  async req(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Res> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-client-package': 'io.ente.photos',
      ...opts.headers,
    };
    if (opts.token) headers['x-auth-token'] = opts.token;
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      redirect: 'manual',
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text.length ? JSON.parse(text) : null;
    } catch {
      /* keep raw text */
    }
    return { status: res.status, headers: res.headers, body };
  }

  /** Put object bytes where a just-minted upload URL points. */
  async putObject(url: string, objectKey: string, bytes: Uint8Array): Promise<void> {
    if (this.name === 'ours') {
      const md5 = createHash('md5').update(bytes).digest('base64');
      const r = await fetch(url, { method: 'PUT', body: bytes, headers: { 'Content-MD5': md5 } });
      if (!r.ok) throw new Error(`ours PUT ${r.status}: ${await r.text()}`);
      return;
    }
    execFileSync(
      'docker',
      [
        'exec', '-i', MINIO, 'sh', '-c',
        `mc alias set dx http://localhost:3200 minioadmin minioadmin >/dev/null 2>&1; mc pipe dx/${MINIO_BUCKET}/${objectKey} >/dev/null`,
      ],
      { input: bytes },
    );
  }
}

interface Account {
  email: string;
  userId: number;
  token: string;
  keys: ClientKeys;
}

const signup = async (t: Target, label: string): Promise<Account> => {
  const email = `dx-${label}-${t.runId}@example.org`;
  const keys = makeClientKeys();
  const ott = await t.req('POST', '/users/ott', { body: { email, purpose: 'signup' } });
  if (ott.status !== 200) throw new Error(`${t.name} ott ${ott.status} ${JSON.stringify(ott.body)}`);
  const v = await t.req('POST', '/users/verify-email', { body: { email, ott: '123456' } });
  const vb = v.body as { id: number; token: string };
  if (v.status !== 200 || !vb.token) throw new Error(`${t.name} verify ${v.status}`);
  const a = await t.req('PUT', '/users/attributes', { token: vb.token, body: { keyAttributes: keys.keyAttributes } });
  if (a.status !== 200) throw new Error(`${t.name} attributes ${a.status} ${JSON.stringify(a.body)}`);

  const srpUserID = randomUUID();
  const salt = new Uint8Array(randomBytes(16));
  const identity = new TextEncoder().encode(srpUserID);
  const client = new SrpClient(salt, identity, keys.loginSubKey, randomBytes(32));
  const setup = await t.req('POST', '/users/srp/setup', {
    token: vb.token,
    body: {
      srpUserID,
      srpSalt: b64(salt),
      srpVerifier: b64(computeVerifier(salt, identity, keys.loginSubKey)),
      srpA: b64(client.computeA()),
    },
  });
  const sb = setup.body as { setupID: string; srpB: string };
  client.setB(fromB64(sb.srpB));
  const done = await t.req('POST', '/users/srp/complete', {
    token: vb.token,
    body: { setupID: sb.setupID, srpM1: b64(client.computeM1()) },
  });
  if (done.status !== 200) throw new Error(`${t.name} srp complete ${done.status}`);
  return { email, userId: vb.id, token: vb.token, keys };
};

const sealedKeyFor = (recipient: Account, collectionKey: Uint8Array): string =>
  b64(sodium.crypto_box_seal(collectionKey, recipient.keys.publicKey));

const createAlbum = async (t: Target, owner: Account): Promise<{ id: number; key: Uint8Array }> => {
  const key = sodium.crypto_secretbox_keygen();
  const nonce = sodium.randombytes_buf(24);
  const nameNonce = sodium.randombytes_buf(24);
  const r = await t.req('POST', '/collections', {
    token: owner.token,
    body: {
      encryptedKey: b64(sodium.crypto_secretbox_easy(key, nonce, owner.keys.masterKey)),
      keyDecryptionNonce: b64(nonce),
      encryptedName: b64(sodium.crypto_secretbox_easy(new TextEncoder().encode('dx'), nameNonce, key)),
      nameDecryptionNonce: b64(nameNonce),
      type: 'album',
      attributes: { version: 0 },
    },
  });
  if (r.status !== 200) throw new Error(`${t.name} create album ${r.status} ${JSON.stringify(r.body)}`);
  return { id: (r.body as { collection: { id: number } }).collection.id, key };
};

const upload = async (t: Target, owner: Account, collection: { id: number; key: Uint8Array }): Promise<number> => {
  const put = async (bytes: Uint8Array) => {
    const md5 = createHash('md5').update(bytes).digest('base64');
    const u = await t.req('POST', '/files/upload-url', {
      token: owner.token,
      body: { contentLength: bytes.length, contentMD5: md5 },
    });
    if (u.status !== 200) throw new Error(`${t.name} upload-url ${u.status} ${JSON.stringify(u.body)}`);
    const { objectKey, url } = u.body as { objectKey: string; url: string };
    await t.putObject(url, objectKey, bytes);
    return objectKey;
  };
  const fileBytes = new Uint8Array(randomBytes(2048));
  const thumbBytes = new Uint8Array(randomBytes(512));
  const fileKey = sodium.crypto_secretbox_keygen();
  const keyNonce = sodium.randombytes_buf(24);
  const r = await t.req('POST', '/files', {
    token: owner.token,
    body: {
      collectionID: collection.id,
      encryptedKey: b64(sodium.crypto_secretbox_easy(fileKey, keyNonce, collection.key)),
      keyDecryptionNonce: b64(keyNonce),
      file: { objectKey: await put(fileBytes), decryptionHeader: b64(randomBytes(24)), size: fileBytes.length },
      thumbnail: { objectKey: await put(thumbBytes), decryptionHeader: b64(randomBytes(24)), size: thumbBytes.length },
      metadata: { encryptedData: b64(randomBytes(64)), decryptionHeader: b64(randomBytes(24)) },
    },
  });
  if (r.status !== 200) throw new Error(`${t.name} commit ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body as { id: number }).id;
};

// ---- shape diffing ---------------------------------------------------------

const shape = (v: unknown): unknown => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : '[]';
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = shape((v as Record<string, unknown>)[k]);
    return out;
  }
  return typeof v;
};

interface Observation {
  status: number;
  shape: unknown;
  /** Values the scenario wants compared exactly (beyond shape). */
  values?: Record<string, unknown>;
  body: unknown;
}

const observe = (r: Res, values?: Record<string, unknown>): Observation => ({
  status: r.status,
  shape: shape(r.body),
  values,
  body: r.body,
});

type Step = (t: Target, ctx: Ctx) => Promise<Observation>;
interface Ctx {
  a: Account;
  b: Account;
  d: Account;
  [k: string]: unknown;
}

const results: { name: string; museum: Observation; ours: Observation; ok: boolean; expected?: string }[] = [];

const scenario = async (name: string, step: Step, ctxs: Record<string, Ctx>, targets: Target[]) => {
  if (ONLY && !name.startsWith(ONLY)) return;
  const obs: Record<string, Observation> = {};
  for (const t of targets) {
    try {
      obs[t.name] = await step(t, ctxs[t.name]!);
    } catch (e) {
      obs[t.name] = { status: -1, shape: `THREW ${(e as Error).message}`, body: null };
    }
  }
  const m = obs.museum!;
  const o = obs.ours!;
  const ok =
    m.status !== -1 &&
    o.status !== -1 &&
    m.status === o.status &&
    JSON.stringify(m.shape) === JSON.stringify(o.shape) &&
    JSON.stringify(m.values ?? {}) === JSON.stringify(o.values ?? {});
  results.push({ name, museum: m, ours: o, ok, expected: ok ? undefined : EXPECTED_DIVERGENCES[name] });
};

// ---- scenarios -------------------------------------------------------------

const main = async () => {
  await sodium.ready;
  const targets = [new Target('museum', MUSEUM), new Target('ours', OURS)];
  const ctxs: Record<string, Ctx> = {};
  for (const t of targets) {
    ctxs[t.name] = { a: await signup(t, 'a'), b: await signup(t, 'b'), d: await signup(t, 'd') };
  }
  const run = (name: string, step: Step) => scenario(name, step, ctxs, targets);

  // -- feature flags
  await run('flags.serverApiFlag', async (t, c) => {
    const r = await t.req('GET', '/remote-store/feature-flags', { token: c.a.token });
    return observe(r, { serverApiFlag: (r.body as { serverApiFlag: number }).serverApiFlag });
  });

  // -- batch public keys (POST /users/public-keys)
  await run('pubkeys.ok-ordered', async (t, c) => {
    const r = await t.req('POST', '/users/public-keys', { token: c.a.token, body: { emails: [c.d.email, c.b.email] } });
    const keys = (r.body as { publicKeys?: string[] }).publicKeys;
    return observe(r, {
      ordered: JSON.stringify(keys) === JSON.stringify([b64(c.d.keys.publicKey), b64(c.b.keys.publicKey)]),
    });
  });
  await run('pubkeys.empty', async (t, c) => observe(await t.req('POST', '/users/public-keys', { token: c.a.token, body: { emails: [] } })));
  await run('pubkeys.missing-field', async (t, c) => observe(await t.req('POST', '/users/public-keys', { token: c.a.token, body: {} })));
  await run('pubkeys.over-10', async (t, c) =>
    observe(await t.req('POST', '/users/public-keys', {
      token: c.a.token,
      body: { emails: Array.from({ length: 11 }, (_, i) => `x${i}-${t.runId}@example.org`) },
    })));
  await run('pubkeys.duplicate-case', async (t, c) =>
    observe(await t.req('POST', '/users/public-keys', { token: c.a.token, body: { emails: [c.b.email, c.b.email.toUpperCase()] } })));
  await run('pubkeys.unknown-email', async (t, c) =>
    observe(await t.req('POST', '/users/public-keys', { token: c.a.token, body: { emails: [c.b.email, `nobody-${t.runId}@example.org`] } })));
  await run('pubkeys.blank-email', async (t, c) =>
    observe(await t.req('POST', '/users/public-keys', { token: c.a.token, body: { emails: ['  '] } })));
  await run('pubkeys.no-auth', async (t, c) => observe(await t.req('POST', '/users/public-keys', { body: { emails: [c.b.email] } })));

  // -- batch share (POST /collections/share/batch)
  for (const t of targets) {
    const c = ctxs[t.name]!;
    c.album = await createAlbum(t, c.a);
    c.album2 = await createAlbum(t, c.a);
  }
  type Album = { id: number; key: Uint8Array };
  const share = (c: Ctx, who: Account, album = c.album as Album, extra: Record<string, unknown> = {}) => ({
    collectionID: album.id,
    email: who.email,
    encryptedKey: sealedKeyFor(who, album.key),
    ...extra,
  });
  await run('batchshare.empty', async (t, c) => observe(await t.req('POST', '/collections/share/batch', { token: c.a.token, body: { shares: [] } })));
  await run('batchshare.over-10', async (t, c) =>
    observe(await t.req('POST', '/collections/share/batch', {
      token: c.a.token,
      body: { shares: Array.from({ length: 11 }, (_, i) => ({ ...share(c, c.b), email: `y${i}-${t.runId}@example.org` })) },
    })));
  await run('batchshare.mixed-collections', async (t, c) =>
    observe(await t.req('POST', '/collections/share/batch', {
      token: c.a.token,
      body: { shares: [share(c, c.b), share(c, c.d, c.album2 as Album)] },
    })));
  await run('batchshare.duplicate-email', async (t, c) =>
    observe(await t.req('POST', '/collections/share/batch', {
      token: c.a.token,
      body: { shares: [share(c, c.b), { ...share(c, c.b), email: c.b.email.toUpperCase() }] },
    })));
  await run('batchshare.self', async (t, c) =>
    observe(await t.req('POST', '/collections/share/batch', { token: c.a.token, body: { shares: [share(c, c.a)] } })));
  await run('batchshare.bad-key', async (t, c) =>
    observe(await t.req('POST', '/collections/share/batch', {
      token: c.a.token,
      body: { shares: [{ ...share(c, c.b), encryptedKey: b64(randomBytes(10)) }] },
    })));
  await run('batchshare.bad-role', async (t, c) =>
    observe(await t.req('POST', '/collections/share/batch', {
      token: c.a.token,
      body: { shares: [{ ...share(c, c.b), role: 'OWNER' }] },
    })));
  await run('batchshare.unknown-email-no-partial', async (t, c) => {
    const r = await t.req('POST', '/collections/share/batch', {
      token: c.a.token,
      body: { shares: [share(c, c.b), { ...share(c, c.d), email: `nobody-${t.runId}@example.org` }] },
    });
    const after = await t.req('GET', `/collections/sharees?collectionID=${(c.album as Album).id}`, { token: c.a.token });
    return observe(r, { shareesAfter: ((after.body as { sharees?: unknown[] }).sharees ?? []).length });
  });
  await run('batchshare.non-member', async (t, c) =>
    observe(await t.req('POST', '/collections/share/batch', { token: c.d.token, body: { shares: [share(c, c.b)] } })));
  await run('batchshare.unknown-collection', async (t, c) =>
    observe(await t.req('POST', '/collections/share/batch', {
      token: c.a.token,
      body: { shares: [{ ...share(c, c.b), collectionID: 999999999 }] },
    })));
  await run('batchshare.ok', async (t, c) => {
    const r = await t.req('POST', '/collections/share/batch', {
      token: c.a.token,
      body: { shares: [share(c, c.b), share(c, c.d, undefined, { role: 'COLLABORATOR' })] },
    });
    const sharees = ((r.body as { sharees?: { email: string; role: string }[] }).sharees ?? [])
      .map((s) => `${s.email === c.b.email ? 'b' : s.email === c.d.email ? 'd' : '?'}:${s.role}`)
      .sort();
    return observe(r, { sharees });
  });
  await run('batchshare.reshare-role-change', async (t, c) => {
    const r = await t.req('POST', '/collections/share/batch', {
      token: c.a.token,
      body: { shares: [share(c, c.b, undefined, { role: 'COLLABORATOR' })] },
    });
    const roles = ((r.body as { sharees?: { email: string; role: string }[] }).sharees ?? [])
      .map((s) => `${s.email === c.b.email ? 'b' : 'd'}:${s.role}`)
      .sort();
    return observe(r, { roles });
  });
  await run('batchshare.sharee-feed', async (t, c) => {
    const r = await t.req('GET', '/collections/v2?sinceTime=0', { token: c.b.token });
    const ids = ((r.body as { collections?: { id: number }[] }).collections ?? []).map((x) => x.id);
    return observe(r, { seesAlbum: ids.includes((c.album as Album).id) });
  });

  // -- privacy: sharee view of owner-private magic metadata + removed files
  for (const t of targets) {
    const c = ctxs[t.name]!;
    const album = c.album as Album;
    await t.req('PUT', '/collections/magic-metadata', {
      token: c.a.token,
      body: { id: album.id, magicMetadata: { version: 1, count: 1, data: b64(randomBytes(32)), header: b64(randomBytes(24)) } },
    });
    try {
      c.fileID = await upload(t, c.a, album);
    } catch (e) {
      c.uploadError = (e as Error).message;
    }
  }
  await run('privacy.get-collection-as-sharee', async (t, c) => {
    const r = await t.req('GET', `/collections/${(c.album as Album).id}`, { token: c.b.token });
    const col = (r.body as { collection?: Record<string, unknown> }).collection ?? {};
    return observe(r, { hasMagicMetadata: col.magicMetadata !== undefined && col.magicMetadata !== null });
  });
  await run('privacy.get-collection-as-owner', async (t, c) => {
    const r = await t.req('GET', `/collections/${(c.album as Album).id}`, { token: c.a.token });
    const col = (r.body as { collection?: Record<string, unknown> }).collection ?? {};
    return observe(r, { hasMagicMetadata: col.magicMetadata !== undefined && col.magicMetadata !== null });
  });
  await run('privacy.removed-file-diff-as-sharee', async (t, c) => {
    if (c.uploadError) throw new Error(c.uploadError as string);
    const album = c.album as Album;
    // An owner cannot remove its own file via remove-files; trashing it puts
    // the same deleted entry into the collection diff.
    const rm = await t.req('POST', '/files/trash', {
      token: c.a.token,
      body: { items: [{ fileID: c.fileID, collectionID: album.id }] },
    });
    if (rm.status !== 200) throw new Error(`remove ${rm.status} ${JSON.stringify(rm.body)}`);
    const r = await t.req('GET', `/collections/v2/diff?collectionID=${album.id}&sinceTime=0`, { token: c.b.token });
    const diff = (r.body as { diff?: Record<string, unknown>[] }).diff ?? [];
    const gone = diff.find((f) => f.id === c.fileID);
    return { status: r.status, shape: shape(gone ?? null), body: gone, values: { found: !!gone } };
  });

  // -- unshare tombstone shape (sharee feed after unshare)
  await run('privacy.unshare-tombstone', async (t, c) => {
    const album = c.album as Album;
    const un = await t.req('POST', '/collections/unshare', { token: c.a.token, body: { collectionID: album.id, email: c.d.email } });
    if (un.status !== 200) throw new Error(`unshare ${un.status}`);
    const r = await t.req('GET', '/collections/v2?sinceTime=0', { token: c.d.token });
    const tomb = ((r.body as { collections?: Record<string, unknown>[] }).collections ?? []).find((x) => x.id === album.id);
    return { status: r.status, shape: shape(tomb ?? null), body: tomb, values: { isDeleted: tomb?.isDeleted } };
  });

  // -- bulk unshare (POST /collections/unshare/bulk)
  const bulk = (c: Ctx, body: Record<string, unknown>) => ({ recipientUserID: c.b.userId, source: 'manual', ...body });
  await run('unsharebulk.bad-source', async (t, c) =>
    observe(await t.req('POST', '/collections/unshare/bulk', { token: c.a.token, body: bulk(c, { source: 'weird', collectionIDs: [1] }) })));
  await run('unsharebulk.empty', async (t, c) =>
    observe(await t.req('POST', '/collections/unshare/bulk', { token: c.a.token, body: bulk(c, { collectionIDs: [] }) })));
  await run('unsharebulk.duplicate-ids', async (t, c) =>
    observe(await t.req('POST', '/collections/unshare/bulk', {
      token: c.a.token,
      body: bulk(c, { collectionIDs: [(c.album as Album).id, (c.album as Album).id] }),
    })));
  await run('unsharebulk.self', async (t, c) =>
    observe(await t.req('POST', '/collections/unshare/bulk', {
      token: c.a.token,
      body: bulk(c, { recipientUserID: c.a.userId, collectionIDs: [(c.album as Album).id] }),
    })));
  await run('unsharebulk.zero-recipient', async (t, c) =>
    observe(await t.req('POST', '/collections/unshare/bulk', {
      token: c.a.token,
      body: bulk(c, { recipientUserID: 0, collectionIDs: [(c.album as Album).id] }),
    })));
  await run('unsharebulk.over-100', async (t, c) =>
    observe(await t.req('POST', '/collections/unshare/bulk', {
      token: c.a.token,
      body: bulk(c, { collectionIDs: Array.from({ length: 101 }, (_, i) => i + 1) }),
    })));
  await run('unsharebulk.mixed', async (t, c) => {
    const r = await t.req('POST', '/collections/unshare/bulk', {
      token: c.a.token,
      body: bulk(c, { collectionIDs: [(c.album as Album).id, (c.album2 as Album).id, 999999999] }),
    });
    return observe(r, { statuses: ((r.body as { results?: { status: string }[] }).results ?? []).map((x) => x.status) });
  });
  await run('unsharebulk.repeat', async (t, c) => {
    const r = await t.req('POST', '/collections/unshare/bulk', {
      token: c.a.token,
      body: bulk(c, { collectionIDs: [(c.album as Album).id] }),
    });
    return observe(r, { statuses: ((r.body as { results?: { status: string }[] }).results ?? []).map((x) => x.status) });
  });
  await run('unsharebulk.non-owner', async (t, c) => {
    const r = await t.req('POST', '/collections/unshare/bulk', {
      token: c.d.token,
      body: bulk(c, { collectionIDs: [(c.album as Album).id] }),
    });
    return observe(r, { statuses: ((r.body as { results?: { status: string }[] }).results ?? []).map((x) => x.status) });
  });

  // -- user-entity library_share
  const lsId = (c: Ctx) => `ls_${c.a.userId}_${c.b.userId}`;
  const ent = (extra: Record<string, unknown>) => ({
    type: 'library_share',
    encryptedData: b64(randomBytes(40)),
    header: b64(randomBytes(24)),
    ...extra,
  });
  await run('entity.ls-key', async (t, c) =>
    observe(await t.req('POST', '/user-entity/key', {
      token: c.a.token,
      body: { type: 'library_share', encryptedKey: b64(randomBytes(48)), header: b64(randomBytes(24)) },
    })));
  await run('entity.ls-create-no-id', async (t, c) => observe(await t.req('POST', '/user-entity/entity', { token: c.a.token, body: ent({}) })));
  await run('entity.ls-create-foreign-owner', async (t, c) =>
    observe(await t.req('POST', '/user-entity/entity', { token: c.a.token, body: ent({ id: `ls_${c.b.userId}_${c.a.userId}` }) })));
  await run('entity.ls-create-self', async (t, c) =>
    observe(await t.req('POST', '/user-entity/entity', { token: c.a.token, body: ent({ id: `ls_${c.a.userId}_${c.a.userId}` }) })));
  await run('entity.ls-create-malformed', async (t, c) =>
    observe(await t.req('POST', '/user-entity/entity', { token: c.a.token, body: ent({ id: `ls_${c.a.userId}_0${c.b.userId}` }) })));
  await run('entity.ls-create-ok', async (t, c) => {
    const r = await t.req('POST', '/user-entity/entity', { token: c.a.token, body: ent({ id: lsId(c) }) });
    c.lsUpdatedAt = (r.body as { updatedAt?: number }).updatedAt;
    return observe(r, { id: (r.body as { id?: string }).id === lsId(c) });
  });
  await run('entity.ls-create-duplicate-live', async (t, c) =>
    observe(await t.req('POST', '/user-entity/entity', { token: c.a.token, body: ent({ id: lsId(c) }) })));
  await run('entity.ls-update-missing-expected', async (t, c) =>
    observe(await t.req('PUT', '/user-entity/entity', { token: c.a.token, body: ent({ id: lsId(c) }) })));
  await run('entity.ls-update-stale-expected', async (t, c) =>
    observe(await t.req('PUT', '/user-entity/entity', {
      token: c.a.token,
      body: ent({ id: lsId(c), expectedUpdatedAt: (c.lsUpdatedAt as number) - 1 }),
    })));
  await run('entity.ls-update-ok', async (t, c) => {
    const r = await t.req('PUT', '/user-entity/entity', {
      token: c.a.token,
      body: ent({ id: lsId(c), expectedUpdatedAt: c.lsUpdatedAt }),
    });
    return observe(r);
  });
  await run('entity.ls-delete-then-recreate', async (t, c) => {
    const del = await t.req('DELETE', `/user-entity/entity?id=${lsId(c)}`, { token: c.a.token });
    if (del.status !== 200) throw new Error(`delete ${del.status}`);
    const r = await t.req('POST', '/user-entity/entity', { token: c.a.token, body: ent({ id: lsId(c) }) });
    return observe(r, { isDeleted: (r.body as { isDeleted?: boolean }).isDeleted });
  });
  await run('entity.ls-diff', async (t, c) => {
    const r = await t.req('GET', '/user-entity/entity/diff?type=library_share&sinceTime=0&limit=100', { token: c.a.token });
    const diff = (r.body as { diff?: { id: string; isDeleted: boolean }[] }).diff ?? [];
    return observe(r, { rows: diff.map((x) => `${x.id === lsId(c)}:${x.isDeleted}`) });
  });
  await run('entity.unknown-type', async (t, c) =>
    observe(await t.req('POST', '/user-entity/entity', { token: c.a.token, body: ent({ type: 'nope' }) })));

  // -- push token (Android registers with apnsToken null)
  await run('push.android-null-apns', async (t, c) =>
    observe(await t.req('POST', '/push/token', {
      token: c.a.token,
      body: { fcmToken: `fcm-${t.runId}`, apnsToken: null, platform: 'android' },
    })));
  await run('push.ios-legacy', async (t, c) =>
    observe(await t.req('POST', '/push/token', {
      token: c.a.token,
      body: { fcmToken: `fcm2-${t.runId}`, apnsToken: 'apns-token' },
    })));

  // -- public links: device-token header, expired + disabled codes
  const link = async (t: Target, c: Ctx, album: Album, extra: Record<string, unknown> = {}) => {
    const r = await t.req('POST', '/collections/share-url', { token: c.a.token, body: { collectionID: album.id, ...extra } });
    if (r.status !== 200) throw new Error(`share-url ${r.status} ${JSON.stringify(r.body)}`);
    const url = (r.body as { result: { url: string } }).result.url;
    return new URL(url).searchParams.get('t') ?? url.split('t=')[1]!.split('#')[0]!;
  };
  await run('publink.info-device-header', async (t, c) => {
    const token = await link(t, c, c.album2 as Album);
    c.linkToken = token;
    const r = await t.req('GET', '/public-collection/info', { headers: { 'X-Auth-Access-Token': token } });
    return observe(r, {
      newHeader: r.headers.get('x-link-device-token') !== null,
      exposeNew: (r.headers.get('access-control-expose-headers') ?? '').toLowerCase().includes('x-link-device-token'),
    });
  });
  await run('publink.cors-expose', async (t) => {
    const res = await fetch(`${t.base}/public-collection/info`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://albums.example', 'Access-Control-Request-Method': 'GET' },
    });
    const expose = (res.headers.get('access-control-expose-headers') ?? '').toLowerCase();
    return { status: res.status, shape: null, body: expose, values: { exposesNew: expose.includes('x-link-device-token') } };
  });
  await run('publink.disabled-code', async (t, c) => {
    const del = await t.req('DELETE', `/collections/share-url/${(c.album2 as Album).id}`, { token: c.a.token });
    if (del.status !== 200) throw new Error(`unshare-url ${del.status}`);
    const r = await t.req('GET', '/public-collection/info', { headers: { 'X-Auth-Access-Token': c.linkToken as string } });
    return observe(r, { code: (r.body as { code?: string })?.code });
  });
  await run('publink.expired-code', async (t, c) => {
    const token = await link(t, c, c.album2 as Album);
    // validTill is microseconds; museum refuses past values on create, so
    // shorten an existing link to ~1.5 s from now and wait it out.
    const upd = await t.req('PUT', '/collections/share-url', {
      token: c.a.token,
      body: { collectionID: (c.album2 as Album).id, validTill: (Date.now() + 1500) * 1000 },
    });
    if (upd.status !== 200) throw new Error(`update ${upd.status} ${JSON.stringify(upd.body)}`);
    await new Promise((r) => setTimeout(r, 2500));
    const r = await t.req('GET', '/public-collection/info', { headers: { 'X-Auth-Access-Token': token } });
    return observe(r, { code: (r.body as { code?: string })?.code });
  });

  // -- sessions: opaque identifiers + isCurrent
  await run('sessions.list', async (t, c) => {
    const r = await t.req('GET', '/users/sessions', { token: c.a.token });
    const s = ((r.body as { sessions?: Record<string, unknown>[] }).sessions ?? [])[0] ?? {};
    return observe(r, {
      opaque: typeof s.token === 'string' && (s.token as string).startsWith('th:'),
      leaksBearer: s.token === c.a.token,
      isCurrent: s.isCurrent,
    });
  });
  await run('sessions.delete-by-opaque-id', async (t, c) => {
    // A second session for b (login via a fresh OTT is not available for an
    // account with keys; reuse d's single session and delete it by id).
    const list = await t.req('GET', '/users/sessions', { token: c.d.token });
    const id = (((list.body as { sessions?: { token: string }[] }).sessions ?? [])[0] ?? { token: '' }).token;
    const r = await t.req('DELETE', `/users/session?token=${encodeURIComponent(id)}`, { token: c.d.token });
    const after = await t.req('GET', '/users/details/v2', { token: c.d.token });
    return observe(r, { tokenRevoked: after.status === 401 });
  });

  // -- core regression sweep: the sync/read surface the stock app hits on
  //    every launch, plus validation edges, so drift beyond the D66 list shows.
  for (const t of targets) {
    const c = ctxs[t.name]!;
    try {
      c.liveFileID = await upload(t, c.a, c.album2 as Album);
    } catch (e) {
      c.uploadError2 = (e as Error).message;
    }
  }
  const live = (c: Ctx) => {
    if (c.uploadError2) throw new Error(c.uploadError2 as string);
    return c.liveFileID as number;
  };
  await run('core.details-v2', async (t, c) => observe(await t.req('GET', '/users/details/v2', { token: c.a.token })));
  await run('core.session-validity', async (t, c) =>
    observe(await t.req('GET', '/users/session-validity/v2', { token: c.a.token })));
  await run('core.collections-v2-owner', async (t, c) => {
    const r = await t.req('GET', '/collections/v2?sinceTime=0', { token: c.a.token });
    const own = ((r.body as { collections?: Record<string, unknown>[] }).collections ?? []).find(
      (x) => x.id === (c.album2 as Album).id,
    );
    return { status: r.status, shape: shape(own ?? null), body: own };
  });
  await run('core.diff-owner-live-file', async (t, c) => {
    const fileID = live(c);
    const r = await t.req('GET', `/collections/v2/diff?collectionID=${(c.album2 as Album).id}&sinceTime=0`, { token: c.a.token });
    const f = ((r.body as { diff?: Record<string, unknown>[] }).diff ?? []).find((x) => x.id === fileID);
    return { status: r.status, shape: shape(f ?? null), body: f, values: { hasMore: (r.body as { hasMore?: boolean }).hasMore } };
  });
  await run('core.files-info', async (t, c) =>
    observe(await t.req('POST', '/files/info', { token: c.a.token, body: { fileIDs: [live(c)] } })));
  await run('core.files-size', async (t, c) =>
    observe(await t.req('POST', '/files/size', { token: c.a.token, body: { fileIDs: [live(c)] } })));
  await run('core.trash-diff', async (t, c) => {
    const r = await t.req('GET', '/trash/v2/diff?sinceTime=0', { token: c.a.token });
    return observe(r, { count: ((r.body as { diff?: unknown[] }).diff ?? []).length });
  });
  await run('core.download-redirect', async (t, c) => {
    const r = await t.req('GET', `/files/download/${live(c)}`, { token: c.a.token });
    return { status: r.status, shape: null, body: null, values: { location: !!r.headers.get('location') } };
  });
  await run('core.thumbnail-v3', async (t, c) => observe(await t.req('GET', `/files/thumbnail/v3/${live(c)}`, { token: c.a.token })));
  await run('core.upload-eligibility', async (t, c) => observe(await t.req('GET', '/files/upload-eligibility', { token: c.a.token })));
  await run('core.upload-url-bad-md5', async (t, c) =>
    observe(await t.req('POST', '/files/upload-url', { token: c.a.token, body: { contentLength: 10, contentMD5: 'nope' } })));
  await run('core.upload-url-zero-length', async (t, c) =>
    observe(await t.req('POST', '/files/upload-url', {
      token: c.a.token,
      body: { contentLength: 0, contentMD5: createHash('md5').update('').digest('base64') },
    })));
  await run('core.multipart-url-ok', async (t, c) => {
    const part = 5 * 1024 * 1024;
    const md5 = createHash('md5').update('x').digest('base64');
    const r = await t.req('POST', '/files/multipart-upload-url', {
      token: c.a.token,
      body: { contentLength: part + 10, partLength: part, partMd5s: [md5, md5] },
    });
    return observe(r, { parts: ((r.body as { partURLs?: unknown[] }).partURLs ?? []).length });
  });
  await run('core.multipart-url-wrong-count', async (t, c) => {
    const md5 = createHash('md5').update('x').digest('base64');
    return observe(await t.req('POST', '/files/multipart-upload-url', {
      token: c.a.token,
      body: { contentLength: 11 * 1024 * 1024, partLength: 5 * 1024 * 1024, partMd5s: [md5] },
    }));
  });
  await run('core.nonmember-diff', async (t, c) =>
    observe(await t.req('GET', `/collections/v2/diff?collectionID=${(c.album2 as Album).id}&sinceTime=0`, { token: c.d.token })));
  await run('core.nonmember-get', async (t, c) =>
    observe(await t.req('GET', `/collections/${(c.album2 as Album).id}`, { token: c.d.token })));
  await run('core.nonmember-sharees', async (t, c) =>
    observe(await t.req('GET', `/collections/sharees?collectionID=${(c.album2 as Album).id}`, { token: c.d.token })));
  // Non-member semantics per endpoint (D49 capture-gated: 403 vs 404).
  const nonMember: [string, string, string, (c: Ctx) => unknown][] = [
    ['rename', 'POST', '/collections/rename', (c) => ({ collectionID: (c.album2 as Album).id, encryptedName: b64(randomBytes(20)), nameDecryptionNonce: b64(randomBytes(24)) })],
    ['magic-metadata', 'PUT', '/collections/magic-metadata', (c) => ({ id: (c.album2 as Album).id, magicMetadata: { version: 1, count: 1, data: b64(randomBytes(32)), header: b64(randomBytes(24)) } })],
    ['add-files', 'POST', '/collections/add-files', (c) => ({ collectionID: (c.album2 as Album).id, files: [{ id: live(c), encryptedKey: b64(randomBytes(48)), keyDecryptionNonce: b64(randomBytes(24)) }] })],
    ['remove-files', 'POST', '/collections/v3/remove-files', (c) => ({ collectionID: (c.album2 as Album).id, fileIDs: [live(c)] })],
    ['share', 'POST', '/collections/share', (c) => ({ collectionID: (c.album2 as Album).id, email: c.b.email, encryptedKey: sealedKeyFor(c.b, (c.album2 as Album).key) })],
    ['unshare', 'POST', '/collections/unshare', (c) => ({ collectionID: (c.album2 as Album).id, email: c.b.email })],
    ['share-url', 'POST', '/collections/share-url', (c) => ({ collectionID: (c.album2 as Album).id })],
    ['leave', 'POST', '/collections/leave/ALBUM2', () => undefined],
    ['delete', 'DELETE', '/collections/v3/ALBUM2?keepFiles=true&collectionID=ALBUM2', () => undefined],
  ];
  for (const [label, method, path, body] of nonMember) {
    await run(`core.nonmember-${label}`, async (t, c) =>
      observe(await t.req(method, path.replace('ALBUM2', String((c.album2 as Album).id)), { token: c.d.token, body: body(c) })));
  }
  await run('core.nonexistent-download', async (t, c) =>
    observe(await t.req('GET', '/files/download/999999999', { token: c.a.token })));
  await run('core.nonexistent-get-collection', async (t, c) =>
    observe(await t.req('GET', '/collections/999999999', { token: c.a.token })));
  await run('core.foreign-download', async (t, c) => {
    const r = await t.req('GET', `/files/download/${live(c)}`, { token: c.d.token });
    return { status: r.status, shape: shape(r.body), body: r.body };
  });
  await run('core.entity-key-missing', async (t, c) =>
    observe(await t.req('GET', '/user-entity/key?type=location', { token: c.d.token })));
  await run('core.entity-diff-bad-limit', async (t, c) =>
    observe(await t.req('GET', '/user-entity/entity/diff?type=location&sinceTime=0&limit=0', { token: c.a.token })));
  await run('core.filedata-status-diff', async (t, c) =>
    observe(await t.req('POST', '/files/data/status-diff', { token: c.a.token, body: { lastUpdatedAt: 0 } })));
  await run('core.preview-upload-url-v1', async (t, c) => {
    const r = await t.req('GET', `/files/data/preview-upload-url?fileID=${live(c)}&type=vid_preview`, { token: c.a.token });
    return observe(r);
  });
  await run('core.preview-upload-url-v2', async (t, c) => {
    const r = await t.req('POST', '/files/data/preview-upload-url', {
      token: c.a.token,
      body: { fileID: live(c), type: 'vid_preview', contentLength: 10, contentMD5: createHash('md5').update('x').digest('base64') },
    });
    return observe(r);
  });
  await run('core.remote-store-get', async (t, c) =>
    observe(await t.req('GET', '/remote-store?key=mapEnabled&defaultValue=false', { token: c.a.token })));
  await run('core.deletion-summary', async (t, c) => observe(await t.req('GET', '/users/deletion-summary', { token: c.a.token })));
  await run('core.unknown-route', async (t, c) => {
    const r = await t.req('GET', '/definitely/not/a/route', { token: c.a.token });
    return { status: r.status, shape: typeof r.body, body: r.body };
  });

  // ---- report
  let failed = 0;
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
  console.log(`\n${pad('scenario', 42)} ${pad('museum', 8)} ${pad('ours', 8)} verdict`);
  for (const r of results) {
    const verdict = r.ok ? 'MATCH' : r.expected ? 'EXPECTED' : 'DIFF';
    if (verdict === 'DIFF') failed++;
    console.log(`${pad(r.name, 42)} ${pad(String(r.museum.status), 8)} ${pad(String(r.ours.status), 8)} ${verdict}`);
    if (!r.ok) {
      const show = (o: Observation) =>
        o.status === -1 ? String(o.shape) : JSON.stringify({ values: o.values, body: o.body }).slice(0, 400);
      console.log(`    museum: ${show(r.museum)}`);
      console.log(`    ours:   ${show(r.ours)}`);
      if (JSON.stringify(r.museum.shape) !== JSON.stringify(r.ours.shape)) {
        console.log(`    museum shape: ${JSON.stringify(r.museum.shape).slice(0, 400)}`);
        console.log(`    ours shape:   ${JSON.stringify(r.ours.shape).slice(0, 400)}`);
      }
      if (r.expected) console.log(`    expected: ${r.expected}`);
    }
  }
  console.log(`\n${results.length} scenarios, ${results.filter((r) => r.ok).length} match, ${failed} unexplained diffs`);
  process.exit(failed ? 1 : 0);
};

await main();
