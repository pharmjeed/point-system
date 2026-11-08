/**
 * The runtime configuration handed over by app.config.ts as `extra` (pure; ./config.ts reads it from
 * expo-constants). Brand names never appear as literals in the app (canon §1): they come from here.
 */
export interface AppConfig {
  brand: { nameAr: string; nameEn: string };
  api: { mode: 'fake' | 'http'; baseUrl: string | null };
  forceLocale: 'ar' | 'en' | null;
  /**
   * C-07 map view (V2-012, DEC-506): Apple Maps on iOS needs no key; Android draws Google Maps only when the build
   * was given a key (`CUSTOMER_ANDROID_GOOGLE_MAPS_API_KEY`, never committed). Without one the list stays, with
   * «فتح في الخرائط» links.
   */
  maps: { android: boolean };
  /** C-19 «تواصل معنا» (V2-017): a support WhatsApp number (digits, E.164 without +) and/or an e-mail, if set. */
  support: { whatsapp: string | null; email: string | null };
  /** The app version shown on C-19 (app.config.ts `version`). */
  version: string;
}

export class ConfigError extends Error {}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Validates `extra`. A release build (`isDev = false`) refuses the fake backend unless it was asked for
 * explicitly (`CUSTOMER_API_MODE=fake`, which app.config.ts records as `api.explicit`), and needs HTTPS.
 */
export function parseAppConfig(extra: unknown, isDev: boolean, version?: string | null): AppConfig {
  const e = (extra ?? {}) as Record<string, unknown>;
  const brand = (e.brand ?? {}) as Record<string, unknown>;
  const api = (e.api ?? {}) as Record<string, unknown>;
  const maps = (e.maps ?? {}) as Record<string, unknown>;
  const support = (e.support ?? {}) as Record<string, unknown>;
  const nameAr = str(brand.nameAr);
  const nameEn = str(brand.nameEn);
  if (!nameAr || !nameEn) throw new ConfigError('extra.brand.nameAr/nameEn are required (app.config.ts)');
  const mode = api.mode === 'http' ? 'http' : api.mode === 'fake' ? 'fake' : null;
  if (!mode) throw new ConfigError('extra.api.mode must be fake or http');
  const baseUrl = str(api.baseUrl);
  if (mode === 'http') {
    if (!baseUrl) throw new ConfigError('extra.api.baseUrl is required in http mode');
    if (!isDev && !baseUrl.startsWith('https://'))
      throw new ConfigError('release builds call the API over https');
  }
  if (mode === 'fake' && !isDev && api.explicit !== true) {
    throw new ConfigError('a release build never falls back to the fake API');
  }
  const forced = e.forceLocale === 'ar' || e.forceLocale === 'en' ? e.forceLocale : null;
  const whatsapp = str(support.whatsapp);
  const email = str(support.email);
  return {
    brand: { nameAr, nameEn },
    api: { mode, baseUrl },
    forceLocale: forced,
    maps: { android: maps.android === true },
    support: {
      whatsapp: whatsapp && /^[1-9][0-9]{7,14}$/.test(whatsapp) ? whatsapp : null,
      email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    },
    version: str(version) ?? '0.0.0',
  };
}
