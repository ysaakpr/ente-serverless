/**
 * Client IP for audit rows (security review 2026-08-17, finding 7).
 *
 * X-Forwarded-For is client-settable, and every login path used to store it
 * verbatim on the token row — so a caller fully controlled what
 * GET /users/sessions later showed as the session's origin, which is exactly
 * the surface a user reads to spot a compromise. CloudFront appends the
 * viewer's address to the RIGHT of whatever the client sent, so the rightmost
 * entry is the edge-observed address and cannot be forged through that path.
 *
 * Honest limit: on a direct Function URL hit there is no trustworthy value in
 * the header at all; this is a strict improvement, and becomes fully sound
 * only once the CloudFront origin secret (finding 4) makes the edge the sole
 * path.
 */

import type { Context } from 'hono';

export const clientIp = (c: Context): string =>
  (c.req.header('x-forwarded-for') ?? '').split(',').pop()?.trim() ?? '';
