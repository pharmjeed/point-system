import { expect, test } from '@playwright/test';
import { driverMe, MockApi, staffMe } from './support/api';

/**
 * PNT-021 acceptance 4 (canon §1): a customer brand distinct from the staff brand never appears in the staff
 * UI outside its allowed surfaces (D-07 QR panel, S-03 message preview, S-13 channel settings), none of which
 * these pages show — markup, attributes and title — even though `/v1/me` carries it. Since V2-D01 the default
 * customer brand is the staff brand itself (DEC-470); the check keeps a distinct configured value (here the
 * V1 one) for a deployment that sets its own `BRAND_CUSTOMER_NAME_AR`. The staff brand is taken from the
 * environment/manifest (title) and org settings, never hard-coded.
 */
const CUSTOMER = 'مصاف'; // a distinct configured customer brand (not the default since DEC-470)
const STAFF = 'بوينت';

const withBrand = <T extends { brand: unknown }>(me: T) => ({ ...me, brand: { customer_name_ar: CUSTOMER } });

const PAGES: Array<[string, Record<string, unknown> | null]> = [
  ['/login', null],
  ['/staff/login', null],
  ['/session-ended', null],
  ['/account/secret', withBrand(driverMe({ mustChange: true }))],
  ['/d/start', withBrand(driverMe())],
  ['/d', withBrand(driverMe({ onDuty: true }))],
  ['/d/vehicles', withBrand(driverMe({ onDuty: true }))],
  ['/d/account', withBrand(driverMe({ onDuty: true }))],
  ['/ops', withBrand(staffMe())],
  ['/drivers', withBrand(staffMe())],
  ['/venues', withBrand(staffMe())],
  ['/reports', withBrand(staffMe())],
  ['/admin', withBrand(staffMe())],
];

for (const [path, me] of PAGES) {
  test(`«${CUSTOMER}» is absent from ${path}`, async ({ page }) => {
    await new MockApi(page, me).install();
    await page.goto(path);
    await expect(page.locator('main')).toBeVisible();
    const html = await page.content();
    expect(html).not.toContain(CUSTOMER);
    expect(await page.title()).toBe(STAFF);
  });
}

test('the staff brand shows as live text next to the mark in the TopBar', async ({ page }) => {
  await new MockApi(page, staffMe()).install();
  await page.goto('/ops');
  await expect(page.locator('.pt-topbar__title')).toHaveText(STAFF);
});
