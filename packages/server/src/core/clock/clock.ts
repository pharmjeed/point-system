/**
 * All time-dependent domain logic goes through a Clock (16 §2.12, 05 §7.5). Queries receive "now" as a
 * parameter instead of relying on now() so that tests can move time deterministically.
 */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('CLOCK');

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FakeClock implements Clock {
  private t: number;
  constructor(start: Date | string = '2026-10-29T18:00:00.000Z') {
    this.t = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  set(at: Date | string): void {
    this.t = new Date(at).getTime();
  }
  advance(ms: number): Date {
    this.t += ms;
    return this.now();
  }
  advanceSeconds(s: number): Date {
    return this.advance(s * 1000);
  }
}
