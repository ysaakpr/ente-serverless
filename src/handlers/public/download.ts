/**
 * GET /public-collection/files/download/:fileID (307) and
 * GET /public-collection/files/download/v3/:fileID ({"url"}) — src:
 * pkg/api/public_collection.go GetFile / GetFileURLV3 +
 * pkg/controller/file.go GetPublicOrCastFileURL. The file must be LIVE-linked
 * to the link's collection (museum GetCollectionObject; sql.ErrNoRows -> 404
 * on the redirect route, and the v3 route maps missing to 400
 * {"code":"NOT_FOUND","message":"requested object was not found"} —
 * api/file.go fileURLV3Error, "so 404 can signal endpoint unavailability").
 *
 * Two deliberate divergences (both D51):
 *  - enableDownload=false -> 403 {} on ORIGINAL downloads (previews still
 *    serve — the viewer cannot render at all without thumbnail bytes). Museum
 *    does NOT enforce the flag server-side (client-honoured only); plan §4.2
 *    says enforce the enforceable, and documents that this is access-control,
 *    not DRM.
 *  - per-link daily download ceiling -> 429 {} (plan §4.1d).
 * Presigns use the short public expiry (presignPublicGetExpirySeconds).
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { publicAccess } from '../../middleware/publicAccess.ts';
import { bumpDailyCeiling, getPublicLinkedFile } from '../../domain/publicLinks.ts';
import { ApiError, errBadRequestSentinel, errPermissionDenied, SentinelError } from '../../lib/errors.ts';

const signedOriginalUrl = async (deps: Deps, c: Context): Promise<string> => {
  const fileId = Number.parseInt(c.req.param('fileID') ?? '', 10);
  if (!Number.isFinite(fileId)) throw errBadRequestSentinel();
  const { link } = publicAccess(c);
  if (!link.enableDownload) throw errPermissionDenied(); // divergence: enforced server-side
  const file = await getPublicLinkedFile(deps, link, fileId);
  await bumpDailyCeiling(deps, link.tokenHash, 'downloads', deps.config.publicLinkDailyDownloadLimit);
  return deps.blobs.presignGet(file.file.objectKey!, deps.config.presignPublicGetExpirySeconds);
};

export const publicDownloadFile = (deps: Deps) => async (c: Context) => {
  const url = await signedOriginalUrl(deps, c);
  return c.redirect(url, 307);
};

export const publicDownloadFileUrlV3 = (deps: Deps) => async (c: Context) => {
  try {
    const url = await signedOriginalUrl(deps, c);
    return c.json({ url });
  } catch (err) {
    // museum fileURLV3Error: not-found becomes a 400 NOT_FOUND ApiError.
    if (err instanceof SentinelError && err.httpStatus === 404) {
      throw new ApiError('NOT_FOUND', 400, 'requested object was not found');
    }
    throw err;
  }
};
