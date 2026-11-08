import { expect, test, type Page } from '@playwright/test';
import { errorMessagesAr } from '../src/i18n/errors';
import { apiError, loginResult, MockApi, ok, staffMe } from './support/api';
import { runOnlyAt390 } from './support/checks';

runOnlyAt390();

async function signIn(page: Page, password = 'correct-horse-battery') {
  await page.getByLabel('رقم الجوال').fill('0501234567');
  await page.getByLabel('كلمة المرور').fill(password);
  await page.getByRole('button', { name: 'دخول', exact: true }).click();
}

async function typeCode(page: Page, code: string) {
  await page.getByLabel('الرقم 1').fill(code); // one-time-code autofill / paste spreads over the cells
}

test.describe('S-01 — staff sign-in and two-factor', () => {
  test('step 2: wrong code, then the right code → S-02', async ({ page }) => {
    const api = new MockApi(page);
    api.on('POST', '/v1/auth/login', loginResult(null, { mfa_required: true, mfa_token: 'mfa-tok-1' }));
    api.sequence('POST', '/v1/auth/mfa/verify', [
      apiError('AUTH_MFA_INVALID', 401, { details: { attempts_left: 4 } }),
      ok(staffMe()),
    ]);
    api.on('GET', '/v1/me', () =>
      api.callsTo('POST', '/v1/auth/mfa/verify').length >= 2
        ? ok(staffMe())
        : apiError('AUTH_UNAUTHENTICATED', 401),
    );
    await api.install();
    await page.goto('/staff/login');
    await signIn(page);

    await expect(page.getByText('أدخل رمز التحقق من تطبيق المصادقة')).toBeVisible();
    await typeCode(page, '123456');
    await page.getByRole('button', { name: 'تحقق' }).click();
    await expect(page.getByText(errorMessagesAr.AUTH_MFA_INVALID)).toBeVisible();
    await expect(page.getByLabel('الرقم 1')).toHaveValue(''); // the wrong code is cleared

    await typeCode(page, '654321');
    await page.getByRole('button', { name: 'تحقق' }).click();
    await expect(page).toHaveURL(/\/ops$/);
    const calls = api.callsTo('POST', '/v1/auth/mfa/verify');
    expect(calls[1]?.body).toEqual({ mfa_token: 'mfa-tok-1', code: '654321' });
    expect(calls[1]?.headers['x-requested-with']).toBe('point-web');
  });

  test('step 2: an expired mfa_token returns to phone + password with the reason', async ({ page }) => {
    await new MockApi(page)
      .on('POST', '/v1/auth/login', loginResult(null, { mfa_required: true, mfa_token: 'old' }))
      .on('POST', '/v1/auth/mfa/verify', apiError('AUTH_MFA_REQUIRED', 401))
      .install();
    await page.goto('/staff/login');
    await signIn(page);
    await typeCode(page, '123456');
    await page.getByRole('button', { name: 'تحقق' }).click();
    await expect(page.getByText(errorMessagesAr.AUTH_MFA_REQUIRED)).toBeVisible();
    await expect(page.getByLabel('كلمة المرور')).toBeVisible();
  });

  test('wrong password: 08 text, password cleared, phone kept', async ({ page }) => {
    await new MockApi(page).on('POST', '/v1/auth/login', apiError('AUTH_INVALID_CREDENTIALS', 401)).install();
    await page.goto('/staff/login');
    await signIn(page);
    await expect(page.locator('#staff-password-err')).toHaveText(errorMessagesAr.AUTH_INVALID_CREDENTIALS);
    await expect(page.getByLabel('كلمة المرور')).toHaveValue('');
    await expect(page.getByLabel('رقم الجوال')).toHaveValue('0501234567');
  });

  test('first sign-in: step 3 password change, then step 4 MFA setup → S-02', async ({ page }) => {
    const api = new MockApi(page);
    api.on('POST', '/v1/auth/login', () => {
      api.me = staffMe({ mustChange: true, restricted: true });
      return loginResult(api.me, { must_change_secret: true, mfa_setup_required: true });
    });
    api.on('POST', '/v1/auth/secret/change', () => {
      api.me = staffMe({ restricted: true });
      return ok(api.me);
    });
    api.on(
      'POST',
      '/v1/auth/mfa/setup',
      ok({
        otpauth_uri: 'otpauth://totp/POINT:0501234567?secret=JBSWY3DPEHPK3PXP&issuer=POINT',
        secret_base32: 'JBSWY3DPEHPK3PXP',
      }),
    );
    api.on('POST', '/v1/auth/mfa/confirm', () => {
      api.me = staffMe();
      return ok(api.me);
    });
    await api.install();
    await page.goto('/staff/login');
    await signIn(page, 'Temp-Pass-1234');

    await expect(page.getByRole('heading', { name: 'تغيير كلمة المرور' })).toBeVisible();
    await page.getByLabel('كلمة المرور الحالية').fill('Temp-Pass-1234');
    await page.getByLabel('كلمة المرور الجديدة').fill('short');
    await page.getByLabel('تأكيدها').fill('short');
    await page.getByRole('button', { name: 'حفظ والمتابعة' }).click();
    await expect(page.locator('#pw-next-err')).toHaveText('استخدم كلمة مرور طويلة يصعب تخمينها.');
    await page.getByLabel('كلمة المرور الجديدة').fill('a-much-longer-passphrase');
    await page.getByLabel('تأكيدها').fill('a-much-longer-passphrase');
    await page.getByRole('button', { name: 'حفظ والمتابعة' }).click();

    await expect(page.getByRole('heading', { name: 'إعداد التحقق الثنائي' })).toBeVisible();
    await expect(
      page.getByRole('img', { name: 'رمز QR لإعداد التحقق الثنائي' }).locator('svg'),
    ).toBeVisible();
    await expect(page.getByText('JBSWY3DPEHPK3PXP')).toBeVisible();
    await typeCode(page, '246810');
    await page.getByRole('button', { name: 'تأكيد' }).click();
    await expect(page).toHaveURL(/\/ops$/);
    expect(api.callsTo('POST', '/v1/auth/mfa/setup')).toHaveLength(1); // the secret is issued once
    expect(api.callsTo('POST', '/v1/auth/mfa/confirm')[0]?.body).toEqual({ code: '246810' });
  });

  test('a restricted session opening a staff page is sent back to the pending S-01 step', async ({
    page,
  }) => {
    await new MockApi(page, staffMe({ restricted: true }))
      .on(
        'POST',
        '/v1/auth/mfa/setup',
        ok({ otpauth_uri: 'otpauth://totp/POINT:x?secret=ABC&issuer=POINT', secret_base32: 'ABC' }),
      )
      .install();
    await page.goto('/ops');
    await expect(page).toHaveURL(/\/staff\/login$/);
    await expect(page.getByRole('heading', { name: 'إعداد التحقق الثنائي' })).toBeVisible();
  });
});
