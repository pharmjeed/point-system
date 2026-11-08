import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * V2-018 (DEC-550): e2e of the customer app without devices — the Expo **web** export of the same screens and
 * code (`pnpm run export:web`, the in-memory fake backend, `CUSTOMER_API_MODE=fake`) served statically and driven
 * by Playwright at the phone widths of the staff app (17 H-06): 360×740, 390×844, 430×932, touch, ar-SA,
 * Asia/Riyadh. Every spec asserts `<html dir="rtl" lang="ar">` and the Arabic copy of src/i18n/ar.ts.
 *
 * Native-only behaviour (Keychain, push, maps, brightness, 3-D Secure browser, Apple Pay, camera-free QR scan by the
 * driver) is not reachable here: the Maestro flows in e2e/maestro run the same journeys on devices (gate H2, DEC-553).
 *
 * The export is built once by the web server command; `E2E_REUSE_EXPORT=1` skips the rebuild locally.
 */
const PORT = Number(process.env.E2E_PORT ?? 4310);
// as apps/web: `PW_CHROMIUM_PATH` or the pre-installed Chromium when this Playwright's own browser is absent
const chromiumPath =
  process.env.PW_CHROMIUM_PATH ??
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

const phone = (width: number, height: number) => ({
  ...devices['Pixel 7'],
  browserName: 'chromium' as const,
  viewport: { width, height },
  isMobile: true,
  hasTouch: true,
});

export default defineConfig({
  testDir: './e2e',
  // the copy is imported from src/i18n/ar.ts, which reads @point/shared from its sources (no build step)
  tsconfig: './e2e/tsconfig.json',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'ar-SA',
    timezoneId: 'Asia/Riyadh',
    trace: process.env.CI ? 'retain-on-failure' : 'off',
    ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
  },
  projects: [
    { name: 'phone-360', use: phone(360, 740) },
    { name: 'phone-390', use: phone(390, 844) },
    { name: 'phone-430', use: phone(430, 932) },
  ],
  webServer: {
    command:
      process.env.E2E_REUSE_EXPORT === '1'
        ? 'node e2e/serve.mjs'
        : 'pnpm run export:web && node e2e/serve.mjs',
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    env: { E2E_PORT: String(PORT), CI: '1' },
  },
});
