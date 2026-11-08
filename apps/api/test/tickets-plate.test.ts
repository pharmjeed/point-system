import {
  draftFieldsPresent,
  latinDigits,
  missingIntakeFields,
  normalizePlate,
  normalizeTag,
  plateView,
} from '@point/server';
import { describe, expect, it } from 'vitest';

const plateError = (input: Parameters<typeof normalizePlate>[0]) => {
  try {
    normalizePlate(input);
  } catch (e) {
    return { code: (e as { code: string }).code, details: (e as { details: unknown }).details };
  }
  throw new Error('expected PLATE_INVALID');
};

describe('PNT-026 — Saudi plate normalization (07 §1.8)', () => {
  it('derives the Latin letters from the Arabic plate letters', () => {
    expect(normalizePlate({ digits: '1234', letters_ar: 'ب ح د' })).toEqual({
      country: 'SA',
      digits: '1234',
      letters_ar: 'ب ح د',
      letters_en: 'B J D',
      raw: null,
    });
    expect(normalizePlate({ digits: '5678', letters_ar: 'رسص' }).letters_en).toBe('R S X');
    expect(normalizePlate({ digits: '910', letters_ar: 'ط ع ق' }).letters_en).toBe('T E G');
    expect(normalizePlate({ digits: '1', letters_ar: 'ك ل م' }).letters_en).toBe('K L Z');
    expect(normalizePlate({ digits: '2', letters_ar: 'ن ه و' }).letters_en).toBe('N H U');
  });

  it('accepts keyboard variants, Arabic-Indic digits, spaces, tatweel and diacritics', () => {
    expect(normalizePlate({ digits: '١٢٣', letters_ar: 'أ إ آ' })).toMatchObject({
      digits: '123',
      letters_ar: 'ا ا ا',
      letters_en: 'A A A',
    });
    expect(normalizePlate({ digits: '۴۵', letters_ar: 'ي ة ک' })).toMatchObject({
      digits: '45',
      letters_ar: 'ى ه ك',
    });
    expect(normalizePlate({ digits: ' 7 ', letters_ar: 'بـ حَ د' }).letters_ar).toBe('ب ح د');
    expect(normalizePlate({ digits: '7', letters_ar: 'ب ح د', letters_en: 'b j d' }).letters_en).toBe(
      'B J D',
    );
  });

  it('PLATE_INVALID with field and reason', () => {
    expect(plateError({ digits: '12345', letters_ar: 'ب ح د' })).toEqual({
      code: 'PLATE_INVALID',
      details: { field: 'plate.digits', reason: 'digits' },
    });
    expect(plateError({ letters_ar: 'ب ح د' }).details).toEqual({ field: 'plate.digits', reason: 'digits' });
    expect(plateError({ digits: '1', letters_ar: 'ب ح' }).details).toEqual({
      field: 'plate.letters_ar',
      reason: 'letters',
    });
    expect(plateError({ digits: '1', letters_ar: 'ب ح خ' }).details).toEqual({
      field: 'plate.letters_ar',
      reason: 'letters',
    });
    expect(plateError({ digits: '1', letters_ar: 'ب ح د', letters_en: 'B H D' }).details).toEqual({
      field: 'plate.letters_en',
      reason: 'mapping',
    });
    expect(plateError({ country: 'KW' }).details).toEqual({ field: 'plate.raw', reason: 'raw' });
  });

  it('other countries keep the raw text; the display is computed', () => {
    expect(normalizePlate({ country: 'kw', raw: ' 12 / ٣٤٥ ' })).toEqual({
      country: 'KW',
      digits: null,
      letters_ar: null,
      letters_en: null,
      raw: '12 / 345',
    });
    const v = (p: ReturnType<typeof normalizePlate>) =>
      plateView({
        plate_country: p.country,
        plate_digits: p.digits,
        plate_letters_ar: p.letters_ar,
        plate_letters_en: p.letters_en,
        plate_raw: p.raw,
      });
    expect(v(normalizePlate({ digits: '1234', letters_ar: 'ب ح د' })).display).toBe('1234 ب ح د');
    expect(v(normalizePlate({ country: 'KW', raw: 'K 1' })).display).toBe('K 1');
    expect(latinDigits('٠١٢٣٤٥٦٧٨٩ ۰۱۲')).toBe('0123456789 012');
    expect(normalizeTag('  k-٧٣ ')).toBe('K-73');
  });
});

describe('PNT-028/029 — intake rules', () => {
  const draft = {
    channel: 'whatsapp' as const,
    plate_country: 'SA',
    plate_digits: null,
    plate_letters_ar: null,
    plate_raw: null,
    vehicle_make: null,
    vehicle_model: null,
    vehicle_color: null,
    vehicle_type: null,
    key_tag: null,
    paper_serial: null,
    customer_id: null,
    notes: null,
    wa_link_status: 'none',
  };
  it('missing fields per channel; a QR link replaces the phone', () => {
    expect(missingIntakeFields(draft, { hasQrLink: false })).toEqual([
      'plate',
      'vehicle.make',
      'vehicle.color',
      'key_tag',
      'customer_phone',
    ]);
    expect(missingIntakeFields(draft, { hasQrLink: true })).not.toContain('customer_phone');
    expect(missingIntakeFields({ ...draft, channel: 'paper' }, { hasQrLink: false })).toContain(
      'paper_serial',
    );
    expect(
      missingIntakeFields(
        {
          ...draft,
          plate_digits: '1',
          plate_letters_ar: 'ب ح د',
          vehicle_make: 'x',
          vehicle_color: 'y',
          key_tag: 'K',
          customer_id: 'c',
        },
        { hasQrLink: false },
      ),
    ).toEqual([]);
  });
  it('a draft with any entered data cannot be discarded (DEC-20)', () => {
    expect(draftFieldsPresent(draft, { uploadedPhotos: 0, damageMarks: 0 })).toEqual([]);
    expect(
      draftFieldsPresent(
        { ...draft, vehicle_color: 'أبيض', key_tag: 'K' },
        { uploadedPhotos: 2, damageMarks: 1 },
      ),
    ).toEqual(['vehicle', 'key_tag', 'damage_marks', 'photos']);
  });
});
