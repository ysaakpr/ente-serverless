/**
 * The self-host free subscription (ente/billing.go): productID "free",
 * transactionID "none", 100-day rolling expiry. Storage is configurable
 * (museum default 10 GiB; self-hosters raise it via CLI — ours via env).
 */

import type { Deps } from '../deps.ts';
import { MICROS_PER_DAY } from '../lib/time.ts';

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

export const freeSubscription = (deps: Deps, userId: number): Subscription => ({
  id: userId,
  userID: userId,
  productID: 'free',
  storage: deps.config.freePlanStorageBytes,
  originalTransactionID: 'none',
  expiryTime: deps.clock.nowMicros() + 100 * MICROS_PER_DAY,
  paymentProvider: '',
  attributes: {},
  price: '',
  period: '',
});
