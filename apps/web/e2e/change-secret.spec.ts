import { expect, test, type Page } from '@playwright/test';
import { errorMessagesAr } from '../src/i18n/errors';
import { apiError, driverMe, loginResult, MockApi, ok } from './support/api';
import { runOnlyAt390 } from './support/checks';

runOnlyAt390();

async function fillPins(page: Page, current: string, next: string, confirm = next) {
  await page.getByLabel('الرقم السري الحالي').fill(current);
  await page.getByLabel('الرقم السري الجديد').fill(next);
  await page.getByLabel('تأكيد الرقم الجديد').fill(confirm);
  await page.getByRole('button', { name: 'حفظ والمتابعة' }).click();
}

test.describe('D-02 — change the PIN', () => {
  test('first sign-in: D-01 → D-02 → D-03 (PNT-022 acceptance 3)', async ({ page }) => {
    const api = new MockApi(page);
    api.on('POST', '/v1/auth/login', () => {
      api.me = driverMe({ mustChange: true });
      return loginResult(api.me, { must_change_secret: true });
    });
    api.on('POST', '/v1/auth/secret/change', () => {
      api.me = driverMe();
      return ok(api.me);
    });
    await api.install();
    await page.goto('/login');
    await page.getByLabel('رقم الجوال').fill('0551234567');
    await page.getByLabel('الرقم السري', { exact: true }).fill('730194');
    await page.getByRole('button', { name: 'دخول', exact: true }).click();

    await expect(page).toHaveURL(/\/account\/secret$/);
    await expect(page.getByRole('button', { name: 'رجوع' })).toHaveCount(0); // no back on first sign-in
    await expect(page.getByText('لا تستخدم أرقامًا متكررة أو متسلسلة مثل 111111 أو 123456.')).toBeVisible();
    await fillPins(page, '730194', '482915');

    await expect(page).toHaveURL(/\/d\/start$/);
    await expect(page.getByRole('heading', { name: 'بدء الوردية' })).toBeVisible();
    const [call] = api.callsTo('POST', '/v1/auth/secret/change');
    expect(call?.body).toEqual({ current_secret: '730194', new_secret: '482915' });
    expect(call?.headers['x-requested-with']).toBe('point-web');
  });

  test('local checks: mismatch and weak PIN (no request)', async ({ page }) => {
    const api = await new MockApi(page, driverMe({ mustChange: true })).install();
    await page.goto('/account/secret');
    await fillPins(page, '730194', '482915', '482916');
    await expect(page.getByText('الرقمان غير متطابقين.')).toBeVisible();
    await fillPins(page, '730194', '123456');
    await expect(page.getByText('اختر رقمًا سريًا أقوى.')).toBeVisible();
    await fillPins(page, '730194', '111111');
    await expect(page.getByText('اختر رقمًا سريًا أقوى.')).toBeVisible();
    expect(api.callsTo('POST', '/v1/auth/secret/change')).toHaveLength(0);
  });

  test('a wrong current PIN shows the server text under that field and clears it', async ({ page }) => {
    await new MockApi(page, driverMe({ mustChange: true }))
      .on('POST', '/v1/auth/secret/change', apiError('AUTH_INVALID_CREDENTIALS', 401))
      .install();
    await page.goto('/account/secret');
    await fillPins(page, '000001', '482915');
    await expect(page.locator('#pin-current-err')).toHaveText(errorMessagesAr.AUTH_INVALID_CREDENTIALS);
    await expect(page.getByLabel('الرقم السري الحالي')).toHaveValue('');
    await expect(page.getByLabel('الرقم السري الجديد')).toHaveValue('482915'); // other inputs are kept
  });

  test('from D-14: back button, then return to D-14 after saving', async ({ page }) => {
    await new MockApi(page, driverMe({ onDuty: true }))
      .on('POST', '/v1/auth/secret/change', ok(driverMe({ onDuty: true })))
      .install();
    await page.goto('/d/account');
    await page.getByRole('link', { name: 'تغيير الرقم السري' }).click();
    await expect(page).toHaveURL(/\/account\/secret$/);
    await expect(page.getByRole('button', { name: 'رجوع' })).toBeVisible();
    await fillPins(page, '730194', '482915');
    await expect(page).toHaveURL(/\/d\/account$/);
  });

  test('a staff account is sent to S-01 (password, not PIN)', async ({ page }) => {
    await new MockApi(page, {
      ...driverMe(),
      user: { ...driverMe().user, role: 'admin', must_change_secret: true },
    }).install();
    await page.goto('/account/secret');
    await expect(page).toHaveURL(/\/staff\/login$/);
  });
});
