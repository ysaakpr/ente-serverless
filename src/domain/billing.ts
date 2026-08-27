/**
 * The self-host free subscription (ente/billing.go): productID "free",
 * transactionID "none". Storage is configurable (museum default 10 GiB;
 * self-hosters raise it via CLI — ours via env).
 *
 * Expiry is derived from the user's stored creationTime, NEVER from the clock:
 * museum keeps the subscription in Postgres, so the same GET always returns the
 * same expiryTime. Recomputing it per request made every /users/details/v2
 * response unique and hung the web client in a refetch loop (D30).
 *
 * Oracle capture 2026-08-17 (ghcr.io/ente/server@sha256:f646b68a…), free user
 * created 2026-08-17T07:05:30Z -> expiryTime 4942623930338282
 * (= 2126-08-17T07:05:30Z): exactly Go's AddDate(100, 0, 0), and period "year".
 */

import type { Deps } from '../deps.ts';
import type { UserRow } from './users.ts';
import type { Micros } from '../lib/time.ts';

export interface Subscription {
  id: number;
  userID: number;
  productID: string;
  storage: number;
  originalTransactionID: string;
  expiryTime: number;
  paymentProvider: string;
  attributes: Record<string, unknown>;
  price: string;
  period: string;
}

/** Go's AddDate(100, 0, 0) — calendar years, not 100 × 365 days. */
export const plusHundredYears = (at: Micros): Micros => {
  const d = new Date(Math.floor(at / 1000));
  d.setUTCFullYear(d.getUTCFullYear() + 100);
  return d.getTime() * 1000 + (at % 1000); // keep sub-millisecond precision
};

/**
 * The user's effective storage cap, bytes (D54): the per-user override when
 * set (0 means ZERO), else 0 for viewer accounts (they only consume shares),
 * else the config free-plan default. Everything that reports or enforces
 * storage — the subscription stub, /users/details/v2, assertQuota — resolves
 * through here, so the number the client renders is the number the server
 * enforces.
 */
export const userStorageBytes = (
  deps: Deps,
  user: Pick<UserRow, 'storageLimitBytes' | 'viewer'>,
): number => user.storageLimitBytes ?? (user.viewer ? 0 : deps.config.freePlanStorageBytes);

export const freeSubscription = (
  deps: Deps,
  user: Pick<UserRow, 'userId' | 'creationTime' | 'storageLimitBytes' | 'viewer'>,
): Subscription => ({
  id: user.userId,
  userID: user.userId,
  productID: 'free',
  // Museum-shaped envelope, per-user VALUE (D54): same field, real number.
  storage: userStorageBytes(deps, user),
  originalTransactionID: 'none',
  expiryTime: plusHundredYears(user.creationTime),
  paymentProvider: '',
  attributes: {},
  price: '',
  period: 'year',
});
