/**
 * POST /collections/join-link (auth + link) — src: pkg/api/collection.go
 * JoinLink + pkg/controller/collections/share.go JoinViaLink. Mounted on the
 * AUTHENTICATED api (museum storageAPI): the caller is a real account holding
 * BOTH a session token and the link's access token in X-Auth-Access-Token
 * (dual credentials — the public middleware is NOT involved). Body
 * ente.JoinCollectionViaLinkRequest {collectionID, encryptedKey: the
 * collection key sealed to the JOINER's own public key, produced client-side
 * from the key in the link fragment}. Response 200 {}.
 *
 * Museum's checks, in order: sealed-key shape (bare 500 on bad shape), repo
 * lookup (404), owner-cannot-join (400), AllowSharing (400), active link
 * (404), CanJoin — disabled / expired / download disabled / join disabled all
 * read bare 400 (ente.ErrBadRequest wrap), access-token-matches-collection
 * (403), password JWT when the link is passworded (a missing/garbled JWT is a
 * bare 500 — golang-jwt's parse error propagates as a plain Go error; a valid
 * JWT with a stale passKey is 401). Role: COLLABORATOR when enableCollect,
 * else VIEWER (museum JoinViaLink). The share row is the SAME upsert as
 * /collections/share (sharedBy = the owner) and the collection is restamped
 * so both feeds converge (museum repo.Share).
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { bumpCollection, getCollection } from '../../domain/collections.ts';
import {
  addSharee,
  assertSealedCollectionKey,
  getLinkForCollection,
} from '../../domain/sharing.ts';
import { validatePasswordJwt } from '../../domain/publicLinks.ts';
import {
  errBadRequestSentinel,
  errInvalidPassword,
  errNotFound,
  errPermissionDenied,
  SentinelError,
} from '../../lib/errors.ts';

const bodySchema = z.object({
  collectionID: z.number().refine((v) => v !== 0),
  encryptedKey: z.string().min(1),
});

export const joinLink = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
  assertSealedCollectionKey(body.encryptedKey);
  const { userId } = auth(c);

  const collection = await getCollection(deps, body.collectionID);
  if (!collection || collection.isDeleted) throw errNotFound();
  if (collection.ownerID === userId) throw errBadRequestSentinel(); // owner can not join
  if (collection.type === 'uncategorized') throw errBadRequestSentinel(); // AllowSharing()

  const link = await getLinkForCollection(deps, body.collectionID);
  if (!link) throw errNotFound();

  // ente.CollectionLinkRow.CanJoin() — each branch a bare 400 upstream.
  if (link.isDisabled) throw errBadRequestSentinel();
  if (link.validTill > 0 && link.validTill < deps.clock.nowMicros()) throw errBadRequestSentinel();
  if (!link.enableDownload) throw errBadRequestSentinel();
  if (!link.enableJoin) throw errBadRequestSentinel();

  const accessToken = c.req.header('X-Auth-Access-Token') || c.req.query('accessToken') || '';
  if (link.token !== accessToken) throw errPermissionDenied(); // token doesn't match collection

  if (link.passHash) {
    const jwt = c.req.header('X-Auth-Access-Token-JWT') || c.req.query('accessTokenJWT') || '';
    const verdict = validatePasswordJwt(deps, jwt, link.passHash);
    // museum: parse failure propagates as a plain error -> bare 500;
    // a valid signature with the wrong passKey is ErrInvalidPassword -> 401.
    if (verdict === 'parseFailed') throw new SentinelError(500, 'JWT parse failed');
    if (verdict === 'invalid') throw errInvalidPassword();
  }

  const role = link.enableCollect ? 'COLLABORATOR' : 'VIEWER';
  await addSharee(deps, {
    collectionID: body.collectionID,
    userID: userId,
    role,
    encryptedKey: body.encryptedKey,
    sharedBy: collection.ownerID,
  });
  await bumpCollection(deps, collection, {}); // museum repo.Share restamps
  return c.json({});
};
