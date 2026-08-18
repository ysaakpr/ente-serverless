/**
 * EventBridge cron entry: purge trash entries past deleteBy (30 days).
 * OTT/SRP-session rows expire via DynamoDB TTL and need no cron.
 */

import { wireAwsDeps } from '../wire.ts';
import { purgeAgedTrash } from '../domain/trash.ts';
import { sweepDeletedObjects } from '../domain/objectSweep.ts';

const deps = await wireAwsDeps();

export const handler = async (): Promise<{ purged: number; swept: number }> => {
  // SECURITY-REVIEW-2 F6: run the two GCs independently so a purge failure can
  // no longer skip the object sweep (deferred deletes are what actually reclaim
  // S3 bytes). Failures are still re-thrown at the end so the CloudWatch
  // `Errors` alarm — which keys on a FAILED invocation — keeps working.
  const errors: unknown[] = [];
  let purged = 0;
  let swept = 0;
  try {
    purged = await purgeAgedTrash(deps);
  } catch (err) {
    errors.push(err);
    console.error('trash purge failed', err);
  }
  try {
    swept = await sweepDeletedObjects(deps);
  } catch (err) {
    errors.push(err);
    console.error('object sweep failed', err);
  }
  console.log(`trash purge: ${purged} entries; object sweep: ${swept} objects`);
  if (errors.length > 0) {
    throw new AggregateError(errors, 'trash-purge worker had failures');
  }
  return { purged, swept };
};
