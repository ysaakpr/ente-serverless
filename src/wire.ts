/** Production wiring: AWS adapters + real clock/rand. */

import { configFromEnv } from './config.ts';
import type { Deps } from './deps.ts';
import { DynamoDb } from './adapters/aws/db.dynamo.ts';
import { S3Blobs } from './adapters/aws/blobs.s3.ts';
import { SesMail } from './adapters/aws/mail.ses.ts';
import { RealRand, SystemClock } from './adapters/memory/system.memory.ts';
import { IdGenerator } from './domain/ids.ts';
import { sodiumReady } from './domain/tokens.ts';

export const wireAwsDeps = async (): Promise<Deps> => {
  await sodiumReady();
  const config = configFromEnv();
  const clock = new SystemClock();
  const hashingKeyB64 = process.env.HASHING_KEY;
  if (!hashingKeyB64) throw new Error('HASHING_KEY (base64, 32 bytes) is required');
  // SECURITY-REVIEW-2 F9: enforce the length, not just presence. A malformed
  // value (non-base64, or short) decodes to a 0/short buffer, silently
  // degrading emailHash's keyed blake2b to an UNKEYED hash — making EMAIL#/OTT#
  // partition keys predictable from the email. Fail closed instead.
  const hashingKey = new Uint8Array(Buffer.from(hashingKeyB64, 'base64'));
  if (hashingKey.length !== 32) {
    throw new Error(`HASHING_KEY must decode to 32 bytes (got ${hashingKey.length})`);
  }
  return {
    db: new DynamoDb(config),
    blobs: new S3Blobs(config),
    mail: new SesMail(config),
    clock,
    rand: new RealRand(),
    config,
    ids: new IdGenerator(clock),
    hashingKey,
  };
};
