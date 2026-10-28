import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Accepts any Saudi format (0551234567, 551234567, +966551234567, 966551234567) or international E.164 and
 * returns E.164, or null when invalid (07 §1.8). Default region SA.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = input
    .trim()
    .replace(/[\s\-()]/g, '')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  if (!raw) return null;
  const withPlus = /^966\d{9}$/.test(raw) ? `+${raw}` : /^00/.test(raw) ? `+${raw.slice(2)}` : raw;
  const parsed = parsePhoneNumberFromString(withPlus, 'SA');
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}
