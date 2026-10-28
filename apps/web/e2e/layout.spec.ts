import { expect, test } from '@playwright/test';
import { driverMe, MockApi, staffMe } from './support/api';
import { expectMobileLayout } from './support/checks';

/**
 * PNT-021 acceptance 1 & 2 (17 TC-059, TC-060): every shell page and every sign-in screen at 360, 390 and
 * 430 px (one project each), in light and dark: no horizontal scroll, RTL, 16px base font, ≥44px targets.
 */
const PAGES: Array<{
  path: string;
  me: Record<string, unknown> | null;
  area: 'driver' | 'staff';
  heading?: RegExp;
}> = [
  { path: '/login', me: null, area: 'driver', heading: /تسجيل الدخول/ },
  { path: '/staff/login', me: null, area: 'staff', heading: /دخول المشرفين والإدارة/ },
  { path: '/session-ended', me: null, area: 'driver', heading: /انتهت جلستك/ },
  {
    path: '/account/secret',
    me: driverMe({ mustChange: true }),
    area: 'driver',
    heading: /تغيير الرقم السري/,
  },
  { path: '/d/start', me: driverMe(), area: 'driver', heading: /بدء الوردية/ },
  { path: '/d', me: driverMe({ onDuty: true, state: 'busy_with_next' }), area: 'driver' },
  {
    path: '/d/vehicles',
    me: driverMe({ onDuty: true, state: 'retrieving' }),
    area: 'driver',
    heading: /المركبات/,
  },
  { path: '/d/account', me: driverMe({ onDuty: true }), area: 'driver', heading: /حسابي/ },
  { path: '/ops', me: staffMe(), area: 'staff', heading: /التشغيل/ },
  { path: '/drivers', me: staffMe(), area: 'staff', heading: /السائقون/ },
  { path: '/venues', me: staffMe(), area: 'staff', heading: /المواقع والحفلات/ },
  { path: '/reports', me: staffMe(), area: 'staff', heading: /التقارير/ },
  { path: '/admin', me: staffMe(), area: 'staff', heading: /الإدارة/ },
];

for (const theme of ['light', 'dark'] as const) {
  for (const p of PAGES) {
    test(`${p.path} — ${theme}`, async ({ page }) => {
      if (theme === 'dark') {
        // Driver screens follow the device (DEC-19); staff screens are light unless switched in ☰.
        await page.emulateMedia({ colorScheme: 'dark' });
        if (p.area === 'staff')
          await page.addInitScript(() => localStorage.setItem('point.theme.staff', 'dark'));
      }
      await new MockApi(page, p.me).install();
      await page.goto(p.path);
      await expect(page.locator('main')).toBeVisible();
      if (p.heading) await expect(page.getByRole('heading', { level: 1 })).toHaveText(p.heading);
      await page.evaluate(() => document.fonts.ready);
      await expectMobileLayout(page);
      const dark = await page.evaluate(() => {
        const bg = getComputedStyle(document.body).backgroundColor;
        const [r = 0, g = 0, b = 0] = (bg.match(/\d+/g) ?? []).map(Number);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b < 60;
      });
      expect(dark, `${theme} background`).toBe(theme === 'dark');
    });
  }
}

test('the staff shell switches to the side navigation from 1024 px', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await new MockApi(page, staffMe()).install();
  await page.goto('/ops');
  await expect(page.getByRole('navigation', { name: 'أقسام لوحة المشرف' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'التنقل الرئيسي' })).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
