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
 * basePath does NOT reach hand-written root-absolute asset URLs: the CSS
 * @font-face rules (`url("/fonts/…")`), the font preload and favicon in
 * ente-base's Head (`href="/fonts/…"`, `href="/images/…"`) and the upload
 * dialogs' `src="/images/…"` stayed unprefixed, so on the /albums* behavior
 * they reached the API and 404'd (the Inter font silently fell back to the
 * system font on every build up to photos-v1.3.61). With a web root as the
 * second argument the script also rewrites every quoted/`url(`-wrapped
 * `/fonts/` and `/images/` reference under apps/albums/src and packages/ to
 * carry the prefix; `make build-web` then refuses an export that still has
 * one (D68).
 *
 * Invoked by `make build-web` between the sparse checkout and the build:
 *   node --experimental-transform-types scripts/patch-albums-basepath.ts \
 *     dist/ente-web-src/web/apps/albums/next.config.js dist/ente-web-src/web
 *
 * The pure patch function is exported for the unit test
 * (test/unit/albums-basepath-patch.test.ts) — the anchor logic is testable
 * without the ~2 GB workspace clone.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * A root-absolute reference to one of the static-asset dirs the albums app
 * serves from public/: the quote or `url(` right before the slash is what
 * tells it apart from a path inside an absolute URL
 * ("https://albums.ente.com/images/preview.png" stays untouched).
 */
const ROOT_ASSET = /(["'`(])\/(fonts|images)\//g;

/** Prefixes root-absolute /fonts/ and /images/ references; idempotent. */
export const prefixRootAssetPaths = (source: string): { patched: string; count: number } => {
  let count = 0;
  const patched = source.replace(ROOT_ASSET, (_m, open: string, dir: string) => {
    count++;
    return `${open}${ALBUMS_BASE_PATH}/${dir}/`;
  });
  return { patched, count };
};

const SOURCE_FILE = /\.(css|js|jsx|ts|tsx)$/;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === 'pkg' || e.name.startsWith('.')) return [];
    const path = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(path);
    return SOURCE_FILE.test(e.name) ? [path] : [];
  });

/** Patches every albums-reachable source under the web workspace root. */
export const prefixRootAssetsInWorkspace = (webRoot: string): { file: string; count: number }[] => {
  const changed: { file: string; count: number }[] = [];
  for (const file of [join(webRoot, 'apps/albums/src'), join(webRoot, 'packages')].flatMap(sourceFiles)) {
    const before = readFileSync(file, 'utf8');
    const { patched, count } = prefixRootAssetPaths(before);
    if (count === 0) continue;
    writeFileSync(file, patched);
    changed.push({ file, count });
  }
  return changed;
};

const main = () => {
  const [path, webRoot] = process.argv.slice(2);
  if (!path) {
    console.error('usage: patch-albums-basepath.ts <path to albums next.config.js> [<web workspace root>]');
    process.exit(2);
  }
  const before = readFileSync(path, 'utf8');
  const after = patchAlbumsNextConfig(before);
  if (after === before) {
    console.log(`==> ${path} already carries basePath ${ALBUMS_BASE_PATH} — nothing to do`);
  } else {
    writeFileSync(path, after);
    console.log(`==> patched ${path}: basePath/assetPrefix = ${ALBUMS_BASE_PATH} (D60)`);
  }
  if (!webRoot) return;
  const changed = prefixRootAssetsInWorkspace(webRoot);
  const total = changed.reduce((n, c) => n + c.count, 0);
  for (const c of changed) console.log(`    ${c.file.slice(webRoot.length + 1)}: ${c.count}`);
  console.log(`==> prefixed ${total} root-absolute /fonts/ and /images/ reference(s) with ${ALBUMS_BASE_PATH} (D68)`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
