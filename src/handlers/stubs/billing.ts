/**
 * [BILLING-STUB] GET /billing/plans/v2 (public) · GET /billing/user-plans
 * (auth) · GET /billing/subscription · POST /billing/verify-subscription —
 * self-host answers: no paid plans, the free plan, the user's free
 * subscription (src: pkg/api/billing.go).
 *
 * Oracle capture 2026-08-17: plans/v2 and user-plans return the IDENTICAL
 * body — `freePlan` first, then `plans` — and differ only in auth (plans/v2
 * is public, user-plans 401s without a token). freePlan.period is "year",
 * not the "days" we had invented; duration 100 + period "year" is the same
 * 100-year horizon as the free subscription's expiry (D30). D34.
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { freeSubscription } from '../../domain/billing.ts';
import { getUser } from '../../domain/users.ts';
import { errNotFound } from '../../lib/errors.ts';

const plansBody = (deps: Deps) => ({
  freePlan: {
    storage: deps.config.freePlanStorageBytes,
    duration: 100,
    period: 'year',
  },
  plans: [],
});

export const getPlansV2 = (deps: Deps) => async (c: Context) => c.json(plansBody(deps));

/** Same payload as plans/v2; museum only differs by requiring a token. */
export const getUserPlans = (deps: Deps) => async (c: Context) => c.json(plansBody(deps));

/** The expiry comes off the user row (D30), so both routes need the user. */
const subscriptionFor = async (deps: Deps, c: Context) => {
  const user = await getUser(deps, auth(c).userId);
  if (!user) throw errNotFound();
  return freeSubscription(deps, user);
};

export const getSubscription = (deps: Deps) => async (c: Context) =>
  c.json({ subscription: await subscriptionFor(deps, c) });

export const verifySubscription = (deps: Deps) => async (c: Context) =>
  c.json({ subscription: await subscriptionFor(deps, c) });
