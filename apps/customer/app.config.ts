/**
 * Expo config of the customer app (V2-011). Nothing here is a store credential: bundle ids default to
 * `sa.point.app` and are overridable per environment; no EAS project is linked (DEC-483).
 *
 * Brand names are never literals in the app (canon §1, scripts/check-brand.mjs): they come from
 * `BRAND_CUSTOMER_APP_NAME_AR/_EN`, defaulting to `CUSTOMER_APP_BRAND_DEFAULTS` (V2-D01, DEC-480), and reach the
 * app as `extra.brand`. Colours come from brand/tokens (DEC-49); icons and logos are copies of brand/ files.
 */
import type { ConfigContext, ExpoConfig } from 'expo/config';
import tokens from '../../brand/tokens/tokens.json';
import { CUSTOMER_APP_BRAND_DEFAULTS } from '../../packages/shared/src/canon/brand-defaults.ts';

type ApiMode = 'fake' | 'http';

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * `fake` runs the in-memory backend (src/api/fake); `http` calls `CUSTOMER_API_BASE_URL` (V2-010). Without either
 * variable a development build uses the fake; a release build refuses an implicit fake (src/configModel.ts).
 */
function apiConfig(): { mode: ApiMode; baseUrl: string | null; explicit: boolean } {
  const baseUrl = env('CUSTOMER_API_BASE_URL') ?? null;
  const requested = env('CUSTOMER_API_MODE');
  if (requested && requested !== 'fake' && requested !== 'http') {
    throw new Error(`CUSTOMER_API_MODE must be fake or http, got ${requested}`);
  }
  const mode: ApiMode = (requested as ApiMode | undefined) ?? (baseUrl ? 'http' : 'fake');
  if (mode === 'http' && !baseUrl) throw new Error('CUSTOMER_API_MODE=http needs CUSTOMER_API_BASE_URL');
  return { mode, baseUrl, explicit: requested !== undefined };
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const nameAr = env('BRAND_CUSTOMER_APP_NAME_AR') ?? CUSTOMER_APP_BRAND_DEFAULTS.BRAND_CUSTOMER_APP_NAME_AR;
  const nameEn = env('BRAND_CUSTOMER_APP_NAME_EN') ?? CUSTOMER_APP_BRAND_DEFAULTS.BRAND_CUSTOMER_APP_NAME_EN;
  const bundleId = env('CUSTOMER_IOS_BUNDLE_ID') ?? 'sa.point.app';
  const androidPackage = env('CUSTOMER_ANDROID_PACKAGE') ?? 'sa.point.app';
  const primary = tokens.color.blue['600'].$value;
  const surface = tokens.color.ink['0'].$value;
  // C-07 (V2-012, DEC-506): react-native-maps draws Apple Maps on iOS with no key; Google Maps on Android needs a
  // key, given to the build from the environment only (never committed). Without it the app hides the map on
  // Android and keeps the list with «فتح في الخرائط» links.
  const androidMapsKey = env('CUSTOMER_ANDROID_GOOGLE_MAPS_API_KEY');

  return {
    ...config,
    name: nameEn,
    slug: env('CUSTOMER_EXPO_SLUG') ?? 'point-customer',
    scheme: env('CUSTOMER_URL_SCHEME') ?? bundleId,
    version: '0.1.0',
    orientation: 'portrait',
    platforms: ['ios', 'android'],
    icon: './assets/brand/icon-maskable-512.png',
    userInterfaceStyle: 'light',
    backgroundColor: surface,
    ios: {
      bundleIdentifier: bundleId,
      supportsTablet: false,
      infoPlist: { CFBundleAllowMixedLocalizations: true },
    },
    android: {
      package: androidPackage,
      adaptiveIcon: { foregroundImage: './assets/brand/icon-maskable-512.png', backgroundColor: primary },
      ...(androidMapsKey ? { config: { googleMaps: { apiKey: androidMapsKey } } } : {}),
    },
    // The home-screen name per language (the Arabic name on Arabic devices).
    locales: {
      ar: { ios: { CFBundleDisplayName: nameAr, CFBundleName: nameAr }, android: { app_name: nameAr } },
      en: { ios: { CFBundleDisplayName: nameEn, CFBundleName: nameEn }, android: { app_name: nameEn } },
    },
    plugins: [
      'expo-router',
      'expo-secure-store',
      'expo-web-browser',
      ['expo-localization', { supportsRTL: true, supportedLocales: ['ar', 'en'] }],
      [
        'expo-splash-screen',
        // Blue background with the white mark: the only large blue surface the guidelines allow (brand §4.1, §2.4).
        { backgroundColor: primary, image: './assets/brand/point-mark-white-512.png', imageWidth: 96 },
      ],
    ],
    extra: {
      brand: { nameAr, nameEn },
      api: apiConfig(),
      forceLocale: env('CUSTOMER_FORCE_LOCALE') ?? null,
      maps: { android: androidMapsKey !== undefined },
      // C-19 «تواصل معنا» (V2-017): configured per environment, never a number written in the code
      support: {
        whatsapp: env('CUSTOMER_SUPPORT_WHATSAPP') ?? null,
        email: env('CUSTOMER_SUPPORT_EMAIL') ?? null,
      },
      // V2-022 / V2-023 (DEC-524): the device tokenizes the card with the publishable key only (never a secret key)
      payments: {
        moyasarPublishableKey: env('CUSTOMER_MOYASAR_PUBLISHABLE_KEY') ?? null,
        moyasarBaseUrl: env('CUSTOMER_MOYASAR_BASE_URL') ?? 'https://api.moyasar.com',
        applePayMerchantId: env('CUSTOMER_APPLE_PAY_MERCHANT_ID') ?? null,
        cardOnFileVersion: env('CUSTOMER_CARD_ON_FILE_VERSION') ?? '2026-11-01',
        allowTestKey: env('CUSTOMER_MOYASAR_ALLOW_TEST_KEY') === 'true',
      },
    },
  };
};
