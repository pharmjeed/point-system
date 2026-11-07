import { expect, test, type Page } from '@playwright/test';
import { MockApi, ok } from './support/api';
import { browserStorageDump, expectMobileLayout } from './support/checks';

/**
 * V2-003 (P-01 … P-03): the platform console at 360, 390 and 430 px (one Playwright project each) with the platform
 * API mocked in the browser — RTL, no horizontal scroll, the screens per platform role, the owner's temporary
 * password shown once with a copy button and kept out of browser storage, the suspend dialog's reason.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const NOW = () => new Date().toISOString();
const PASSWORD = 'Tmp-Pass_1234567';

const platformMe = (role: string, permissions: string[]) => ({
  user: {
    id: 'pu-1',
    full_name: 'حساب المنصة',
    phone_masked: '05•••••001',
    role,
    status: 'active',
    mfa_enabled: true,
    must_change_secret: false,
  },
  permissions: ['platform.self', 'platform.overview_read', ...permissions],
  session: { expires_at: NOW(), mfa_verified: true, restricted: false, pending: [] },
  brand: { staff_name_ar: 'بوينت', staff_name_en: 'POINT' },
});
const OWNER = platformMe('platform_owner', ['platform.operator_read', 'platform.operator_manage']);
const FINANCE = platformMe('platform_finance', []);

const contract = {
  id: 'c-1',
  org_id: ORG,
  saas_fee_halalas_per_venue: 50000,
  saas_cycle: 'monthly',
  subscriber_visit_payout_halalas: 500,
  app_payment_commission_bp: 250,
  starts_on: '2026-10-01',
  ends_on: null,
  state: 'current',
  created_by: { id: 'pu-1', full_name: 'حساب المنصة' },
  created_at: NOW(),
};
const operator = (status = 'active') => ({
  id: ORG,
  name_ar: 'مؤسسة الفاليت التجريبية بالرياض والمنطقة الشرقية',
  name_en: 'Demo Valet',
  legal_name: 'شركة الفاليت التجريبية للخدمات اللوجستية المحدودة',
  cr_number: '1010123456',
  vat_number: '300000000000003',
  operator_status: status,
  is_platform_operated: false,
  venues_count: 2,
  active_venues_count: 2,
  staff_count: 15,
  current_contract: contract,
  created_at: NOW(),
});

function mockPlatform(page: Page, me: Record<string, unknown>) {
  const api = new MockApi(page, null);
  let status = 'active';
  api.on('GET', '/v1/platform/me', ok(me));
  api.on('GET', '/v1/platform/overview', () =>
    ok({
      operators: { total: 3, by_status: { invited: 0, trial: 1, active: 1, suspended: 1, terminated: 0 } },
      venues: { total: 12, active: 11 },
      drivers_on_duty: 48,
      tickets_today: 1234,
      day: '2026-11-07',
      generated_at: NOW(),
    }),
  );
  api.on('GET', '/v1/platform/operators', () => ok({ items: [operator(status)] }));
  api.on('GET', `/v1/platform/operators/${ORG}`, () =>
    ok({
      ...operator(status),
      venues: [
        { id: 'v1', code: 'RMS', name_ar: 'قاعة ريماس', city: 'الرياض', status: 'active' },
        { id: 'v2', code: 'LYL', name_ar: 'قاعة ليالي', city: null, status: 'active' },
      ],
      owner: {
        id: 'u-own',
        full_name: 'مالك المشغل',
        employee_code: 'O-0001',
        phone_masked: '05•••••123',
        status: 'active',
        last_login_at: null,
        temporary_password_reissuable: true,
      },
      status_history: [
        {
          action: 'operator.create',
          from_status: null,
          to_status: 'active',
          reason: null,
          occurred_at: NOW(),
          actor: { id: 'pu-1', full_name: 'حساب المنصة' },
        },
      ],
    }),
  );
  api.on('GET', `/v1/platform/operators/${ORG}/contracts`, ok({ items: [contract] }));
  api.on(
    'GET',
    `/v1/platform/operators/${ORG}/users`,
    ok({
      items: [
        {
          id: 'u-own',
          employee_code: 'O-0001',
          full_name: 'مالك المشغل',
          phone_masked: '05•••••123',
          role: 'owner',
          can_drive: false,
          status: 'active',
          mfa_enabled: false,
          last_login_at: null,
        },
      ],
    }),
  );
  api.on('POST', '/v1/platform/operators', () =>
    ok(
      {
        operator: { ...operator('trial'), id: 'org-new', current_contract: null },
        owner: { id: 'u-new', full_name: 'مالك الشمال', employee_code: 'O-0001', phone_masked: '05•••••001' },
        temporary_password: PASSWORD,
      },
      201,
    ),
  );
  api.on('POST', `/v1/platform/operators/${ORG}/suspend`, () => {
    status = 'suspended';
    return ok(operator(status));
  });
  return api;
}

test('P-01 overview — layout and counts for every platform role', async ({ page }) => {
  await mockPlatform(page, FINANCE).install();
  await page.goto('/platform');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('النظرة العامة');
  await expect(page.getByText('1234')).toBeVisible();
  await expect(page.getByText('48')).toBeVisible();
  // finance: no P-02 destination
  await expect(page.getByRole('link', { name: 'المشغلون' })).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await expectMobileLayout(page);
});

test('P-02 operators — list, create with the owner password once (copy), never stored', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const api = await mockPlatform(page, OWNER).install();
  await page.goto('/platform/operators');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('المشغلون');
  await expect(
    page.locator('.pt-table-cards').getByText('مؤسسة الفاليت التجريبية بالرياض والمنطقة الشرقية'),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expectMobileLayout(page);

  await page.getByRole('button', { name: 'إضافة مشغل' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'إضافة مشغل' });
  await expect(sheet).toBeVisible();
  await expectMobileLayout(page);
  await sheet.getByLabel('اسم المشغل بالعربية').fill('مشغل الشمال');
  await sheet.getByLabel('الاسم القانوني (كما في السجل التجاري)').fill('شركة الشمال');
  await sheet.getByLabel('السجل التجاري (10 أرقام، اختياري)').fill('123');
  await sheet.getByLabel('اسم المالك').fill('مالك الشمال');
  await sheet.getByLabel('جوال المالك').fill('0551230001');
  await sheet.getByRole('button', { name: 'إضافة مشغل' }).click();
  await expect(sheet.getByText('السجل التجاري 10 أرقام.')).toBeVisible();
  expect(api.callsTo('POST', '/v1/platform/operators')).toHaveLength(0);
  await sheet.getByLabel('السجل التجاري (10 أرقام، اختياري)').fill('1010123456');
  await sheet.getByRole('button', { name: 'إضافة مشغل' }).click();

  const shown = page.getByTestId('operator-created-password');
  await expect(shown).toContainText(PASSWORD);
  const [call] = api.callsTo('POST', '/v1/platform/operators');
  expect(call?.headers['idempotency-key']).toBeTruthy();
  expect(call?.body).toMatchObject({
    name_ar: 'مشغل الشمال',
    cr_number: '1010123456',
    operator_status: 'trial',
    owner: { full_name: 'مالك الشمال', phone: '+966551230001' },
  });
  await expectMobileLayout(page);
  await shown.getByRole('button', { name: 'نسخ كلمة المرور' }).click();
  await expect(page.getByText('نُسخت كلمة المرور.')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PASSWORD);
  expect(await browserStorageDump(page)).not.toContain(PASSWORD);
  await page.getByRole('button', { name: 'فهمت' }).click();
  await expect(page.getByText(PASSWORD)).toHaveCount(0);
});

test('P-03 operator — details, contracts, users read-only; suspend asks for a reason', async ({ page }) => {
  const api = await mockPlatform(page, OWNER).install();
  await page.goto(`/platform/operators/${ORG}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/مؤسسة الفاليت التجريبية/);
  await expect(page.getByText('العقود').first()).toBeVisible();
  await expect(page.getByText('المستخدمون (قراءة فقط)')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expectMobileLayout(page);

  await page.getByRole('button', { name: 'تعليق' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'تعليق' });
  await expect(dialog).toBeVisible();
  await expectMobileLayout(page);
  const confirm = dialog.getByRole('button', { name: 'تعليق' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('السبب').fill('تأخر دفع اشتراك النظام');
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  const [call] = api.callsTo('POST', `/v1/platform/operators/${ORG}/suspend`);
  expect(call?.body).toEqual({ reason: 'تأخر دفع اشتراك النظام' });
  expect(call?.headers['idempotency-key']).toBeTruthy();
  await expect(page.getByRole('button', { name: 'إعادة التفعيل' })).toBeVisible();
});
