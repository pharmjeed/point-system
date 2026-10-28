import type { PoolDriverRow } from '../infra/rows.js';

/**
 * Longest idle first (10 §2.3): `available_since` ascending then `user_id`; with
 * `dispatch.offline_drivers_last` drivers whose connection is not `online` go after the others.
 */
export function compareIdle(a: PoolDriverRow, b: PoolDriverRow, offlineLast: boolean): number {
  if (offlineLast) {
    const ao = a.connection_state === 'online' ? 0 : 1;
    const bo = b.connection_state === 'online' ? 0 : 1;
    if (ao !== bo) return ao - bo;
  }
  const at = a.available_since ? new Date(a.available_since).getTime() : Number.POSITIVE_INFINITY;
  const bt = b.available_since ? new Date(b.available_since).getTime() : Number.POSITIVE_INFINITY;
  if (at !== bt) return at - bt;
  return a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0;
}

/** R-2: single-offer candidates are available drivers without a live single offer, longest idle first. */
export function idleCandidates(
  onDuty: readonly PoolDriverRow[],
  opts: { offlineLast: boolean },
): PoolDriverRow[] {
  return onDuty
    .filter((d) => d.driver_state === 'available' && !d.live_single_offer_id)
    .sort((a, b) => compareIdle(a, b, opts.offlineLast));
}

/** First idle driver not tried for the task in this episode and not blocked by an older live round. */
export function pickCandidate(
  idle: readonly PoolDriverRow[],
  tried: ReadonlySet<string>,
  blocked: ReadonlySet<string>,
): PoolDriverRow | undefined {
  return idle.find((d) => !tried.has(d.user_id) && !blocked.has(d.user_id));
}
