/**
 * Public-link auth for /public-collection/* — port of museum
 * pkg/middleware/collection_link.go Authenticate (fetched 2026-08-27; the
 * frozen-oracle revision ba654ea differs only in a free-user device-cap detail
 * this repo skips — billing is stubbed as an active plan, D34/D51).
 *
 * Check order and every error BODY are museum's, verbatim:
 *   - missing X-Auth-Access-Token (header, or `accessToken` query — museum
 *     auth.GetAccessToken reads both) -> 401 {"error":"missing accessToken",
 *     "context":"album_link"}
 *   - unknown token -> 401 {"error":"invalid token"}   (ONE GetItem — the
 *     cheap-fail demanded by plan §4.1b: an invalid token costs one read)
 *   - disabled     -> 410 {"error":"disabled token"}
 *   - expired      -> 410 {"error":"expired token"}    (validTill 0 = never)
 *   - passworded link, no/invalid X-Auth-Access-Token-JWT -> 401 {"error":{}}
 *     (museum aborts with gin.H{"error": err} where err is a plain Go error —
 *     json.Marshal renders it as {}), EXCEPT the whitelisted paths
 *     /public-collection/info and /public-collection/verify-password, which
 *     must work before unlock so clients can fetch KDF params / verify.
 *   - device limit, ONLY on /info and /diff (museum ties admission to the two
 *     browser entry points): admitted device (ip+ua seen before, or a valid
 *     X-Auth-Link-Device-Token JWT) passes; a new device over the limit gets
 *     403 {"code":"LINK_DEVICE_LIMIT_EXCEEDED",...}; an admitted device is
 *     handed a fresh device JWT in the X-Ente-Link-Device-Token response
 *     header (the frozen-oracle header name; current main renamed it).
 *
 * Deliberately NOT ported: the owner-subscription check (billing is stubbed
 * active) and the custom-domain Origin validation (no custom domains here).
 * Context set: `publicAccess` = { link, ip, userAgent }.
 */

import type { Context, Next } from 'hono';
import type { Deps } from '../deps.ts';
import { tokenHash } from '../domain/tokens.ts';
import { getLinkByTokenHash, type PublicLinkRow } from '../domain/sharing.ts';
import {
  admitDevice,
  LINK_DEVICE_REFRESH_BEFORE_MICROS,
  newLinkDeviceToken,
  validateLinkDeviceToken,
  validatePasswordJwt,
} from '../domain/publicLinks.ts';
import { linkDeviceLimitExceeded, SentinelError } from '../lib/errors.ts';
import { clientIp } from '../lib/ip.ts';

export interface PublicAccessInfo {
  link: PublicLinkRow;
  ip: string;
  userAgent: string;
}

/** museum passwordWhiteListedURLs. */
const PASSWORD_WHITELIST = ['/public-collection/info', '/public-collection/verify-password'];

/** museum shouldCheckCollectionLinkDeviceLimit. */
const DEVICE_LIMIT_PATHS = ['/public-collection/info', '/public-collection/diff'];

export const requirePublicAccess = (deps: Deps) => async (c: Context, next: Next) => {
  const accessToken = c.req.header('X-Auth-Access-Token') || c.req.query('accessToken');
  if (!accessToken) {
    return c.json({ error: 'missing accessToken', context: 'album_link' }, 401);
  }
  const link = await getLinkByTokenHash(deps, tokenHash(accessToken));
  if (!link) return c.json({ error: 'invalid token' }, 401);
  if (link.isDisabled) return c.json({ error: 'disabled token' }, 410);
  if (link.validTill > 0 && link.validTill < deps.clock.nowMicros()) {
    return c.json({ error: 'expired token' }, 410);
  }

  const path = c.req.path;
  if (link.passHash && !PASSWORD_WHITELIST.includes(path)) {
    const jwt = c.req.header('X-Auth-Access-Token-JWT') || c.req.query('accessTokenJWT');
    if (!jwt || validatePasswordJwt(deps, jwt, link.passHash) !== 'ok') {
      return c.json({ error: {} }, 401);
    }
  }

  const ip = clientIp(c);
  const userAgent = c.req.header('User-Agent') ?? '';
  if (DEVICE_LIMIT_PATHS.includes(path)) {
    try {
      const presented = c.req.header('X-Auth-Link-Device-Token');
      const presentedExp = presented ? validateLinkDeviceToken(deps, presented, link) : null;
      if (presentedExp !== null) {
        // Already admitted via JWT; refresh it when inside the renewal window.
        if (presentedExp - deps.clock.nowMicros() < LINK_DEVICE_REFRESH_BEFORE_MICROS) {
          c.header('X-Ente-Link-Device-Token', newLinkDeviceToken(deps, link));
        }
      } else {
        const { admitted } = await admitDevice(deps, link, ip, userAgent);
        if (!admitted) {
          const err = linkDeviceLimitExceeded();
          return c.json(err.body(), err.httpStatus as 403);
        }
        c.header('X-Ente-Link-Device-Token', newLinkDeviceToken(deps, link));
      }
    } catch (err) {
      // The daily admission ceiling (P2-1, D53) surfaces as the same bare-429
      // SentinelError the download/upload ceilings use — not a 500.
      if (err instanceof SentinelError) return c.json({}, err.httpStatus as 429);
      console.error('public link device admission failed', err);
      return c.json({ error: 'something went wrong' }, 500); // museum's 500 body
    }
  }

  c.set('publicAccess', { link, ip, userAgent } satisfies PublicAccessInfo);
  await next();
};

export const publicAccess = (c: Context): PublicAccessInfo =>
  c.get('publicAccess') as PublicAccessInfo;
