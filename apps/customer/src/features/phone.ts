/**
 * C-02 phone field logic (03 §3.8 `PhoneInput`): a fixed `+966` prefix, the customer types the national part
 * (`5XXXXXXXX` or `05XXXXXXXX`, any digit script, pasted `+9665…` too); normalised with the shared rule.
 */
import { normalizeSaudiMobile } from '@point/shared/customer';
import { toLatinDigits } from '../i18n/format';

/** What the field keeps while typing: Latin digits only, at most 10 (`05` + 8) or a pasted international form. */
export function sanitizePhoneInput(raw: string): string {
  let digits = toLatinDigits(raw).replace(/\D/g, '');
  if (digits.startsWith('00966')) digits = digits.slice(5);
  else if (digits.startsWith('966') && digits.length >= 12) digits = digits.slice(3);
  return digits.slice(0, digits.startsWith('0') ? 10 : 9);
}

export type PhoneValidation = { ok: true; e164: string } | { ok: false };

export function validatePhone(raw: string): PhoneValidation {
  const e164 = normalizeSaudiMobile(raw);
  return e164 ? { ok: true, e164 } : { ok: false };
}
