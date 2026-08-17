/** Clock + randomness — injectable so tests control time and ids. */

import type { Micros } from '../lib/time.ts';

export interface Clock {
  nowMicros(): Micros;
}

export interface Rand {
  bytes(n: number): Uint8Array;
  uuid(): string;
  /** Uniform int in [0, maxExclusive). */
  int(maxExclusive: number): number;
}
