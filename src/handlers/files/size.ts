/**
 * POST /files/size (auth) — {"size": total} over the caller's OWN files
 * (foreign ids simply don't count — museum's repo query filters by owner).
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { getFile } from '../../domain/files.ts';

const bodySchema = z.object({ fileIDs: z.array(z.number()) });

export const filesSize = (deps: Deps) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
  const { userId } = auth(c);

  let size = 0;
  for (const id of body.fileIDs) {
    const file = await getFile(deps, id);
    if (file && file.ownerID === userId) size += file.info.fileSize;
  }
  return c.json({ size });
};
