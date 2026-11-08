import { expect, test } from '@playwright/test';
import { MockApi } from './support/api';

/**
 * Component gallery (docs/design/README.md, PNT-021): one screenshot per component, light and dark side by
 * side, attached to the report for comparison with docs/design/system/screenshots/<Name>.png. Rendered at
 * 960 px like the design-system previews. Also fails on any runtime error in a component.
 */
test.use({ viewport: { width: 960, height: 900 }, isMobile: false, hasTouch: false });
test.beforeEach(() => {
  test.skip(test.info().project.name !== 'mobile-390', 'one run is enough');
});

const CORE = [
  'Button',
  'IconButton',
  'TopBar',
  'BottomNav',
  'SideNav',
  'AppShell',
  'StatusChip',
  'DriverStateChip',
  'ConnectionIndicator',
  'Toast',
  'Dialog',
  'Sheet',
  'Banner',
  'Skeleton',
  'EmptyState',
  'TextField',
  'PhoneInput',
  'CodeInput',
  'Card',
  'Logo',
];

test('every component renders in both themes', async ({ page }, testInfo) => {
  test.setTimeout(180_000); // ~50 section captures
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await new MockApi(page).install();
  await page.goto('/_gallery');
  await page.waitForSelector('[data-gallery="DataTable"]');
  await page.evaluate(() => document.fonts.ready);
  const names = await page
    .locator('[data-gallery]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-gallery')));
  for (const name of CORE) expect(names).toContain(name);
  expect(names.length).toBeGreaterThanOrEqual(48);
  for (const name of names) {
    const section = page.locator(`[data-gallery="${name}"]`);
    await expect(section.locator('[data-theme="light"]').first()).toBeVisible();
    await expect(section.locator('[data-theme="dark"]').first()).toBeVisible();
    await testInfo.attach(`${name}.png`, {
      body: await section.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
  }
  expect(errors).toEqual([]);
});
