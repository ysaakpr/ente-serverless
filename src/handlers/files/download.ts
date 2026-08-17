/**
 * GET /files/download/:fileID (307 redirect) + /v2 + /v3 ({"url"}) —
 * src: pkg/api/file.go Get/GetURL/GetURLV3. Same authz as museum's
 * GetAccessibleObject; trashed files stay readable by the owner.
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { getAccessibleFile } from '../../domain/files.ts';
import { errBadRequestSentinel } from '../../lib/errors.ts';

const signedFileUrl = async (deps: Deps, c: Context): Promise<string> => {
  const fileId = Number.parseInt(c.req.param('fileID') ?? '', 10);
  if (!Number.isFinite(fileId)) throw errBadRequestSentinel();
  const file = await getAccessibleFile(deps, auth(c).userId, fileId);
  return deps.blobs.presignGet(file.file.objectKey!, deps.config.presignExpirySeconds);
};

export const downloadFile = (deps: Deps) => async (c: Context) => {
  const url = await signedFileUrl(deps, c);
  return c.redirect(url, 307);
};

export const downloadFileUrl = (deps: Deps) => async (c: Context) => {
  const url = await signedFileUrl(deps, c);
  return c.json({ url });
};
