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
import {
  ALBUMS_BASE_PATH,
  patchAlbumsNextConfig,
} from '../../scripts/patch-albums-basepath.ts';

// The pinned tag's web/apps/albums/next.config.js, verbatim shape
// (photos-v1.3.61, fetched 2026-08-27).
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
