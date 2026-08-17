/**
 * Capture-parity harness (M0 deliverable, skeleton until the oracle runs).
 *
 * Intended flow (same discipline as immich-serverless):
 *   1. `make oracle-up` — museum + Postgres + MinIO from the pinned tag.
 *   2. `node tools/capture.ts` (to be written WITH the first capture run) —
 *      drives the synthetic client against museum, records request/response
 *      pairs into test/fixtures/oracle-<tag>/.
 *   3. this tool replays every capture against OUR server and reports
 *      byte-level envelope divergences; allowlist entries live in
 *      tools/contract-allowlist.ts with a written justification each.
 *
 * Blocked on: pinning the museum tag (DECISIONS.md D2). Until then this
 * exits loudly rather than pretending parity was checked.
 */

import { existsSync } from 'node:fs';

const fixtures = new URL('../test/fixtures', import.meta.url).pathname;

if (!existsSync(`${fixtures}/ORACLE-VERSION`)) {
  console.error(
    'capture-diff: no oracle captures exist yet.\n' +
      'Pin a museum tag (ORACLE-VERSION + docker-compose.oracle.yml), run the\n' +
      'capture script, then re-run. See DECISIONS.md D2.',
  );
  process.exit(2);
}
