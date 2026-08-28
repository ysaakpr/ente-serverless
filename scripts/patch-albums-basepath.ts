/**
 * Patches the pinned ente albums app's next.config.js to serve under
 * /albums (D60): the consolidated CloudFront distribution keeps the API on
 * the DEFAULT behavior (FREE pricing plan, 5-behavior ceiling) and the web
 * app on the single /albums* ordered behavior, so the Next.js static export
 * must be built with basePath/assetPrefix = /albums — asset URLs, router
 * links and the exported chunks all carry the prefix, matching the albums/
 * key prefix `make deploy-web` syncs to.
 *
 * The pinned tag's config (web/apps/albums/next.config.js at
 * ALBUMS_WEB_TAG, checked 2026-08-27) has NO env-based basePath support —
 * it spreads ente-base/next.config.base.js and adds dev-only overrides —
 * hence this build-time patch. The anchor is the `...baseConfig,` spread:
 * stable because the tag is pinned; if a tag bump ever changes the file's
 * shape, this script FAILS LOUDLY instead of building an unprefixed app
 * that would 404 behind /albums*.
 *
 * Invoked by `make build-web` between the sparse checkout and the build:
 *   node --experimental-transform-types scripts/patch-albums-basepath.ts \
 *     dist/ente-web-src/web/apps/albums/next.config.js
 *
 * The pure patch function is exported for the unit test
 * (test/unit/albums-basepath-patch.test.ts) — the anchor logic is testable
 * without the ~2 GB workspace clone.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ALBUMS_BASE_PATH = '/albums';

const ANCHOR = '...baseConfig,';

const INSERT =
  `\n    // ente-serverless (D60): served under ${ALBUMS_BASE_PATH} on the consolidated` +
  `\n    // distribution — injected by scripts/patch-albums-basepath.ts at build time.` +
  `\n    basePath: "${ALBUMS_BASE_PATH}",` +
  `\n    assetPrefix: "${ALBUMS_BASE_PATH}",`;

/** Returns the patched source; throws when the pinned shape is not there. */
export const patchAlbumsNextConfig = (source: string): string => {
  if (source.includes(`basePath: "${ALBUMS_BASE_PATH}"`)) return source; // already patched
  if (source.includes('basePath')) {
    throw new Error(
      'next.config.js already sets a basePath that is not /albums — the pinned tag ' +
        'changed shape; reconcile scripts/patch-albums-basepath.ts with the new config (D60)',
    );
  }
  const at = source.indexOf(ANCHOR);
  if (at === -1) {
    throw new Error(
      `basePath patch anchor ${JSON.stringify(ANCHOR)} not found in next.config.js — ` +
        'the pinned tag changed shape; update scripts/patch-albums-basepath.ts (D60). ' +
        'REFUSING to build: an unprefixed export 404s behind the /albums* behavior.',
    );
  }
  return source.slice(0, at + ANCHOR.length) + INSERT + source.slice(at + ANCHOR.length);
};

const main = () => {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: patch-albums-basepath.ts <path to albums next.config.js>');
    process.exit(2);
  }
  const before = readFileSync(path, 'utf8');
  const after = patchAlbumsNextConfig(before);
  if (after === before) {
    console.log(`==> ${path} already carries basePath ${ALBUMS_BASE_PATH} — nothing to do`);
    return;
  }
  writeFileSync(path, after);
  console.log(`==> patched ${path}: basePath/assetPrefix = ${ALBUMS_BASE_PATH} (D60)`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
