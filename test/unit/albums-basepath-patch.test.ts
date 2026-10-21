/**
 * [INFRA/D60] The build-time basePath patch for the pinned albums app —
 * scripts/patch-albums-basepath.ts. The consolidated distribution serves the
 * web app under the single /albums* behavior (FREE plan, 5-behavior
 * ceiling), so `make build-web` must inject basePath/assetPrefix = /albums
 * into the pinned tag's next.config.js. The anchor logic is what keeps that
 * patch honest across tag bumps: a changed config shape must FAIL the build,
 * never produce an unprefixed export that 404s behind /albums*. Tested here
 * against the pinned tag's verbatim config shape — no 2 GB workspace clone
 * needed.
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALBUMS_BASE_PATH,
  patchAlbumsNextConfig,
  prefixRootAssetPaths,
  prefixRootAssetsInWorkspace,
} from '../../scripts/patch-albums-basepath.ts';

// The pinned tag's web/apps/albums/next.config.js, verbatim shape
// (photos-v1.3.61 fetched 2026-08-27; unchanged at photos-v1.3.65, 2026-10-21).
const PINNED_CONFIG = `const baseConfig = require("ente-base/next.config.base.js");

module.exports = {
    ...baseConfig,
    // Keep static export in production; in development, serve path-token links
    // through the index page so local browser loads match Cloudflare fallback.
    ...(process.env.NODE_ENV === "development" && {
        output: undefined,
        async rewrites() {
            return {
                fallback: [
                    {
                        source: "/:path((?!_next|images|favicon.ico).*)",
                        destination: "/",
                    },
                ],
            };
        },
    }),
};
`;

describe('patch-albums-basepath (D60)', () => {
  it('the base path constant is /albums — the one /albums* behavior and the bucket key prefix', () => {
    expect(ALBUMS_BASE_PATH).toBe('/albums');
  });

  it("injects basePath and assetPrefix after the pinned config's ...baseConfig spread", () => {
    const patched = patchAlbumsNextConfig(PINNED_CONFIG);
    expect(patched).toContain('basePath: "/albums",');
    expect(patched).toContain('assetPrefix: "/albums",');
    // After the base spread (so it overrides nothing from baseConfig by
    // accident and cannot be clobbered by it either — baseConfig sets no
    // basePath), and before the dev-only spread.
    const spreadAt = patched.indexOf('...baseConfig,');
    const baseAt = patched.indexOf('basePath:');
    const devAt = patched.indexOf('process.env.NODE_ENV');
    expect(spreadAt).toBeGreaterThan(-1);
    expect(baseAt).toBeGreaterThan(spreadAt);
    expect(baseAt).toBeLessThan(devAt);
    // Everything else survives verbatim.
    expect(patched).toContain('require("ente-base/next.config.base.js")');
    expect(patched).toContain('async rewrites()');
  });

  it('is idempotent — a second pass returns the input unchanged', () => {
    const once = patchAlbumsNextConfig(PINNED_CONFIG);
    expect(patchAlbumsNextConfig(once)).toBe(once);
  });

  it('FAILS LOUDLY when the anchor is missing (tag bump changed the shape)', () => {
    expect(() => patchAlbumsNextConfig('module.exports = { output: "export" };')).toThrow(
      /anchor.*not found|REFUSING/s,
    );
  });

  it('FAILS LOUDLY on a foreign basePath instead of silently keeping it', () => {
    const foreign = PINNED_CONFIG.replace('...baseConfig,', '...baseConfig,\n    basePath: "/x",');
    expect(() => patchAlbumsNextConfig(foreign)).toThrow(/basePath/);
  });
});

describe('root-absolute asset prefixing (D68)', () => {
  // Verbatim shapes from photos-v1.3.65: apps/albums/src/app/styles/fonts.css
  // and packages/base/components/Head.tsx.
  const FONTS_CSS = `@font-face {
    font-family: "Inter Variable";
    src: url("/fonts/inter-latin-wght-normal.woff2") format("woff2-variations");
}`;
  const HEAD_TSX = `<link rel="preload" href="/fonts/inter-latin-wght-normal.woff2" as="font" />
const albumsPreviewImage = "https://albums.ente.com/images/preview.png";
<link rel="icon" href="/images/favicon.png" type="image/png" />
<img src='/images/upload-complete-duck.svg' />`;

  it('prefixes quoted and url()-wrapped /fonts/ and /images/ references', () => {
    const css = prefixRootAssetPaths(FONTS_CSS);
    expect(css.count).toBe(1);
    expect(css.patched).toContain('url("/albums/fonts/inter-latin-wght-normal.woff2")');
    const head = prefixRootAssetPaths(HEAD_TSX);
    expect(head.count).toBe(3);
    expect(head.patched).toContain('href="/albums/fonts/inter-latin-wght-normal.woff2"');
    expect(head.patched).toContain('href="/albums/images/favicon.png"');
    expect(head.patched).toContain("src='/albums/images/upload-complete-duck.svg'");
  });

  it('leaves paths inside absolute URLs and other directories alone', () => {
    const { patched, count } = prefixRootAssetPaths(
      'a = "https://albums.ente.com/images/preview.png"; b = "/_next/x.js"; c = "/imagesX/y"; d = "/api/images/z"',
    );
    expect(count).toBe(0);
    expect(patched).toContain('https://albums.ente.com/images/preview.png');
  });

  it('is idempotent', () => {
    const once = prefixRootAssetPaths(HEAD_TSX).patched;
    expect(prefixRootAssetPaths(once)).toEqual({ patched: once, count: 0 });
  });

  it('walks apps/albums/src and packages/, skipping node_modules and wasm pkg output', () => {
    const root = mkdtempSync(join(tmpdir(), 'albums-assets-'));
    const put = (rel: string, text: string) => {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    put('apps/albums/src/app/styles/fonts.css', FONTS_CSS);
    put('packages/base/components/Head.tsx', HEAD_TSX);
    put('packages/base/node_modules/dep/index.js', 'x = "/images/a.png"');
    put('packages/wasm/prelogin/pkg/glue.js', 'x = "/images/a.png"');
    put('apps/photos/src/page.tsx', 'x = "/images/a.png"'); // another app: not albums-reachable

    const changed = prefixRootAssetsInWorkspace(root).map((c) => [c.file.slice(root.length + 1), c.count]);
    expect(changed.sort()).toEqual([
      ['apps/albums/src/app/styles/fonts.css', 1],
      ['packages/base/components/Head.tsx', 3],
    ]);
    expect(readFileSync(join(root, 'packages/base/node_modules/dep/index.js'), 'utf8')).toContain('"/images/a.png"');
    expect(readFileSync(join(root, 'apps/photos/src/page.tsx'), 'utf8')).toContain('"/images/a.png"');
  });
});
