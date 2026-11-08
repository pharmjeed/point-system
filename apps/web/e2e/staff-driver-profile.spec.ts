import { expect, test } from '@playwright/test';
import { errorMessagesAr } from '../src/i18n/errors';
import {
  apiError,
  boardFixture,
  driverItemFixture,
  eventFixture,
  MockApi,
  mockStaffApi,
  ok,
  roleMe,
  SAAD,
  secondsAgo,
  ticketFixture,
  VENUE_ID,
} from './support/api';
import { runOnlyAt390 } from './support/checks';

/**
 * GAP-5 (S-06 → S-07) and GAP-6 («إنهاء المناوبة قسرًا» in S-06) — 02 S-06; the DEC-32 confirmation of S-06 (the
 * custody snapshot with «فتح» on each item, what happens automatically, the server's `details.items` under its
 * `message_ar`: 02 §1.9, DEC-80, DEC-351).
 */
runOnlyAt390();

const onDuty = (over: Record<string, unknown> = {}) =>
  driverItemFixture({
    live: {
      driver: SAAD,
      driver_state: 'busy_with_next',
      connection_state: 'online',
      active_task_id: 'k-44',
      next_task_id: 'k-45',
      duty_started_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
      duty_session_id: 'ds-saad',
    },
    ...over,
  });

const offDuty = () =>
  driverItemFixture({
    live: { driver: SAAD, driver_state: 'off_duty', connection_state: 'offline', duty_session_id: null },
  });

test('GAP-5: S-06 «نقل إلى موقع آخر» opens S-07 for the driver, and S-07 returns to S-06', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  await api.install();
  await page.goto(`/drivers/${SAAD.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(SAAD.full_name);
  await page.getByRole('button', { name: 'نقل إلى موقع آخر' }).click();
  await expect(page).toHaveURL(new RegExp(`/drivers/${SAAD.id}/transfer$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('نقل سائق · سعد الحربي (D-0042)');
  await expect(page.getByTestId('transfer-checklist')).toContainText('#39 — يجب إعادته أو نقله رسميًا');
  // the snapshot rows carry «فتح» too (02 S-07: `[فتح]` on the ✗ row), before any refusal
  await expect(page.getByTestId('transfer-checklist').getByRole('button', { name: 'فتح' })).toHaveCount(3);
  await page.getByRole('button', { name: 'رجوع' }).click();
  await expect(page).toHaveURL(new RegExp(`/drivers/${SAAD.id}$`));
});

test('S-07 with two live events: one row per ticket with its event, «فتح» opens that ticket; live single offers', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  // display numbers are unique per event only (UNIQUE (event_id, display_number)): #39 exists in both events
  const second = eventFixture({ id: 'e-rms-2', name_ar: 'حفل آل ناصر', status: 'closing' });
  api.on('GET', `/v1/venues/${VENUE_ID}/events`, ok([eventFixture(), second]));
  api.on(
    'GET',
    '/v1/events/e-rms-2/operations',
    ok(
      boardFixture({
        event: second,
        queue: [
          {
            task_id: 'k-60',
            ticket: ticketFixture(60, { id: 't-60', event_id: 'e-rms-2', status: 'requested' }),
            status: 'offered',
            requested_at: secondsAgo(20),
            waiting_seconds: 20,
            offer: { offer_id: 'o-60', mode: 'single', round_no: 1, recipients: 1, recipient: SAAD },
          },
        ],
        active_tasks: [],
        next_tasks: [],
        custody_issues: [
          {
            ticket: ticketFixture(39, { id: 't-b39', event_id: 'e-rms-2', event_name_ar: 'حفل آل ناصر' }),
            subject: 'key',
            holder: { type: 'driver', id: SAAD.id, label: SAAD.full_name },
            since: secondsAgo(100),
          },
        ],
      }),
    ),
  );
  await api.install();
  await page.goto(`/drivers/${SAAD.id}/transfer`);
  const checklist = page.getByTestId('transfer-checklist');
  await expect(checklist).toContainText('مفاتيح بعهدته: 3');
  await expect(checklist).toContainText('#39 · حفل آل سعيد — يجب إعادته أو نقله رسميًا');
  await expect(checklist).toContainText('#39 · حفل آل ناصر — يجب إعادته أو نقله رسميًا');
  await expect(checklist).toContainText('عروض فردية حية: 1');
  await expect(checklist).toContainText('ستُسحب');
  await checklist
    .locator('.st-inline-list', { hasText: '#39 · حفل آل ناصر' })
    .getByRole('button', { name: 'فتح' })
    .click();
  await expect(page).toHaveURL(/\/ops\/tickets\/t-b39$/);
});

test('GAP-5: no transfer for a driver without an active assignment, nor without driver.transfer', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('supervisor', { remove: ['driver.transfer'] }));
  mockStaffApi(api);
  await api.install();
  await page.goto(`/drivers/${SAAD.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(SAAD.full_name);
  await expect(page.getByRole('button', { name: 'نقل إلى موقع آخر' })).toHaveCount(0);

  api.me = roleMe('supervisor');
  api.on('GET', `/v1/drivers/${SAAD.id}`, ok(driverItemFixture({ active_assignment: null, live: null })));
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(SAAD.full_name);
  await expect(page.getByRole('button', { name: 'تعيين على موقع' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'نقل إلى موقع آخر' })).toHaveCount(0);
});

test('GAP-6: «إنهاء المناوبة قسرًا» — the snapshot, DUTY_END_BLOCKED_CUSTODY items, then the forced end', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  let ended = false;
  api.on('GET', `/v1/drivers/${SAAD.id}`, () => ok(ended ? offDuty() : onDuty()));
  api.sequence('POST', '/v1/duty-sessions/ds-saad/force-end', [
    apiError('DUTY_END_BLOCKED_CUSTODY', 409, {
      details: { items: [{ type: 'key', ticket_id: 't-39', display_number: 39 }] },
    }),
    () => {
      ended = true;
      return ok({
        id: 'ds-saad',
        user_id: SAAD.id,
        status: 'ended',
        ended_at: new Date().toISOString(),
        end_reason: 'forced',
        version: 4,
      });
    },
  ]);
  await api.install();
  await page.goto(`/drivers/${SAAD.id}`);
  await page.getByRole('button', { name: 'إنهاء المناوبة قسرًا' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'إنهاء المناوبة قسرًا' });
  await expect(dialog).toContainText(SAAD.full_name);
  // the snapshot (02 S-06, DEC-32): what blocks, each item with «فتح»; what happens automatically
  const checklist = dialog.getByTestId('custody-checklist');
  await expect(checklist).toContainText('مركبات بعهدته: 1');
  await expect(checklist).toContainText('مفاتيح بعهدته: 2');
  await expect(checklist).toContainText('#39 — يجب إعادته أو نقله رسميًا');
  await expect(checklist).toContainText('مهمة جارية أو صف/إعادة صف: نعم #44');
  await expect(checklist.getByRole('button', { name: 'فتح' })).toHaveCount(3);
  await expect(dialog).toContainText(
    'المهمة التالية المحجوزة #45 ومهمة الإحضار المقبولة قبل استلام المفتاح ستعودان للطابور بأولويتهما، وتُسحب عروضه الفردية.',
  );
  // the reason is mandatory (3+ characters)
  const confirm = dialog.getByRole('button', { name: 'إنهاء المناوبة قسرًا' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('السبب (إلزامي)').fill('غادر الموقع دون إنهاء مناوبته');
  await confirm.click();
  // the server's items replace the snapshot, under the server's text (DEC-80)
  await expect(dialog.getByRole('alert')).toHaveText(errorMessagesAr.DUTY_END_BLOCKED_CUSTODY);
  await expect(checklist).toContainText('مفاتيح بعهدته: 1');
  await expect(checklist).toContainText('مركبات بعهدته: 0');
  await confirm.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('تم تنفيذ الإجراء.')).toBeVisible();
  await expect(page.getByText('لا توجد مناوبة مفتوحة.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'إنهاء المناوبة قسرًا' })).toHaveCount(0);
  const calls = api.callsTo('POST', '/v1/duty-sessions/ds-saad/force-end');
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    expect(call.body).toEqual({ reason: 'غادر الموقع دون إنهاء مناوبته' });
    expect(call.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  }
});

test('GAP-6: «فتح» in the snapshot opens the ticket to transfer it officially first', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  api.on('GET', `/v1/drivers/${SAAD.id}`, ok(onDuty()));
  await api.install();
  await page.goto(`/drivers/${SAAD.id}`);
  await page.getByRole('button', { name: 'إنهاء المناوبة قسرًا' }).click();
  const checklist = page.getByRole('alertdialog').getByTestId('custody-checklist');
  // the keys row lists #44 and #39, each with its own «فتح»
  const keysRow = checklist.getByRole('listitem').filter({ hasText: 'مفاتيح بعهدته' });
  await keysRow.locator('span', { hasText: '#39 — يجب إعادته أو نقله رسميًا' }).getByRole('button').click();
  await expect(page).toHaveURL(/\/ops\/tickets\/t-39$/);
  expect(api.callsTo('POST', '/v1/duty-sessions/ds-saad/force-end')).toHaveLength(0);
});

test('GAP-6: the forced end is the supervisor’s alone (canon §10 duty.force_end); off duty, nothing to end', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('admin'));
  mockStaffApi(api);
  api.on('GET', `/v1/drivers/${SAAD.id}`, ok(onDuty()));
  await api.install();
  await page.goto(`/drivers/${SAAD.id}`);
  await expect(page.getByRole('button', { name: 'تعطيل الحساب' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'إنهاء المناوبة قسرًا' })).toHaveCount(0);

  api.me = roleMe('owner');
  await page.reload();
  await expect(page.getByRole('button', { name: 'تعطيل الحساب' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'إنهاء المناوبة قسرًا' })).toHaveCount(0);

  api.me = roleMe('supervisor');
  api.on('GET', `/v1/drivers/${SAAD.id}`, ok(offDuty()));
  await page.reload();
  await expect(page.getByText('لا توجد مناوبة مفتوحة.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'إنهاء المناوبة قسرًا' })).toHaveCount(0);
});

test('S-06 «تعطيل الحساب»: the DEC-32 snapshot, then CUSTODY_OPEN with its items and the server text', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('admin'));
  mockStaffApi(api);
  api.on('GET', `/v1/drivers/${SAAD.id}`, ok(onDuty()));
  api.on(
    'POST',
    `/v1/drivers/${SAAD.id}/disable`,
    apiError('CUSTODY_OPEN', 409, {
      details: {
        items: [
          { type: 'vehicle', ticket_id: 't-44', display_number: 44 },
          { type: 'key', ticket_id: 't-44', display_number: 44 },
        ],
      },
    }),
  );
  await api.install();
  await page.goto(`/drivers/${SAAD.id}`);
  await page.getByRole('button', { name: 'تعطيل الحساب' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'تعطيل الحساب' });
  const checklist = dialog.getByTestId('custody-checklist');
  await expect(checklist).toContainText('مفاتيح بعهدته: 2');
  await expect(dialog).toContainText('المهمة التالية المحجوزة #45');
  await dialog.getByLabel('السبب (إلزامي)').fill('انتهاء العقد');
  await dialog.getByRole('button', { name: 'تعطيل الحساب' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(errorMessagesAr.CUSTODY_OPEN);
  await expect(checklist).toContainText('مركبات بعهدته: 1');
  await expect(checklist).toContainText('مفاتيح بعهدته: 1');
  await expect(dialog).toBeVisible();
});
