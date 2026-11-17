import {
  addDays,
  daysBetween,
  remainingServiceDays,
  riyadhDate,
  riyadhMidnight,
  type IsoDate,
  type ServiceTerm,
} from '@point/shared';
import type { PlanPolicyRow, SubscriptionRow } from './rows.js';

/**
 * The counted-day term of a subscription on its rows (04 §7; DEC-591, DEC-593): pure helpers over the arithmetic of
 * `@point/shared` (service-days), the clock given by the caller (the transaction's or the injected one).
 */

export const isServiceDaysPlan = (p: Pick<PlanPolicyRow, 'term_kind'>) => p.term_kind === 'service_days';

/** The term as stored (first and last counted days), or null for a calendar term or before the payment. */
export function termOf(
  sub: Pick<SubscriptionRow, 'service_start_on' | 'service_end_on'>,
): ServiceTerm | null {
  return sub.service_start_on && sub.service_end_on
    ? { startOn: sub.service_start_on, endOn: sub.service_end_on }
    : null;
}

export const laterDay = (a: IsoDate, b: IsoDate) => (daysBetween(a, b) > 0 ? b : a);

/**
 * The first counted day a freeze starting at `at` has not consumed (DEC-593): a freeze at a Riyadh midnight (the
 * customer's, from its start day) consumes nothing of that day; a freeze in the middle of a day (the operator
 * suspended, the venue closed) leaves that day consumed.
 */
export function firstUnconsumedAt(at: Date): IsoDate {
  const day = riyadhDate(at);
  return riyadhMidnight(day).getTime() === at.getTime() ? day : addDays(day, 1);
}

/**
 * The day the remaining counted days of a frozen term resume (DEC-593): today (it counts when it serves), never
 * before the first day the freeze left unconsumed nor before the term's first day.
 */
export function resumeDay(
  now: Date,
  sub: Pick<SubscriptionRow, 'frozen_at' | 'service_start_on'>,
  given?: IsoDate,
): IsoDate {
  let day = given ?? riyadhDate(now);
  if (sub.frozen_at) day = laterDay(day, firstUnconsumedAt(sub.frozen_at));
  if (sub.service_start_on) day = laterDay(day, sub.service_start_on);
  return day;
}

/**
 * The counted days a subscriber still has, as C-14 shows them: from today (today included when it serves), the
 * frozen remainder while frozen, all of them before the first day.
 */
export function remainingDaysNow(
  now: Date,
  sub: Pick<SubscriptionRow, 'status' | 'service_start_on' | 'service_end_on' | 'frozen_remaining_days'>,
  mask: number,
): number | null {
  const term = termOf(sub);
  if (!term) return null;
  if (sub.status === 'frozen' && sub.frozen_remaining_days !== null) return sub.frozen_remaining_days;
  if (sub.status !== 'active') return sub.status === 'past_due' ? 0 : null;
  return remainingServiceDays(riyadhDate(now), term, mask);
}

/**
 * The counted days refunded on a termination or an exceptional refund (DEC-600): what is left from tomorrow (today's
 * service is the subscriber's), the frozen remainder while frozen, all of them before the first day.
 */
export function refundableDays(
  now: Date,
  sub: Pick<SubscriptionRow, 'status' | 'service_start_on' | 'service_end_on' | 'frozen_remaining_days'>,
  mask: number,
): number {
  const term = termOf(sub);
  if (!term) return 0;
  if (sub.status === 'frozen' && sub.frozen_remaining_days !== null) return sub.frozen_remaining_days;
  return remainingServiceDays(addDays(riyadhDate(now), 1), term, mask);
}
