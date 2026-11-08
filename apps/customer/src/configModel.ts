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
  /**
   * V2-016 (DEC-519): the EAS project id an Expo push token is issued for (`extra.eas.projectId`, from
   * `CUSTOMER_EAS_PROJECT_ID`); without one the build cannot receive pushes and C-19 says so.
   */
  push: { projectId: string | null };
  /**
   * V2-022 / V2-023 (DEC-524): the card is tokenized on the device with Moyasar's **publishable** key (`pk_…`, never
   * a secret key) at `baseUrl` (`https://api.moyasar.com`, or tools/payment-simulator in development); without a key
   * card entry is unavailable (fake mode tokenizes locally). Apple Pay needs the merchant id of POINT's certificate
   * and a native PassKit sheet (a dev build), else it is not offered. `cardOnFileVersion`: the «حفظ البطاقة» text.
   */
  payments: {
    moyasarPublishableKey: string | null;
    moyasarBaseUrl: string;
    applePayMerchantId: string | null;
    cardOnFileVersion: string;
  };
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
  const eas = (e.eas ?? {}) as Record<string, unknown>;
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
    push: { projectId: str(eas.projectId) },
    payments: parsePayments(e.payments, isDev),
  };
}

function parsePayments(raw: unknown, isDev: boolean): AppConfig['payments'] {
  const p = (raw ?? {}) as Record<string, unknown>;
  const key = str(p.moyasarPublishableKey);
  // a secret key in the app would be a leak of POINT's gateway account: refused outright
  if (key && !/^pk_(test|live)_[A-Za-z0-9]+$/.test(key))
    throw new ConfigError('payments.moyasarPublishableKey must be a publishable key (pk_test_… / pk_live_…)');
  if (key && !isDev && key.startsWith('pk_test_') && p.allowTestKey !== true)
    throw new ConfigError('a release build does not take a test publishable key unless asked (allowTestKey)');
  const baseUrl = str(p.moyasarBaseUrl) ?? 'https://api.moyasar.com';
  if (!isDev && !baseUrl.startsWith('https://')) throw new ConfigError('release builds tokenize over https');
  return {
    moyasarPublishableKey: key,
    moyasarBaseUrl: baseUrl.replace(/\/+$/, ''),
    applePayMerchantId: str(p.applePayMerchantId),
    cardOnFileVersion: str(p.cardOnFileVersion) ?? '2026-11-01',
  };
}
