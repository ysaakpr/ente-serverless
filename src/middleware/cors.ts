/**
 * CORS — captured from the pinned museum oracle, not invented.
 *
 * Capture 2026-08-17 against ghcr.io/ente/server@sha256:f646b68a…
 * (docker-compose.oracle.yml, ORACLE-VERSION), `OPTIONS /users/ott`,
 * `POST /users/ott` and `GET /ping`:
 *   - all six headers ride on EVERY response, preflight or not;
 *   - Access-Control-Allow-Origin echoes the request Origin verbatim (museum
 *     accepts any origin; Allow-Credentials: true forbids a bare `*`), and
 *     with no Origin header museum still emits it, empty;
 *   - preflight answers 200 with an empty body — note hono's built-in
 *     `hono/cors` answers 204, which is why this is hand-rolled.
 * Divergence log: DECISIONS.md D29.
 */

import type { Context, Next } from 'hono';

/** Museum's list verbatim — same order and casing as the capture. */
const ALLOW_HEADERS = [
  'Content-Type',
  'Content-Length',
  'Accept-Encoding',
  'X-CSRF-Token',
  'X-Auth-Token',
  'X-Space-Session-Token',
  'X-Ente-Space-Link-Auth',
  'X-Auth-Access-Token',
  'X-Cast-Access-Token',
  'X-Auth-Access-Token-JWT',
  'X-Auth-Link-Device-Token',
  'X-Client-Package',
  'X-Client-Version',
  'X-Paste-Consume',
  'Authorization',
  'accept',
  'origin',
  'Cache-Control',
  'X-Requested-With',
  'upgrade-insecure-requests',
  'Range',
].join(', ');

const ALLOW_METHODS = 'POST, OPTIONS, GET, PUT, PATCH, DELETE';
const EXPOSE_HEADERS = 'X-Request-Id, X-Ente-Link-Device-Token';
const MAX_AGE = '1728000';

export const cors = () => async (c: Context, next: Next) => {
  const headers = c.res.headers;
  headers.set('Access-Control-Allow-Origin', c.req.header('Origin') ?? '');
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.set('Access-Control-Allow-Headers', ALLOW_HEADERS);
  headers.set('Access-Control-Allow-Methods', ALLOW_METHODS);
  headers.set('Access-Control-Expose-Headers', EXPOSE_HEADERS);
  headers.set('Access-Control-Max-Age', MAX_AGE);

  // Preflight never reaches a route — museum's gin CORS aborts here.
  if (c.req.method === 'OPTIONS') return new Response(null, { status: 200, headers });

  await next();
};
