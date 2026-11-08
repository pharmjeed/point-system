import { expect, test, type Page } from '@playwright/test';
import { errorMessagesAr } from '../src/i18n/errors';
import { apiError, driverMe, loginResult, MockApi, staffMe, type Reply } from './support/api';
import { runOnlyAt390 } from './support/checks';

runOnlyAt390();

async function fillAndSubmit(page: Page, phone = '0551234567', secret = '482915') {
  await page.getByLabel('رقم الجوال').fill(phone);
  await page.getByLabel('الرقم السري', { exact: true }).fill(secret);
  await page.getByRole('button', { name: 'دخول', exact: true }).click();
}

test.describe('D-01 — each sign-in error shows its 08 text (PNT-022 acceptance 1)', () => {
  const lockedUntil = () => new Date(Date.now() + 15 * 60_000).toISOString();
  const cases: Array<{
    code: keyof typeof errorMessagesAr;
    reply: () => Reply;
    check: (page: Page) => Promise<void>;
  }> = [
    {
      code: 'AUTH_INVALID_CREDENTIALS',
      reply: () => apiError('AUTH_INVALID_CREDENTIALS', 401),
      check: async (page) => {
        await expect(page.locator('#login-secret-err')).toHaveText(errorMessagesAr.AUTH_INVALID_CREDENTIALS);
        await expect(page.getByLabel('الرقم السري', { exact: true })).toHaveValue(''); // only the secret is cleared
        await expect(page.getByLabel('رقم الجوال')).toHaveValue('0551234567');
      },
    },
    {
      code: 'AUTH_ACCOUNT_LOCKED',
      reply: () => apiError('AUTH_ACCOUNT_LOCKED', 423, { details: { locked_until: lockedUntil() } }),
      check: async (page) => {
        await expect(page.getByText(errorMessagesAr.AUTH_ACCOUNT_LOCKED)).toBeVisible();
        await expect(page.getByText(/يمكنك المحاولة بعد 1[45]:\d\d/)).toBeVisible();
        await expect(page.getByRole('button', { name: 'دخول', exact: true })).toBeDisabled();
      },
    },
    {
      code: 'AUTH_ACCOUNT_DISABLED',
      reply: () => apiError('AUTH_ACCOUNT_DISABLED', 403),
      check: async (page) => {
        const dialog = page.getByRole('alertdialog');
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText(errorMessagesAr.AUTH_ACCOUNT_DISABLED);
        await dialog.getByRole('button', { name: 'فهمت' }).click();
        await expect(dialog).toBeHidden();
      },
    },
    {
      code: 'PHONE_INVALID',
      reply: () => apiError('PHONE_INVALID', 422, { details: { field: 'phone' } }),
      check: async (page) => {
        await expect(page.locator('#login-phone-err')).toHaveText(errorMessagesAr.PHONE_INVALID);
      },
    },
    {
      code: 'VALIDATION_FAILED',
      reply: () =>
        apiError('VALIDATION_FAILED', 422, {
          details: { fields: [{ field: 'secret', issue: 'too_short', message_ar: 'الرقم السري 6 أرقام.' }] },
        }),
      check: async (page) => {
        await expect(page.locator('#login-secret-err')).toHaveText('الرقم السري 6 أرقام.');
      },
    },
    {
      code: 'RATE_LIMITED',
      reply: () => apiError('RATE_LIMITED', 429, { headers: { 'Retry-After': '30' } }),
      check: async (page) => {
        await expect(page.getByText(errorMessagesAr.RATE_LIMITED)).toBeVisible();
        await expect(page.getByRole('button', { name: 'دخول', exact: true })).toBeDisabled();
      },
    },
    {
      code: 'INTERNAL_ERROR',
      reply: () => apiError('INTERNAL_ERROR', 500),
      check: async (page) => {
        await expect(page.getByText(errorMessagesAr.INTERNAL_ERROR)).toBeVisible();
        await expect(page.getByText('رمز المتابعة: req_e2e_INTERNAL_ERROR')).toBeVisible();
      },
    },
    {
      code: 'SERVICE_UNAVAILABLE',
      reply: () => apiError('SERVICE_UNAVAILABLE', 503, { headers: { 'Retry-After': '5' } }),
      check: async (page) => {
        await expect(page.getByText(errorMessagesAr.SERVICE_UNAVAILABLE)).toBeVisible();
      },
    },
  ];

  for (const c of cases) {
    test(c.code, async ({ page }) => {
      const api = await new MockApi(page).on('POST', '/v1/auth/login', c.reply).install();
      await page.goto('/login');
      await fillAndSubmit(page);
      await c.check(page);
      expect(api.callsTo('POST', '/v1/auth/login')).toHaveLength(1);
    });
  }

  test('the server text is the one shown (message_ar first, 08 map as fallback)', async ({ page }) => {
    await new MockApi(page)
      .on(
        'POST',
        '/v1/auth/login',
        apiError('AUTH_INVALID_CREDENTIALS', 401, { message_ar: 'رقم الجوال أو الرقم السري غير صحيح.' }),
      )
      .install();
    await page.goto('/login');
    await fillAndSubmit(page);
    await expect(page.locator('#login-secret-err')).toHaveText('رقم الجوال أو الرقم السري غير صحيح.');
  });

  test('AUTH_SECRET_CHANGE_REQUIRED opens D-02', async ({ page }) => {
    const api = new MockApi(page);
    api.on('POST', '/v1/auth/login', () => {
      api.me = driverMe({ mustChange: true });
      return apiError('AUTH_SECRET_CHANGE_REQUIRED', 403, { details: { secret_kind: 'pin' } });
    });
    await api.install();
    await page.goto('/login');
    await fillAndSubmit(page);
    await expect(page).toHaveURL(/\/account\/secret$/);
    await expect(page.getByRole('heading', { name: 'تغيير الرقم السري' })).toBeVisible();
  });
});

test.describe('D-01 — request and navigation', () => {
  test('sends E.164, the CSRF header and no Idempotency-Key; Arabic digits are normalised', async ({
    page,
  }) => {
    const api = await new MockApi(page)
      .on('POST', '/v1/auth/login', apiError('AUTH_INVALID_CREDENTIALS', 401))
      .install();
    await page.goto('/login');
    await fillAndSubmit(page, '٠٥٥ ١٢٣ ٤٥٦٧');
    await expect(page.locator('#login-secret-err')).toBeVisible();
    const [call] = api.callsTo('POST', '/v1/auth/login');
    expect(call?.body).toEqual({ phone: '+966551234567', secret: '482915' });
    expect(call?.headers['x-requested-with']).toBe('point-web');
    expect(call?.headers['idempotency-key']).toBeUndefined();
  });

  test('an invalid phone is caught locally (no request)', async ({ page }) => {
    const api = await new MockApi(page).install();
    await page.goto('/login');
    await fillAndSubmit(page, '0123');
    await expect(page.locator('#login-phone-err')).toHaveText('أدخل رقم جوال سعودي صحيح يبدأ بـ 5.');
    expect(api.callsTo('POST', '/v1/auth/login')).toHaveLength(0);
  });

  test('a double press sends one request', async ({ page }) => {
    const api = new MockApi(page);
    api.on('POST', '/v1/auth/login', async () => {
      await new Promise((r) => setTimeout(r, 400));
      return apiError('AUTH_INVALID_CREDENTIALS', 401);
    });
    await api.install();
    await page.goto('/login');
    await page.getByLabel('رقم الجوال').fill('0551234567');
    await page.getByLabel('الرقم السري', { exact: true }).fill('482915');
    await page.getByLabel('الرقم السري', { exact: true }).press('Enter');
    await page.getByLabel('الرقم السري', { exact: true }).press('Enter');
    await expect(page.locator('#login-secret-err')).toBeVisible();
    expect(api.callsTo('POST', '/v1/auth/login')).toHaveLength(1);
  });

  const destinations: Array<[string, () => Reply, RegExp]> = [
    ['driver without an open duty → D-03', () => loginResult(driverMe()), /\/d\/start$/],
    ['driver with an open duty → D-04', () => loginResult(driverMe({ onDuty: true })), /\/d$/],
    [
      'first sign-in (temporary PIN) → D-02',
      () => loginResult(driverMe({ mustChange: true }), { must_change_secret: true }),
      /\/account\/secret$/,
    ],
    ['staff account → S-02', () => loginResult(staffMe()), /\/ops$/],
    [
      'MFA account → S-01 code step',
      () => loginResult(null, { mfa_required: true, mfa_token: 'mfa-tok-1' }),
      /\/staff\/login$/,
    ],
  ];
  for (const [name, reply, url] of destinations) {
    test(name, async ({ page }) => {
      const api = new MockApi(page);
      api.on('POST', '/v1/auth/login', () => {
        const r = reply();
        const me = (r.body as { data: { me: Record<string, unknown> | null } }).data.me;
        if (me) api.me = me;
        return r;
      });
      await api.install();
      await page.goto('/login');
      await fillAndSubmit(page);
      await expect(page).toHaveURL(url);
    });
  }

  test('MFA hand-over shows the code step', async ({ page }) => {
    await new MockApi(page)
      .on('POST', '/v1/auth/login', loginResult(null, { mfa_required: true, mfa_token: 't' }))
      .install();
    await page.goto('/login');
    await fillAndSubmit(page);
    await expect(page.getByText('أدخل رمز التحقق من تطبيق المصادقة')).toBeVisible();
  });

  test('offline: banner and disabled button (D-01 states)', async ({ page, context }) => {
    await new MockApi(page).install();
    await page.goto('/login');
    await page.getByLabel('رقم الجوال').fill('0551234567');
    await page.getByLabel('الرقم السري', { exact: true }).fill('482915');
    await context.setOffline(true);
    await expect(page.getByRole('alert').filter({ hasText: 'لا يوجد اتصال بالإنترنت.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'دخول', exact: true })).toBeDisabled();
    await context.setOffline(false);
    await expect(page.getByRole('button', { name: 'دخول', exact: true })).toBeEnabled();
  });

  test('a signed-in user opening /login goes to their shell', async ({ page }) => {
    await new MockApi(page, driverMe({ onDuty: true })).install();
    await page.goto('/login');
    await expect(page).toHaveURL(/\/d$/);
  });

  test('the staff link opens S-01', async ({ page }) => {
    await new MockApi(page).install();
    await page.goto('/login');
    await page.getByRole('link', { name: 'دخول المشرفين والإدارة' }).click();
    await expect(page).toHaveURL(/\/staff\/login$/);
    await expect(page.getByRole('heading', { name: 'دخول المشرفين والإدارة' })).toBeVisible();
  });
});
