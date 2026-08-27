/**
 * The unauthenticated public client (plan §4.8) — what the albums web app is
 * to the /public-collection surface: it holds ONLY the link's access token
 * (X-Auth-Access-Token), never a session, plus the optional password JWT and
 * link-device token headers. Also the shareUrl fixture every Phase D test
 * starts from.
 */

import type { TestWorld } from './deps.ts';
import type { Account } from './client.ts';

export interface PublicLinkFixture {
  /** The full museum-shaped URL (`<albums>/?t=<token>`). */
  url: string;
  /** The raw access token, extracted from the url. */
  token: string;
  result: Record<string, unknown>;
}

/** POST /collections/share-url and hand back the minted token. */
export const createShareUrl = async (
  world: TestWorld,
  owner: Account,
  collectionID: number,
  body: Record<string, unknown> = {},
): Promise<PublicLinkFixture> => {
  const res = await world.request('POST', '/collections/share-url', {
    token: owner.token,
    body: { collectionID, ...body },
  });
  if (res.status !== 200) throw new Error(`share-url failed: ${res.status} ${await res.text()}`);
  const { result } = (await res.json()) as { result: Record<string, unknown> };
  const url = result.url as string;
  const token = new URL(url).searchParams.get('t')!;
  return { url, token, result };
};

export interface PublicRequestOpts {
  /** X-Auth-Access-Token; omit to simulate a missing token. */
  accessToken?: string;
  /** X-Auth-Access-Token-JWT (password unlock). */
  jwt?: string;
  /** X-Auth-Link-Device-Token. */
  deviceToken?: string;
  body?: unknown;
  /** Extra headers (e.g. a distinct x-forwarded-for / user-agent per device). */
  headers?: Record<string, string>;
}

/** An anonymous request — NO X-Auth-Token ever rides on this client. */
export const publicRequest = (
  world: TestWorld,
  method: string,
  path: string,
  opts: PublicRequestOpts = {},
): Promise<Response> =>
  world.request(method, path, {
    body: opts.body,
    headers: {
      ...(opts.accessToken !== undefined ? { 'x-auth-access-token': opts.accessToken } : {}),
      ...(opts.jwt !== undefined ? { 'x-auth-access-token-jwt': opts.jwt } : {}),
      ...(opts.deviceToken !== undefined ? { 'x-auth-link-device-token': opts.deviceToken } : {}),
      ...opts.headers,
    },
  });
