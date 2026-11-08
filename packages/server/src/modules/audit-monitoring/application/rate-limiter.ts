/**
 * Sliding one-minute window per key (15 §9.3: 120 telemetry events per device and minute). In-process:
 * each api instance counts its own traffic, which bounds a device per instance — enough for a limit whose
 * purpose is protecting the table from a runaway client. Time comes from the injected clock.
 */
export class SlidingWindowLimiter {
  private readonly windows = new Map<string, { at: number; n: number }[]>();
  private lastSweep = 0;

  constructor(
    readonly limit: number,
    readonly windowMs = 60_000,
  ) {}

  /** Consumes `n` units when they fit in the window; otherwise returns the seconds until they would. */
  consume(key: string, n: number, nowMs: number): { ok: true } | { ok: false; retryAfterS: number } {
    this.sweep(nowMs);
    const from = nowMs - this.windowMs;
    const entries = (this.windows.get(key) ?? []).filter((e) => e.at > from);
    const used = entries.reduce((s, e) => s + e.n, 0);
    if (used + n > this.limit) {
      // the oldest entries leave the window first
      let freed = 0;
      let wait = this.windowMs;
      for (const e of entries) {
        freed += e.n;
        if (used - freed + n <= this.limit) {
          wait = e.at + this.windowMs - nowMs;
          break;
        }
      }
      this.windows.set(key, entries);
      return { ok: false, retryAfterS: Math.max(1, Math.ceil(wait / 1000)) };
    }
    entries.push({ at: nowMs, n });
    this.windows.set(key, entries);
    return { ok: true };
  }

  private sweep(nowMs: number) {
    if (nowMs - this.lastSweep < this.windowMs) return;
    this.lastSweep = nowMs;
    for (const [k, entries] of this.windows) {
      if (!entries.some((e) => e.at > nowMs - this.windowMs)) this.windows.delete(k);
    }
  }
}
