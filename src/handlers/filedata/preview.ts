/**
 * GET /files/data/preview-upload-url + GET /files/data/preview —
 * vid_preview | img_preview only (GetPreviewURLRequest/PreviewUploadUrlRequest
 * type gates). img_preview accepted from day one (three-tier plan, dormant).
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { getFdRow, getOwnedFile, objectKey, upsertFdRow, type FdType } from '../../domain/fileData.ts';
import { badRequest, errNotFound } from '../../lib/errors.ts';

const PREVIEW_TYPES = ['vid_preview', 'img_preview'];

const parse = (c: Context) => {
  const fileId = Number.parseInt(c.req.query('fileID') ?? '', 10);
  const type = c.req.query('type') ?? '';
  if (!Number.isFinite(fileId)) throw badRequest('fileID required');
  if (!PREVIEW_TYPES.includes(type)) throw badRequest(`unsupported object type ${type}`);
  return { fileId, type: type as FdType };
};

export const previewUploadUrl = (deps: Deps) => async (c: Context) => {
  const { fileId, type } = parse(c);
  const isMultiPart = c.req.query('isMultiPart') === 'true';
  const count = Number.parseInt(c.req.query('count') ?? '0', 10);
  if (isMultiPart && (count <= 0 || count > 10000)) {
    throw badRequest('invalid count, should be between 1 and 10000');
  }
  const { userId } = auth(c);
  await getOwnedFile(deps, userId, fileId);

  const objectID = `${type === 'vid_preview' ? 'pv' : 'pi'}_${deps.rand.uuid()}`;
  const key = objectKey(fileId, userId, type, objectID);
  if (type === 'img_preview') {
    // img_preview has no commit endpoint in museum main yet (no client
    // generates it); record the objectID at issuance so the GET side can
    // serve it — protocol-ready divergence, capture-gated (DECISIONS.md D8).
    await upsertFdRow(deps, userId, fileId, type, { objectID });
  }
  if (isMultiPart) {
    const multipart = await deps.blobs.createMultipart(key, count, deps.config.presignPutExpirySeconds);
    return c.json({ objectID, partURLs: multipart.partUrls, completeURL: multipart.completeUrl });
  }
  return c.json({ objectID, url: await deps.blobs.presignPut(key, deps.config.presignPutExpirySeconds) });
};

export const previewUrl = (deps: Deps) => async (c: Context) => {
  const { fileId, type } = parse(c);
  const { userId } = auth(c);
  await getOwnedFile(deps, userId, fileId);

  const row = await getFdRow(deps, fileId, type);
  if (!row || row.isDeleted || !row.objectID) throw errNotFound();
  const key = objectKey(fileId, userId, type, row.objectID);
  return c.json({ url: await deps.blobs.presignGet(key, deps.config.presignGetExpirySeconds) });
};
