/**
 * Social/sharing sync probes the app polls every sync loop (gate finding
 * D27). Core scope has no sharing, comments, or contacts, so every feed is
 * legitimately empty — but the routes must answer 200 or the app's sync
 * degrades. Shapes from pkg/api/social.go, collection_actions.go, contact.go.
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';

/** GET /comments-reactions/updated-at — {"updates":[CollectionLatestUpdate…]}. */
export const socialLatestUpdates = (_deps: Deps) => async (c: Context) => {
  auth(c);
  return c.json({ updates: [] });
};

/** GET /comments-reactions/counts — {"counts": …} per active collection. */
export const socialCounts = (_deps: Deps) => async (c: Context) => {
  auth(c);
  return c.json({ counts: [] });
};

/** GET /collection-actions/pending-remove — {"actions":[],"hasMore":false}. */
export const pendingRemoveActions = (_deps: Deps) => async (c: Context) => {
  auth(c);
  return c.json({ actions: [], hasMore: false });
};

/** GET /collection-actions/delete-suggestions — same envelope. */
export const deleteSuggestions = (_deps: Deps) => async (c: Context) => {
  auth(c);
  return c.json({ actions: [], hasMore: false });
};

/** GET /contacts/diff — {"diff":[]} (encrypted contacts sync, post-core). */
export const contactsDiff = (_deps: Deps) => async (c: Context) => {
  auth(c);
  return c.json({ diff: [] });
};
