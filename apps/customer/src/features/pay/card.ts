/**
 * C-10 card entry (V2-022), pure: the card number, expiry and CVC as typed, checked on the device before they are
 * tokenized — and never stored, logged or sent anywhere but Moyasar's tokenization endpoint (SAQ-A, V2-D08).
 * Western digits only (canon rule 10): Arabic-Indic digits typed on an Arabic keyboard are converted.
 */

export interface CardInput {
  number: string;
  /** `MM/YY` as typed */
  expiry: string;
  cvc: string;
  name: string;
}

export interface CardFields {
  number: string;
  month: number;
  year: number;
  cvc: string;
  name: string;
}

export type CardIssue = 'number' | 'expiry' | 'expired' | 'cvc' | 'name';

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

/** Western digits only, everything else dropped. */
export function digitsOnly(value: string): string {
  return value.replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) & 0x0f) % 10)).replace(/[^0-9]/g, '');
}

/** `4111 1111 1111 1111` while typing (up to 19 digits). */
export function formatCardNumber(value: string): string {
  return digitsOnly(value)
    .slice(0, 19)
    .replace(/(.{4})/g, '$1 ')
    .trim();
}

/** `12/30` while typing. */
export function formatExpiry(value: string): string {
  const d = digitsOnly(value).slice(0, 4);
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
}

export function luhnValid(number: string): boolean {
  const d = digitsOnly(number);
  if (d.length < 12 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** The card network shown next to the number (mada BINs are many: the gateway names the brand after tokenizing). */
export function cardBrandHint(number: string): 'visa' | 'master' | 'amex' | 'mada' | null {
  const d = digitsOnly(number);
  if (/^(4400|5297|5888|4464|4685|4406)/.test(d)) return 'mada';
  if (d.startsWith('4')) return 'visa';
  if (/^5[1-5]/.test(d) || /^2[2-7]/.test(d)) return 'master';
  if (/^3[47]/.test(d)) return 'amex';
  return null;
}

/** The fields, or the first problems found; `nowMs` decides whether the card has expired (end of its month). */
export function validateCard(
  input: CardInput,
  nowMs: number,
): { card: CardFields | null; issues: CardIssue[] } {
  const issues: CardIssue[] = [];
  const number = digitsOnly(input.number);
  if (!luhnValid(number)) issues.push('number');
  const exp = digitsOnly(input.expiry);
  const month = Number(exp.slice(0, 2));
  const year = 2000 + Number(exp.slice(2, 4));
  if (exp.length !== 4 || month < 1 || month > 12) issues.push('expiry');
  else {
    const endOfMonth = Date.UTC(year, month, 1); // the first moment after the card's last month
    if (endOfMonth <= nowMs) issues.push('expired');
  }
  const cvc = digitsOnly(input.cvc);
  const cvcLength = cardBrandHint(number) === 'amex' ? 4 : 3;
  if (cvc.length !== cvcLength) issues.push('cvc');
  const name = input.name.trim();
  if (name.length < 2) issues.push('name');
  return issues.length ? { card: null, issues } : { card: { number, month, year, cvc, name }, issues };
}

/** SAR from halalas with Western digits: 2000 → `20`, 2050 → `20.50`. */
export function sar(halalas: number): string {
  const whole = Math.trunc(halalas / 100);
  const rest = Math.abs(halalas % 100);
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, '0')}`;
}
