/**
 * Invite rows + per-user storage overrides (Phase H1, D54). Deliberately
 * OFF-PARITY: museum has no invite mode or per-user storage knob — self-host
 * operators there run everyone on the config'd free plan. This is a
 * server/CLI-side feature only: no client-visible route reads or writes these
 * rows, the wire shapes the stock app sees are unchanged (the per-user limit
 * surfaces solely as a different NUMBER in the museum-shaped subscription),
 * and capture-diff must skip invite-mode servers (D54).
 *
 * Written by tools/invite.ts (`make invite` / `make revoke-invite` /
 * `make set-storage`), consumed once at signup (createUser, users.ts). The
 * consumed row is kept as the audit trail — `consumedAt` set means the invite
 * no longer admits a signup; re-running `make invite` re-arms it.
 */

import type { Deps } from '../deps.ts';
import { keys } from './model.ts';
import { emailHash, normalizeEmail } from './tokens.ts';
import type { UserRow } from './users.ts';

/** What the invite/storage functions actually need — full Deps satisfies
 * these, and tools/invite.ts can wire a Db + clock without mail/blobs. */
export type InviteDeps = Pick<Deps, 'db' | 'clock'>;
export type StorageDeps = Pick<Deps, 'db' | 'hashingKey'>;

export interface InviteRow {
  pk: string;
  sk: string;
  email: string;
  /** Absent = the config free-plan default applies. 0 means ZERO bytes. */
  storageLimitBytes?: number;
  /** Viewer accounts only consume shares — uploads and album creation are blocked. */
  viewer: boolean;
  /** Federation seam (D54): which instance "owns" this user. Always 'local'
   * today; stored so a future multi-home deployment can route without a
   * migration. Nothing reads it yet. */
  home: string;
  /** Pre-signup pool assignment (H2, D55): copied onto the user row when the
   * invite is consumed, so signup lands the user straight in their pool.
   * Set via `make pool-attach EMAIL=... POOL=...` before the user signs up. */
  storagePoolId?: string;
  createdAt: number;
  /** Set when a signup consumes the invite; the row is kept for audit. */
  consumedAt?: number;
  [attr: string]: unknown;
}

export const getInvite = async (deps: InviteDeps, email: string): Promise<InviteRow | null> => {
  const key = keys.invite(normalizeEmail(email));
  return deps.db.get<InviteRow>(key.pk, key.sk);
};

/** An invite admits a signup only while unconsumed. */
export const hasUsableInvite = async (deps: InviteDeps, email: string): Promise<boolean> => {
  const invite = await getInvite(deps, email);
  return invite !== null && invite.consumedAt === undefined;
};

/**
 * Create or re-arm an invite. An upsert clears `consumedAt` on purpose — the
 * operator re-inviting a consumed email (e.g. after account deletion) is the
 * documented way to admit the same address again.
 */
export const upsertInvite = async (
  deps: InviteDeps,
  email: string,
  opts: { storageLimitBytes?: number; viewer?: boolean; storagePoolId?: string } = {},
): Promise<InviteRow> => {
  const normalized = normalizeEmail(email);
  const existing = await getInvite(deps, normalized);
  // Existing overrides survive a re-invite unless this upsert explicitly sets
  // new ones (explicit values win) — pool assignment (H2, D55) and, since
  // D56, storageLimitBytes/viewer too: the documented re-arm path (`make
  // invite` after account deletion) must not silently lift a 0-byte or
  // viewer restriction.
  const storagePoolId = opts.storagePoolId ?? (existing?.storagePoolId as string | undefined);
  const storageLimitBytes = opts.storageLimitBytes ?? existing?.storageLimitBytes;
  const viewer = opts.viewer ?? existing?.viewer ?? false;
  const row: InviteRow = {
    ...keys.invite(normalized),
    email: normalized,
    ...(storageLimitBytes !== undefined ? { storageLimitBytes } : {}),
    viewer,
    home: 'local',
    ...(storagePoolId ? { storagePoolId } : {}),
    createdAt: existing?.createdAt ?? deps.clock.nowMicros(),
  };
  await deps.db.put(row);
  return row;
};

/** Pre-signup pool assignment on an invite row (H2, D55); null clears it. */
export const setInvitePool = async (
  deps: InviteDeps,
  email: string,
  poolId: string | null,
): Promise<InviteRow | null> => {
  const normalized = normalizeEmail(email);
  const invite = await getInvite(deps, normalized);
  if (!invite) return null;
  const key = keys.invite(normalized);
  await deps.db.update(key.pk, key.sk, { storagePoolId: poolId ?? undefined });
  return { ...invite, storagePoolId: poolId ?? undefined };
};

/** Delete an UNCONSUMED invite. Consumed rows are audit trail — refuse. */
export const revokeInvite = async (
  deps: InviteDeps,
  email: string,
): Promise<'revoked' | 'not-found' | 'consumed'> => {
  const normalized = normalizeEmail(email);
  const invite = await getInvite(deps, normalized);
  if (!invite) return 'not-found';
  if (invite.consumedAt !== undefined) return 'consumed';
  const key = keys.invite(normalized);
  await deps.db.delete(key.pk, key.sk);
  return 'revoked';
};

/**
 * Stamp the invite consumed and return the overrides to copy onto the user
 * row. Callers (createUser) put these attributes and the consumed row in the
 * same transaction — see the `transactWrite` there.
 */
export const inviteConsumption = (
  deps: InviteDeps,
  invite: InviteRow,
): {
  consumedRow: InviteRow;
  userAttrs: Pick<UserRow, 'storageLimitBytes' | 'viewer' | 'home' | 'storagePoolId'>;
} => ({
  consumedRow: { ...invite, consumedAt: deps.clock.nowMicros() },
  userAttrs: {
    ...(invite.storageLimitBytes !== undefined ? { storageLimitBytes: invite.storageLimitBytes } : {}),
    ...(invite.viewer ? { viewer: true } : {}),
    home: invite.home,
    // Signup lands the user straight in their pool (H2, D55).
    ...(invite.storagePoolId ? { storagePoolId: invite.storagePoolId } : {}),
  },
});

/**
 * The operator's post-hoc lever: set (or clear, bytes === null) an EXISTING
 * user's storageLimitBytes. Needs HASHING_KEY — user lookup goes through the
 * hashed EMAIL# guard, unlike invite rows.
 */
export const setUserStorage = async (
  deps: StorageDeps,
  email: string,
  bytes: number | null,
): Promise<{ userId: number } | null> => {
  const hash = emailHash(normalizeEmail(email), deps.hashingKey);
  const guard = await deps.db.get(keys.emailGuard(hash).pk, 'META');
  if (!guard) return null;
  const userId = guard.userId as number;
  const key = keys.user(userId);
  // update() removes attributes set to undefined — clearing falls back to the
  // config free-plan default.
  await deps.db.update(key.pk, key.sk, { storageLimitBytes: bytes ?? undefined });
  return { userId };
};
