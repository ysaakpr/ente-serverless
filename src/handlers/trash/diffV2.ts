/**
 * GET /trash/v2/diff?sinceTime=T (auth) — {"diff":[Trash...],"hasMore"}.
 * Same never-split-a-version pagination as the collection diff.
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { gsi, padTime } from '../../domain/model.ts';
import { TRASH_DIFF_LIMIT, trashToJson, type TrashRow } from '../../domain/trash.ts';

export const trashDiffV2 = (deps: Deps) => async (c: Context) => {
  const { userId } = auth(c);
  const sinceTime = Number.parseInt(c.req.query('sinceTime') ?? '0', 10) || 0;

  const page = await deps.db.query<TrashRow>(gsi.trashDiff(userId), {
    index: 'gsi3',
    skFrom: padTime(sinceTime + 1),
    limit: TRASH_DIFF_LIMIT + 1,
  });

  let rows = page;
  let hasMore = false;
  if (page.length > TRASH_DIFF_LIMIT) {
    hasMore = true;
    const boundary = page[TRASH_DIFF_LIMIT]!.updatedAt;
    rows = page.filter((r) => r.updatedAt !== boundary);
    if (rows.length === 0) {
      rows = await deps.db.query<TrashRow>(gsi.trashDiff(userId), {
        index: 'gsi3',
        skFrom: padTime(boundary),
        skTo: `${padTime(boundary)}#￿`,
      });
    }
  }

  const diff = await Promise.all(rows.map((r) => trashToJson(deps, r)));
  return c.json({ diff, hasMore });
};
