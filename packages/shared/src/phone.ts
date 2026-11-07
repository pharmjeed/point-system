/**
 * Phone display helpers (canon §15): phones are stored E.164 (`+9665XXXXXXXX`) and displayed
 * masked as `05•••••123`. Pure, no dependencies.
 */

/** The masking character. */
export const MASK_CHAR = '•';

const SAUDI_PREFIX = '+966';

/**
 * Masks an E.164 phone for display. Saudi numbers use the national form (`+966512345678` →
 * `05•••••678`); other numbers keep `+` and the first two digits (`+447911123456` → `+44•••••••456`).
 * Anything that is not an E.164 number yields a fully masked placeholder.
 */
export function maskPhone(e164: string | null | undefined): string {
  if (!e164 || !/^\+[1-9]\d{6,14}$/.test(e164)) return MASK_CHAR.repeat(5);
  const shown = e164.startsWith(SAUDI_PREFIX) ? `0${e164.slice(SAUDI_PREFIX.length)}` : e164;
  const headLength = shown.startsWith('+') ? 3 : 2;
  const head = shown.slice(0, headLength);
  const tail = shown.slice(-3);
  const hidden = Math.max(shown.length - headLength - 3, 1);
  return `${head}${MASK_CHAR.repeat(hidden)}${tail}`;
}

/** A Saudi mobile in E.164: `+9665` then 8 digits (03 §3.8, 07 §1.8). */
export const SAUDI_MOBILE_E164_RE = /^\+9665\d{8}$/;

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EXTENDED_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';

/** Arabic-Indic (`٠-٩`) and Extended Arabic-Indic (`۰-۹`) digits → Latin `0-9` (DEC-17). */
function latinDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(EXTENDED_ARABIC_INDIC.indexOf(d)));
}

/**
 * Normalises a Saudi mobile number to E.164 (`+9665XXXXXXXX`), or returns null (V2-011, DEC-481). Accepts
 * `05XXXXXXXX`, `5XXXXXXXX`, `+9665…`, `9665…` and `009665…`, with spaces, dashes, brackets, bidi marks and any
 * digit script: the rule of the staff `PhoneInput` (03 §3.8). The server normalises again and stays the judge
 * (`PHONE_INVALID`). Pure and dependency-free so the customer app (React Native) can use it.
 */
export function normalizeSaudiMobile(input: string | null | undefined): string | null {
  if (!input) return null;
  const compact = latinDigits(input).replace(/[\s\-().‎‏؜]/g, '');
  let local: string;
  if (compact.startsWith('+966')) local = compact.slice(4);
  else if (compact.startsWith('00966')) local = compact.slice(5);
  else if (compact.startsWith('966') && compact.length === 12) local = compact.slice(3);
  else if (compact.startsWith('0')) local = compact.slice(1);
  else local = compact;
  const e164 = `${SAUDI_PREFIX}${local}`;
  return SAUDI_MOBILE_E164_RE.test(e164) ? e164 : null;
}
