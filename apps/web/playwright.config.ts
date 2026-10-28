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
 */
const PORT = Number(process.env.E2E_PORT ?? 5317);
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
  },
  projects: [
    { name: 'mobile-360', use: mobile(360, 740) },
    { name: 'mobile-390', use: mobile(390, 844) },
    { name: 'mobile-430', use: mobile(430, 932) },
  ],
  webServer: {
    command: `pnpm exec vite build && pnpm exec vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { VITE_ENABLE_GALLERY: 'true' },
  },
});
