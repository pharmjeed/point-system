import { toLatinDigits } from './digits';
import { DISPLAY_TIME_ZONE } from './format';

/**
 * Local dates and times for forms (07 §1.8): the API exchanges UTC instants (`…Z`) and `event_date` as the
 * Asia/Riyadh calendar date. Saudi Arabia keeps UTC+03:00 all year (no daylight saving), so a local
 * "YYYY-MM-DD" + "HH:MM" maps to one instant with a fixed offset.
 */
const RIYADH_OFFSET = '+03:00';

const partsFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** `{ date: 'YYYY-MM-DD', time: 'HH:MM' }` of an instant, in Riyadh. */
export function riyadhParts(value: string | number | Date): { date: string; time: string } {
  const parts = Object.fromEntries(
    partsFormat.formatToParts(value instanceof Date ? value : new Date(value)).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** Today's calendar date in Riyadh, `YYYY-MM-DD`. */
export function todayRiyadh(now: number = Date.now()): string {
  return riyadhParts(now).date;
}

/** The UTC ISO instant of a Riyadh-local date and time; null when either is missing or malformed. */
export function riyadhToIso(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const ms = Date.parse(`${date}T${time}:00${RIYADH_OFFSET}`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Adds whole days to a `YYYY-MM-DD` date (for an end time after midnight). */
export function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T12:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Start and end instants of a local time range on a date; an end at or before the start is the next day
 * (an evening event that ends after midnight).
 */
export function riyadhRange(
  date: string,
  start: string,
  end: string,
): { starts_at: string | null; ends_at: string | null } {
  const starts_at = start ? riyadhToIso(date, start) : null;
  let ends_at = end ? riyadhToIso(date, end) : null;
  if (starts_at && ends_at && Date.parse(ends_at) <= Date.parse(starts_at)) {
    ends_at = riyadhToIso(addDays(date, 1), end);
  }
  return { starts_at, ends_at };
}

/** «25» / «25.5» / «25.50» riyals → 2550 halalas (07 §1.8: integer halalas); null when not a valid amount. */
export function halalasFromSar(input: string): number | null {
  const text = toLatinDigits(input).trim().replace('٫', '.').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** 2550 → "25.50" for an input field (Western digits, no currency). */
export function sarFromHalalas(halalas: number): string {
  return (halalas / 100).toFixed(2);
}
