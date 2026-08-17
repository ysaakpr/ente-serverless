/**
 * POST /trash/empty (auth) — {"lastUpdatedAt":T}: everything at or before T
 * goes; newer entries survive. Museum answers fast and works async — ours is
 * synchronous; behaviour parity is what's tested, not timing.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { gsi } from '../../domain/model.ts';
import { permanentlyDelete, type TrashRow } from '../../domain/trash.ts';

const bodySchema = z.object({ lastUpdatedAt: z.number() });

export const emptyTrash = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
  const { userId } = auth(c);

  const rows = await deps.db.query<TrashRow>(gsi.trashDiff(userId), { index: 'gsi3' });
  for (const row of rows) {
    if (row.updatedAt > body.lastUpdatedAt) continue;
    await permanentlyDelete(deps, userId, row);
  }
  return c.body(null, 200);
};
