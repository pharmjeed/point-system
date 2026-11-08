import { components } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';

/**
 * Display formatting (02 §1.2, 03 §2.9): Western digits (DEC-17), Gregorian calendar, Riyadh time.
 * Plain `ar-SA` would give the Hijri calendar and Arabic-Indic digits, hence the explicit extensions.
 * Times are stored and exchanged in UTC (`…Z`); only the display uses Asia/Riyadh.
 */
export const DISPLAY_TIME_ZONE = 'Asia/Riyadh';
export const NUMBER_LOCALE = 'ar-SA-u-nu-latn';
export const DATE_LOCALE = 'ar-SA-u-ca-gregory-nu-latn';

type DateInput = string | number | Date;

const toDate = (value: DateInput): Date => (value instanceof Date ? value : new Date(value));

const numberFormat = new Intl.NumberFormat(NUMBER_LOCALE);
const amountFormat = new Intl.NumberFormat(NUMBER_LOCALE, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const timeFormat = new Intl.DateTimeFormat(DATE_LOCALE, {
  timeZone: DISPLAY_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
});
const dateFormat = new Intl.DateTimeFormat(DATE_LOCALE, {
  timeZone: DISPLAY_TIME_ZONE,
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
});
const dateTimeFormat = new Intl.DateTimeFormat(DATE_LOCALE, {
  timeZone: DISPLAY_TIME_ZONE,
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** 1234567 → "1,234,567" */
export function formatNumber(value: number): string {
  return numberFormat.format(value);
}

/** "7:42 م" in Riyadh time. */
export function formatTime(value: DateInput): string {
  return timeFormat.format(toDate(value));
}

/** "29/10/2026" (Gregorian, Riyadh). */
export function formatDate(value: DateInput): string {
  return dateFormat.format(toDate(value));
}

export function formatDateTime(value: DateInput): string {
  return dateTimeFormat.format(toDate(value));
}

/** Countdown / waiting counter "m:ss" (02 §1.2: "2:10"); "h:mm:ss" from one hour. Negative → "0:00". */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

/** Elapsed time in whole minutes: "منذ 3 د" (02 §1.2). */
export function formatSinceMinutes(elapsedMs: number): string {
  return fmt(components.time.sinceMinutes, { n: Math.max(0, Math.floor(elapsedMs / 60000)) });
}

/** Amounts are integer halalas (07 §1.8): 2500 → "25.00 ر.س" (03 §2.9). */
export function formatHalalas(halalas: number): string {
  return `${amountFormat.format(halalas / 100)} ${components.money.currency}`;
}

/** Removes the bidi marks Intl inserts (U+200E/U+200F/U+061C) — for comparisons, never for display. */
export function stripBidiMarks(text: string): string {
  return text.replace(/[‎‏؜]/g, '');
}
