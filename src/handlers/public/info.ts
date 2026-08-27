/**
 * GET /public-collection/info (link auth) — src: pkg/api/public_collection.go
 * GetCollection + pkg/controller/public/collection_link.go
 * GetPublicCollection. Response {"collection": Collection, "referralCode": s}.
 *
 * The collection JSON is museum's repo.Get scan with the privacy scrub
 * GetPublicCollection applies for anonymous viewers, field for field:
 *   - owner is {id, email:"", name:"", role:""} — repo.Get never selects the
 *     owner email, so the public surface must not leak it either;
 *   - sharees: null (Sharees = nil), magicMetadata withheld, pubMagicMetadata
 *     passes;
 *   - publicURLs carries ONE "limited info" entry: flags + password KDF
 *     params only — url/deviceLimit/validTill are Go zero values ("" and 0,
 *     no omitempty), so the token is never echoed back to its bearer.
 * referralCode: museum GetOrCreateReferralCode; storage-bonus is a zeros stub
 * here (README), so "" — the error path's zero value upstream. D51.
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { publicAccess } from '../../middleware/publicAccess.ts';
import { getPublicCollectionRow } from '../../domain/publicLinks.ts';

export const publicCollectionInfo = (deps: Deps) => async (c: Context) => {
  const { link } = publicAccess(c);
  const row = await getPublicCollectionRow(deps, link);

  const passworded = link.nonce !== undefined && link.nonce !== '';
  const limitedUrl = {
    url: '',
    deviceLimit: 0,
    validTill: 0,
    enableDownload: link.enableDownload,
    enableCollect: link.enableCollect,
    enableComment: link.enableComment,
    passwordEnabled: passworded,
    ...(passworded
      ? { nonce: link.nonce, memLimit: link.memLimit ?? 0, opsLimit: link.opsLimit ?? 0 }
      : {}),
    enableJoin: link.enableJoin,
  };

  return c.json({
    collection: {
      id: row.collectionId,
      owner: { id: row.ownerID, email: '', name: '', role: '' },
      encryptedKey: row.encryptedKey,
      keyDecryptionNonce: row.keyDecryptionNonce,
      name: '',
      encryptedName: row.encryptedName,
      nameDecryptionNonce: row.nameDecryptionNonce,
      type: row.type,
      attributes: row.attributes,
      sharees: null,
      publicURLs: [limitedUrl],
      updationTime: row.updationTime,
      ...(row.pubMagicMetadata ? { pubMagicMetadata: row.pubMagicMetadata } : {}),
      app: row.app,
    },
    referralCode: '',
  });
};
