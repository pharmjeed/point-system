/**
 * C-05 logic: the Saudi plate (up to 4 digits + 3 of the 17 plate letters, 03 §3.7 `PlateInput`/`LetterPad`)
 * normalised with the shared rule before sending, and the make/colour pick lists of 02 §8.4 with «أخرى» as free
 * text (DEC-350). The server normalises again (`PLATE_INVALID` with `field`/`reason`).
 */
import {
  CUSTOMER_VEHICLES_MAX,
  SAUDI_PLATE_LETTERS,
  normalizeSaudiPlate,
  type CustomerVehicleCreateBody,
  type CustomerVehicleType,
} from '@point/shared/customer';
import { ApiError } from '../api/errors';
import { toLatinDigits } from '../i18n/format';

/** The 17 letters in the order of 03 §3.7, with their Latin equivalent (shown together on the pad). */
export const PLATE_LETTER_PAD: ReadonlyArray<{ ar: string; en: string }> = Object.entries(
  SAUDI_PLATE_LETTERS,
).map(([ar, en]) => ({ ar, en }));

export interface VehicleForm {
  digits: string;
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

export function addLetter(form: VehicleForm, letter: string): VehicleForm {
  if (form.letters.length >= 3 || !Object.hasOwn(SAUDI_PLATE_LETTERS, letter)) return form;
  return { ...form, letters: [...form.letters, letter] };
}

export const removeLastLetter = (form: VehicleForm): VehicleForm => ({
  ...form,
  letters: form.letters.slice(0, -1),
});

export interface VehicleErrors {
  digits?: true;
  letters?: true;
}

export function validateVehicle(form: VehicleForm): VehicleErrors {
  const r = normalizeSaudiPlate({ digits: form.digits, letters_ar: form.letters.join('') });
  if (r.ok) return {};
  return r.field === 'plate.digits' ? { digits: true } : { letters: true };
}

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
