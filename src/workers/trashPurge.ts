/**
 * EventBridge cron entry: purge trash entries past deleteBy (30 days).
 * OTT/SRP-session rows expire via DynamoDB TTL and need no cron.
 */

import { wireAwsDeps } from '../wire.ts';
import { purgeAgedTrash } from '../domain/trash.ts';
import { sweepDeletedObjects } from '../domain/objectSweep.ts';

const deps = await wireAwsDeps();

export const handler = async (): Promise<{ purged: number; swept: number }> => {
  const purged = await purgeAgedTrash(deps);
  const swept = await sweepDeletedObjects(deps);
  console.log(`trash purge: ${purged} entries; object sweep: ${swept} objects`);
  return { purged, swept };
};
