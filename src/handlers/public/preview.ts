/**
 * GET /public-collection/files/preview/:fileID (307) and
 * GET /public-collection/files/thumbnail/v3/:fileID ({"url"}) — src:
 * pkg/api/public_collection.go GetThumbnail / GetThumbnailURLV3. Thumbnail
 * variants of download.ts: same live-link authz and v3 not-found mapping, but
 * NO enableDownload gate — a viewer needs preview bytes to render at all
 * (plan §3 caveat 2; download.ts documents the flag's limits). Previews count
 * against the same daily download ceiling.
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { publicAccess } from '../../middleware/publicAccess.ts';
import { bumpDailyCeiling, getPublicLinkedFile } from '../../domain/publicLinks.ts';
import { thumbPoolPin } from '../../domain/files.ts';
import { blobsForPoolId } from '../../domain/storagePools.ts';
import { ApiError, errBadRequestSentinel, SentinelError } from '../../lib/errors.ts';

const signedThumbUrl = async (deps: Deps, c: Context): Promise<string> => {
  const fileId = Number.parseInt(c.req.param('fileID') ?? '', 10);
  if (!Number.isFinite(fileId)) throw errBadRequestSentinel();
  const { link } = publicAccess(c);
  const file = await getPublicLinkedFile(deps, link, fileId);
  await bumpDailyCeiling(deps, link.tokenHash, 'downloads', deps.config.publicLinkDailyDownloadLimit);
  const blobs = await blobsForPoolId(deps, thumbPoolPin(file)); // pinned pool (H2, D55)
  return blobs.presignGet(file.thumbnail.objectKey!, deps.config.presignPublicGetExpirySeconds);
};

export const publicPreviewFile = (deps: Deps) => async (c: Context) => {
  const url = await signedThumbUrl(deps, c);
  return c.redirect(url, 307);
};

export const publicThumbnailUrlV3 = (deps: Deps) => async (c: Context) => {
  try {
    const url = await signedThumbUrl(deps, c);
    return c.json({ url });
  } catch (err) {
    if (err instanceof SentinelError && err.httpStatus === 404) {
      throw new ApiError('NOT_FOUND', 400, 'requested object was not found');
    }
    throw err;
  }
};
