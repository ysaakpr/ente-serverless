/**
 * POST /files/data/fetch (batch) + GET /files/data/fetch (single) +
 * POST /files/data/status-diff — src: ente/filedata/filedata.go type gates
 * (vid_preview | mldata only, batch <= 200).
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { padTime } from '../../domain/model.ts';
import type { FileRow } from '../../domain/files.ts';
import {
  fdStatusPartition,
  fileDataBlobs,
  getFdRow,
  getOwnedFile,
  metadataKey,
  readMetadataObject,
  type FdRow,
  type FdType,
} from '../../domain/fileData.ts';
import { badRequest } from '../../lib/errors.ts';

const FETCH_TYPES = ['vid_preview', 'mldata'];

const entityJson = async (deps: Deps, userId: number, file: FileRow, row: FdRow) => {
  const metadata = await readMetadataObject(
    await fileDataBlobs(deps, file), // file's pinned pool (H2, D55)
    metadataKey(row.fileID, userId, row.type, row.objectID),
  );
  if (!metadata) return null;
  return {
    fileID: row.fileID,
    type: row.type,
    encryptedData: metadata.encryptedData,
    decryptionHeader: metadata.header,
    updatedAt: row.updatedAt,
  };
};

const batchSchema = z.object({ fileIDs: z.array(z.number()), type: z.string() });

export const getFilesData = (deps: Deps) => async (c: Context) => {
  const body = batchSchema.parse(await c.req.json());
  if (!FETCH_TYPES.includes(body.type)) throw badRequest(`unsupported object type ${body.type}`);
  if (body.fileIDs.length === 0) throw badRequest('fileIDs are required');
  if (body.fileIDs.length > 200) throw badRequest('fileIDs should be less than or equal to 200');
  const { userId } = auth(c);

  const data = [];
  const pendingIndexFileIDs = [];
  const errFileIDs = [];
  for (const fileId of body.fileIDs) {
    try {
      const file = await getOwnedFile(deps, userId, fileId);
      const row = await getFdRow(deps, fileId, body.type as FdType);
      if (!row || row.isDeleted) {
        pendingIndexFileIDs.push(fileId);
        continue;
      }
      const entity = await entityJson(deps, userId, file, row);
      if (entity) data.push(entity);
      else errFileIDs.push(fileId);
    } catch {
      errFileIDs.push(fileId);
    }
  }
  return c.json({ data, pendingIndexFileIDs, errFileIDs });
};

export const getFileData = (deps: Deps) => async (c: Context) => {
  const fileId = Number.parseInt(c.req.query('fileID') ?? '', 10);
  const type = c.req.query('type') ?? '';
  if (!Number.isFinite(fileId) || !FETCH_TYPES.includes(type)) {
    throw badRequest(`unsupported object type ${type}`);
  }
  const { userId } = auth(c);
  const file = await getOwnedFile(deps, userId, fileId);

  const row = await getFdRow(deps, fileId, type as FdType);
  if (!row || row.isDeleted) return c.body(null, 204);
  const entity = await entityJson(deps, userId, file, row);
  if (!entity) return c.body(null, 204);
  return c.json({ data: entity });
};

const diffSchema = z.object({ lastUpdatedAt: z.number().nullish() });

export const fileDataStatusDiff = (deps: Deps) => async (c: Context) => {
  const body = diffSchema.parse(await c.req.json());
  if (body.lastUpdatedAt === null || body.lastUpdatedAt === undefined || body.lastUpdatedAt < 0) {
    throw badRequest('lastUpdated is required and should be greater than or equal to 0');
  }
  const { userId } = auth(c);

  const rows = await deps.db.query<FdRow>(fdStatusPartition(userId), {
    index: 'gsi3',
    skFrom: padTime(body.lastUpdatedAt + 1),
  });
  const diff = rows
    .filter((r) => !r.isDeleted) // museum: status diff omits deleted rows
    .map((r) => ({
      fileID: r.fileID,
      userID: r.userID,
      type: r.type,
      isDeleted: r.isDeleted,
      objectID: r.objectID,
      objectNonce: r.objectNonce,
      size: r.size,
      updatedAt: r.updatedAt,
    }));
  return c.json({ diff });
};
