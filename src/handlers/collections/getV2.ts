/**
 * GET /collections/v2?sinceTime=T (auth) — src: pkg/api/collection.go GetV2:
 * {"collections": owned ++ shared}, no limit. Owned rides gsi2 exactly as
 * before (the pure-owner path is byte-identical modulo the now-populated
 * sharees list); shared is the Phase C query-time merge (plan §2): the user's
 * SHARED# reverse rows joined to their collections, plus SHAREDTOMB# unshare
 * tombstones — museum GetCollectionsSharedWithUser emits both live shares and
 * is_deleted share rows from one query (repo/collection.go).
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import {
  collectionToJson,
  getCollection,
  listUserCollections,
  sharedCollectionToJson,
  shareesJson,
} from '../../domain/collections.ts';
import { listSharedTombstones, listUserShareRows } from '../../domain/sharing.ts';

export const getCollectionsV2 = (deps: Deps) => async (c: Context) => {
  const { userId, app } = auth(c);
  const sinceTime = Number.parseInt(c.req.query('sinceTime') ?? '0', 10) || 0;

  const rows = (await listUserCollections(deps, userId, sinceTime)).filter((r) => r.app === app);
  const collections = await Promise.all(
    rows.map(async (r) =>
      collectionToJson(
        deps,
        r,
        r.isDeleted ? {} : { sharees: await shareesJson(deps, r.collectionId) },
      ),
    ),
  );

  // Shared-with-me: a share surfaces when the collection was restamped (share,
  // rename, ...) OR the share row itself moved — museum's join condition is
  // `collection_shares.updation_time > $since OR collections.updation_time >
  // $since`. Emitted updationTime is the collection's, as museum scans it.
  for (const share of await listUserShareRows(deps, userId)) {
    const col = await getCollection(deps, share.collectionID);
    if (!col || col.app !== app) continue;
    // The delete cascade removes share rows before tombstoning the collection;
    // a row pointing at a deleted collection is a mid-cascade race — the
    // tombstone below (or the next sync) covers it.
    if (col.isDeleted) continue;
    if (col.updationTime <= sinceTime && share.updationTime <= sinceTime) continue;
    collections.push(await sharedCollectionToJson(deps, col, share));
  }

  // Unshares: per-user tombstones (plan §3 caveat 4 — the collection row is
  // untouched, so the owner and other sharees never see this entry). Museum's
  // equivalent rows keep the collection's fields and an is_deleted flag; this
  // reuses the blanked tombstone shape clients already handle (D50).
  for (const tomb of await listSharedTombstones(deps, userId, sinceTime)) {
    const col = await getCollection(deps, tomb.collectionID);
    if (!col || col.app !== app) continue;
    collections.push(
      await collectionToJson(deps, { ...col, isDeleted: true, updationTime: tomb.updationTime }),
    );
  }

  return c.json({ collections });
};
