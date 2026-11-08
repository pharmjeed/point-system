/**
 * Send pacing of the single number (12 §5.6–§5.9, 12 §5.14). Pure functions over send times so that every
 * worker computes the same answer from the database (no in-memory buckets shared between processes).
 */

/** 12 §5.9: temporary errors retry after 1, 4, 16, 64, 256 s (±20 %); `attempt` = attempts made so far (1-based). */
export function sendRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = 4 ** (Math.max(1, Math.min(attempt, 5)) - 1) * 1000;
  return Math.round(base * (0.8 + random() * 0.4));
}

/**
 * Per-recipient bucket (12 §5.7): capacity `capacity`, one token every `refillS` seconds. Written as a
 * GCRA over the recipient's previous send times: a send at `now` conforms when, for the i-th newest
 * previous send, `now - t_i >= (i + 1 - capacity) · refillS`. Returns the wait in ms (0 = send now).
 */
export function pairBucketWaitMs(
  sendTimes: readonly Date[],
  now: Date,
  capacity: number,
  refillS: number,
): number {
  const times = sendTimes.map((d) => d.getTime()).sort((a, b) => b - a);
  let wait = 0;
  times.forEach((t, idx) => {
    const need = (idx + 2 - capacity) * refillS * 1000;
    if (need > 0) wait = Math.max(wait, need - (now.getTime() - t));
  });
  return Math.max(0, Math.ceil(wait));
}

/** 12 §5.8: at most `mps` sends in any sliding second; `recent` = send times (any order). */
export function slidingSecondWaitMs(recent: readonly Date[], now: Date, mps: number): number {
  const limit = Math.max(1, Math.floor(mps));
  const from = now.getTime() - 1000;
  const inWindow = recent
    .map((d) => d.getTime())
    .filter((t) => t > from && t <= now.getTime())
    .sort((a, b) => a - b);
  if (inWindow.length < limit) return 0;
  const expiring = inWindow[inWindow.length - limit]!;
  return Math.max(1, expiring + 1000 - now.getTime());
}

/** 12 §5.9 (130429): the global limiter runs 20 % slower for a minute after a throughput error. */
export function effectiveGlobalMps(mps: number, throttledRecently: boolean): number {
  return Math.max(1, Math.floor(throttledRecently ? mps * 0.8 : mps));
}

/** Fair share of the global ceiling between the venues that have due sends (12 §5.8 round robin). */
export function venueShare(mps: number, dueVenues: number): number {
  return Math.max(1, Math.floor(mps / Math.max(1, dueVenues)));
}

export interface PreviousMessage {
  /** provider acceptance time (whatsapp_messages.queued_at) */
  acceptedAt: Date;
  status: string;
  statusRank: number;
}

/**
 * Per-ticket ordering gate (12 §5.6): the next message of a ticket waits until the previous one is
 * delivered/read/failed, or `maxWaitS` after the provider accepted it. Returns the wait in ms.
 */
export function orderingGateWaitMs(prev: PreviousMessage | null, now: Date, maxWaitS: number): number {
  if (!prev) return 0;
  if (prev.status === 'failed' || prev.status === 'skipped' || prev.statusRank >= 2) return 0;
  const left = prev.acceptedAt.getTime() + maxWaitS * 1000 - now.getTime();
  return left > 0 ? left : 0;
}

/** 12 §5.14: temporary error rate above 20 % over the last 5 minutes (at least 5 attempts) → degraded. */
export function temporaryErrorRateExceeded(total: number, temporary: number): boolean {
  return total >= 5 && temporary / total > 0.2;
}

/** 12 §5.14: every temporary attempt failing for more than 2 consecutive minutes → down. */
export function failingStreakExceeded(firstFailureSinceLastSuccess: Date | null, now: Date): boolean {
  return (
    firstFailureSinceLastSuccess !== null && now.getTime() - firstFailureSinceLastSuccess.getTime() >= 120_000
  );
}
