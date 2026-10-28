import { expect, test } from '@playwright/test';
import { apiError, driverMe, MockApi, ok, staffMe } from './support/api';
import { runOnlyAt390 } from './support/checks';

/** Session end (02 §1.6, §1.9, D-15 c; 08 §3 relogin), sign-out (D-14) and the theme switch (DEC-19). */
runOnlyAt390();

test('a revoked session (transfer) shows D-15 with the new venue', async ({ page }) => {
  await new MockApi(page)
    .on(
      'GET',
      '/v1/me',
      apiError('AUTH_SESSION_REVOKED', 401, { details: { reason: 'transfer', venue_name_ar: 'قاعة ليلتي' } }),
    )
    .install();
  await page.goto('/d');
  await expect(page).toHaveURL(/\/session-ended$/);
  await expect(page.getByRole('heading', { name: 'انتهت جلستك' })).toBeVisible();
  await expect(
    page.getByText('تم نقلك إلى قاعة ليلتي. سجّل الدخول لمتابعة العمل في موقعك الجديد.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test('an expired session on any request ends the shell (D-15, expiry text)', async ({ page }) => {
  const api = new MockApi(page, driverMe());
  api.on('POST', '/v1/me/duty/start', apiError('AUTH_SESSION_EXPIRED', 401));
  await api.install();
  await page.goto('/d/start');
  await page.getByRole('button', { name: 'بدء الوردية' }).click();
  await expect(page).toHaveURL(/\/session-ended$/);
  await expect(page.getByText('انتهت مدة الجلسة. سجّل الدخول من جديد.')).toBeVisible();
});

test('staff: a revoked session returns to S-01 with the reason line', async ({ page }) => {
  await new MockApi(page)
    .on('GET', '/v1/me', apiError('AUTH_SESSION_REVOKED', 401, { details: { reason: 'admin' } }))
    .install();
  await page.goto('/ops');
  await expect(page).toHaveURL(/\/staff\/login$/);
  await expect(page.getByText('أُنهيت جلستك من الإدارة. سجّل الدخول من جديد.')).toBeVisible();
});

test('no session at all → D-01', async ({ page }) => {
  await new MockApi(page).install();
  await page.goto('/d/account');
  await expect(page).toHaveURL(/\/login$/);
});

test('D-14 sign-out off duty: POST /v1/auth/logout then D-01', async ({ page }) => {
  const api = await new MockApi(page, driverMe({ onDuty: false, state: 'off_duty' })).install();
  // An off-duty driver reaches D-14 through the tabs only when on duty; open it directly.
  await page.goto('/d/account');
  await page.getByRole('button', { name: 'تسجيل الخروج' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(api.callsTo('POST', '/v1/auth/logout')).toHaveLength(1);
});

test('D-14 sign-out on duty asks to end the shift first, then ends it and signs out', async ({ page }) => {
  const api = new MockApi(page, driverMe({ onDuty: true }));
  api.on('POST', '/v1/me/duty/end', () => ok({ duty_session: { status: 'ended' } }));
  await api.install();
  await page.goto('/d/account');
  await page.getByRole('button', { name: 'تسجيل الخروج' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('أنهِ ورديتك قبل تسجيل الخروج حتى لا تُحسب متاحًا.');
  await dialog.getByRole('button', { name: 'إنهاء الوردية والخروج' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(api.callsTo('POST', '/v1/me/duty/end')[0]?.headers['idempotency-key']).toBeTruthy();
  expect(api.callsTo('POST', '/v1/auth/logout')).toHaveLength(1);
});

test('theme: driver follows the device, the D-14 switch persists; staff stays light', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await new MockApi(page, driverMe({ onDuty: true })).install();
  await page.goto('/d/account');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
  await page.getByRole('radio', { name: 'فاتح' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('radio', { name: 'فاتح' })).toHaveAttribute('aria-checked', 'true');
});

test('theme: supervisor/admin screens are light by default even on a dark device', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await new MockApi(page, staffMe()).install();
  await page.goto('/ops');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});
