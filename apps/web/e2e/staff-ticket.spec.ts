import { expect, test } from '@playwright/test';
import {
  apiError,
  KHALID,
  LEAKED_CODE,
  MockApi,
  mockStaffApi,
  ok,
  roleMe,
  secondsAgo,
  ticketDetailFixture,
} from './support/api';
import { runOnlyAt390 } from './support/checks';

/**
 * S-03 — تفاصيل التذكرة وسجلها (PNT-076): the timeline, custody chain and messages never show a handover code;
 * the action panel follows /v1/me.permissions and the server's refusal text is shown when a command is refused
 * anyway; S-02 quick actions open S-03 with the action.
 */
runOnlyAt390();

test('the timeline and its tabs; a handover code is never shown', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  await api.install();
  await page.goto('/ops/tickets/t-47');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('تفاصيل التذكرة · #47');
  await expect(page.getByText('سجّلها: خالد العتيبي', { exact: false })).toBeVisible();
  const timeline = page.locator('#ticket-panel-timeline');
  await expect(timeline).toContainText('صف في A-03 وإيداع المفتاح في 12');
  await expect(timeline).toContainText('طلب السيارة');
  await expect(timeline).toContainText('العميل عبر واتساب');
  await expect(timeline).toContainText('رمز التسليم: ••••••');
  expect(await page.content()).not.toContain(LEAKED_CODE);

  await page.getByRole('tab', { name: /العهدة/ }).click();
  await expect(page.locator('#ticket-panel-custody')).toContainText(
    'إيداع المفتاح: السائق خالد العتيبي ← الخانة 12',
  );
  await page.getByRole('tab', { name: /الرسائل/ }).click();
  await expect(page.locator('#ticket-panel-messages')).toContainText('W-04 — وصلت');
  await expect(page.locator('#ticket-panel-messages')).not.toContainText(LEAKED_CODE);
  await page.getByRole('tab', { name: /الصور/ }).click();
  await expect(page.locator('#ticket-panel-photos img')).toHaveAttribute('alt', /الأمام/);
});

test('the server refusal text is shown when a command is refused, and /v1/me hides it afterwards', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  const refusal = 'لا تملك صلاحية إلغاء الطلبات في هذا الموقع.';
  api.on('POST', '/v1/retrieval-cycles/cy-47/cancel', () => {
    api.me = roleMe('supervisor', { remove: ['retrieval.cancel'] }); // the grant changed on the server
    return apiError('PERMISSION_DENIED', 403, { message_ar: refusal });
  });
  await api.install();
  await page.goto('/ops/tickets/t-47');
  await page.getByRole('button', { name: 'الإجراءات' }).click();
  await page.getByRole('button', { name: 'إلغاء طلب الإحضار' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'إلغاء طلب الإحضار' });
  const confirm = dialog.getByRole('button', { name: 'تأكيد الإلغاء' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('السبب (إلزامي)').fill('العميل سيبقى حتى نهاية الحفل');
  await confirm.click();
  await expect(page.locator('.pt-toast').filter({ hasText: refusal })).toBeVisible();
  await expect(dialog).toBeHidden();
  const call = api.callsTo('POST', '/v1/retrieval-cycles/cy-47/cancel')[0];
  expect(call?.body).toEqual({ reason: 'العميل سيبقى حتى نهاية الحفل' });
  expect(call?.headers['idempotency-key']).toBeTruthy();

  await expect.poll(() => api.callsTo('GET', '/v1/me').length).toBeGreaterThan(1);
  await page.getByRole('button', { name: 'الإجراءات' }).click();
  const sheet = page.getByRole('dialog', { name: 'الإجراءات' });
  await expect(sheet.getByRole('button', { name: 'فتح واقعة' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'إلغاء طلب الإحضار' })).toHaveCount(0);
});

test('the action panel follows the role: admin sees only its canon §10 actions, owner no panel', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('admin'));
  mockStaffApi(api);
  await api.install();
  await page.goto('/ops/tickets/t-47');
  await page.getByRole('button', { name: 'الإجراءات' }).click();
  const sheet = page.getByRole('dialog', { name: 'الإجراءات' });
  // `ticket.change_phone` and `ticket.manual_reconcile` are the administration's too (canon §10; GAP-2), no
  // operational action of the supervisor (09)
  await expect(sheet.locator('.pt-sheet__body').getByRole('button')).toHaveText([
    'تغيير الجوال',
    'مطابقة يدوية بعد انقطاع',
    'فتح واقعة',
  ]);
  await page.keyboard.press('Escape');

  api.me = roleMe('owner');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('تفاصيل التذكرة · #47');
  await expect(page.getByRole('button', { name: 'الإجراءات' })).toHaveCount(0);
});

test('a quick action from S-02 opens S-03 with that action', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  await api.install();
  await page.goto('/ops');
  const oldest = page.getByRole('list', { name: 'الطابور (الأقدم أولًا)' }).locator(':scope > li').first();
  await expect(oldest).toHaveAttribute('data-ticket', '47');
  await oldest.getByRole('button', { name: 'إلغاء' }).click();
  await expect(page).toHaveURL(/\/ops\/tickets\/t-47$/);
  await expect(page.getByRole('alertdialog', { name: 'إلغاء طلب الإحضار' })).toBeVisible();
});

test('reassign: reason and destination, then the server reply refreshes the ticket', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  const state = mockStaffApi(api, {
    ticket: ticketDetailFixture({
      status: 'requested',
      open_task: {
        id: 'k-47',
        ticket_id: 't-47',
        type: 'retrieve',
        status: 'offered',
        priority_at: secondsAgo(310),
        seq: 3,
        assignee: KHALID,
        first_offered_at: secondsAgo(20),
        version: 2,
      },
    }),
  });
  api.on('GET', '/v1/drivers', () =>
    ok([
      {
        user: {
          id: 'd-fahad',
          employee_code: 'D-0007',
          full_name: 'فهد الدوسري',
          role: 'driver',
          status: 'active',
          version: 1,
        },
        live: { driver: { id: 'd-fahad', full_name: 'فهد الدوسري' }, driver_state: 'available' },
      },
    ]),
  );
  api.on('POST', '/v1/tasks/k-47/reassign', () => {
    state.ticket = { ...state.ticket, version: 5 };
    return ok({ task: { id: 'k-47', status: 'offered', version: 3 }, ticket: state.ticket });
  });
  await api.install();
  await page.goto('/ops/tickets/t-47?action=reassign');
  const sheet = page.getByRole('dialog', { name: 'إعادة إسناد #47' });
  await expect(sheet).toBeVisible();
  // an offered task must go to a driver
  await expect(sheet.getByRole('radio', { name: 'إسناده لسائق متاح' })).toBeChecked();
  const confirm = sheet.getByRole('button', { name: 'تأكيد إعادة الإسناد' });
  await expect(confirm).toBeDisabled();
  await sheet.getByLabel('السائق').selectOption('d-fahad');
  await sheet.getByLabel('السبب (إلزامي)').fill('السائق لا يرد على العرض');
  await confirm.click();
  await expect(sheet).toBeHidden();
  const body = api.callsTo('POST', '/v1/tasks/k-47/reassign')[0]?.body;
  expect(body).toEqual({
    reason: 'السائق لا يرد على العرض',
    target_driver_id: 'd-fahad',
    override_priority: false,
    expected_version: 2,
  });
  await expect(page.locator('.pt-toast').filter({ hasText: 'تم تنفيذ الإجراء.' })).toBeVisible();
  await expect.poll(() => api.callsTo('GET', '/v1/tickets/t-47').length).toBeGreaterThan(1);
});

test('OLDER_REQUEST_PENDING offers the audited priority override', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api, {
    ticket: ticketDetailFixture({
      open_task: {
        id: 'k-47',
        ticket_id: 't-47',
        type: 'retrieve',
        status: 'assigned_waiting',
        priority_at: secondsAgo(310),
        seq: 3,
        assignee: KHALID,
        version: 2,
      },
    }),
  });
  api.on('GET', '/v1/drivers', () =>
    ok([
      {
        user: {
          id: 'd-fahad',
          employee_code: 'D-0007',
          full_name: 'فهد الدوسري',
          role: 'driver',
          status: 'active',
          version: 1,
        },
        live: { driver: { id: 'd-fahad', full_name: 'فهد الدوسري' }, driver_state: 'available' },
      },
    ]),
  );
  api.sequence('POST', '/v1/tasks/k-47/reassign', [
    apiError('OLDER_REQUEST_PENDING', 409),
    ok({ task: { id: 'k-47', status: 'accepted', version: 3 }, ticket: ticketDetailFixture() }),
  ]);
  await api.install();
  await page.goto('/ops/tickets/t-47?action=reassign');
  const sheet = page.getByRole('dialog', { name: 'إعادة إسناد #47' });
  await sheet.getByRole('radio', { name: 'إسناده لسائق متاح' }).check();
  await sheet.getByLabel('السائق').selectOption('d-fahad');
  await sheet.getByLabel('السبب (إلزامي)').fill('فهد أقرب للبوابة');
  await sheet.getByRole('button', { name: 'تأكيد إعادة الإسناد' }).click();
  await expect(sheet.getByRole('alert')).toBeVisible();
  const override = sheet.getByLabel('تجاوز أولوية الطلب الأقدم (يُسجّل في التدقيق)');
  await override.check();
  await sheet.getByRole('button', { name: 'تأكيد إعادة الإسناد' }).click();
  await expect(sheet).toBeHidden();
  const calls = api.callsTo('POST', '/v1/tasks/k-47/reassign');
  expect(calls).toHaveLength(2);
  expect((calls[1]?.body as { override_priority: boolean }).override_priority).toBe(true);
});
