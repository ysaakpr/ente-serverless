/** GET /ping — src: pkg/api/healthcheck.go. Auth: none. */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';

export const ping = (deps: Deps) => async (c: Context) =>
  c.json({ message: 'pong', id: deps.config.instanceId });
