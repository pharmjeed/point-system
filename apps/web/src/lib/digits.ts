/**
 * Western digits everywhere (DEC-17). Arabic keyboards type Arabic-Indic (٠–٩) or Extended Arabic-Indic
 * (۰–۹) digits; every numeric input normalises them before validation or sending.
 */
export function toLatinDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/** Keeps only 0–9 after normalising the digit script. */
export function onlyDigits(input: string): string {
  return toLatinDigits(input).replace(/\D/g, '');
}
