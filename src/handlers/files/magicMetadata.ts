/**
 * PUT /files/magic-metadata + /files/public-magic-metadata (auth) —
 * src: pkg/controller/file.go UpdateMagicMetadata: owner-only, version must
 * equal stored version, count may not drop by more than 2 (409
 * version-mismatch otherwise); bumps every live collection link.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { padTime } from '../../domain/model.ts';
import { getFile, type MagicMetadata } from '../../domain/files.ts';
import { assertBatchSize } from '../../domain/collections.ts';
import { errBadRequestSentinel, errPermissionDenied, SentinelError } from '../../lib/errors.ts';

const bodySchema = z.object({
  metadataList: z.array(
    z.object({
      id: z.number(),
      magicMetadata: z.object({
        version: z.number(),
        count: z.number(),
        data: z.string(),
        header: z.string(),
      }),
    }),
  ),
  skipVersion: z.boolean().nullish(),
});

export const updateMagicMetadata = (deps: Deps, isPublic: boolean) => async (c: Context) => {
  const body = bodySchema.parse(await c.req.json());
  // SECURITY-REVIEW-2 F4: bound the batch — each item drives a getFile, a
  // FILE-LINKS query, and a write per live collection link, so an uncapped
  // list is a write-amplification DoS.
  assertBatchSize(body.metadataList.length);
  const { userId } = auth(c);
  const attr = isPublic ? 'pubMagicMetadata' : 'magicMetadata';

  // Validate everything first (museum validates the whole batch before writing).
  const files = [];
  for (const item of body.metadataList) {
    const file = await getFile(deps, item.id);
    if (!file) throw errBadRequestSentinel();
    if (file.ownerID !== userId) throw errPermissionDenied();
    const existing = file[attr] as MagicMetadata | undefined;
    if (existing && !body.skipVersion) {
      const countDrop = existing.count - item.magicMetadata.count;
      if (existing.version !== item.magicMetadata.version || countDrop > 2) {
        throw new SentinelError(409, 'client version is out of sync'); // ErrVersionMismatch
      }
    }
    files.push({ file, item });
  }

  for (const { file, item } of files) {
    const next: MagicMetadata = { ...item.magicMetadata, version: item.magicMetadata.version + 1 };
    const updationTime = deps.ids.nextUpdationTime();
    await deps.db.put({ ...file, [attr]: next, updationTime });
    const links = await deps.db.query(`FILE-LINKS#${file.fileId}`, { index: 'gsi3' });
    for (const link of links) {
      if (link.isDeleted) continue;
      const stamped = deps.ids.nextUpdationTime();
      await deps.db.put({ ...link, updationTime: stamped, gsi1sk: `${padTime(stamped)}#${file.fileId}` });
    }
  }
  return c.body(null, 200);
};
