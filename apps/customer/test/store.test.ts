/**
 * V2-052 (DEC-565 … DEC-568): the store-facing parts of the Expo config and the incoming-link mapping.
 */
import { afterEach, describe, expect, it } from 'vitest';
import appConfig, {
  ANDROID_BLOCKED_PERMISSIONS,
  COLLECTED_DATA_TYPES,
  CUSTOMER_APP_VERSION,
} from '../app.config';
import { linkPath, systemPathFor } from '../src/features/links';

const ENV_KEYS = [
  'CUSTOMER_WEB_EXPORT',
  'CUSTOMER_LINK_DOMAIN',
  'EAS_PROJECT_ID',
  'CUSTOMER_EAS_PROJECT_ID',
  'EXPO_OWNER',
  'CUSTOMER_IOS_BUNDLE_ID',
  'CUSTOMER_ANDROID_PACKAGE',
  'GOOGLE_SERVICES_JSON',
];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const build = () => appConfig({ config: {} } as Parameters<typeof appConfig>[0]);

describe('store config (DEC-565 … DEC-567)', () => {
  it('ships iOS and Android only; the web target exists for the one web export (e2e + screenshots) alone', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(build().platforms).toEqual(['ios', 'android']);
    process.env.CUSTOMER_WEB_EXPORT = '1';
    expect(build().platforms).toEqual(['ios', 'android', 'web']);
  });

  it('identifiers, version and icon', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const c = build();
    expect(c.ios?.bundleIdentifier).toBe('sa.point.app');
    expect(c.android?.package).toBe('sa.point.app');
    expect(c.version).toBe(CUSTOMER_APP_VERSION);
    expect(c.ios?.buildNumber).toBeUndefined(); // EAS owns build numbers (remote, auto-increment)
    expect(c.android?.versionCode).toBeUndefined();
    expect(c.icon).toBe('./assets/brand/icon-1024.png');
    expect(c.ios?.supportsTablet).toBe(false);
    expect(c.ios?.config?.usesNonExemptEncryption).toBe(false);
  });

  it('EAS project and owner come from the environment only', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(build().extra?.eas).toBeUndefined();
    expect(build().owner).toBeUndefined();
    process.env.EAS_PROJECT_ID = '00000000-0000-4000-8000-000000000000';
    process.env.EXPO_OWNER = 'example-org';
    expect(build().extra?.eas).toEqual({ projectId: '00000000-0000-4000-8000-000000000000' });
    expect(build().owner).toBe('example-org');
    expect(build().android?.googleServicesFile).toBeUndefined();
    process.env.GOOGLE_SERVICES_JSON = '/builder/tmp/google-services.json';
    expect(build().android?.googleServicesFile).toBe('/builder/tmp/google-services.json');
  });

  it('links on the link domain under /app', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const c = build();
    expect(c.ios?.associatedDomains).toEqual(['applinks:pointsa.net']);
    expect(c.android?.intentFilters?.[0]).toMatchObject({
      autoVerify: true,
      data: [{ scheme: 'https', host: 'pointsa.net', pathPrefix: '/app' }],
    });
    process.env.CUSTOMER_LINK_DOMAIN = 'links.example.sa';
    expect(build().ios?.associatedDomains).toEqual(['applinks:links.example.sa']);
  });

  it('privacy: no tracking, every collected type linked and for app functionality only', () => {
    const manifest = build().ios?.privacyManifests;
    expect(manifest?.NSPrivacyTracking).toBe(false);
    expect(manifest?.NSPrivacyTrackingDomains).toEqual([]);
    expect(COLLECTED_DATA_TYPES.map((d) => d.NSPrivacyCollectedDataType)).toContain(
      'NSPrivacyCollectedDataTypePhoneNumber',
    );
    for (const d of COLLECTED_DATA_TYPES) {
      expect(d.NSPrivacyCollectedDataTypeTracking).toBe(false);
      expect(d.NSPrivacyCollectedDataTypePurposes).toEqual([
        'NSPrivacyCollectedDataTypePurposeAppFunctionality',
      ]);
    }
    // no location, no analytics, no crash data: the app collects none (docs/v2/store/PRIVACY_LABELS.md)
    const types = COLLECTED_DATA_TYPES.map((d) => d.NSPrivacyCollectedDataType).join(' ');
    expect(types).not.toMatch(/Location|Crash|Performance|ProductInteraction|Advertising/);
    expect(manifest?.NSPrivacyAccessedAPITypes?.map((a) => a.NSPrivacyAccessedAPIType)).toEqual([
      'NSPrivacyAccessedAPICategoryUserDefaults',
      'NSPrivacyAccessedAPICategoryFileTimestamp',
      'NSPrivacyAccessedAPICategorySystemBootTime',
      'NSPrivacyAccessedAPICategoryDiskSpace',
    ]);
  });

  it('Android: no location, camera, storage or overlay permission; no cloud backup', () => {
    const c = build();
    expect(c.android?.blockedPermissions).toEqual(ANDROID_BLOCKED_PERMISSIONS);
    for (const p of ['ACCESS_FINE_LOCATION', 'CAMERA', 'READ_EXTERNAL_STORAGE', 'SYSTEM_ALERT_WINDOW']) {
      expect(ANDROID_BLOCKED_PERMISSIONS).toContain(`android.permission.${p}`);
    }
    expect(c.android?.allowBackup).toBe(false);
  });

  it('the location purpose string exists in both languages and never claims the app uses it', () => {
    const c = build();
    const ar = (c.locales?.ar as { ios: Record<string, string> }).ios.NSLocationWhenInUseUsageDescription;
    const en = (c.locales?.en as { ios: Record<string, string> }).ios.NSLocationWhenInUseUsageDescription;
    expect(ar).toMatch(/لا يطلب التطبيق موقعك/);
    expect(en).toMatch(/does not ask for your location/);
    expect(c.ios?.infoPlist?.NSLocationWhenInUseUsageDescription).toBe(en);
  });
});

describe('incoming links (DEC-566)', () => {
  it('reads the path of a URL or a path', () => {
    expect(linkPath('https://pointsa.net/app/?x=1')).toBe('/app');
    expect(linkPath('sa.point.app://pay/return?id=1')).toBe('/pay/return');
    expect(linkPath('/visit//abc/')).toBe('/visit/abc');
    expect(linkPath('home')).toBe('/home');
  });

  it('/app opens the entry; /app/visit/{uuid} opens C-12; anything else under /app the entry', () => {
    const id = '7B1C2D3E-4F50-4A6B-8C7D-9E0F1A2B3C4D';
    expect(systemPathFor('https://pointsa.net/app', true)).toBe('/');
    expect(systemPathFor(`https://pointsa.net/app/visit/${id}`, false)).toBe(`/visit/${id.toLowerCase()}`);
    expect(systemPathFor('https://pointsa.net/app/visit/not-a-uuid', false)).toBe('/');
    expect(systemPathFor('https://pointsa.net/app/anything/else', true)).toBe('/');
    expect(systemPathFor('https://pointsa.net/application', true)).toBe('https://pointsa.net/application');
  });

  it('the 3-D Secure return changes nothing (the server holds the result)', () => {
    expect(systemPathFor('sa.point.app://pay/return', false)).toBeNull();
    expect(systemPathFor('sa.point.app://pay/return', true)).toBe('/');
  });

  it('other paths go to the router unchanged', () => {
    expect(systemPathFor('/visits', false)).toBe('/visits');
  });
});
