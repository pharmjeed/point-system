import { expect, test, type Page } from '@playwright/test';
import { MockApi, apiError, ok } from './support/api';
import { expectMobileLayout } from './support/checks';

/**
 * V2-024 (P-06 «العملاء», P-08 «المدفوعات والاسترداد»): the platform console screens at 360, 390 and 430 px (one
 * Playwright project each) and the desktop table layout at 1280 px, with the platform API mocked in the browser — RTL,
 * no horizontal scroll, 44px targets, the screens per platform role, masked phones only, the exact phone search,
 * suspend with a reason, the refund (amount ≤ refundable, a reason), the reconciliation runs and an alert resolved
 * with a note — each command once, with its Idempotency-Key.
 */

const NOW = () => new Date().toISOString();
const ACCOUNT = '00000000-0000-4000-8000-0000000000c1';
const PAYMENT = '00000000-0000-4000-8000-0000000000a1';
const RUN = '00000000-0000-4000-8000-0000000000b1';
const ALERT = '00000000-0000-4000-8000-0000000000d1';
const FULL_PHONE_DIGITS = '551230001';

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
const SUPPORT = platformMe('platform_support', ['platform.customer_read', 'platform.customer_manage']);
const FINANCE = platformMe('platform_finance', [
  'platform.customer_read',
  'platform.customer_manage',
  'platform.payment_read',
  'platform.refund_issue',
]);

const summary = (status = 'active') => ({
  id: ACCOUNT,
  display_name: 'سارة عبدالله القحطاني',
  phone_masked: '05•••••001',
  status,
  locale: 'ar',
  vehicles_count: 2,
  live_sessions: 1,
  created_at: NOW(),
  deleted_at: null,
});

const paymentRow = {
  id: PAYMENT,
  purpose: 'visit',
  status: 'paid',
  amount_halalas: 2300,
  vat_halalas: 300,
  refunded_halalas: 0,
  currency: 'SAR',
  gateway: 'moyasar',
  gateway_payment_id: 'pay_7f3a9c2b1e',
  source_type: 'token',
  card_brand: 'mada',
  card_last4: '4242',
  failure_code: null,
  account: { id: ACCOUNT, phone_masked: '05•••••001', status: 'active' },
  org: { id: 'org-1', name_ar: 'مؤسسة الفاليت التجريبية بالرياض' },
  venue: { id: 'v-rms', name_ar: 'قاعة ريماس للاحتفالات' },
  ticket_id: 't-1',
  subscription_id: null,
  created_at: NOW(),
  paid_at: NOW(),
};

const alert = (status = 'open') => ({
  id: ALERT,
  type: 'payment_mismatch',
  severity: 'critical',
  status,
  dedupe_key: `payment_mismatch:${PAYMENT}`,
  online_payment_id: PAYMENT,
  details: { point_status: 'paid', gateway_status: 'failed' },
  occurrences: 2,
  raised_at: NOW(),
  last_seen_at: NOW(),
  resolved_at: status === 'resolved' ? NOW() : null,
  resolved_by: status === 'resolved' ? { id: 'pu-1', full_name: 'حساب المنصة' } : null,
  resolution_note: status === 'resolved' ? 'طابقنا مع لوحة البوابة' : null,
});

function mockConsole(page: Page, me: Record<string, unknown>) {
  const api = new MockApi(page, null);
  let accountStatus = 'active';
  let alertStatus = 'open';
  api.on('GET', '/v1/platform/me', ok(me));
  api.on('GET', '/v1/platform/overview', () =>
    ok({
      operators: { total: 1, by_status: { invited: 0, trial: 0, active: 1, suspended: 0, terminated: 0 } },
      venues: { total: 2, active: 2 },
      drivers_on_duty: 3,
      tickets_today: 12,
      day: '2026-11-08',
      generated_at: NOW(),
    }),
  );
  api.on('GET', '/v1/platform/customers', (req) => {
    const phone = new URL(req.url()).searchParams.get('phone');
    return ok(phone && phone !== `+966${FULL_PHONE_DIGITS}` ? [] : [summary(accountStatus)]);
  });
  api.on('GET', `/v1/platform/customers/${ACCOUNT}`, () =>
    ok({
      ...summary(accountStatus),
      updated_at: NOW(),
      consents: {
        current: [
          {
            kind: 'terms',
            current_version: '2026-11-01',
            answered_version: '2026-11-01',
            granted: true,
            up_to_date: true,
            answered_at: NOW(),
          },
          {
            kind: 'privacy',
            current_version: '2026-11-01',
            answered_version: '2026-11-01',
            granted: true,
            up_to_date: true,
            answered_at: NOW(),
          },
          {
            kind: 'marketing',
            current_version: '2026-11-01',
            answered_version: '2026-10-01',
            granted: false,
            up_to_date: false,
            answered_at: NOW(),
          },
        ],
        history: [],
      },
      vehicles: [
        {
          id: 'veh-1',
          plate_display: 'ب ح د 4821',
          make: 'تويوتا',
          model: 'كامري',
          color: 'أبيض',
          type: 'sedan',
          created_at: NOW(),
          removed_at: null,
        },
      ],
      visits: [
        {
          ticket_id: 't-1',
          org: { id: 'org-1', name_ar: 'مؤسسة الفاليت التجريبية بالرياض' },
          venue: { id: 'v-rms', name_ar: 'قاعة ريماس للاحتفالات' },
          status: 'parked',
          open: true,
          channel: 'app',
          plate_display: 'ب ح د 4821',
          entitlement: 'none',
          received_at: NOW(),
          delivered_at: null,
        },
      ],
      sessions: {
        live: 1,
        total: 2,
        devices: 2,
        items: [
          {
            id: 's-1',
            platform: 'ios',
            device_hint: 'a1b2',
            live: true,
            push_enabled: true,
            created_at: NOW(),
            last_seen_at: NOW(),
            revoked_at: null,
            revoked_reason: null,
          },
          {
            id: 's-2',
            platform: 'android',
            device_hint: 'c3d4',
            live: false,
            push_enabled: false,
            created_at: NOW(),
            last_seen_at: null,
            revoked_at: NOW(),
            revoked_reason: 'logout',
          },
        ],
      },
      payment_methods: [
        {
          id: 'pm-1',
          brand: 'mada',
          last4: '4242',
          expires_month: 12,
          expires_year: 2030,
          is_default: true,
          created_at: NOW(),
          removed_at: null,
        },
      ],
      payments: [paymentRow],
      history: [],
    }),
  );
  api.on('POST', `/v1/platform/customers/${ACCOUNT}/suspend`, () => {
    accountStatus = 'suspended';
    return ok({ account: summary('suspended'), revoked_sessions: 0 });
  });
  api.on(
    'GET',
    '/v1/platform/payments',
    ok([
      paymentRow,
      { ...paymentRow, id: `${PAYMENT.slice(0, -1)}2`, status: 'failed', paid_at: null, failure_code: '51' },
    ]),
  );
  api.on('GET', `/v1/platform/payments/${PAYMENT}`, () =>
    ok({
      ...paymentRow,
      authorized_at: null,
      failed_at: null,
      refunded_at: null,
      gateway_updated_at: NOW(),
      updated_at: NOW(),
      version: 2,
      refundable_halalas: 2300,
      refund_pending_halalas: 0,
      refunds: [],
      status_history: [
        {
          action: 'online_payment.initiated',
          from_status: null,
          to_status: 'initiated',
          cause: null,
          failure_code: null,
          occurred_at: NOW(),
        },
        {
          action: 'online_payment.paid',
          from_status: 'initiated',
          to_status: 'paid',
          cause: 'call',
          failure_code: null,
          occurred_at: NOW(),
        },
      ],
      webhook_events: [
        {
          id: 1,
          event_type: 'payment_paid',
          live: false,
          received_at: NOW(),
          processed_at: NOW(),
          outcome: 'unchanged',
          claimed: { status: 'paid', amount_halalas: 2300, refunded_halalas: 0 },
        },
      ],
      alerts: [alert(alertStatus)],
    }),
  );
  api.on('POST', `/v1/platform/payments/${PAYMENT}/refunds`, (req) => {
    const body = JSON.parse(req.postData() ?? '{}');
    if ((body.amount_halalas ?? 2300) > 2300)
      return apiError('REFUND_AMOUNT_EXCEEDS_PAID', 409, { details: { refundable_halalas: 2300 } });
    return ok(
      {
        refund: { id: 'rf-1', status: 'requested', amount_halalas: body.amount_halalas ?? 2300 },
        payment: paymentRow,
      },
      201,
    );
  });
  api.on(
    'GET',
    '/v1/platform/reconciliation-runs',
    ok([
      {
        id: RUN,
        gateway: 'moyasar',
        run_date: '2026-11-07',
        status: 'mismatched',
        started_at: NOW(),
        finished_at: NOW(),
        gateway_count: 41,
        local_count: 40,
        matched_count: 40,
        mismatch_count: 1,
        gateway_paid_halalas: 94300,
        local_paid_halalas: 92000,
        failure_reason: null,
      },
    ]),
  );
  api.on(
    'GET',
    `/v1/platform/reconciliation-runs/${RUN}`,
    ok({
      id: RUN,
      gateway: 'moyasar',
      run_date: '2026-11-07',
      status: 'mismatched',
      started_at: NOW(),
      finished_at: NOW(),
      gateway_count: 41,
      local_count: 40,
      matched_count: 40,
      mismatch_count: 1,
      gateway_paid_halalas: 94300,
      local_paid_halalas: 92000,
      failure_reason: null,
      mismatches: [
        {
          kind: 'unknown_at_point',
          gateway_payment_id: 'pay_unknown_9d8c7b6a',
          online_payment_id: null,
          point_status: null,
          gateway_status: 'paid',
          point_amount_halalas: null,
          gateway_amount_halalas: 2300,
          point_refunded_halalas: null,
          gateway_refunded_halalas: 0,
          synced: false,
        },
      ],
    }),
  );
  api.on('GET', '/v1/platform/alerts', () => ok(alertStatus === 'open' ? [alert('open')] : []));
  api.on('POST', `/v1/platform/alerts/${ALERT}/resolve`, () => {
    alertStatus = 'resolved';
    return ok(alert('resolved'));
  });
  return api;
}

test('P-06 search (support): exact phone, masked list, the account, suspend with a reason', async ({
  page,
}) => {
  const api = await mockConsole(page, SUPPORT).install();
  await page.goto('/platform/customers');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('العملاء');
  // support: P-06, no P-08
  await expect(page.getByRole('link', { name: 'المدفوعات' })).toHaveCount(0);
  await expect(page.getByText('05•••••001').filter({ visible: true }).first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expectMobileLayout(page);

  const field = page.getByLabel('بحث بالجوال');
  await field.fill('0551');
  await page.getByRole('button', { name: 'بحث', exact: true }).click();
  await expect(page.getByText('أدخل رقم جوال سعوديًا كاملًا.')).toBeVisible();
  expect(api.calls.filter((c) => c.path === '/v1/platform/customers' && c.method === 'GET')).toHaveLength(1);
  await field.fill(`0${FULL_PHONE_DIGITS}`);
  await page.getByRole('button', { name: 'بحث', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'نتيجة البحث' })).toBeVisible();
  await page.getByRole('button', { name: 'فتح' }).first().click();

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('سارة عبدالله القحطاني');
  await expect(page.getByText('الموافقات')).toBeVisible();
  await expect(page.getByText('الإصدار الساري 2026-11-01: لم يوافق عليه بعد')).toBeVisible();
  await expect(page.getByText('mada •••• 4242 · 12/2030')).toBeVisible();
  // the full number never reaches the page (only what the server masked)
  expect(await page.content()).not.toContain(FULL_PHONE_DIGITS.slice(2));
  await page.evaluate(() => document.fonts.ready);
  await expectMobileLayout(page);

  await page.getByRole('button', { name: 'تعليق الحساب' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'تعليق الحساب' });
  await expect(dialog).toBeVisible();
  await expectMobileLayout(page);
  const confirm = dialog.getByRole('button', { name: 'تعليق الحساب' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('السبب').fill('بلاغ احتيال من العميل');
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  const calls = api.callsTo('POST', `/v1/platform/customers/${ACCOUNT}/suspend`);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body).toEqual({ reason: 'بلاغ احتيال من العميل' });
  expect(calls[0]?.headers['idempotency-key']).toBeTruthy();
  await expect(page.getByRole('button', { name: 'إعادة التفعيل' })).toBeVisible();
});

test('P-08 payments (finance): list with VAT, the payment timeline, refund ≤ refundable with a reason', async ({
  page,
}) => {
  const api = await mockConsole(page, FINANCE).install();
  await page.goto('/platform/payments');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('المدفوعات والاسترداد');
  await expect(page.getByText('شامل الضريبة 3.00 ر.س').filter({ visible: true }).first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expectMobileLayout(page);

  // a backwards range is refused before it is sent
  await page.getByLabel('من يوم (الرياض)').fill('2026-11-08');
  await page.getByLabel('إلى يوم (الرياض)').fill('2026-11-01');
  await page.getByRole('button', { name: 'تطبيق' }).click();
  await expect(page.getByText('يوم النهاية قبل يوم البداية.')).toBeVisible();
  await page.getByRole('button', { name: 'مسح' }).click();

  await page.getByRole('button', { name: 'فتح' }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('23.00');
  await expect(page.getByText('تسليم البوابة: payment_paid')).toBeVisible();
  await expect(page.getByText('تعارض مع البوابة')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expectMobileLayout(page);

  await page.getByRole('button', { name: 'استرداد' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'استرداد من الدفعة' });
  await expect(dialog).toBeVisible();
  await expectMobileLayout(page);
  const amount = dialog.getByLabel('المبلغ بالريال (اختياري)');
  const reason = dialog.getByLabel('السبب');
  const confirm = dialog.getByRole('button', { name: 'استرداد' });
  await amount.fill('30');
  await reason.fill('تأخر تسليم السيارة');
  await expect(dialog.getByText('أدخل مبلغًا صحيحًا لا يتجاوز المتاح.')).toBeVisible();
  await expect(confirm).toBeDisabled();
  await amount.fill('12.50');
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  const calls = api.callsTo('POST', `/v1/platform/payments/${PAYMENT}/refunds`);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body).toEqual({ amount_halalas: 1250, reason: 'تأخر تسليم السيارة' });
  expect(calls[0]?.headers['idempotency-key']).toBeTruthy();
});

test('P-08 reconciliation runs and alerts: mismatches, resolve with a note', async ({ page }) => {
  const api = await mockConsole(page, FINANCE).install();
  await page.goto('/platform/payments/reconciliation');
  await expect(page.getByText('2026-11-07').filter({ visible: true }).first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expectMobileLayout(page);
  await page.getByRole('button', { name: 'الفروق' }).first().click();
  await expect(page.getByText('لدى البوابة لا لدينا')).toBeVisible();
  await expect(page.getByText('pay_unknown_9d8c7b6a')).toBeVisible();
  await expectMobileLayout(page);

  await page.getByRole('radio', { name: 'التنبيهات' }).click();
  await expect(page).toHaveURL(/\/platform\/payments\/alerts$/);
  await expect(page.getByText('تعارض مع البوابة')).toBeVisible();
  await expectMobileLayout(page);
  await page.getByRole('button', { name: 'حل التنبيه' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'حل التنبيه' });
  await expect(dialog).toBeVisible();
  await expectMobileLayout(page);
  await dialog.getByLabel('السبب').fill('طابقنا مع لوحة البوابة');
  await dialog.getByRole('button', { name: 'حل التنبيه' }).click();
  await expect(dialog).toHaveCount(0);
  const calls = api.callsTo('POST', `/v1/platform/alerts/${ALERT}/resolve`);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body).toEqual({ note: 'طابقنا مع لوحة البوابة' });
  expect(calls[0]?.headers['idempotency-key']).toBeTruthy();
  await expect(page.getByText('لا تنبيهات.')).toBeVisible();
});

test('desktop: P-06 and P-08 lists are tables from a 1024px column (S-05 layout), RTL', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile-390', 'one desktop check is enough');
  await mockConsole(page, FINANCE).install();
  // the table needs a 1024px content column beside the side navigation (container query, 03 §3.16)
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const path of ['/platform/customers', '/platform/payments', '/platform/payments/reconciliation']) {
    await page.goto(path);
    const table = page.locator('table.pt-table');
    await expect(table).toBeVisible();
    await expect(page.locator('.pt-table-cards')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  // the side navigation offers P-06 and P-08 to finance
  await expect(page.getByRole('link', { name: 'العملاء' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'المدفوعات' }).first()).toBeVisible();
});
