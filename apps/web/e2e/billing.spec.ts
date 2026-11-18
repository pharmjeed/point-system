import { expect, test, type Page } from '@playwright/test';
import { MockApi, apiError, mockStaffApi, ok, roleMe } from './support/api';
import { expectMobileLayout } from './support/checks';

/**
 * V5 (V2-040 … V2-042): P-09 «التسوية» and P-10 «الفواتير» in the platform console, O-05 «كشف التسوية» and O-06
 * «اشتراك النظام» in the staff administration — at 360, 390 and 430 px with the API mocked in the browser: RTL, no
 * horizontal scroll, the statement's breakdown adding up to its net, an adjustment with a signed amount and a
 * reason, the issue, the operator's dispute, the invoices with their provider status — each command once, with its
 * Idempotency-Key and the statement's expected_version.
 */

const NOW = () => new Date().toISOString();
const ST = '00000000-0000-4000-8000-00000000a501';
const INV = '00000000-0000-4000-8000-00000000a502';

const platformMe = (role: string, permissions: string[]) => ({
  user: {
    id: 'pu-1',
    full_name: 'حساب المالية',
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
const FINANCE = platformMe('platform_finance', [
  'platform.payment_read',
  'platform.settlement_manage',
  'platform.invoice_read',
]);

const statement = (status: string, version = 3, over: Record<string, unknown> = {}) => ({
  id: ST,
  org_id: 'org-1',
  period: '2026-10',
  period_start: '2026-10-01',
  period_end: '2026-11-01',
  status,
  subscriber_visit_count: 4,
  subscriber_payout_halalas: 3000,
  app_payment_count: 2,
  app_gross_halalas: 4645,
  app_commission_halalas: 523,
  app_refund_halalas: 1001,
  app_refund_commission_halalas: 100,
  saas_fee_halalas: 110324,
  saas_vat_halalas: 16548,
  adjustments_halalas: 0,
  net_payable_halalas: -120651,
  computed_at: NOW(),
  issued_at: status === 'draft' ? null : NOW(),
  disputed_at: null,
  dispute_reason: null,
  dispute_resolved_at: null,
  dispute_resolution: null,
  paid_at: null,
  paid_on: null,
  paid_reference: null,
  voided_at: null,
  void_reason: null,
  saas_invoice_id: status === 'draft' ? null : INV,
  version,
  org: { id: 'org-1', name_ar: 'مؤسسة الفاليت التجريبية', operator_status: 'active' },
  ...over,
});

const lines = [
  {
    id: 'l1',
    kind: 'subscriber_visit',
    amount_halalas: 700,
    base_halalas: null,
    rate_bp: null,
    quantity_days: null,
    occurred_on: '2026-10-01',
    venue: { id: 'v1', name_ar: 'قاعة ريماس' },
    ticket: { id: 't1', display_number: 17 },
    online_payment_id: null,
    refund_id: null,
    note: null,
    created_at: NOW(),
    released_at: null,
  },
  {
    id: 'l2',
    kind: 'saas_fee',
    amount_halalas: -24194,
    base_halalas: 50000,
    rate_bp: null,
    quantity_days: 15,
    occurred_on: '2026-10-01',
    venue: { id: 'v1', name_ar: 'قاعة ريماس' },
    ticket: null,
    online_payment_id: null,
    refund_id: null,
    note: null,
    created_at: NOW(),
    released_at: null,
  },
];

const invoice = {
  id: INV,
  number: 'PB-00000001',
  series: 'standard',
  kind: 'operator_standard',
  type_code: 388,
  icv: 1,
  uuid: '3cf5ee18-ee25-44ea-a444-2c37ba7f28be',
  issued_at: NOW(),
  supply_date: '2026-10-01',
  period_start: '2026-10-01',
  period_end: '2026-11-01',
  vat_rate_bp: 1500,
  subtotal_halalas: 110324,
  vat_halalas: 16548,
  total_halalas: 126872,
  seller: {
    legal_name_ar: 'شركة تجريبية',
    vat_number: '399999999900003',
    cr_number: '0000000000',
    address_ar: 'الرياض',
  },
  buyer: { kind: 'operator', legal_name_ar: 'شركة المشغل الأول المحدودة', vat_number: '310000000000003' },
  lines: [
    {
      description_ar: 'اشتراك نظام التشغيل — قاعة ريماس — 2026-10 (15 يومًا)',
      description_en: 'Operating system subscription',
      quantity: 1,
      net_halalas: 110324,
      vat_rate_bp: 1500,
      vat_halalas: 16548,
      total_halalas: 126872,
    },
  ],
  original: null,
  credit_reason: null,
  status: 'cleared',
  provider: 'simulator',
  provider_reference: `sim-${INV}`,
  provider_codes: [],
  pdf_url: 'https://storage.example.test/invoices/standard/PB-00000001.pdf?sig=1',
  pdf_url_expires_at: NOW(),
  provider_events: [{ id: 1, kind: 'submit', outcome: 'accepted', status: 'cleared', occurred_at: NOW() }],
  credit_notes: [],
};

function mockPlatform(page: Page) {
  const api = new MockApi(page, null);
  let current = statement('draft');
  api.on('GET', '/v1/platform/me', ok(FINANCE));
  api.on('GET', '/v1/platform/settlements', () => ok([current]));
  api.on('GET', `/v1/platform/settlements/${ST}`, () =>
    ok({ ...current, lines, invoices: current.status === 'draft' ? [] : [{ ...invoice }], history: [] }),
  );
  api.on('POST', `/v1/platform/settlements/${ST}/adjustments`, (req) => {
    const body = JSON.parse(req.postData() ?? '{}');
    if (body.expected_version !== current.version) return apiError('VERSION_CONFLICT', 409);
    current = statement('draft', current.version + 1, {
      adjustments_halalas: body.amount_halalas,
      net_payable_halalas: -120651 + body.amount_halalas,
    });
    return ok({ statement: current, line_id: 'l9' });
  });
  api.on('POST', `/v1/platform/settlements/${ST}/issue`, () => {
    current = statement('issued', current.version + 1, {
      adjustments_halalas: current.adjustments_halalas,
      net_payable_halalas: current.net_payable_halalas,
    });
    return ok({ statement: current, saas_invoice: { id: INV, number: 'PB-00000001' } });
  });
  api.on('POST', '/v1/platform/settlements/generate', () => ok({ period: '2026-10', results: [] }));
  api.on(
    'GET',
    '/v1/platform/invoices',
    ok([{ ...invoice, org: { id: 'org-1', name_ar: 'مؤسسة الفاليت' }, account: null, pdf_ready: true }]),
  );
  api.on('GET', `/v1/platform/invoices/${INV}`, ok(invoice));
  return api;
}

test('P-09 (finance): the breakdown adds up, an adjustment with a signed amount, then the issue', async ({
  page,
}) => {
  const api = await mockPlatform(page).install();
  await page.goto('/platform/settlements');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('التسوية');
  await expect(page.getByText('2026-10').filter({ visible: true }).first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expectMobileLayout(page);

  await page.getByRole('button', { name: 'فتح' }).first().click();
  await expect(page.getByTestId('settlement-breakdown')).toContainText('زيارات المشتركين (4)');
  await expect(page.getByTestId('settlement-breakdown')).toContainText('يدفعه المشغل للمنصة');
  await expect(page.getByTestId('settlement-lines')).toContainText('تذكرة 17');
  await expectMobileLayout(page);

  await page.getByRole('button', { name: 'تسوية يدوية' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'إضافة تسوية يدوية' });
  await expect(dialog).toBeVisible();
  await expectMobileLayout(page);
  const confirm = dialog.getByRole('button', { name: 'تسوية يدوية' });
  await dialog.getByLabel('المبلغ بالريال (مثل -12.50)').fill('0');
  await dialog.getByLabel('السبب').fill('زيارة مكررة في الكشف');
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('المبلغ بالريال (مثل -12.50)').fill('-12.34');
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  const adj = api.callsTo('POST', `/v1/platform/settlements/${ST}/adjustments`);
  expect(adj).toHaveLength(1);
  expect(adj[0]?.body).toEqual({
    expected_version: 3,
    amount_halalas: -1234,
    reason: 'زيارة مكررة في الكشف',
  });
  expect(adj[0]?.headers['idempotency-key']).toBeTruthy();

  await page.getByRole('button', { name: 'إصدار الكشف' }).click();
  const issue = page.getByRole('alertdialog', { name: 'إصدار الكشف للمشغل' });
  await issue.getByRole('button', { name: 'إصدار الكشف' }).click();
  await expect(issue).toHaveCount(0);
  const issued = api.callsTo('POST', `/v1/platform/settlements/${ST}/issue`);
  expect(issued).toHaveLength(1);
  expect(issued[0]?.body).toEqual({ expected_version: 4 });
  await expect(page.getByText('PB-00000001')).toBeVisible();
  await expect(page.getByRole('button', { name: 'تسجيل الدفع' })).toBeVisible();
});

test('P-10 (finance): the invoices with their provider status, a tax invoice and its PDF link', async ({
  page,
}) => {
  await mockPlatform(page).install();
  await page.goto('/platform/invoices');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('الفواتير');
  await expect(page.getByText('PB-00000001').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText('معتمدة').filter({ visible: true }).first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expectMobileLayout(page);
  await page.getByRole('button', { name: 'فتح' }).first().click();
  await expect(page.getByTestId('invoice-detail')).toContainText('شركة المشغل الأول المحدودة');
  await expect(page.getByText('محاكاة: لم يُرسل شيء إلى الهيئة.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'تنزيل PDF' })).toHaveAttribute('href', /PB-00000001\.pdf/);
  await expectMobileLayout(page);
});

test('O-05 / O-06 (owner): the issued statement, a dispute with a reason; the system subscription', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('owner'));
  mockStaffApi(api);
  let current = statement('issued', 5);
  api.on('GET', '/v1/settlement-statements', () => ok([current]));
  api.on('GET', `/v1/settlement-statements/${ST}`, () => ok({ ...current, lines, invoices: [invoice] }));
  api.on('POST', `/v1/settlement-statements/${ST}/dispute`, (req) => {
    const body = JSON.parse(req.postData() ?? '{}');
    current = statement('disputed', 6, { dispute_reason: body.reason, disputed_at: NOW() });
    return ok(current);
  });
  api.on(
    'GET',
    '/v1/system-subscription',
    ok({
      operator: {
        name_ar: 'مؤسسة الفاليت',
        legal_name: 'شركة المشغل الأول المحدودة',
        vat_number: '310000000000003',
        cr_number: '1010000001',
        operator_status: 'active',
      },
      contract: {
        id: 'c2',
        starts_on: '2026-10-16',
        ends_on: null,
        saas_fee_halalas_per_venue: 60000,
        saas_cycle: 'monthly',
        subscriber_visit_payout_halalas: 800,
        app_payment_commission_bp: 1250,
        state: 'current',
      },
      contracts: [],
      active_venues: 2,
      invoices: [invoice],
    }),
  );
  api.on('GET', `/v1/system-subscription/invoices/${INV}`, ok(invoice));
  await api.install();

  await page.goto('/admin');
  await expect(page.getByRole('link', { name: 'كشف التسوية' })).toBeVisible();
  await page.goto('/admin/settlements');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('كشف التسوية');
  await page.evaluate(() => document.fonts.ready);
  await expectMobileLayout(page);
  await page.getByRole('button', { name: 'عرض' }).first().click();
  await expect(page.getByTestId('settlement-breakdown')).toContainText('اشتراك النظام');
  await expectMobileLayout(page);
  await page.getByRole('button', { name: 'اعتراض' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'الاعتراض على الكشف' });
  await dialog.getByLabel('السبب').fill('عدد الزيارات أقل من الفعلي');
  await dialog.getByRole('button', { name: 'اعتراض' }).click();
  await expect(dialog).toHaveCount(0);
  const calls = api.callsTo('POST', `/v1/settlement-statements/${ST}/dispute`);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body).toEqual({ expected_version: 5, reason: 'عدد الزيارات أقل من الفعلي' });
  expect(calls[0]?.headers['idempotency-key']).toBeTruthy();
  await expect(page.getByText('معترض عليه').first()).toBeVisible();

  await page.goto('/admin/subscription');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('اشتراك النظام');
  await expect(page.getByTestId('operator-subscription')).toContainText('شركة المشغل الأول المحدودة');
  await expect(page.getByText('PB-00000001').filter({ visible: true }).first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expectMobileLayout(page);
});

test('a supervisor has no settlement section (settlement.read: owner and administration)', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  await api.install();
  await page.goto('/admin/settlements');
  await expect(page.getByRole('link', { name: 'كشف التسوية' })).toHaveCount(0);
  expect(api.calls.filter((c) => c.path === '/v1/settlement-statements')).toHaveLength(0);
});
