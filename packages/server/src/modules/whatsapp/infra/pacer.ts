import { effectiveGlobalMps, slidingSecondWaitMs, venueShare } from '../domain/pacing.js';

/**
 * Global ceiling of the single number (12 §5.8, `wa.global_mps`) and the fair share between venues, kept
 * in the worker's memory: one sliding second of send instants per channel. The ceiling is per worker
 * process; the pilot runs one worker (04 §10), a second replica halves its value through the setting
 * (DEC-PROPOSED-7 in docs/progress/notes/s3-whatsapp.md). The per-recipient bucket (12 §5.7) is computed
 * from the database instead, so it holds across processes.
 */
export class SendPacer {
  private sends: { at: number; venue: string | null }[] = [];
  /** 130429: 20 % slower until this instant (12 §5.9) */
  private throttledUntil = 0;

  private prune(now: number): void {
    const from = now - 1000;
    if (this.sends.length && this.sends[0]!.at <= from) this.sends = this.sends.filter((s) => s.at > from);
  }

  mps(configured: number, now: number): number {
    return effectiveGlobalMps(configured, now < this.throttledUntil);
  }

  /** Sends in the current sliding second (all venues). */
  inWindow(now: number): number {
    this.prune(now);
    return this.sends.length;
  }

  /**
   * Wait before this venue may send: the global ceiling first, then — when several venues have due
   * sends (`dueVenues`) — the venue's share of it, so one busy hall cannot starve the others.
   */
  waitMs(now: number, configuredMps: number, venueId: string | null, dueVenues: number): number {
    this.prune(now);
    const mps = this.mps(configuredMps, now);
    const at = new Date(now);
    const all = this.sends.map((s) => new Date(s.at));
    const global = slidingSecondWaitMs(all, at, mps);
    if (global > 0 || dueVenues <= 1) return global;
    const mine = this.sends.filter((s) => s.venue === venueId).map((s) => new Date(s.at));
    return slidingSecondWaitMs(mine, at, venueShare(mps, dueVenues));
  }

  take(now: number, venueId: string | null): void {
    this.prune(now);
    this.sends.push({ at: now, venue: venueId });
  }

  throttle(now: number): void {
    this.throttledUntil = Math.max(this.throttledUntil, now + 60_000);
  }
}

/** Result of the 60-second phone-number probe (12 §5.14). */
export interface ChannelProbe {
  at: number;
  ok: boolean;
  quality: string | null;
}
