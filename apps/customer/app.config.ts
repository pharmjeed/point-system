/**
 * Expo config of the customer app (V2-011; store completeness V2-052, DEC-565 … DEC-569). Nothing here is a store
 * credential: bundle ids are `sa.point.app` (DEC-565) and overridable per environment; the EAS project id comes from
 * the environment only (`EAS_PROJECT_ID`, eas.json; DEC-483). Build numbers are EAS's (remote, auto-increment).
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

/**
 * The marketing version (CFBundleShortVersionString / versionName), raised by hand for each store release; the build
 * number (CFBundleVersion / versionCode) is not here: EAS keeps it remotely and increments it on every production
 * build (eas.json `appVersionSource: remote`, `autoIncrement`, DEC-566).
 */
export const CUSTOMER_APP_VERSION = '1.0.0';

/**
 * Universal links / App Links (DEC-566): `https://{CUSTOMER_LINK_DOMAIN}/app…` opens the app (src/app/+native-intent.ts
 * maps the path). The domain serves apple-app-site-association and assetlinks.json (scripts/well-known.mjs); until it
 * does, the links simply open in the browser.
 */
export const CUSTOMER_LINK_PATH_PREFIX = '/app';

/**
 * Apple's required-reason APIs used by the app's native code (DEC-567): the union of what React Native and the Expo
 * modules in package.json declare in their own PrivacyInfo.xcprivacy (React/Resources, ReactCommon/timing,
 * expo-constants, expo-localization, expo-notifications, expo-file-system, expo-application), declared again at app
 * level because static libraries' manifests are not always merged. Re-audit when a native dependency is added.
 */
const ACCESSED_API_TYPES = [
  {
    NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
    NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
  },
  {
    NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
    NSPrivacyAccessedAPITypeReasons: ['C617.1', '0A2A.1', '3B52.1'],
  },
  {
    NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime',
    NSPrivacyAccessedAPITypeReasons: ['35F9.1'],
  },
  {
    NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace',
    NSPrivacyAccessedAPITypeReasons: ['E174.1', '85F4.1'],
  },
];

/**
 * What the app collects (DEC-567; the same answers as docs/v2/store/PRIVACY_LABELS.md): all linked to the account,
 * none used for tracking, all for app functionality. Payment info = the saved card's brand, last four digits and
 * expiry (the number is tokenized by the gateway from the device and never reaches POINT's servers, V2-D08).
 */
const collected = (type: string) => ({
  NSPrivacyCollectedDataType: `NSPrivacyCollectedDataType${type}`,
  NSPrivacyCollectedDataTypeLinked: true,
  NSPrivacyCollectedDataTypeTracking: false,
  NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
});
export const COLLECTED_DATA_TYPES = [
  'Name',
  'PhoneNumber',
  'UserID',
  'DeviceID',
  'PaymentInfo',
  'PurchaseHistory',
  'OtherUserContent',
  'OtherDataTypes',
].map(collected);

/**
 * Android permissions removed from the merged manifest (DEC-567): the app reads no files, no location, no camera,
 * draws no overlays and never changes the system brightness (C-11 raises its own window's brightness only, which
 * needs no permission; expo-brightness's plugin would add WRITE_SETTINGS). What remains: INTERNET and VIBRATE, and
 * from expo-notifications at merge time POST_NOTIFICATIONS (asked on C-12/C-19 only) and RECEIVE_BOOT_COMPLETED.
 */
export const ANDROID_BLOCKED_PERMISSIONS = [
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.WRITE_SETTINGS',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.CAMERA',
  'android.permission.RECORD_AUDIO',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
];

/**
 * Location purpose strings (DEC-567). The app never asks for the location (C-07 draws no «my location», DEC-506), but
 * react-native-maps links Core Location, and an upload whose binary references the location APIs may be flagged
 * without the purpose string (unverified, RELEASE_CHECKLIST §10); the text says plainly what it would be for.
 */
const LOCATION_PURPOSE = {
  ar: 'لا يطلب التطبيق موقعك. إن طلبه مستقبلًا فلإظهار المواقع القريبة منك على الخريطة فقط، ولا يُحفظ.',
  en: 'The app does not ask for your location. If it ever does, it is only to show the nearby locations on the map, and it is not stored.',
};

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
  const linkDomain = env('CUSTOMER_LINK_DOMAIN') ?? 'pointsa.net';
  const easProjectId = env('EAS_PROJECT_ID') ?? env('CUSTOMER_EAS_PROJECT_ID');

  return {
    ...config,
    name: nameEn,
    slug: env('CUSTOMER_EXPO_SLUG') ?? 'point-customer',
    // the Expo account (or organisation) that owns the EAS project, when it is not the signed-in user (DEC-566)
    ...(env('EXPO_OWNER') ? { owner: env('EXPO_OWNER') } : {}),
    scheme: env('CUSTOMER_URL_SCHEME') ?? bundleId,
    version: CUSTOMER_APP_VERSION,
    orientation: 'portrait',
    // The shipped app is iOS + Android only. `web` is added by CUSTOMER_WEB_EXPORT=1 for the one web export
    // (`pnpm run export:web`, DEC-550 as unified in DEC-568): the e2e suite (V2-018) and the store screenshots
    // (V2-052) use it; never deployed — the customer never opens a web page (canon §1).
    platforms: env('CUSTOMER_WEB_EXPORT') === '1' ? ['ios', 'android', 'web'] : ['ios', 'android'],
    // 1024 × 1024 without alpha, exported from brand/app-icons/icon-maskable.svg (scripts/store-icon.mjs, DEC-567)
    icon: './assets/brand/icon-1024.png',
    userInterfaceStyle: 'light',
    backgroundColor: surface,
    ios: {
      bundleIdentifier: bundleId,
      // iPhone only (the iPad runs it in compatibility mode); no iPad screenshots are needed (DEC-568)
      supportsTablet: false,
      // HTTPS and the OS's own cryptography only: exempt from export documentation (DEC-566)
      config: { usesNonExemptEncryption: false },
      associatedDomains: [`applinks:${linkDomain}`],
      infoPlist: {
        CFBundleAllowMixedLocalizations: true,
        NSLocationWhenInUseUsageDescription: LOCATION_PURPOSE.en,
      },
      privacyManifests: {
        NSPrivacyTracking: false,
        NSPrivacyTrackingDomains: [],
        NSPrivacyCollectedDataTypes: COLLECTED_DATA_TYPES,
        NSPrivacyAccessedAPITypes: ACCESSED_API_TYPES,
      },
    },
    android: {
      package: androidPackage,
      // FCM for Expo push on Android (V2-016): the Firebase file is a build input given as an EAS file variable
      // (GOOGLE_SERVICES_JSON = its path on the builder), never committed (DEC-566)
      ...(env('GOOGLE_SERVICES_JSON') ? { googleServicesFile: env('GOOGLE_SERVICES_JSON') } : {}),
      adaptiveIcon: { foregroundImage: './assets/brand/icon-maskable-512.png', backgroundColor: primary },
      blockedPermissions: ANDROID_BLOCKED_PERMISSIONS,
      // the session lives in the Keystore (expo-secure-store): a cloud backup could not decrypt it anyway
      allowBackup: false,
      intentFilters: [
        {
          action: 'VIEW',
          autoVerify: true,
          data: [{ scheme: 'https', host: linkDomain, pathPrefix: CUSTOMER_LINK_PATH_PREFIX }],
          category: ['BROWSABLE', 'DEFAULT'],
        },
      ],
      ...(androidMapsKey ? { config: { googleMaps: { apiKey: androidMapsKey } } } : {}),
    },
    // The home-screen name per language (the Arabic name on Arabic devices) and the purpose strings.
    locales: {
      ar: {
        ios: {
          CFBundleDisplayName: nameAr,
          CFBundleName: nameAr,
          NSLocationWhenInUseUsageDescription: LOCATION_PURPOSE.ar,
        },
        android: { app_name: nameAr },
      },
      en: {
        ios: {
          CFBundleDisplayName: nameEn,
          CFBundleName: nameEn,
          NSLocationWhenInUseUsageDescription: LOCATION_PURPOSE.en,
        },
        android: { app_name: nameEn },
      },
    },
    plugins: [
      'expo-router',
      'expo-secure-store',
      'expo-web-browser',
      // V2-016 (DEC-519): pushes through Expo (APNs / FCM); the Android small icon is the white mark of brand/
      [
        'expo-notifications',
        { icon: './assets/brand/point-mark-white-512.png', color: primary, defaultChannel: 'visits' },
      ],
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
      // V2-016 (DEC-519): the EAS project the Expo push tokens belong to; no project linked → no push (DEC-483).
      // `EAS_PROJECT_ID` (eas.json, DEC-566) or the older `CUSTOMER_EAS_PROJECT_ID`; never committed.
      ...(easProjectId ? { eas: { projectId: easProjectId } } : {}),
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
