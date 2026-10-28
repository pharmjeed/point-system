/**
 * Inbound free text (12 §6.6): normalization, stop keywords (PNT-048) and QR link codes (PNT-044).
 */

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';
const TATWEEL = /ـ/g;

/** Trim, NFKC, Arabic-Indic digits → 0-9, no tatweel, Latin upper case, single spaces. */
export function normalizeInboundText(body: string): string {
  return body
    .normalize('NFKC')
    .replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(PERSIAN.indexOf(d)))
    .replace(TATWEEL, '')
    .replace(/[a-z]/g, (c) => c.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Exact matches after normalization only (12 §6.6). «إلغاء» is NOT a stop word: the customer usually
 * means canceling a request and receives the W-10 guidance instead.
 */
export const OPT_OUT_KEYWORDS: ReadonlySet<string> = new Set([
  'إيقاف',
  'ايقاف',
  'أوقف',
  'STOP',
  'UNSUBSCRIBE',
]);

export function isOptOutKeyword(normalized: string): boolean {
  return OPT_OUT_KEYWORDS.has(normalized);
}

/** Link code alphabet without 0/O/1/I (12 §7.2, `link_codes_code_check`). */
export const LINK_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LINK_CODE_EXACT = /^[A-HJ-NP-Z2-9]{6}$/;
const LINK_WORD = 'ربط';
const DASHES = /[-‐-―]/g;

/**
 * Finds a 6-character link code after removing spaces and dashes inside it, only when the message
 * contains «ربط» or the code is the whole message (fewer false positives from random text).
 */
export function extractLinkCode(normalized: string): string | null {
  if (!normalized.includes(LINK_WORD)) {
    const compact = normalized.replace(/\s+/g, '').replace(DASHES, '');
    return LINK_CODE_EXACT.test(compact) ? compact : null;
  }
  // tokens without dashes and without Arabic letters/punctuation («…تذكرةK7Q29F» → K7Q29F)
  const tokens = normalized
    .split(' ')
    .map((t) => t.replace(DASHES, '').replace(/[^A-Z0-9]/g, ''))
    .filter(Boolean);
  for (let width = 1; width <= 3; width++) {
    for (let i = 0; i + width <= tokens.length; i++) {
      const candidate = tokens.slice(i, i + width).join('');
      if (LINK_CODE_EXACT.test(candidate)) return candidate;
    }
  }
  return null;
}
