/**
 * [BILLING-STUB] GET /billing/plans/v2 (public) · GET /billing/subscription ·
 * POST /billing/verify-subscription — self-host answers: no paid plans, the
 * free plan, the user's free subscription (src: pkg/api/billing.go).
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { freeSubscription } from '../../domain/billing.ts';

export const getPlansV2 = (deps: Deps) => async (c: Context) =>
  c.json({
    plans: [],
    freePlan: {
      storage: deps.config.freePlanStorageBytes,
      duration: 100,
      period: 'days',
    },
  });

export const getSubscription = (deps: Deps) => async (c: Context) =>
  c.json({ subscription: freeSubscription(deps, auth(c).userId) });

export const verifySubscription = (deps: Deps) => async (c: Context) =>
  c.json({ subscription: freeSubscription(deps, auth(c).userId) });
