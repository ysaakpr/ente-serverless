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
  return {
    db: new DynamoDb(config),
    blobs: new S3Blobs(config),
    mail: new SesMail(config),
    clock,
    rand: new RealRand(),
    config,
    ids: new IdGenerator(clock),
    hashingKey: new Uint8Array(Buffer.from(hashingKeyB64, 'base64')),
  };
};
