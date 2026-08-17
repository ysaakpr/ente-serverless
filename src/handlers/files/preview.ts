/**
 * GET /files/preview/:fileID (307) + /preview/v2 + /thumbnail/v3 ({"url"}) —
 * the THUMBNAIL routes ("preview" here != vid_preview under /files/data).
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { getAccessibleFile } from '../../domain/files.ts';
import { errBadRequestSentinel } from '../../lib/errors.ts';

const signedThumbUrl = async (deps: Deps, c: Context): Promise<string> => {
  const fileId = Number.parseInt(c.req.param('fileID') ?? '', 10);
  if (!Number.isFinite(fileId)) throw errBadRequestSentinel();
  const file = await getAccessibleFile(deps, auth(c).userId, fileId);
  return deps.blobs.presignGet(file.thumbnail.objectKey!, deps.config.presignExpirySeconds);
};

export const previewFile = (deps: Deps) => async (c: Context) => {
  const url = await signedThumbUrl(deps, c);
  return c.redirect(url, 307);
};

export const previewFileUrl = (deps: Deps) => async (c: Context) => {
  const url = await signedThumbUrl(deps, c);
  return c.json({ url });
};
