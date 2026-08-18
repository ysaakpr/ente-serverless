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
};

// GSI partitions
export const gsi = {
  /** gsi1: file membership + diff feed for one collection. */
  collectionDiff: (collectionId: number) => `COL#${collectionId}#DIFF`,
  /** gsi2: all collections visible to a user, by updationTime. */
  userCollections: (userId: number) => `USER#${userId}#COLS`,
  /** gsi3: tokens per user / trash diff per user. */
  userTokens: (userId: number) => `USER#${userId}#TOKENS`,
  trashDiff: (userId: number) => `USER#${userId}#TRASH`,
  entityDiff: (userId: number, type: string) => `USER#${userId}#ENT#${type}`,
};
