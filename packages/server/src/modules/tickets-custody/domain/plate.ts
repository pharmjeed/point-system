import { AppError } from '../../../core/errors/app-error.js';

/**
 * Saudi plate normalization (07 §1.8, canon §15): up to 4 Latin digits + three Arabic plate letters stored
 * space-separated, with the common Latin equivalent derived from them. Other countries keep a free `raw`.
 */
export const PLATE_LETTER_MAP: Readonly<Record<string, string>> = Object.freeze({
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
const LETTER_VARIANTS: Readonly<Record<string, string>> = Object.freeze({
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

export interface PlateInput {
  country?: string;
  digits?: string;
  letters_ar?: string;
  letters_en?: string;
  raw?: string;
}

export interface NormalizedPlate {
  country: string;
  digits: string | null;
  letters_ar: string | null;
  letters_en: string | null;
  raw: string | null;
}

/** Arabic-Indic and Extended Arabic-Indic digits → Latin (DEC-17). */
export function latinDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** Whitespace, tatweel (U+0640) and Arabic diacritics (U+064B–U+065F, U+0670) carry no plate letter. */
function isIgnorable(c: string): boolean {
  const cp = c.codePointAt(0) ?? 0;
  return /\s/.test(c) || cp === 0x0640 || (cp >= 0x064b && cp <= 0x065f) || cp === 0x0670;
}

function invalid(field: string, reason: 'digits' | 'letters' | 'mapping' | 'raw'): AppError {
  return new AppError('PLATE_INVALID', { field, reason });
}

/** Throws PLATE_INVALID with `field` and `reason` (08: digits / letters / mapping; `raw` for other countries). */
export function normalizePlate(input: PlateInput): NormalizedPlate {
  const country = (input.country ?? 'SA').trim().toUpperCase() || 'SA';
  if (country !== 'SA') {
    const raw = (input.raw ?? '').trim().replace(/\s+/g, ' ');
    if (!raw || raw.length > 20) throw invalid('plate.raw', 'raw');
    return { country, digits: null, letters_ar: null, letters_en: null, raw: latinDigits(raw).toUpperCase() };
  }
  const digits = latinDigits(input.digits ?? '').replace(/\s+/g, '');
  if (!/^[0-9]{1,4}$/.test(digits)) throw invalid('plate.digits', 'digits');

  const letters = [...(input.letters_ar ?? '')]
    .filter((c) => !isIgnorable(c))
    .map((c) => LETTER_VARIANTS[c] ?? c);
  if (letters.length !== 3 || letters.some((c) => !(c in PLATE_LETTER_MAP)))
    throw invalid('plate.letters_ar', 'letters');
  const derived = letters.map((c) => PLATE_LETTER_MAP[c]!);
  if (input.letters_en !== undefined && input.letters_en !== null) {
    const given = input.letters_en.replace(/\s+/g, '').toUpperCase();
    if (given !== derived.join('')) throw invalid('plate.letters_en', 'mapping');
  }
  return {
    country,
    digits,
    letters_ar: letters.join(' '),
    letters_en: derived.join(' '),
    raw: null,
  };
}

/** Plate schema of 07 (`display` computed). */
export function plateView(t: {
  plate_country: string;
  plate_digits: string | null;
  plate_letters_ar: string | null;
  plate_letters_en: string | null;
  plate_raw: string | null;
}) {
  const display =
    t.plate_country === 'SA'
      ? [t.plate_digits, t.plate_letters_ar].filter(Boolean).join(' ')
      : (t.plate_raw ?? '');
  return {
    country: t.plate_country,
    digits: t.plate_digits,
    letters_ar: t.plate_letters_ar,
    letters_en: t.plate_letters_en,
    raw: t.plate_raw,
    display,
  };
}

/** Paper serials and key tags: trimmed, Latin digits, upper case, inner spaces collapsed. */
export function normalizeTag(s: string): string {
  return latinDigits(s.trim()).replace(/\s+/g, ' ').toUpperCase();
}
