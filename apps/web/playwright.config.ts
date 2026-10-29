import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * E2E (17 H-06): mobile viewports 360×740, 390×844, 430×932, touch, ar-SA, Asia/Riyadh, RTL — against a
 * production build (`vite preview`) with the API mocked in the browser (`page.route`, e2e/support/api.ts),
 * so no backend is needed. The build enables the component gallery route for the screenshot spec.
 *
 * Chromium only here (17 also asks for WebKit: add `devices['iPhone 13']`-style projects in CI where the
 * browser is installed). `PW_CHROMIUM_PATH` or the pre-installed /opt/pw-browsers/chromium is used when
 * the Playwright-managed browser for this version is not present.
 *
 * `E2E_BACKEND=live` adds the `g1-live` project (PNT-036, `pnpm --filter @point/web test:e2e:live`): the G1
 * path at 390 px against the real API on a fresh seeded PostgreSQL (e2e/live/), reached through the
 * `vite preview` proxy on `API_PORT` = E2E_API_PORT. The mocked projects never reach that proxy (their `/v1`
 * is answered in the browser), so the default run stays fast and needs no database.
 */
const PORT = Number(process.env.E2E_PORT ?? 5317);

/**
 * A throwaway VAPID public key for the e2e build (PNT-072): the subscription path of D-03/D-14 runs against a
 * stubbed PushManager; nothing is ever pushed with it. Generated per run (public by nature, never stored).
 */
function throwawayVapidPublicKey(): string {
  const jwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(String(jwk.x), 'base64url'),
    Buffer.from(String(jwk.y), 'base64url'),
  ]);
  return raw.toString('base64url');
}
const API_PORT = Number(process.env.E2E_API_PORT ?? 3917);
const LIVE = process.env.E2E_BACKEND === 'live';
const LIVE_SPECS = /[\\/]live[\\/].+\.live\.spec\.ts$/;
const chromiumPath =
  process.env.PW_CHROMIUM_PATH ??
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

const mobile = (width: number, height: number) => ({
  ...devices['Pixel 7'],
  browserName: 'chromium' as const,
  viewport: { width, height },
  isMobile: true,
  hasTouch: true,
});

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'ar-SA',
    timezoneId: 'Asia/Riyadh',
    trace: 'retain-on-failure',
    launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
    // page.route() does not see requests a Service Worker handles: the mocked runs block the SW; the PWA
    // spec (e2e/pwa.spec.ts) opens its own context with service workers allowed (PNT-070)
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'mobile-360', use: mobile(360, 740), testIgnore: LIVE_SPECS },
    { name: 'mobile-390', use: mobile(390, 844), testIgnore: LIVE_SPECS },
    { name: 'mobile-430', use: mobile(430, 932), testIgnore: LIVE_SPECS },
    // one worker: the vite proxy reaches one API port
    ...(LIVE
      ? [
          {
            name: 'g1-live',
            testMatch: LIVE_SPECS,
            use: mobile(390, 844),
            fullyParallel: false,
            workers: 1,
            retries: 0,
          },
        ]
      : []),
  ],
  webServer: {
    command: `pnpm exec vite build && pnpm exec vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      VITE_ENABLE_GALLERY: 'true',
      API_PORT: String(API_PORT),
      VITE_VAPID_PUBLIC_KEY: process.env.VITE_VAPID_PUBLIC_KEY ?? throwawayVapidPublicKey(),
    },
  },
});
