import { expect, test } from '@playwright/test';
import {
  apiError,
  auditFixture,
  EVENT_ID,
  eventFixture,
  KHALID,
  MockApi,
  mockStaffApi,
  ok,
  OTHER_VENUE_ID,
  reconciliationFixture,
  roleMe,
  SAAD,
  secondsAgo,
  STAFF_USER_ID,
  ticketDetailFixture,
  VENUE_ID,
} from './support/api';
import { actorPage } from './support/actors';
import { runOnlyAt390 } from './support/checks';
import { createFake, SEED_IDS } from './support/fake';
import { FakeRealtime } from './support/fake/realtime';

/**
 * The staff audit items closed in the final round (docs/progress/notes/audit-close.md): S-05 table from 1024 px
 * (A-S05-2), the shell's alerts badge and shared venue (A-SHELL-1), commands held while a resync runs
 * (A-SHELL-2), the scope-denied read (A-SHELL-3), the S-09 draft-abandoned timer (A-S09-1), the S-10 close
 * confirmation (A-S10-1), the S-11 payments rows (A-S11-1), self-approval in the S-13 audit log (A-S11-2) and
 * the S-03 waiver row (A-S03-1).
 */
runOnlyAt390();

function driverRow(
  user: { id: string; full_name: string; employee_code: string },
  live: Record<string, unknown> | null,
) {
  return {
    user: { ...user, role: 'driver', status: 'active', version: 1 },
    active_assignment: {
      id: `as-${user.id}`,
      driver_id: user.id,
      venue_id: VENUE_ID,
      venue_name_ar: 'قاعة ريماس',
      status: 'active',
      starts_at: secondsAgo(86400),
    },
    live: live ? { driver: user, ...live } : null,
  };
}

test('A-S05-2: S-05 is the 02 table from 1024 px (name, code, state, task, connection, duty start, device), rows below', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  api.on(
    'GET',
    '/v1/drivers',
    ok([
      driverRow(KHALID, {
        driver_state: 'available',
        connection_state: 'online',
        available_since: secondsAgo(250),
        duty_started_at: secondsAgo(3600),
      }),
      driverRow(SAAD, { driver_state: 'off_duty', connection_state: 'offline' }),
    ]),
  );
  await api.install();
  await page.goto('/drivers');
  // below 1024 px: the DriverRow list, no table
  await expect(page.getByRole('link', { name: /خالد العتيبي/ })).toBeVisible();
  await expect(page.getByRole('table')).toBeHidden();

  await page.setViewportSize({ width: 1280, height: 900 });
  const table = page.getByRole('table');
  await expect(table).toBeVisible();
  await expect(page.getByRole('list', { name: 'السائقون' })).toBeHidden();
  const headers = await table.locator('th').allInnerTexts();
  expect(headers.map((h) => h.trim())).toEqual([
    'الاسم',
    'الرقم الوظيفي',
    'الحالة',
    'المهمة',
    'الاتصال',
    'بداية المناوبة',
    'الجهاز',
  ]);
  const rows = table.locator('tbody tr');
  await expect(rows).toHaveCount(2);
  // sorted by name (Arabic collation): خالد before سعد; a click on «الاسم» sorts descending
  await expect(rows.nth(0)).toContainText('خالد العتيبي');
  await expect(rows.nth(0)).toContainText('D-0011');
  await expect(rows.nth(0)).toContainText('متاح');
  await expect(rows.nth(0)).toContainText(/منذ 4:\d\d/);
  await expect(rows.nth(0)).toContainText('متصل');
  await expect(rows.nth(1)).toContainText('خارج الوردية');
  await expect(table.locator('th').first()).toHaveAttribute('aria-sort', 'ascending');
  await page.getByRole('button', { name: 'الاسم' }).click();
  await expect(table.locator('th').first()).toHaveAttribute('aria-sort', 'descending');
  await expect(rows.nth(0)).toContainText('سعد الحربي');
  await rows.nth(1).getByRole('link', { name: 'خالد العتيبي' }).click();
  await expect(page).toHaveURL(new RegExp(`/drivers/${KHALID.id}$`));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('A-SHELL-1: «التنبيهات (n)» in the TopBar of every staff screen opens S-04; the venue chosen in S-02 carries to S-05 and S-11', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  await api.install();
  await page.goto('/drivers');
  // the fixtures hold two alerts, both open
  const badge = page.getByRole('banner').getByRole('button', { name: 'التنبيهات (2)' });
  await expect(badge).toBeVisible();
  await badge.click();
  await expect(page).toHaveURL(/\/ops\/alerts$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('مركز التنبيهات');

  // S-02's venue picker → S-05 and S-11 start from it (in memory, DEC-320)
  await page
    .getByRole('navigation', { name: 'التنقل الرئيسي' })
    .getByRole('link', { name: 'التشغيل' })
    .click();
  await page.locator('#ops-venue').selectOption(OTHER_VENUE_ID);
  await page
    .getByRole('navigation', { name: 'التنقل الرئيسي' })
    .getByRole('link', { name: 'السائقون' })
    .click();
  await expect(page.locator('#drivers-venue')).toHaveValue(OTHER_VENUE_ID);
  await page
    .getByRole('navigation', { name: 'التنقل الرئيسي' })
    .getByRole('link', { name: 'التقارير' })
    .click();
  await expect(page.locator('#reports-venue')).toHaveValue(OTHER_VENUE_ID);
});

test('A-SHELL-2: while a resync runs (sync.required) the staff commands wait, then come back', async ({
  page,
}) => {
  const alertId = crypto.randomUUID();
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api, {
    alerts: [
      {
        id: alertId,
        venue_id: VENUE_ID,
        event_id: EVENT_ID,
        ticket_id: 't-47',
        type: 'request_unaccepted',
        severity: 'critical',
        status: 'open',
        details: { display_number: 47 },
        raised_at: secondsAgo(250),
      },
    ],
  });
  let release: (() => void) | null = null;
  let stall = false;
  const alerts = ok([
    {
      id: alertId,
      venue_id: VENUE_ID,
      event_id: EVENT_ID,
      ticket_id: 't-47',
      type: 'request_unaccepted',
      severity: 'critical',
      status: 'open',
      details: { display_number: 47 },
      raised_at: secondsAgo(250),
    },
  ]);
  api.on('GET', '/v1/alerts', async () => {
    if (stall) await new Promise<void>((r) => (release = r));
    return alerts;
  });
  const hub = FakeRealtime.standalone();
  api.realtime = hub;
  await api.install();
  await page.goto('/ops/alerts');
  await expect.poll(() => hub.connectedUsers()).toEqual([STAFF_USER_ID]);
  const ack = page.locator(`li[data-alert-id="${alertId}"]`).getByRole('button', { name: 'إقرار' });
  await expect(ack).toBeEnabled();

  stall = true;
  hub.emit(STAFF_USER_ID, 'sync.required', { reason: 'test', scope: 'venue' });
  await expect(ack).toBeDisabled();
  await expect.poll(() => release !== null).toBe(true);
  stall = false;
  (release as unknown as () => void)();
  await expect(ack).toBeEnabled();
});

test('A-SHELL-3: a staff read refused with SCOPE_VENUE_DENIED says «خارج نطاق موقعك», not the permission text', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  api.on('GET', '/v1/tickets/t-99', apiError('SCOPE_VENUE_DENIED', 403));
  api.on('GET', '/v1/tickets/t-99/timeline', apiError('SCOPE_VENUE_DENIED', 403));
  await api.install();
  await page.goto('/ops/tickets/t-99');
  await expect(page.getByText('هذا العنصر خارج نطاق موقعك.')).toBeVisible();
  await expect(page.getByText('لا تملك صلاحية عرض هذه الصفحة.')).toHaveCount(0);
});

test('A-S03-1: S-03 «التحصيل» shows the waiver with its reason', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api, {
    ticket: ticketDetailFixture({ payment_status: 'waived', payment_waiver_reason: 'ضيف من أهل العريس' }),
  });
  await api.install();
  await page.goto('/ops/tickets/t-47');
  await page.getByRole('tab', { name: 'التحصيل' }).click();
  const panel = page.getByRole('tabpanel');
  await expect(panel).toContainText('إعفاء من الرسوم');
  await expect(panel).toContainText('السبب: ضيف من أهل العريس');
});

test('A-S10-1: «إغلاق الحفل» asks a confirmation first; cancel sends nothing, confirm closes', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('supervisor'));
  const state = mockStaffApi(api, { event: eventFixture({ status: 'closing', version: 4 }) });
  api.on('GET', `/v1/events/${EVENT_ID}/reconciliation`, ok(reconciliationFixture(false)));
  api.on('POST', `/v1/events/${EVENT_ID}/close`, () => {
    state.event = eventFixture({ status: 'closed', version: 5 });
    return ok(state.event);
  });
  await api.install();
  await page.goto(`/events/${EVENT_ID}/close`);
  await page.getByRole('button', { name: 'إغلاق الحفل' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'إغلاق الحفل' });
  await expect(dialog).toContainText('إغلاق الحفل نهائي');
  await dialog.getByRole('button', { name: 'إلغاء' }).click();
  await expect(dialog).toBeHidden();
  expect(api.callsTo('POST', `/v1/events/${EVENT_ID}/close`)).toHaveLength(0);

  await page.getByRole('button', { name: 'إغلاق الحفل' }).click();
  await dialog.getByRole('button', { name: 'إغلاق الحفل' }).click();
  await expect(page.getByText('أُغلق الحفل. التقرير متاح.')).toBeVisible();
  const close = api.callsTo('POST', `/v1/events/${EVENT_ID}/close`);
  expect(close).toHaveLength(1);
  expect(close[0]?.body).toEqual({ expected_version: 4 });
  expect(close[0]?.headers['idempotency-key']).toBeTruthy();
});

test('A-S11-1: S-11 «التحصيل» lists one row per event of the period under the totals', async ({ page }) => {
  const api = new MockApi(page, roleMe('admin'));
  mockStaffApi(api);
  api.on(
    'GET',
    '/v1/reports/payments',
    ok({
      from: '',
      to: '',
      totals: { cash_halalas: 75000, pos_halalas: 40000, waived: 1, reversed: 1, outstanding: 2 },
      rows: [
        {
          event_id: EVENT_ID,
          event_name_ar: 'حفل آل سعيد',
          cash_halalas: 50000,
          pos_halalas: 40000,
          waived: 1,
          reversed: 0,
          outstanding: 1,
        },
        {
          event_id: 'e-old',
          event_name_ar: 'حفل آل ناصر',
          cash_halalas: 25000,
          pos_halalas: 0,
          waived: 0,
          reversed: 1,
          outstanding: 1,
        },
      ],
    }),
  );
  await api.install();
  await page.goto('/reports');
  const card = page.getByRole('region', { name: 'التحصيل' });
  const rows = card.locator('.pt-table-cards > li').filter({ visible: true });
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('حفل آل سعيد');
  await expect(rows.nth(1)).toContainText('حفل آل ناصر');
  await expect(rows.nth(1)).toContainText('العكس');
});

test('A-S11-2: the S-13 audit log marks a self-approved exception and shows its metadata', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('admin'));
  mockStaffApi(api);
  api.on(
    'GET',
    '/v1/admin/audit-log',
    ok([
      {
        ...auditFixture()[0],
        id: 9002,
        action: 'payment.waive',
        reason: 'ضيف من أهل العريس',
        before: { payment_status: 'due' },
        after: { payment_status: 'waived' },
        metadata: { self_approved: true },
      },
      auditFixture()[0],
    ]),
  );
  await api.install();
  await page.goto('/admin/audit');
  const self = page.getByText('اعتماد ذاتي').filter({ visible: true });
  await expect(self).toHaveCount(1);
  await page.locator('summary').filter({ hasText: 'قبل / بعد' }).filter({ visible: true }).first().click();
  await expect(page.getByText('بيانات إضافية').filter({ visible: true })).toBeVisible();
  await expect(page.getByText('"self_approved": true').filter({ visible: true })).toBeVisible();
});

test('A-S09-1: «المؤقتات» shows and saves intake.draft_abandoned_alert_min (canon §12, minimum 1)', async ({
  browser,
}) => {
  const fake = createFake();
  const admin = await actorPage(browser, fake, 'ADM1');
  const rms = SEED_IDS.venues.RMS;
  await admin.page.goto(`/venues/${rms}/setup?section=timers`);
  const field = admin.page.getByLabel('تنبيه مسودة استلام متروكة دون إرسال');
  await expect(field).toHaveValue('10');
  await field.fill('0');
  await admin.page.getByRole('button', { name: 'حفظ' }).click();
  await expect(admin.page.getByText('القيمة خارج الحدود المسموحة (1–∞).')).toBeVisible();
  expect(fake.callsTo('PUT /v1/venues/:venueId/settings')).toHaveLength(0);
  await field.fill('15');
  await admin.page.getByRole('button', { name: 'حفظ' }).click();
  await expect(admin.page.getByText('تم الحفظ.')).toBeVisible();
  const put = fake.callsTo('PUT /v1/venues/:venueId/settings')[0];
  expect((put?.body as { settings: { intake: unknown } }).settings.intake).toEqual({
    draft_abandoned_alert_min: 15,
  });
});
