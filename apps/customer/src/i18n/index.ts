/**
 * Language choice and text helpers (pure; the React side is ./I18nProvider.tsx).
 *
 * Arabic first (DEC-481): the app speaks Arabic unless the device's first preferred language is English. The
 * layout direction follows the device (expo-localization `supportsRTL`), so Arabic is right-to-left. A language
 * switch inside the app comes with C-19 (settings). Values that read left-to-right (phone, plate, code, amounts)
 * are wrapped in Unicode isolates inside sentences — the native equivalent of `<bdi>` (03 §2.9).
 */
import { ar } from './ar';
import { en } from './en';
import type { AppLocale, Dictionary } from './types';

export type { AppLocale, Dictionary } from './types';

export const dictionaries: Readonly<Record<AppLocale, Dictionary>> = { ar, en };

/**
 * `preferred`: BCP-47 language codes in the device's order (`expo-localization` `getLocales()`); `forced`: the
 * `CUSTOMER_FORCE_LOCALE` dev override. Anything but a leading English choice is Arabic.
 */
export function resolveLocale(preferred: readonly string[], forced?: string | null): AppLocale {
  if (forced === 'ar' || forced === 'en') return forced;
  const first = preferred[0]?.toLowerCase().split(/[-_]/)[0];
  return first === 'en' ? 'en' : 'ar';
}

const FSI = '⁨';
const PDI = '⁩';

/** Isolates a left-to-right value inside a sentence (the `<bdi>` of 03 §2.9). */
export function isolate(value: string): string {
  return `${FSI}${value}${PDI}`;
}

/** Fills `{name}` placeholders; unknown placeholders are left visible so a missing value is noticed. */
export function fmt(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : whole,
  );
}
