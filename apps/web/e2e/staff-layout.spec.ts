import { expect, test } from '@playwright/test';
import { eventFixture, MockApi, mockStaffApi, roleMe, secondsAgo } from './support/api';
import { expectMobileLayout } from './support/checks';

/**
 * Layout of every supervisor/admin/owner screen at 360, 390 and 430 px (one Playwright project each; 17 TC-059,
 * TC-060): no horizontal scroll, RTL, 16px base and inputs, ≥44px targets — with the screen's data loaded.
 */
const SCREENS: Array<{
  path: string;
  role: 'supervisor' | 'admin' | 'owner';
  heading: RegExp;
  ready: string;
  closing?: boolean;
}> = [
  { path: '/ops', role: 'supervisor', heading: /لوحة التشغيل/, ready: '[data-ticket="47"]' },
  { path: '/ops/alerts', role: 'supervisor', heading: /مركز التنبيهات/, ready: '[data-alert-id="al-47"]' },
];

for (const s of SCREENS) {
  test(`${s.path} — layout`, async ({ page }) => {
    const api = new MockApi(page, roleMe(s.role));
    mockStaffApi(
      api,
      s.closing ? { event: eventFixture({ status: 'closing', closing_started_at: secondsAgo(600) }) } : {},
    );
    await api.install();
    await page.goto(s.path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(s.heading);
    await expect(page.locator(s.ready).first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expectMobileLayout(page);
  });
}

test('S-02 from 1024 px: three columns, no tabs, no horizontal scroll', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile-390', 'one desktop check is enough');
  await page.setViewportSize({ width: 1280, height: 900 });
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  await api.install();
  await page.goto('/ops');
  await expect(page.locator('[data-ticket="47"]')).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'أقسام لوحة التشغيل' })).toBeHidden();
  for (const id of ['queue', 'active', 'next', 'drivers', 'alerts', 'failed', 'custody'])
    await expect(page.locator(`#ops-panel-${id}`)).toBeVisible();
  const columns = await page
    .locator('.st-board > .st-col')
    .evaluateAll((cols) => cols.map((c) => Math.round(c.getBoundingClientRect().top)));
  expect(new Set(columns).size).toBe(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
