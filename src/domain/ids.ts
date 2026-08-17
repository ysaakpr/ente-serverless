/**
 * Server-assigned int64 IDs. Museum's are epoch-derived and fit in a JS
 * number (< 2^53 until year ~2255 for epoch-microsecond values — asserted in
 * unit tests). Monotonic per process: nowMicros, bumped past the last issued
 * value on collision.
 */

import type { Clock } from '../ports/system.ts';

export class IdGenerator {
  private last = 0;

  constructor(private clock: Clock) {}

  next(): number {
    let candidate = this.clock.nowMicros();
    if (candidate <= this.last) candidate = this.last + 1;
    if (!Number.isSafeInteger(candidate)) throw new Error('id overflow past 2^53');
    this.last = candidate;
    return candidate;
  }

  /**
   * Monotonic updationTime in epoch micros — every mutation to files,
   * collection links, and trash gets a strictly increasing stamp so diff
   * feeds never interleave equal keys.
   */
  nextUpdationTime(): number {
    return this.next();
  }
}
