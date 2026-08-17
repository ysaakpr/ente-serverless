/** PUT /files/update (auth) — explicit update path, same logic as commit's id!=0. */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { commitSchema, updateFileAttributes } from './commit.ts';
import { validateCommitShape } from '../../domain/files.ts';
import { errBadRequestSentinel } from '../../lib/errors.ts';

export const updateFile = (deps: Deps) => async (c: Context) => {
  const body = commitSchema.parse(await c.req.json());
  const { userId } = auth(c);
  if (body.id === 0) throw errBadRequestSentinel();
  validateCommitShape(userId, body);
  return c.json(await updateFileAttributes(deps, userId, body));
};
