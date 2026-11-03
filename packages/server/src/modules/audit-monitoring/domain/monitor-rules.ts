/**
 * Pure rules of the SystemMonitor (04 §6.7, 14 §8, 15 §12).
 */

/** 14 §8 `outbox_lag`: resolves after the lag stays below the threshold for two minutes with no dead row. */
export const OUTBOX_LAG_RESOLVE_AFTER_MS = 2 * 60 * 1000;

/** `ops.outbox_lag_alert_s` with its canon §12 default (core: the readiness probe reads it too). */
export { outboxLagThresholdS } from '../../../core/settings/ops-settings.js';

/**
 * 14 §8 / 15 §12 `task_stuck` (initial values, tuned after the pilot; no canon §12 key): a `retrieve` task
 * accepted without start for 10 minutes, a `retrieve` task in progress without readiness for 20 minutes, a
 * `park`/`repark` task in progress for 20 minutes.
 */
export const TASK_STUCK_THRESHOLD_MIN = {
  retrieve_accepted: 10,
  retrieve_in_progress: 20,
  park_in_progress: 20,
} as const;
export type StuckPhase = keyof typeof TASK_STUCK_THRESHOLD_MIN;

export interface OutboxHealth {
  /** age in seconds of the oldest due unprocessed row (pending and due, or processing with an expired lease) */
  oldestDueAgeS: number;
  dueCount: number;
  deadCount: number;
}

/** 14 §8: older than `ops.outbox_lag_alert_s`, or any row `dead`. */
export function isOutboxLagging(h: OutboxHealth, thresholdS: number): boolean {
  return h.oldestDueAgeS > thresholdS || h.deadCount > 0;
}

/** Whether a live `outbox_lag` alert that turned healthy at `belowSince` may be resolved at `now`. */
export function lagResolvable(
  belowSince: Date | null,
  now: Date,
  afterMs = OUTBOX_LAG_RESOLVE_AFTER_MS,
): boolean {
  return belowSince !== null && now.getTime() - belowSince.getTime() >= afterMs;
}

const PHONE_IN_TEXT = /(?<![0-9])(?:\+?966|00966|0)?5[0-9]{8}(?![0-9])/g;

/** Masks Saudi mobile numbers inside free text (`05•••••123`, canon §15) — audit `reason` read-back. */
export function maskPhonesInText(text: string, mask: (digits: string) => string | null): string {
  return text.replace(PHONE_IN_TEXT, (m) => mask(m) ?? '•••');
}
