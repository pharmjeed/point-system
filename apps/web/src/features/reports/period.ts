/**
 * Report periods in Riyadh days (02 §1.2, PNT-088 «العرض بتوقيت Asia/Riyadh»): a `YYYY-MM-DD` picked in the
 * UI is the Riyadh calendar day; the API takes UTC instants (07 §1.8). Asia/Riyadh is UTC+03:00 all year.
 */
const RIYADH_OFFSET_MS = 3 * 3600_000;
const DAY_MS = 24 * 3600_000;

const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);

/** The Riyadh calendar date of an instant. */
export function riyadhDate(nowMs: number): string {
  return new Date(nowMs + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** [from 00:00 Riyadh, day after `to` 00:00 Riyadh) as UTC ISO; null when a date is missing or reversed. */
export function periodToUtc(from: string, to: string): { from: string; to: string } | null {
  if (!isDate(from) || !isDate(to) || from > to) return null;
  return {
    from: new Date(Date.parse(`${from}T00:00:00+03:00`)).toISOString(),
    to: new Date(Date.parse(`${addDays(to, 1)}T00:00:00+03:00`)).toISOString(),
  };
}

/** The default period: the last 7 Riyadh days including today. */
export function lastWeek(nowMs: number): { from: string; to: string } {
  const today = riyadhDate(nowMs);
  return { from: addDays(today, -6), to: today };
}
