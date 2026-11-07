/**
 * The 02 §8.4 intake pick lists. The make and the colour travel and are stored as these keys (02 §9.3 item 16,
 * DEC-350); «أخرى» sends the typed text instead. The staff UI translates them itself (apps/web/src/i18n/ar.ts);
 * the server translates them wherever it writes Arabic for people: the customer's W-01 `{{3}}` (12 §5, 14 §4)
 * and the CSV exports. Free text passes through unchanged.
 */
export const VEHICLE_COLOR_LABELS_AR = {
  white: 'أبيض',
  black: 'أسود',
  silver: 'فضي',
  gray: 'رمادي',
  red: 'أحمر',
  blue: 'أزرق',
  navy: 'كحلي',
  green: 'أخضر',
  beige: 'بيج',
  brown: 'بني',
  gold: 'ذهبي',
  yellow: 'أصفر',
  orange: 'برتقالي',
  other: 'أخرى',
} as const;

export const VEHICLE_MAKE_LABELS_AR = {
  toyota: 'تويوتا',
  hyundai: 'هيونداي',
  nissan: 'نيسان',
  kia: 'كيا',
  lexus: 'لكزس',
  ford: 'فورد',
  chevrolet: 'شيفروليه',
  gmc: 'جي إم سي',
  mercedes: 'مرسيدس',
  bmw: 'بي إم دبليو',
  honda: 'هوندا',
  mazda: 'مازدا',
  mitsubishi: 'ميتسوبيشي',
  land_rover: 'لاند روفر',
  audi: 'أودي',
  geely: 'جيلي',
  changan: 'شانجان',
  mg: 'إم جي',
  other: 'أخرى',
} as const;

export type VehicleColorKey = keyof typeof VEHICLE_COLOR_LABELS_AR;
export type VehicleMakeKey = keyof typeof VEHICLE_MAKE_LABELS_AR;

function label(map: Readonly<Record<string, string>>, value: string | null | undefined): string | null {
  if (value == null) return null;
  return Object.hasOwn(map, value) ? (map[value] ?? value) : value;
}

/** `toyota` → «تويوتا»; a typed make («بروتون») or an unknown value is returned as is; null stays null. */
export const vehicleMakeLabelAr = (value: string | null | undefined): string | null =>
  label(VEHICLE_MAKE_LABELS_AR, value);

/** `white` → «أبيض»; a typed colour or an unknown value is returned as is; null stays null. */
export const vehicleColorLabelAr = (value: string | null | undefined): string | null =>
  label(VEHICLE_COLOR_LABELS_AR, value);

// ---------------------------------------------------------------- Saudi plate (07 §1.8, canon §15, 03 §3.7)

/**
 * The 17 Saudi plate letters and their Latin equivalent (03 §3.7). The same table as the server's intake
 * normalisation (`packages/server/src/modules/tickets-custody/domain/plate.ts`), here without the server's
 * error type so the customer app can validate before it sends (V2-011, DEC-481). The server stays the judge.
 */
export const SAUDI_PLATE_LETTERS: Readonly<Record<string, string>> = Object.freeze({
  ا: 'A',
  ب: 'B',
  ح: 'J',
  د: 'D',
  ر: 'R',
  س: 'S',
  ص: 'X',
  ط: 'T',
  ع: 'E',
  ق: 'G',
  ك: 'K',
  ل: 'L',
  م: 'Z',
  ن: 'N',
  ه: 'H',
  و: 'U',
  ى: 'V',
});

/** Spelling variants a keyboard may produce for the same plate letter. */
const PLATE_LETTER_VARIANTS: Readonly<Record<string, string>> = Object.freeze({
  أ: 'ا',
  إ: 'ا',
  آ: 'ا',
  ٱ: 'ا',
  ي: 'ى',
  ئ: 'ى',
  ی: 'ى',
  ة: 'ه',
  ھ: 'ه',
  ۀ: 'ه',
  ک: 'ك',
  ؤ: 'و',
});

/** Arabic-Indic and Extended Arabic-Indic digits → Latin (DEC-17). */
function plateLatinDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** Whitespace, tatweel (U+0640) and Arabic diacritics (U+064B–U+065F, U+0670) carry no plate letter. */
function isPlateIgnorable(c: string): boolean {
  const cp = c.codePointAt(0) ?? 0;
  return /\s/.test(c) || cp === 0x0640 || (cp >= 0x064b && cp <= 0x065f) || cp === 0x0670;
}

export interface SaudiPlate {
  country: 'SA';
  /** 1–4 Latin digits. */
  digits: string;
  /** Three plate letters, space-separated («ا ب ح»). */
  letters_ar: string;
  /** The Latin equivalents, space-separated («A B J»). */
  letters_en: string;
}

/** `PLATE_INVALID` reasons of 08 (`details.reason`) with the field they belong to. */
export type SaudiPlateIssue =
  { field: 'plate.digits'; reason: 'digits' } | { field: 'plate.letters_ar'; reason: 'letters' };

export type SaudiPlateResult = { ok: true; plate: SaudiPlate } | ({ ok: false } & SaudiPlateIssue);

/**
 * Normalises a Saudi plate typed by a person: digits in any script (spaces dropped, 1–4 digits) and exactly three
 * of the 17 plate letters (keyboard variants, spaces, tatweel and diacritics tolerated).
 */
export function normalizeSaudiPlate(input: {
  digits?: string | null;
  letters_ar?: string | null;
}): SaudiPlateResult {
  const digits = plateLatinDigits(input.digits ?? '').replace(/\s+/g, '');
  if (!/^[0-9]{1,4}$/.test(digits)) return { ok: false, field: 'plate.digits', reason: 'digits' };
  const letters = [...(input.letters_ar ?? '')]
    .filter((c) => !isPlateIgnorable(c))
    .map((c) => PLATE_LETTER_VARIANTS[c] ?? c);
  if (letters.length !== 3 || letters.some((c) => !Object.hasOwn(SAUDI_PLATE_LETTERS, c)))
    return { ok: false, field: 'plate.letters_ar', reason: 'letters' };
  return {
    ok: true,
    plate: {
      country: 'SA',
      digits,
      letters_ar: letters.join(' '),
      letters_en: letters.map((c) => SAUDI_PLATE_LETTERS[c]).join(' '),
    },
  };
}

/** «1234 ا ب ح»: digits then letters, as `plateView().display` on the server (07 Plate). */
export function saudiPlateDisplay(p: { digits: string | null; letters_ar: string | null }): string {
  return [p.digits, p.letters_ar].filter(Boolean).join(' ');
}
