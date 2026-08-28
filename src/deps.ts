/** The dependency container every handler receives. */

import type { Db } from './ports/db.ts';
import type { Blobs, BlobsResolver } from './ports/blobs.ts';
import type { Mail } from './ports/mail.ts';
import type { Clock, Rand } from './ports/system.ts';
import type { Config } from './config.ts';
import { IdGenerator } from './domain/ids.ts';

export interface Deps {
  db: Db;
  blobs: Blobs;
  /** Pool-aware blobs (H2, D55): forPool(null) is `blobs`, the central bucket. */
  blobsResolver: BlobsResolver;
  mail: Mail;
  clock: Clock;
  rand: Rand;
  config: Config;
  ids: IdGenerator;
  /** Keyed blake2b hashing key for email hashes (museum HashingKey). */
  hashingKey: Uint8Array;
}
