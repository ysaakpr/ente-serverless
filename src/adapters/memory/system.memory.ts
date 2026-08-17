/** Controllable clock + real randomness for tests. */

import { randomBytes, randomUUID, randomInt } from 'node:crypto';
import type { Clock, Rand } from '../../ports/system.ts';
import type { Micros } from '../../lib/time.ts';

export class TestClock implements Clock {
  constructor(private now: Micros = Date.now() * 1000) {}

  nowMicros(): Micros {
    return this.now;
  }

  advance(byMicros: number): void {
    this.now += byMicros;
  }

  set(to: Micros): void {
    this.now = to;
  }
}

export class RealRand implements Rand {
  bytes(n: number): Uint8Array {
    return new Uint8Array(randomBytes(n));
  }

  uuid(): string {
    return randomUUID();
  }

  int(maxExclusive: number): number {
    return randomInt(maxExclusive);
  }
}

export class SystemClock implements Clock {
  nowMicros(): Micros {
    return Date.now() * 1000;
  }
}
