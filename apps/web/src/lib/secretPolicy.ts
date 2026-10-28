import { onlyDigits } from './digits';

/**
 * Client-side pre-checks for a new secret (09 §9.1). The server is the judge and also rejects the last
 * 6 digits of the phone and the employee code; these checks only spare an obviously weak round trip.
 */
export const PIN_LENGTH = 6;
export const STAFF_PASSWORD_MIN = 12;

export function isSixDigitPin(value: string): boolean {
  return /^\d{6}$/.test(value);
}

/** All-identical digits (111111) or an ascending/descending run (123456, 987654). */
export function isWeakPin(pin: string): boolean {
  const digits = onlyDigits(pin);
  if (digits.length !== PIN_LENGTH) return false;
  if (/^(\d)\1+$/.test(digits)) return true;
  let up = true;
  let down = true;
  for (let i = 1; i < digits.length; i += 1) {
    const step = Number(digits[i]) - Number(digits[i - 1]);
    if (step !== 1) up = false;
    if (step !== -1) down = false;
  }
  return up || down;
}

export function isLongEnoughPassword(value: string): boolean {
  return [...value].length >= STAFF_PASSWORD_MIN;
}
