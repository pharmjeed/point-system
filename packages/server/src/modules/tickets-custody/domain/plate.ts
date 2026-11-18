import { SAUDI_PLATE_LETTERS, normalizeSaudiPlate } from '@point/shared';
import { AppError } from '../../../core/errors/app-error.js';

/**
 * Saudi plate normalization (07 §1.8, canon §15): up to 4 Latin digits + three Arabic plate letters stored
 * space-separated, with the common Latin equivalent derived from them. Other countries keep a free `raw`.
 *
 * The Saudi rule itself is the shared `normalizeSaudiPlate` (packages/shared/src/vehicle.ts), which the customer app
 * and the customer API (`customer_vehicles`, V2-010) use too, so a plate typed by a driver and the same plate typed
 * by its owner normalise to the same row values (DEC-499); this module adds the server's error type, the optional
 * `letters_en` cross-check and the non-Saudi `raw` path. tickets-plate.test.ts proves the V1 behaviour unchanged.
 */
export const PLATE_LETTER_MAP: Readonly<Record<string, string>> = SAUDI_PLATE_LETTERS;

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
  const sa = normalizeSaudiPlate({ digits: input.digits, letters_ar: input.letters_ar });
  if (!sa.ok) throw invalid(sa.field, sa.reason);
  const { digits, letters_ar } = sa.plate;
  if (input.letters_en !== undefined && input.letters_en !== null) {
    const given = input.letters_en.replace(/\s+/g, '').toUpperCase();
    if (given !== sa.plate.letters_en.replace(/ /g, '')) throw invalid('plate.letters_en', 'mapping');
  }
  return { country, digits, letters_ar, letters_en: sa.plate.letters_en, raw: null };
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
