/**
 * Number, money, distance and time formatting with Western digits and the Asia/Riyadh clock (DEC-17, 03 §2.9).
 * Written by hand rather than with `Intl` because Hermes' `Intl` support for numbering-system extensions differs
 * between iOS and Android; Riyadh has a fixed UTC+3 offset (no daylight saving), so the arithmetic is exact.
 */
import type { AppLocale, Dictionary } from './types';

const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Any digit script → Latin `0-9`. */
export function toLatinDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** `2500` halalas → `25.00 ر.س` / `25.00 SAR` (03 §2.9: halalas ÷ 100, two decimals). */
export function formatMoney(halalas: number, dict: Dictionary): string {
  const sign = halalas < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(halalas));
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = String(abs % 100).padStart(2, '0');
  return `${sign}${whole}.${cents} ${dict.common.currency}`;
}

/** `850` → `850 م`; `2400` → `2.4 كم`. */
export function formatDistance(metres: number, dict: Dictionary): string {
  if (metres < 1000) return `${Math.round(metres)} ${dict.common.m}`;
  return `${(metres / 1000).toFixed(1)} ${dict.common.km}`;
}

export interface RiyadhParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** UTC instant → wall-clock parts in Asia/Riyadh. */
export function riyadhParts(iso: string | Date): RiyadhParts {
  const t = (typeof iso === 'string' ? Date.parse(iso) : iso.getTime()) + RIYADH_OFFSET_MS;
  const d = new Date(t);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `14:05` (24-hour, Riyadh). */
export function formatTime(iso: string | Date): string {
  const p = riyadhParts(iso);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** `2026-11-07` (Riyadh date, ISO order in both languages). */
export function formatDate(iso: string | Date): string {
  const p = riyadhParts(iso);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Whole seconds left until `target` (never negative). */
export function secondsUntil(target: string | number, now: number): number {
  const t = typeof target === 'string' ? Date.parse(target) : target;
  return Math.max(0, Math.ceil((t - now) / 1000));
}

/** Whole minutes left until `target`, at least 1 while it is in the future. */
export function minutesUntil(target: string, now: number): number {
  const s = secondsUntil(target, now);
  return s === 0 ? 0 : Math.max(1, Math.ceil(s / 60));
}

/** Writing direction of a locale (the native layout direction follows the device, DEC-481). */
export const isRtl = (locale: AppLocale): boolean => locale === 'ar';
