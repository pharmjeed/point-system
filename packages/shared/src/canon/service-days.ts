/**
 * Counted service days (docs/v2/04 §7; DEC-590 … DEC-593): a plan whose term is `service_days` lasts N counted days
 * (22 for the student plan) on the plan's service weekdays (Sunday … Thursday), not a calendar month. Friday and
 * Saturday never count; every other day counts even when it falls in a holiday or a closure, unless a freeze covers
 * it. Days are `YYYY-MM-DD` dates of the Asia/Riyadh calendar (UTC+3 all year, no daylight saving); the instants
 * the database stores are the Riyadh midnights of those dates. Pure functions: the server's injectable clock gives
 * `today`, nothing here reads the time.
 */

/** A `YYYY-MM-DD` date of the Asia/Riyadh calendar. */
export type IsoDate = string;

const RIYADH_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Weekday numbers as JavaScript counts them: 0 = Sunday … 6 = Saturday. */
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Bit `d` of a mask = weekday `d` serves (`subscription_plans.service_weekdays_mask`). */
export const SUNDAY_TO_THURSDAY_MASK = 0b0011111;

/** The fixed rules of the counted-day terms (DEC-591, DEC-594, DEC-596, DEC-600). */
export const SERVICE_DAY_RULES = {
  /**
   * A payment on a service day before this local minute makes that day the first counted day; later (or on a day
   * that does not serve) the first counted day is the next service day (DEC-591).
   */
  same_day_cutoff_minute: 12 * 60,
  /** an approved eligibility waits this many days for its payment (DEC-596) */
  eligibility_payment_days: 7,
  /** an approval of the same student number at the same venue is reused for this many days (renewal, DEC-596) */
  eligibility_reuse_days: 180,
  /** the exceptional refund reaches the original payment method within this many calendar days (DEC-600) */
  exceptional_refund_sla_days: 12,
  /** the longest window a freeze may be requested ahead of its start (DEC-594) */
  freeze_max_lead_days: 60,
} as const;

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value;
}

function assertDate(day: IsoDate): number {
  if (!isIsoDate(day)) throw new RangeError(`not a YYYY-MM-DD date: ${String(day)}`);
  return Date.parse(`${day}T00:00:00Z`);
}

/** The Riyadh date of an instant. */
export function riyadhDate(at: Date): IsoDate {
  return new Date(at.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
}

/** The Riyadh minute of the day of an instant (0 … 1439). */
export function riyadhMinuteOfDay(at: Date): number {
  const local = new Date(at.getTime() + RIYADH_OFFSET_MS);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

/** The instant of 00:00 Asia/Riyadh on a date. */
export function riyadhMidnight(day: IsoDate): Date {
  return new Date(assertDate(day) - RIYADH_OFFSET_MS);
}

export function addDays(day: IsoDate, n: number): IsoDate {
  if (!Number.isInteger(n)) throw new RangeError('n');
  return new Date(assertDate(day) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole calendar days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((assertDate(b) - assertDate(a)) / DAY_MS);
}

export function weekdayOf(day: IsoDate): Weekday {
  return new Date(assertDate(day)).getUTCDay() as Weekday;
}

export function isValidWeekdayMask(mask: number): boolean {
  return Number.isInteger(mask) && mask >= 1 && mask <= 127;
}

function assertMask(mask: number): void {
  if (!isValidWeekdayMask(mask)) throw new RangeError(`weekday mask ${mask}`);
}

export function weekdaysOfMask(mask: number): Weekday[] {
  assertMask(mask);
  return WEEKDAYS.filter((d) => (mask & (1 << d)) !== 0);
}

export function maskOfWeekdays(days: readonly number[]): number {
  let mask = 0;
  for (const d of days) {
    if (!Number.isInteger(d) || d < 0 || d > 6) throw new RangeError(`weekday ${d}`);
    mask |= 1 << d;
  }
  assertMask(mask);
  return mask;
}

export function isServiceDay(day: IsoDate, mask: number): boolean {
  assertMask(mask);
  return (mask & (1 << weekdayOf(day))) !== 0;
}

/** The first service day on or after `day`. */
export function nextServiceDayOnOrAfter(day: IsoDate, mask: number): IsoDate {
  assertMask(mask);
  let d = day;
  for (let i = 0; i < 7; i++, d = addDays(d, 1)) if (isServiceDay(d, mask)) return d;
  throw new RangeError('unreachable: a valid mask serves at least one weekday');
}

/** The n-th service day (n ≥ 1) counting from `from` itself. */
export function nthServiceDay(from: IsoDate, n: number, mask: number): IsoDate {
  if (!Number.isInteger(n) || n < 1) throw new RangeError('n must be a positive integer');
  const perWeek = weekdaysOfMask(mask).length;
  // whole weeks first (each holds `perWeek` service days), then day by day
  const weeks = Math.floor((n - 1) / perWeek);
  let left = n - weeks * perWeek;
  let d = addDays(from, weeks * 7);
  for (;;) {
    if (isServiceDay(d, mask) && --left === 0) return d;
    d = addDays(d, 1);
  }
}

/** Service days in [from, toExclusive). 0 when `toExclusive` is not after `from`. */
export function countServiceDays(from: IsoDate, toExclusive: IsoDate, mask: number): number {
  assertMask(mask);
  const span = daysBetween(from, toExclusive);
  if (span <= 0) return 0;
  const perWeek = weekdaysOfMask(mask).length;
  const weeks = Math.floor(span / 7);
  let n = weeks * perWeek;
  for (let d = addDays(from, weeks * 7); d !== toExclusive; d = addDays(d, 1)) if (isServiceDay(d, mask)) n++;
  return n;
}

/**
 * The first counted day of a term paid at `paidAt` (DEC-591): the payment's own Riyadh date when it is a service day
 * and the payment came before the cutoff minute, else the next service day after it.
 */
export function serviceTermStart(
  paidAt: Date,
  mask: number,
  cutoffMinute: number = SERVICE_DAY_RULES.same_day_cutoff_minute,
): IsoDate {
  const today = riyadhDate(paidAt);
  if (isServiceDay(today, mask) && riyadhMinuteOfDay(paidAt) < cutoffMinute) return today;
  return nextServiceDayOnOrAfter(addDays(today, 1), mask);
}

export interface ServiceTerm {
  /** the first counted day */
  startOn: IsoDate;
  /** the last counted day (inclusive) */
  endOn: IsoDate;
}

/** The term of `days` counted days paid at `paidAt` (no freeze). */
export function serviceTerm(
  paidAt: Date,
  days: number,
  mask: number,
  cutoffMinute: number = SERVICE_DAY_RULES.same_day_cutoff_minute,
): ServiceTerm {
  const startOn = serviceTermStart(paidAt, mask, cutoffMinute);
  return { startOn, endOn: nthServiceDay(startOn, days, mask) };
}

/** The instants a term occupies: from the Riyadh midnight of its first day to the midnight after its last. */
export function serviceTermInstants(term: ServiceTerm): { start: Date; end: Date } {
  return { start: riyadhMidnight(term.startOn), end: riyadhMidnight(addDays(term.endOn, 1)) };
}

/**
 * The counted days of a term not consumed from `firstUnconsumed` on (that day included): the service days in
 * [max(firstUnconsumed, startOn), endOn]. A term not begun yet has all of them.
 */
export function remainingServiceDays(firstUnconsumed: IsoDate, term: ServiceTerm, mask: number): number {
  const from = daysBetween(term.startOn, firstUnconsumed) > 0 ? firstUnconsumed : term.startOn;
  return countServiceDays(from, addDays(term.endOn, 1), mask);
}

/**
 * The counted days consumed by `today` (that day included when it is a service day of the term): the term's
 * total minus what remains from tomorrow. A term that has not started has consumed nothing.
 */
export function consumedServiceDays(
  today: IsoDate,
  term: ServiceTerm,
  totalDays: number,
  mask: number,
): number {
  return Math.max(0, totalDays - remainingServiceDays(addDays(today, 1), term, mask));
}

/**
 * The new last day of a term whose `remaining` counted days resume on `resumeOn` (DEC-593): after a freeze ends on
 * its return date, on an early reactivation, or after a system freeze is lifted. The resume day counts when it
 * serves. No remaining day: the term ended the day before it resumed.
 */
export function resumedTermEnd(resumeOn: IsoDate, remaining: number, mask: number): IsoDate {
  if (!Number.isInteger(remaining) || remaining < 0) throw new RangeError('remaining');
  if (remaining === 0) return addDays(resumeOn, -1);
  return nthServiceDay(resumeOn, remaining, mask);
}

export type FreezeRequestIssue =
  | 'not_in_advance'
  | 'too_far_ahead'
  | 'start_not_service_day'
  | 'return_not_service_day'
  | 'return_not_after_start'
  | 'before_term'
  | 'after_term'
  | 'too_long';

/**
 * A customer freeze request (DEC-594; annex clause 4): asked in advance (the start is after today, never
 * retroactive), starting on a service day inside the term and returning on a service day after it; the counted days
 * frozen — the service days in [startsOn, returnsOn), Friday and Saturday never among them — are 1 … `maxDays`.
 */
export function freezeRequestCheck(input: {
  today: IsoDate;
  startsOn: IsoDate;
  returnsOn: IsoDate;
  term: ServiceTerm;
  mask: number;
  maxDays: number;
}): { ok: true; days: number } | { ok: false; issue: FreezeRequestIssue } {
  const { today, startsOn, returnsOn, term, mask, maxDays } = input;
  if (daysBetween(today, startsOn) < 1) return { ok: false, issue: 'not_in_advance' };
  if (daysBetween(today, startsOn) > SERVICE_DAY_RULES.freeze_max_lead_days)
    return { ok: false, issue: 'too_far_ahead' };
  if (!isServiceDay(startsOn, mask)) return { ok: false, issue: 'start_not_service_day' };
  if (daysBetween(startsOn, returnsOn) < 1) return { ok: false, issue: 'return_not_after_start' };
  if (!isServiceDay(returnsOn, mask)) return { ok: false, issue: 'return_not_service_day' };
  if (daysBetween(term.startOn, startsOn) < 0) return { ok: false, issue: 'before_term' };
  if (daysBetween(startsOn, term.endOn) < 0) return { ok: false, issue: 'after_term' };
  const days = countServiceDays(startsOn, returnsOn, mask);
  if (days < 1 || days > maxDays) return { ok: false, issue: 'too_long' };
  return { ok: true, days };
}

/**
 * The share of a paid term refunded for its `remaining` counted days out of `totalDays` (annex clause 5, DEC-600):
 * the price × remaining ÷ total in whole halalas rounded down, never more than paid. The VAT inside it is settled by
 * the credit note of the refund (V5).
 */
export function serviceDaysRefundHalalas(priceHalalas: number, remaining: number, totalDays: number): number {
  if (totalDays <= 0 || remaining <= 0) return 0;
  return Math.min(priceHalalas, Math.floor((priceHalalas * Math.min(remaining, totalDays)) / totalDays));
}
