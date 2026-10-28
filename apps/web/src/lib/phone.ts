import { toLatinDigits } from './digits';

/** Saudi mobile: 5 followed by 8 digits (03 §3.8, 07 §1.8). */
const SAUDI_MOBILE_LOCAL = /^5\d{8}$/;

/**
 * Normalises a Saudi mobile number typed by staff to E.164 (`+9665XXXXXXXX`), or returns null.
 * Accepts `05XXXXXXXX`, `5XXXXXXXX`, `+9665…`, `9665…`, `009665…`, with spaces, dashes or any digit script.
 * The server normalises again and stays the judge (`PHONE_INVALID`).
 */
export function normalizeSaudiMobile(input: string): string | null {
  const compact = toLatinDigits(input).replace(/[\s\-().‎‏]/g, '');
  let local: string;
  if (compact.startsWith('+966')) local = compact.slice(4);
  else if (compact.startsWith('00966')) local = compact.slice(5);
  else if (compact.startsWith('966') && compact.length === 12) local = compact.slice(3);
  else if (compact.startsWith('0')) local = compact.slice(1);
  else local = compact;
  return SAUDI_MOBILE_LOCAL.test(local) ? `+966${local}` : null;
}

export const MASK_CHAR = '•';

/**
 * Masks a phone for display: `05•••••123` (03 §2.9, 02 §1.2). A value that is already masked by the
 * server (`phone_masked`) is returned unchanged. Non-Saudi numbers keep the first 2 and last 3 digits.
 */
export function maskPhone(phone: string): string {
  if (phone.includes(MASK_CHAR)) return phone;
  const digits = toLatinDigits(phone).replace(/\D/g, '');
  let national = digits;
  if (digits.startsWith('966') && digits.length === 12) national = `0${digits.slice(3)}`;
  if (national.length < 6) return national;
  return `${national.slice(0, 2)}${MASK_CHAR.repeat(5)}${national.slice(-3)}`;
}
