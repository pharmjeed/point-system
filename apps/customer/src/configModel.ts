/**
 * The runtime configuration handed over by app.config.ts as `extra` (pure; ./config.ts reads it from
 * expo-constants). Brand names never appear as literals in the app (canon §1): they come from here.
 */
export interface AppConfig {
  brand: { nameAr: string; nameEn: string };
  api: { mode: 'fake' | 'http'; baseUrl: string | null };
  forceLocale: 'ar' | 'en' | null;
}

export class ConfigError extends Error {}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Validates `extra`. A release build (`isDev = false`) refuses the fake backend unless it was asked for
 * explicitly (`CUSTOMER_API_MODE=fake`, which app.config.ts records as `api.explicit`), and needs HTTPS.
 */
export function parseAppConfig(extra: unknown, isDev: boolean): AppConfig {
  const e = (extra ?? {}) as Record<string, unknown>;
  const brand = (e.brand ?? {}) as Record<string, unknown>;
  const api = (e.api ?? {}) as Record<string, unknown>;
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
  return { brand: { nameAr, nameEn }, api: { mode, baseUrl }, forceLocale: forced };
}
