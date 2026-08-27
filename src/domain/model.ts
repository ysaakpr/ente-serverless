/**
 * Single-table key builders (build plan §1). Every key shape lives here so
 * handlers never assemble raw strings.
 */

/** Left-pad a numeric timestamp for lexicographic ordering in sort keys. */
export const padTime = (micros: number): string => String(micros).padStart(16, '0');

export const keys = {
  user: (userId: number) => ({ pk: `USER#${userId}`, sk: 'META' }),
  userKeys: (userId: number) => ({ pk: `USER#${userId}`, sk: 'KEYS' }),
  userSrp: (userId: number) => ({ pk: `USER#${userId}`, sk: 'SRP' }),
  userUsage: (userId: number) => ({ pk: `USER#${userId}`, sk: 'USAGE' }),
  /** Enabled 2FA: the TOTP secret + the client-encrypted copy for recovery. */
  userTwoFactor: (userId: number) => ({ pk: `USER#${userId}`, sk: '2FA' }),
  /** Secret handed out by /two-factor/setup, pending an /enable that proves it. */
  twoFactorSetup: (userId: number) => ({ pk: `USER#${userId}`, sk: '2FASETUP' }),
  /** Half-authenticated login awaiting a TOTP code; keyed by hash, like tokens. */
  twoFactorSession: (sessionHash: string) => ({ pk: `2FASESSION#${sessionHash}`, sk: 'META' }),
  emailGuard: (emailHash: string) => ({ pk: `EMAIL#${emailHash}`, sk: 'META' }),
  srpUserGuard: (srpUserID: string) => ({ pk: `SRPUSER#${srpUserID}`, sk: 'META' }),
  srpSession: (sessionID: string) => ({ pk: `SRPSESSION#${sessionID}`, sk: 'META' }),
  srpSetup: (setupID: string) => ({ pk: `SRPSETUP#${setupID}`, sk: 'META' }),
  ott: (emailHash: string, app: string, code: string) => ({ pk: `OTT#${app}#${emailHash}`, sk: code }),
  ottPartition: (emailHash: string, app: string) => `OTT#${app}#${emailHash}`,
  token: (tokenHash: string) => ({ pk: `TOKEN#${tokenHash}`, sk: 'META' }),
  file: (fileId: number) => ({ pk: `FILE#${fileId}`, sk: 'META' }),
  fileData: (fileId: number, type: string) => ({ pk: `FILE#${fileId}`, sk: `FD#${type}` }),
  collection: (collectionId: number) => ({ pk: `COL#${collectionId}`, sk: 'META' }),
  collectionFile: (collectionId: number, fileId: number) => ({
    pk: `COL#${collectionId}`,
    sk: `FILE#${fileId}`,
  }),
  trashEntry: (userId: number, fileId: number) => ({ pk: `TRASH#${userId}`, sk: `FILE#${fileId}` }),
  entityKey: (userId: number, type: string) => ({ pk: `USER#${userId}`, sk: `ENTKEY#${type}` }),
  entity: (userId: number, type: string, id: string) => ({
    pk: `ENTITY#${userId}#${type}`,
    sk: id,
  }),
  remoteStore: (userId: number, key: string) => ({ pk: `USER#${userId}`, sk: `STORE#${key}` }),
  /** Store-and-ignore push registration (one row per user). */
  pushToken: (userId: number) => ({ pk: `USER#${userId}`, sk: 'PUSHTOKEN' }),

  // --- Sharing + public links (PENDING-FEATURES-PLAN §2 Phase A, D48) ---
  // Rollback rule: none of these rows may set gsi1/gsi2/gsi3 attributes. The
  // GSIs are sparse, so staying out of them keeps every pre-sharing query
  // path blind to the new rows — old code deployed against a table containing
  // them behaves exactly as before.
  /** Participant row, collection side: who can see COL#<id>. */
  collectionSharee: (collectionId: number, userId: number) => ({
    pk: `COL#${collectionId}`,
    sk: `SHAREE#${userId}`,
  }),
  /** Participant row, user side (dual-written): collections shared with me. */
  userSharedCollection: (userId: number, collectionId: number) => ({
    pk: `USER#${userId}`,
    sk: `SHARED#${collectionId}`,
  }),
  /** Public link token → collection: a plain GetItem. tokenHash only — the
   * plaintext token never lands at rest (same discipline as TOKEN# rows). */
  publicLinkToken: (tokenHash: string) => ({ pk: `PUBTOKEN#${tokenHash}`, sk: 'META' }),
  /** Per-collection pointer to its active link (holds the tokenHash). */
  collectionLink: (collectionId: number) => ({ pk: `COL#${collectionId}`, sk: 'LINK' }),
  /** Per-user unshare tombstone for the sharee's /collections/v2 feed
   * (written by sharing.ts removeSharee/removeAllSharees since Phase C; a
   * re-share deletes it). The sk deliberately does NOT match the `SHARED#`
   * prefix, so live listings never see tombstones. */
  sharedTombstone: (userId: number, collectionId: number) => ({
    pk: `USER#${userId}`,
    sk: `SHAREDTOMB#${collectionId}`,
  }),

  // --- Public-link serving rows (Phase D, D51). All live under the link's
  // PUBTOKEN# partition so disabling a link can purge them with one Query, and
  // none set gsi attributes (the D48 rollback rule).
  /** One admitted device per (ip, ua) — museum public_collection_access_history
   * (unique_access_sid_ip_ua). Existence = admitted. */
  publicLinkDevice: (tokenHash: string, deviceHash: string) => ({
    pk: `PUBTOKEN#${tokenHash}`,
    sk: `DEVICE#${deviceHash}`,
  }),
  /** Atomic unique-device counter (museum counts the history rows instead). */
  publicLinkDeviceCount: (tokenHash: string) => ({ pk: `PUBTOKEN#${tokenHash}`, sk: 'DEVICES' }),
  /** verify-password wrong-attempt cap per (link, ip) — OTT-cap pattern. */
  publicLinkPwAttempts: (tokenHash: string, ipHash: string) => ({
    pk: `PUBTOKEN#${tokenHash}`,
    sk: `PWATTEMPTS#${ipHash}`,
  }),
  /** Per-link daily download/upload ceilings (plan §4.1d), one row per UTC day. */
  publicLinkCeiling: (tokenHash: string, day: string) => ({
    pk: `PUBTOKEN#${tokenHash}`,
    sk: `CEIL#${day}`,
  }),

  // --- Invite-gated signup (Phase H1, D54). Ops-provisioned rows only —
  // written by tools/invite.ts, read at signup; no client route creates them.
  // Keyed by the LOWERCASED email in plaintext, unlike EMAIL# guards (hashed):
  // an operator must be able to list and revoke invites without HASHING_KEY,
  // and an invite is operator data, not a user secret. No gsi attributes
  // (the D48 rollback rule holds for every new row type).
  invite: (lowercasedEmail: string) => ({ pk: `INVITE#${lowercasedEmail}`, sk: 'META' }),
};

/** sk prefixes for partition listings over the sharing rows. */
export const skPrefixes = {
  /** All sharees of one collection (COL#<id> partition). */
  sharee: 'SHAREE#',
  /** All collections shared with one user (USER#<id> partition). */
  sharedWithUser: 'SHARED#',
  /** All unshare tombstones for one user (USER#<id> partition). Distinct from
   * `SHARED#` — 'SHAREDTOMB#'.startsWith('SHARED#') is false (T ≠ #), so live
   * listings never see tombstones. */
  sharedTombstone: 'SHAREDTOMB#',
};

// GSI partitions
export const gsi = {
  /** gsi1: file membership + diff feed for one collection. */
  collectionDiff: (collectionId: number) => `COL#${collectionId}#DIFF`,
  /** gsi2: collections OWNED by a user, by updationTime. Shared-with-me
   * visibility is NOT here — it lives in the `SHARED#` reverse rows above,
   * merged at query time (Phase C). */
  userCollections: (userId: number) => `USER#${userId}#COLS`,
  /** gsi3: tokens per user / trash diff per user. */
  userTokens: (userId: number) => `USER#${userId}#TOKENS`,
  trashDiff: (userId: number) => `USER#${userId}#TRASH`,
  entityDiff: (userId: number, type: string) => `USER#${userId}#ENT#${type}`,
};
