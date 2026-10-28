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
