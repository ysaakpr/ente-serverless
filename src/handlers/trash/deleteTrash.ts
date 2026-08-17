/**
 * POST /trash/delete (auth) — permanent delete of listed trash entries:
 * usage decremented once, diff tombstone, double-delete idempotent.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { getTrashRow, permanentlyDelete } from '../../domain/trash.ts';

const bodySchema = z.object({ fileIDs: z.array(z.number()) });

export const deleteTrash = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
  const { userId } = auth(c);

  for (const fileId of body.fileIDs) {
    const row = await getTrashRow(deps, userId, fileId);
    if (!row) continue; // museum repo deletes by owner+id; unknown ids no-op
    await permanentlyDelete(deps, userId, row);
  }
  return c.body(null, 200);
};
