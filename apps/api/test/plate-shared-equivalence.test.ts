import { normalizePlate } from '@point/server';
import { normalizeSaudiPlate } from '@point/shared/customer';
import { describe, expect, it } from 'vitest';

/**
 * V2-010 (DEC-499): the staff intake's plate rule now delegates its Saudi path to the shared `normalizeSaudiPlate`
 * (the customer app and `customer_vehicles` use it too). This sweep proves the V1 behaviour unchanged: the V1
 * implementation is kept below verbatim as the reference, and both are run over every combination of a corpus of
 * digit and letter inputs (Latin/Arabic-Indic digits, keyboard variants, tatweel, diacritics, spaces, invalid input).
 */

// ---------------------------------------------------------------- V1 reference (packages/server … plate.ts @ 332a7be)
const V1_LETTERS: Readonly<Record<string, string>> = Object.freeze({
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
const V1_VARIANTS: Readonly<Record<string, string>> = Object.freeze({
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
const v1Digits = (s: string) =>
  s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
const v1Ignorable = (c: string) => {
  const cp = c.codePointAt(0) ?? 0;
  return /\s/.test(c) || cp === 0x0640 || (cp >= 0x064b && cp <= 0x065f) || cp === 0x0670;
};
function v1(input: {
  country?: string;
  digits?: string;
  letters_ar?: string;
  letters_en?: string;
  raw?: string;
}) {
  const country = (input.country ?? 'SA').trim().toUpperCase() || 'SA';
  if (country !== 'SA') {
    const raw = (input.raw ?? '').trim().replace(/\s+/g, ' ');
    if (!raw || raw.length > 20) return { error: { field: 'plate.raw', reason: 'raw' } };
    return { country, digits: null, letters_ar: null, letters_en: null, raw: v1Digits(raw).toUpperCase() };
  }
  const digits = v1Digits(input.digits ?? '').replace(/\s+/g, '');
  if (!/^[0-9]{1,4}$/.test(digits)) return { error: { field: 'plate.digits', reason: 'digits' } };
  const letters = [...(input.letters_ar ?? '')]
    .filter((c) => !v1Ignorable(c))
    .map((c) => V1_VARIANTS[c] ?? c);
  if (letters.length !== 3 || letters.some((c) => !(c in V1_LETTERS)))
    return { error: { field: 'plate.letters_ar', reason: 'letters' } };
  const derived = letters.map((c) => V1_LETTERS[c]!);
  if (input.letters_en !== undefined && input.letters_en !== null) {
    const given = input.letters_en.replace(/\s+/g, '').toUpperCase();
    if (given !== derived.join('')) return { error: { field: 'plate.letters_en', reason: 'mapping' } };
  }
  return { country, digits, letters_ar: letters.join(' '), letters_en: derived.join(' '), raw: null };
}

const now = (input: Parameters<typeof normalizePlate>[0]) => {
  try {
    return normalizePlate(input);
  } catch (e) {
    return { error: (e as { details: unknown }).details };
  }
};

const DIGITS = ['', ' ', '1', '12', '1234', '12345', '٤٨٢١', '۴۵', ' 7 ', '1 2', 'a1', '0000', '١٢٣٤٥', '-1'];
const LETTERS = [
  '',
  'ب ح د',
  'بحد',
  'أ إ آ',
  'ي ة ک',
  'بـ حَ د',
  'ب ح',
  'ب ح د ر',
  'abc',
  'ب ح x',
  'ٱ ؤ ئ',
  'ر س ص',
  'ط ع ق',
  'ك ل م',
  'ن ه و',
  'ى ھ ۀ',
  '  ب\tح\nد  ',
  'ج ح د',
];
const LATIN = [undefined, 'B J D', 'bjd', 'A A A', 'X Y Z', ''];

describe('PNT-026 plate rule ↔ the shared normalizeSaudiPlate (V2-010, DEC-499)', () => {
  it('normalizePlate equals the V1 implementation on every combination of the corpus', () => {
    let n = 0;
    for (const digits of DIGITS)
      for (const letters_ar of LETTERS)
        for (const letters_en of LATIN) {
          const input = { digits, letters_ar, ...(letters_en === undefined ? {} : { letters_en }) };
          expect(now(input), JSON.stringify(input)).toEqual(v1(input));
          n++;
        }
    for (const raw of ['', 'abc 123', ' x  y ', '١٢ ab', 'x'.repeat(21)])
      expect(now({ country: 'ae', raw })).toEqual(v1({ country: 'ae', raw }));
    expect(n).toBe(DIGITS.length * LETTERS.length * LATIN.length);
  });

  it('a customer vehicle and a ticket normalise one plate to the same row values', () => {
    for (const digits of DIGITS)
      for (const letters_ar of LETTERS) {
        const shared = normalizeSaudiPlate({ digits, letters_ar });
        const staff = now({ digits, letters_ar });
        if (shared.ok) expect(staff).toEqual({ ...shared.plate, raw: null });
        else expect(staff).toEqual({ error: { field: shared.field, reason: shared.reason } });
      }
  });
});
