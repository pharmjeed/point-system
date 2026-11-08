import { AppError } from '../../../core/errors/app-error.js';
import { COMMON_PASSWORDS } from './common-passwords.js';

export const PIN_LENGTH = 6; // security.pin_length is fixed at 6 in V1 (DEC-09)
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Driver PIN rules (09 §9.1): exactly 6 digits; not all identical; not an ascending/descending run; not the
 * last 6 digits of the driver's phone; not the digits of the employee code.
 */
export function pinProblem(
  pin: string,
  ctx: { phoneE164?: string | null; employeeCode?: string | null },
): string | null {
  if (!/^[0-9]{6}$/.test(pin)) return 'pin_format';
  if (/^(\d)\1{5}$/.test(pin)) return 'pin_repeated';
  const d = [...pin].map(Number);
  const asc = d.every((x, i) => i === 0 || x === (d[i - 1]! + 1) % 10);
  const desc = d.every((x, i) => i === 0 || x === (d[i - 1]! + 9) % 10);
  if (asc || desc) return 'pin_sequence';
  const phoneDigits = (ctx.phoneE164 ?? '').replace(/\D/g, '');
  if (phoneDigits.length >= 6 && phoneDigits.endsWith(pin)) return 'pin_phone';
  const codeDigits = (ctx.employeeCode ?? '').replace(/\D/g, '');
  if (codeDigits.length > 0 && (pin.includes(codeDigits) || codeDigits.includes(pin)))
    return 'pin_employee_code';
  return null;
}

/** Staff password rules (09 §9.1): ≥ 12 characters, not a common password, no composition rules. */
export function passwordProblem(pw: string): string | null {
  if ([...pw].length < PASSWORD_MIN_LENGTH) return 'password_too_short';
  if (pw.length > 128) return 'password_too_long';
  if (COMMON_PASSWORDS.has(pw.trim().toLowerCase())) return 'password_common';
  return null;
}

export function assertNewSecret(
  kind: 'pin' | 'password',
  secret: string,
  ctx: { phoneE164?: string | null; employeeCode?: string | null },
  field = 'new_secret',
): void {
  const problem = kind === 'pin' ? pinProblem(secret, ctx) : passwordProblem(secret);
  if (problem) throw new AppError('VALIDATION_FAILED', { fields: [{ field, issue: problem }] });
}
