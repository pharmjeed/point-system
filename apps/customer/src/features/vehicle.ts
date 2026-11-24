/**
 * C-05 logic: the Saudi plate (up to 4 digits + 3 of the 17 plate letters) normalised with the shared rule before
 * sending, and the make/colour pick lists of 02 §8.4 with «أخرى» as free text (DEC-350). The server normalises
 * again (`PLATE_INVALID` with `field`/`reason`). Owner's option 3 (DEC-638): the letters are typed with the phone's
 * own keyboard, Arabic or Latin, instead of an on-screen pad; type and colour are picked from tiles and swatches.
 */
import {
  CUSTOMER_VEHICLES_MAX,
  SAUDI_PLATE_LETTERS,
  normalizeSaudiPlate,
  plateLettersFromTyping,
  type CustomerVehicleCreateBody,
  type CustomerVehicleType,
} from '@point/shared/customer';
import { ApiError } from '../api/errors';
import { toLatinDigits } from '../i18n/format';

export interface VehicleForm {
  digits: string;
  /** The letters field as typed (Arabic or Latin); `letters` holds the plate letters read from it. */
  lettersText: string;
  letters: readonly string[];
  /** A key of 02 §8.4 (`toyota`), `other` with `makeOther`, or null. */
  make: string | null;
  makeOther: string;
  model: string;
  color: string | null;
  colorOther: string;
  type: CustomerVehicleType | null;
}

export const emptyVehicleForm = (): VehicleForm => ({
  digits: '',
  lettersText: '',
  letters: [],
  make: null,
  makeOther: '',
  model: '',
  color: null,
  colorOther: '',
  type: null,
});

/** Digits field: Latin digits only, at most 4. */
export const sanitizePlateDigits = (raw: string): string => toLatinDigits(raw).replace(/\D/g, '').slice(0, 4);

/** Letters field: what was typed stays as typed; the plate letters are read from it (at most three). */
export const withLettersText = (form: VehicleForm, raw: string): VehicleForm => ({
  ...form,
  lettersText: raw.slice(0, 12),
  letters: plateLettersFromTyping(raw.slice(0, 12)).letters,
});

/** The Latin plate letters of the chosen Arabic ones («ا ب ح» → «ABJ»), for the plate's second row. */
export const latinLetters = (letters: readonly string[]): string =>
  letters.map((l) => SAUDI_PLATE_LETTERS[l] ?? '').join('');

export interface VehicleErrors {
  digits?: true;
  letters?: true;
}

export function validateVehicle(form: VehicleForm): VehicleErrors {
  const r = normalizeSaudiPlate({ digits: form.digits, letters_ar: form.letters.join('') });
  if (!r.ok) return r.field === 'plate.digits' ? { digits: true } : { letters: true };
  // three good letters were read, but something else typed is no plate letter («ABQ», «ا ب ج»)
  return plateLettersFromTyping(form.lettersText).invalid ? { letters: true } : {};
}

/**
 * The paint of each colour swatch of C-05 (DEC-638). These are pictures of car paints, content like a photo, not
 * interface colours, so they are not brand tokens; every swatch is drawn with its name under it. «other» has none
 * (the swatch shows a mixed ring and opens the free-text field).
 */
export const VEHICLE_COLOR_SWATCH: Readonly<Record<string, string>> = Object.freeze({
  white: '#FFFFFF',
  black: '#141414',
  silver: '#C3C7CE',
  gray: '#7B8088',
  red: '#C8102E',
  blue: '#1E4FD8',
  navy: '#0D2150',
  green: '#1F7A3A',
  beige: '#D8C6A2',
  brown: '#6B4226',
  gold: '#C9A227',
  yellow: '#F2C200',
  orange: '#F26B1D',
});

/** The colours shown before «المزيد» (the most common paints in the Saudi market first). */
export const VEHICLE_COLORS_FIRST: readonly string[] = [
  'white',
  'black',
  'silver',
  'gray',
  'red',
  'blue',
  'navy',
  'green',
  'beige',
];

const pick = (key: string | null, other: string): string | null => {
  if (key === null) return null;
  if (key !== 'other') return key;
  const typed = other.trim();
  return typed ? typed : null;
};

/** The request body (the plate exactly as typed; the server normalises it). */
export function vehicleBody(form: VehicleForm): CustomerVehicleCreateBody {
  const model = form.model.trim();
  return {
    plate: { country: 'SA', digits: form.digits, letters_ar: form.letters.join(' ') },
    vehicle_make: pick(form.make, form.makeOther),
    vehicle_model: model ? model : null,
    vehicle_color: pick(form.color, form.colorOther),
    vehicle_type: form.type,
  };
}

export type VehicleSubmitIssue =
  { kind: 'field'; errors: VehicleErrors } | { kind: 'duplicate' } | { kind: 'limit'; max: number };

/** Maps the server's refusal to a field or a message; other errors return null (generic handling). */
export function vehicleIssueFromError(e: unknown): VehicleSubmitIssue | null {
  if (!(e instanceof ApiError)) return null;
  if (e.code === 'PLATE_INVALID') {
    return {
      kind: 'field',
      errors: e.detailString('field') === 'plate.digits' ? { digits: true } : { letters: true },
    };
  }
  if (e.code === 'CUSTOMER_VEHICLE_DUPLICATE') return { kind: 'duplicate' };
  if (e.code === 'CUSTOMER_VEHICLE_LIMIT')
    return { kind: 'limit', max: e.detailNumber('max') ?? CUSTOMER_VEHICLES_MAX };
  return null;
}
