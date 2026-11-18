import { expect, test, type Page } from '@playwright/test';
import { MockApi, ok } from './support/api';
import { expectMobileLayout } from './support/checks';

/**
 * V2-030 / V2-035 (P-05 «باقات الاشتراك», P-07 «الاشتراكات»): the platform console screens at 360, 390 and 430 px
 * (one Playwright project each) and the desktop table at 1440 px, with the platform API mocked in the browser — RTL,
 * no horizontal scroll, the screens per platform role, a new plan and a price change (a new plan replacing the old
 * one with a reason), a plan taken off sale, the report (MRR, renewals, churn, per venue) and the list with the
 * customer masked — each command once, with its Idempotency-Key.
 */

const NOW = () => new Date().toISOString();
const VENUE = '00000000-0000-4000-8000-0000000000e1';
const PLAN = '00000000-0000-4000-8000-0000000000f1';
const SUB = '00000000-0000-4000-8000-0000000000f9';

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
const FINANCE = platformMe('platform_finance', [
  'platform.plan_manage',
  'platform.subscription_read',
  'platform.subscription_manage',
  'platform.payment_read',
  'platform.refund_issue',
  'platform.complaint_manage',
]);
const ADMIN = platformMe('platform_admin', ['platform.operator_read', 'platform.venue_review']);

interface MockPlan {
  plan_id: string;
  status: string;
  replaced_by_plan_id: string | null;
  retired_at: string | null;
  [field: string]: unknown;
}

const plan = (over: Record<string, unknown> = {}): MockPlan => ({
  plan_id: PLAN,
  venue_id: VENUE,
  name_ar: 'سيارة واحدة',
  name_en: null,
  vehicles_included: 1,
  monthly_price_halalas: 30000,
  yearly_price_halalas: 300000,
  status: 'active',
  replaces_plan_id: null,
  replaced_by_plan_id: null,
  live_subscriptions: 12,
  created_at: NOW(),
  retired_at: null,
  ...over,
});

const subscription = {
  subscription_id: SUB,
  account_id: 'acc-1',
  phone_masked: '05•••••321',
  account_status: 'active',
  org_id: 'org-1',
  operator_name_ar: 'مؤسسة الفاليت التجريبية',
  venue_id: VENUE,
  venue_name_ar: 'برج الأعمال الشمالي',
  plan_id: PLAN,
  plan_name_ar: 'سيارة واحدة',
  billing_cycle: 'monthly',
  status: 'past_due',
  price_halalas: 30000,
  next_price_halalas: null,
  vehicles_included: 1,
  current_period_start: NOW(),
  current_period_end: NOW(),
  cancel_at_period_end: false,
  grace_ends_at: NOW(),
  renewal_attempts: 1,
  frozen_at: null,
  frozen_reason: null,
  frozen_days_total: 0,
  periods_paid: 2,
  visits: 17,
  activated_at: NOW(),
  ended_at: null,
  ended_reason: null,
  created_at: NOW(),
};

const STUDENT_PLAN = '00000000-0000-4000-8000-0000000000f5';
const APPLICATION = '00000000-0000-4000-8000-0000000000fa';
const COMPLAINT = '00000000-0000-4000-8000-0000000000fc';

function mockConsole(page: Page, me: Record<string, unknown>, opts: { annex?: boolean } = {}) {
  const api = new MockApi(page, null);
  let plans = [
    plan(),
    ...(opts.annex
      ? [
          plan({
            plan_id: STUDENT_PLAN,
            name_ar: 'باقة الطالب الشهرية',
            monthly_price_halalas: 17250,
            yearly_price_halalas: null,
            live_subscriptions: 3,
            term_kind: 'service_days',
            service_days: 22,
            service_weekdays: [0, 1, 2, 3, 4],
            renewal_mode: 'manual',
            daily_visit_limit: 1,
            refund_policy: 'non_refundable',
            closure_policy: 'continue',
            freeze_max_times: 1,
            freeze_max_days: 5,
            eligibility: 'student_id_review',
            capacity: 300,
            seats_taken: 2,
            audience_ar: 'طلاب وطالبات الجامعة',
            vehicle_change: 'any_time',
          }),
        ]
      : []),
  ];
  let closures: Record<string, unknown>[] = [];
  let complaintStatus = 'open';
  api.on('GET', '/v1/platform/venue-closures', () => ok({ items: closures }));
  api.on('POST', '/v1/platform/venue-closures', (req) => {
    const body = JSON.parse(req.postData() ?? '{}');
    const c = { closure_id: 'cl-1', ...body, created_at: NOW(), canceled_at: null, cancel_reason: null };
    closures = [c];
    return ok(c, 201);
  });
  api.on('GET', `/v1/platform/venues/${VENUE}/eligible-students`, () =>
    ok({ venue_id: VENUE, listed: 120, pending_applications: 1 }),
  );
  api.on('POST', `/v1/platform/venues/${VENUE}/eligible-students`, () =>
    ok({ venue_id: VENUE, mode: 'add', changed: 2, approved: 1, listed: 122 }),
  );
  const application = {
    ...subscription,
    subscription_id: APPLICATION,
    plan_id: STUDENT_PLAN,
    plan_name_ar: 'باقة الطالب الشهرية',
    status: 'pending_eligibility',
    price_halalas: 17250,
    current_period_start: null,
    current_period_end: null,
    periods_paid: 0,
    eligibility_status: 'pending',
    student_number_masked: '••••••567',
  };
  let decided = false;
  api.on('GET', `/v1/platform/subscriptions/${APPLICATION}`, () =>
    ok({
      ...application,
      ...(decided ? { status: 'pending_payment', eligibility_status: 'approved' } : {}),
      covered_vehicles: 1,
      periods: [],
      payments: [],
      timeline: [],
      eligibility: {
        status: decided ? 'approved' : 'pending',
        source: decided ? 'review' : null,
        student_number: '441234567',
        student_name: 'سارة أحمد',
        decided_at: null,
        decision_reason: null,
        created_at: NOW(),
      },
      freezes: [],
      purchase_consents: [],
      refunds: [],
    }),
  );
  api.on('POST', `/v1/platform/subscriptions/${APPLICATION}/eligibility`, () => {
    decided = true;
    return ok({ ...application, status: 'pending_payment' });
  });
  const complaint = () => ({
    complaint_id: COMPLAINT,
    reference: 'PT-C-000121',
    category: 'delay',
    status: complaintStatus,
    body: 'تأخر إحضار السيارة أكثر من نصف ساعة',
    account_id: 'acc-1',
    phone_masked: '05•••••321',
    ticket_id: null,
    subscription_id: null,
    org_id: 'org-1',
    operator_name_ar: 'مؤسسة الفاليت التجريبية',
    venue_id: VENUE,
    venue_name_ar: 'برج الأعمال الشمالي',
    resolution_note: complaintStatus === 'open' ? null : 'نعتذر، راجعنا المناوبة',
    allowed_next: complaintStatus === 'open' ? ['in_progress', 'resolved', 'closed'] : [],
    created_at: NOW(),
    updated_at: NOW(),
  });
  api.on('GET', '/v1/platform/complaints', () => ok([complaint()]));
  api.on('POST', `/v1/platform/complaints/${COMPLAINT}/status`, (req) => {
    complaintStatus = JSON.parse(req.postData() ?? '{}').status;
    return ok(complaint());
  });
  api.on('GET', '/v1/platform/me', ok(me));
  api.on('GET', '/v1/platform/overview', () =>
    ok({
      operators: { total: 1, by_status: { invited: 0, trial: 0, active: 1, suspended: 0, terminated: 0 } },
      venues: { total: 2, active: 2 },
      drivers_on_duty: 3,
      tickets_today: 12,
      subscriptions: { active: 41, mrr_halalas: 1230000 },
      day: '2026-11-08',
      generated_at: NOW(),
    }),
  );
  api.on('GET', '/v1/platform/plans', () =>
    ok([
      {
        venue_id: VENUE,
        org_id: 'org-1',
        name_ar: 'برج الأعمال الشمالي',
        name_en: null,
        operator_name_ar: 'مؤسسة الفاليت التجريبية',
        category: 'office',
        profile_status: 'approved',
        profile_version: 3,
        subscriptions_enabled: true,
        subscriptions_allowed: true,
        pay_per_visit_halalas: 2000,
        plans,
      },
    ]),
  );
  api.on('POST', '/v1/platform/plans', (req) => {
    const body = JSON.parse(req.postData() ?? '{}');
    const created = plan({
      plan_id: `${PLAN.slice(0, -1)}2`,
      ...body,
      live_subscriptions: 0,
    });
    plans = [
      created,
      ...plans.map((p) =>
        p.plan_id === body.replaces_plan_id
          ? { ...p, status: 'retired', replaced_by_plan_id: created.plan_id, retired_at: NOW() }
          : p,
      ),
    ];
    return ok(created, 201);
  });
  api.on('POST', `/v1/platform/plans/${PLAN.slice(0, -1)}2/retire`, () => {
    plans = plans.map((p) => (p.plan_id.endsWith('2') ? { ...p, status: 'retired', retired_at: NOW() } : p));
    return ok(plans[0]);
  });
  api.on('GET', '/v1/platform/subscriptions/report', () =>
    ok({
      generated_at: NOW(),
      days: 30,
      counts: { active: 41, past_due: 2, frozen: 0, canceled: 5, expired: 1 },
      active_subscribers: 41,
      mrr_halalas: 1230000,
      renewals_due: { count: 37, amount_halalas: 1110000, until: NOW() },
      churn: { count: 3, rate_bp: 682, by_reason: { period_end: 2, grace_expired: 1 }, since: NOW() },
      new_subscriptions: 9,
      venues: [
        {
          venue_id: VENUE,
          venue_name_ar: 'برج الأعمال الشمالي',
          org_id: 'org-1',
          operator_name_ar: 'مؤسسة الفاليت التجريبية',
          active: 41,
          frozen: 0,
          past_due: 2,
          mrr_halalas: 1230000,
        },
      ],
    }),
  );
  api.on('GET', '/v1/platform/subscriptions', (req) =>
    ok(
      new URL(req.url()).searchParams.get('status') === 'pending_eligibility'
        ? [application]
        : [subscription],
    ),
  );
  api.on(
    'GET',
    `/v1/platform/subscriptions/${SUB}`,
    ok({
      ...subscription,
      covered_vehicles: 1,
      periods: [
        {
          seq: 1,
          starts_at: NOW(),
          ends_at: NOW(),
          price_halalas: 30000,
          plan_id: PLAN,
          online_payment_id: 'op-1',
          extended_days: 10,
        },
      ],
      payments: [
        {
          payment_id: 'op-1',
          status: 'paid',
          amount_halalas: 30000,
          refunded_halalas: 0,
          seq: 1,
          card_brand: 'mada',
          card_last4: '4242',
          failure_code: null,
          paid_at: NOW(),
          created_at: NOW(),
        },
      ],
      timeline: [
        {
          action: 'subscription.first_payment_paid',
          occurred_at: NOW(),
          actor_type: 'system',
          from_status: 'pending_payment',
          to_status: 'active',
        },
        {
          action: 'subscription.renewal_failed',
          occurred_at: NOW(),
          actor_type: 'system',
          from_status: 'active',
          to_status: 'past_due',
        },
      ],
    }),
  );
  return api;
}

test('P-05 plans (finance): a new plan, a price change with a reason, a plan off sale', async ({ page }) => {
  const api = await mockConsole(page, FINANCE).install();
  await page.goto('/platform/plans');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('باقات الاشتراك');
  await expect(page.getByText('300.00 ر.س').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText('يبيع الاشتراك').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expectMobileLayout(page);

  // a new plan: two cars, a yearly price only
  await page.getByRole('button', { name: 'باقة جديدة' }).click();
  let dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expectMobileLayout(page);
  await dialog.getByLabel('اسم الباقة').fill('سيارتان');
  await dialog.getByLabel('عدد السيارات المشمولة').selectOption('2');
  await dialog.getByLabel('السعر السنوي (ريال، شامل الضريبة)').fill('0.5');
  await expect(dialog.getByText('أدخل مبلغًا صحيحًا بالريال (1.00 فأكثر).')).toBeVisible();
  await dialog.getByLabel('السعر السنوي (ريال، شامل الضريبة)').fill('5000');
  await dialog.getByRole('button', { name: 'حفظ الباقة' }).click();
  await expect(dialog).toHaveCount(0);
  let calls = api.callsTo('POST', '/v1/platform/plans');
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body).toMatchObject({
    venue_id: VENUE,
    name_ar: 'سيارتان',
    vehicles_included: 2,
    monthly_price_halalas: null,
    yearly_price_halalas: 500000,
    // V2-036 (DEC-590): a calendar plan sends the V4 policies
    term_kind: 'calendar',
    renewal_mode: 'auto',
    refund_policy: 'prorated_on_termination',
    closure_policy: 'freeze',
    eligibility: 'none',
  });
  expect(calls[0]?.headers['idempotency-key']).toBeTruthy();

  // a price change of the first plan: a reason, the replaced plan named
  await page.getByRole('button', { name: 'تغيير السعر' }).last().click();
  dialog = page.getByRole('alertdialog');
  await expect(dialog.getByText('يبقى مشتركوها على سعرهم')).toBeVisible();
  await dialog.getByLabel('السعر الشهري (ريال، شامل الضريبة)').fill('320');
  await dialog.getByLabel('السبب').fill('تحديث الأسعار السنوي');
  await dialog.getByRole('button', { name: 'حفظ الباقة' }).click();
  await expect(dialog).toHaveCount(0);
  calls = api.callsTo('POST', '/v1/platform/plans');
  expect(calls).toHaveLength(2);
  expect(calls[1]?.body).toMatchObject({
    replaces_plan_id: PLAN,
    monthly_price_halalas: 32000,
    yearly_price_halalas: 300000,
    reason: 'تحديث الأسعار السنوي',
  });
  await expect(page.getByText('متوقفة').filter({ visible: true }).first()).toBeVisible();

  // off sale with a reason
  await page.getByRole('button', { name: 'إيقاف الباقة' }).first().click();
  dialog = page.getByRole('alertdialog');
  await dialog.getByLabel('السبب').fill('لا طلب عليها');
  await dialog.getByRole('button', { name: 'إيقاف الباقة' }).click();
  await expect(dialog).toHaveCount(0);
  const retire = api.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/retire'));
  expect(retire).toHaveLength(1);
  expect(retire[0]?.body).toEqual({ reason: 'لا طلب عليها' });
});

test('P-07 subscriptions (finance): the report, the list masked, one subscription', async ({ page }) => {
  await mockConsole(page, FINANCE).install();
  await page.goto('/platform/subscriptions');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('الاشتراكات');
  await expect(page.getByText('12,300.00 ر.س').first()).toBeVisible();
  await expect(page.getByText('نسبة 6.82%')).toBeVisible();
  await expect(page.getByText('05•••••321').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText('متأخر الدفع').filter({ visible: true }).first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expectMobileLayout(page);
  await page.getByRole('button', { name: 'فتح' }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('برج الأعمال الشمالي');
  await expect(page.getByText('مُدّدت 10 يومًا')).toBeVisible();
  await expect(page.getByText('1 سيارة مشمولة', { exact: false })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expectMobileLayout(page);
});

test('P-05 / P-07 are not offered to the platform admin (02 §2.1); P-01 shows the subscribers', async ({
  page,
}) => {
  await mockConsole(page, ADMIN).install();
  await page.goto('/platform');
  await expect(page.getByText('المشتركون النشطون')).toBeVisible();
  await expect(page.getByRole('link', { name: 'الباقات' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'الاشتراكات' })).toHaveCount(0);
  await page.goto('/platform/plans');
  await expect(page.getByText('لا تملك صلاحية هذا الإجراء.')).toBeVisible();
});

test('desktop: P-05 and P-07 tables from a 1024px column, RTL', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile-390', 'one desktop check is enough');
  await mockConsole(page, FINANCE).install();
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const path of ['/platform/plans', '/platform/subscriptions']) {
    await page.goto(path);
    await expect(page.locator('table.pt-table').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await expect(page.getByRole('link', { name: 'الباقات' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'الاشتراكات' }).first()).toBeVisible();
});

test('V2-036 P-05: a student plan of counted days, the closures calendar, the eligible list', async ({
  page,
}) => {
  const api = await mockConsole(page, FINANCE, { annex: true }).install();
  await page.goto('/platform/plans');
  await expect(page.getByText('باقة الطالب الشهرية').filter({ visible: true }).first()).toBeVisible();
  await expect(
    page
      .getByText(/22 يومًا محتسبًا · تجديد يدوي · غير قابل للاسترداد/)
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
  await expect(
    page.getByText('المقاعد 2 / 300', { exact: false }).filter({ visible: true }).first(),
  ).toBeVisible();
  await expect(page.getByText('120 رقمًا مدرجًا · 1 طلبًا بانتظار القرار')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expectMobileLayout(page);

  // a counted-day plan: the form fills the student defaults
  await page.getByRole('button', { name: 'باقة جديدة' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByLabel('اسم الباقة').fill('باقة الطالب');
  await dialog.getByLabel('السعر الشهري (ريال، شامل الضريبة)').fill('172.50');
  await dialog.getByLabel('نوع المدة').selectOption('service_days');
  await dialog.getByLabel('السعة (اشتراكات حية، فارغ = بلا حد)').fill('300');
  await expectMobileLayout(page);
  await dialog.getByRole('button', { name: 'حفظ الباقة' }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.callsTo('POST', '/v1/platform/plans')[0]?.body).toMatchObject({
    monthly_price_halalas: 17250,
    yearly_price_halalas: null,
    term_kind: 'service_days',
    service_days: 22,
    service_weekdays: [0, 1, 2, 3, 4],
    renewal_mode: 'manual',
    daily_visit_limit: 1,
    refund_policy: 'non_refundable',
    closure_policy: 'continue',
    freeze_max_times: 1,
    freeze_max_days: 5,
    eligibility: 'student_id_review',
    capacity: 300,
    vehicle_change: 'any_time',
  });

  // an announced holiday
  await page.getByRole('button', { name: 'إضافة إجازة أو إغلاق' }).first().click();
  const add = page.getByRole('alertdialog');
  await add.getByLabel('من (YYYY-MM-DD)').fill('2026-12-27');
  await add.getByLabel('إلى (YYYY-MM-DD)').fill('2027-01-07');
  await add.getByLabel('السبب (يظهر للعميل)').fill('إجازة منتصف العام');
  await add.getByRole('button', { name: 'إضافة إجازة أو إغلاق' }).click();
  await expect(add).toHaveCount(0);
  expect(api.callsTo('POST', '/v1/platform/venue-closures')[0]?.body).toEqual({
    venue_id: VENUE,
    kind: 'holiday',
    starts_on: '2026-12-27',
    ends_on: '2027-01-07',
    reason_ar: 'إجازة منتصف العام',
  });
  await expect(page.getByText('إجازة منتصف العام').first()).toBeVisible();

  // the eligible list: pasted numbers, the waiting applications approved
  await page.getByLabel('الأرقام الجامعية').fill('441234567\n441234568');
  await page.getByRole('button', { name: 'إضافة إلى القائمة' }).click();
  await expect(page.getByText('حُدّثت القائمة: 2 رقمًا، واعتُمد 1 طلبًا')).toBeVisible();
  expect(api.callsTo('POST', `/v1/platform/venues/${VENUE}/eligible-students`)[0]?.body).toEqual({
    mode: 'add',
    student_numbers: ['441234567', '441234568'],
  });
});

test('V2-036 P-07: an application waiting for its eligibility is approved', async ({ page }) => {
  const api = await mockConsole(page, FINANCE, { annex: true }).install();
  await page.goto(`/platform/subscriptions/${APPLICATION}`);
  await expect(page.getByText('بانتظار الأهلية').first()).toBeVisible();
  await expect(page.getByText('441234567')).toBeVisible();
  await expect(page.getByText('سارة أحمد', { exact: false })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expectMobileLayout(page);
  await page.getByRole('button', { name: 'اعتماد الأهلية' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'اعتماد الأهلية' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  const calls = api.callsTo('POST', `/v1/platform/subscriptions/${APPLICATION}/eligibility`);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body).toEqual({ decision: 'approve' });
  expect(calls[0]?.headers['idempotency-key']).toBeTruthy();
});

test('V2-037 P-13: a complaint by its reference, moved with a note', async ({ page }) => {
  const api = await mockConsole(page, FINANCE, { annex: true }).install();
  await page.goto('/platform/complaints');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('الشكاوى');
  await expect(page.getByText('PT-C-000121').first()).toBeVisible();
  await expect(page.getByText('05•••••321').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expectMobileLayout(page);
  await page.getByRole('button', { name: 'تمت المعالجة' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByLabel('السبب').fill('نعتذر، راجعنا المناوبة');
  await dialog.getByRole('button', { name: 'تغيير الحالة' }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.callsTo('POST', `/v1/platform/complaints/${COMPLAINT}/status`)[0]?.body).toEqual({
    status: 'resolved',
    note: 'نعتذر، راجعنا المناوبة',
  });
  await expect(page.getByText('نعتذر، راجعنا المناوبة').first()).toBeVisible();
});
