import { expect, test } from '@playwright/test';
import { apiError, driverMe, loginResult, MockApi, ok, staffMe } from './support/api';
import { browserStorageDump, runOnlyAt390 } from './support/checks';

/**
 * PNT-022 acceptance 2: the PIN and the password are never kept in any browser storage — localStorage,
 * sessionStorage, IndexedDB, Cache Storage, cookies readable by JS, the URL or history state.
 */
runOnlyAt390();

const PIN = '739204';
const NEW_PIN = '582917';
const PASSWORD = 'Unique-Secret-Passphrase-77';
const TOTP = '908172';

test('D-01 failed and successful sign-in, then D-02: no secret anywhere', async ({ page }) => {
  const api = new MockApi(page);
  api.sequence('POST', '/v1/auth/login', [
    apiError('AUTH_INVALID_CREDENTIALS', 401),
    loginResult(driverMe({ mustChange: true }), { must_change_secret: true }),
  ]);
  api.on('POST', '/v1/auth/secret/change', () => {
    api.me = driverMe();
    return ok(api.me);
  });
  await api.install();
  await page.goto('/login');
  await page.getByLabel('رقم الجوال').fill('0551234567');
  await page.getByLabel('الرقم السري', { exact: true }).fill(PIN);
  await page.getByRole('button', { name: 'دخول', exact: true }).click();
  await expect(page.locator('#login-secret-err')).toBeVisible();
  expect(await browserStorageDump(page)).not.toContain(PIN);

  api.me = driverMe({ mustChange: true });
  await page.getByLabel('الرقم السري', { exact: true }).fill(PIN);
  await page.getByRole('button', { name: 'دخول', exact: true }).click();
  await expect(page).toHaveURL(/\/account\/secret$/);
  await page.getByLabel('الرقم السري الحالي').fill(PIN);
  await page.getByLabel('الرقم السري الجديد').fill(NEW_PIN);
  await page.getByLabel('تأكيد الرقم الجديد').fill(NEW_PIN);
  await page.getByRole('button', { name: 'حفظ والمتابعة' }).click();
  await expect(page).toHaveURL(/\/d\/start$/);

  const dump = await browserStorageDump(page);
  expect(dump).not.toContain(PIN);
  expect(dump).not.toContain(NEW_PIN);
  expect(page.url()).not.toContain(PIN);
});

test('S-01 password and TOTP code: no secret anywhere', async ({ page }) => {
  const api = new MockApi(page);
  api.on('POST', '/v1/auth/login', loginResult(null, { mfa_required: true, mfa_token: 'mfa-tok-9' }));
  api.on('POST', '/v1/auth/mfa/verify', () => {
    api.me = staffMe();
    return ok(api.me);
  });
  await api.install();
  await page.goto('/staff/login');
  await page.getByLabel('رقم الجوال').fill('0501234567');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول', exact: true }).click();
  await page.getByLabel('الرقم 1').fill(TOTP);
  expect(await browserStorageDump(page)).not.toContain('mfa-tok-9'); // the mfa_token lives in memory only
  await page.getByRole('button', { name: 'تحقق' }).click();
  await expect(page).toHaveURL(/\/ops$/);

  const dump = await browserStorageDump(page);
  for (const secret of [PASSWORD, TOTP, 'mfa-tok-9']) expect(dump).not.toContain(secret);
});
