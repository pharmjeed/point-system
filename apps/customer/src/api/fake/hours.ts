/**
 * `open_now` from `opening_hours` (DEC-482): intervals in the venue's local time, a `close` before `open` runs
 * past midnight. The fake backend uses it for Asia/Riyadh (fixed UTC+3); the server computes the same field.
 */
import { WEEKDAY_KEYS, type OpeningHours } from '@point/shared/customer';

const RIYADH_OFFSET_MIN = 180;

const minutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export function isOpenAt(hours: OpeningHours, instantMs: number, offsetMinutes = RIYADH_OFFSET_MIN): boolean {
  if (hours.always_open) return true;
  const local = new Date(instantMs + offsetMinutes * 60_000);
  const dayIndex = local.getUTCDay();
  const now = local.getUTCHours() * 60 + local.getUTCMinutes();
  const today = hours.days[WEEKDAY_KEYS[dayIndex] as (typeof WEEKDAY_KEYS)[number]] ?? [];
  const yesterday = hours.days[WEEKDAY_KEYS[(dayIndex + 6) % 7] as (typeof WEEKDAY_KEYS)[number]] ?? [];
  for (const { open, close } of today) {
    const o = minutes(open);
    const c = minutes(close);
    if (c > o ? now >= o && now < c : now >= o) return true;
  }
  for (const { open, close } of yesterday) {
    const o = minutes(open);
    const c = minutes(close);
    if (c <= o && now < c) return true;
  }
  return false;
}

/** Great-circle distance in metres. */
export function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
}
