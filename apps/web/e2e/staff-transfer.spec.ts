import { expect, test } from '@playwright/test';
import {
  apiError,
  boardFixture,
  driverItemFixture,
  EVENT_ID,
  KHALID,
  MockApi,
  mockStaffApi,
  ok,
  OTHER_VENUE_ID,
  roleMe,
  VENUE_ID,
} from './support/api';
import { runOnlyAt390 } from './support/checks';

/**
 * S-07 — نقل سائق (PNT-086, DEC-32): the custody checklist from the snapshot blocks «الآن»; a scheduled transfer is
 * sent with the Riyadh time as UTC; the server's TRANSFER_BLOCKED_CUSTODY items replace the checklist.
 */
runOnlyAt390();

const transferReply = (body: Record<string, unknown>) =>
  ok(
    {
      id: 'tr-1',
      driver_id: 'd-saad',
      from_venue_id: VENUE_ID,
      to_venue_id: body.to_venue_id,
      scheduled_at: body.scheduled_at ?? new Date().toISOString(),
      status: body.scheduled_at ? 'pending' : 'completed',
      reason: body.reason,
      version: 1,
    },
    201,
  );

test('custody blocks «الآن»; a scheduled transfer goes with the Riyadh time in UTC', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  api.on('POST', '/v1/drivers/d-saad/transfers', (req) => transferReply(req.postDataJSON()));
  await api.install();
  await page.goto('/drivers/d-saad/transfer');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('نقل سائق · سعد الحربي (D-0042)');
  await expect(page.getByText('من: قاعة ريماس (الحالي)')).toBeVisible();

  const checklist = page.getByTestId('transfer-checklist');
  await expect(checklist).toContainText('مركبات بعهدته: 1');
  await expect(checklist).toContainText('مفاتيح بعهدته: 2');
  await expect(checklist).toContainText('#44 — يجب إعادته أو نقله رسميًا');
  await expect(checklist).toContainText('#39 — يجب إعادته أو نقله رسميًا');
  await expect(checklist).toContainText('مهمة جارية أو صف/إعادة صف: نعم #44');
  await expect(checklist).toContainText('مهمة تالية محجوزة: #45');

  await page.getByLabel('إلى', { exact: true }).selectOption(OTHER_VENUE_ID);
  await page.getByLabel('سبب النقل (إلزامي)').fill('نقص سائقين في قاعة ليالي');
  const confirm = page.getByRole('button', { name: 'تأكيد النقل' });
  await expect(confirm).toBeDisabled();

  await page.getByRole('radio', { name: 'في وقت محدد' }).click();
  await page.getByLabel('الوقت', { exact: true }).fill('2026-10-29T21:30');
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByText(/جُدول نقل سعد الحربي إلى قاعة ليالي الساعة/)).toBeVisible();
  const call = api.callsTo('POST', '/v1/drivers/d-saad/transfers')[0];
  expect(call?.body).toEqual({
    to_venue_id: OTHER_VENUE_ID,
    scheduled_at: '2026-10-29T18:30:00.000Z',
    reason: 'نقص سائقين في قاعة ليالي',
  });
  expect(call?.headers['idempotency-key']).toBeTruthy();
});

test('TRANSFER_BLOCKED_CUSTODY: the server items replace the checklist', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api, { board: boardFixture({ active_tasks: [], next_tasks: [], custody_issues: [] }) });
  const khalid = driverItemFixture({
    user: { ...KHALID, role: 'driver', status: 'active', version: 1 },
    live: { driver: KHALID, driver_state: 'available', connection_state: 'online' },
  });
  api.on('GET', `/v1/drivers/${KHALID.id}`, ok(khalid));
  api.on('GET', `/v1/drivers/${KHALID.id}/assignments`, ok({ assignments: [], transfers: [] }));
  const refusal = 'لا يمكن نقل السائق قبل إعادة العهدة.';
  api.on('POST', `/v1/drivers/${KHALID.id}/transfers`, () =>
    apiError('TRANSFER_BLOCKED_CUSTODY', 409, {
      message_ar: refusal,
      details: { items: [{ type: 'key', ticket_id: 't-31', display_number: 31, holder_type: 'driver' }] },
    }),
  );
  await api.install();
  await page.goto(`/drivers/${KHALID.id}/transfer`);
  const checklist = page.getByTestId('transfer-checklist');
  await expect(checklist).toContainText('مفاتيح بعهدته: 0');
  await page.getByLabel('إلى', { exact: true }).selectOption(OTHER_VENUE_ID);
  await page.getByLabel('سبب النقل (إلزامي)').fill('نقص سائقين في قاعة ليالي');
  const confirm = page.getByRole('button', { name: 'تأكيد النقل' });
  await confirm.click();
  await expect(page.getByRole('alert').filter({ hasText: refusal })).toBeVisible();
  await expect(checklist).toContainText('مفاتيح بعهدته: 1');
  await expect(checklist).toContainText('#31 — يجب إعادته أو نقله رسميًا');
  await expect(confirm).toBeDisabled();
  await checklist.getByRole('button', { name: 'فتح' }).click();
  await expect(page).toHaveURL(/\/ops\/tickets\/t-31$/);
});

test('a pending transfer is shown with «إلغاء النقل المجدول» (reason required)', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  const pending = {
    id: 'tr-9',
    driver_id: 'd-saad',
    from_venue_id: VENUE_ID,
    to_venue_id: OTHER_VENUE_ID,
    scheduled_at: '2026-10-29T18:30:00.000Z',
    status: 'pending',
    reason: 'نقص سائقين',
    version: 1,
  };
  api.on('GET', '/v1/drivers/d-saad/assignments', ok({ assignments: [], transfers: [pending] }));
  api.on('POST', '/v1/transfers/tr-9/cancel', ok({ ...pending, status: 'canceled' }));
  await api.install();
  await page.goto('/drivers/d-saad/transfer');
  await expect(page.getByText(/نقل .* إلى قاعة ليالي/)).toBeVisible();
  await page.getByRole('button', { name: 'إلغاء النقل المجدول' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'إلغاء النقل المجدول' });
  await expect(dialog.getByRole('button', { name: 'تأكيد' })).toBeDisabled();
  await dialog.getByLabel('السبب (إلزامي)').fill('تغيّر جدول الحفل');
  await dialog.getByRole('button', { name: 'تأكيد' }).click();
  await expect(dialog).toBeHidden();
  expect(api.callsTo('POST', '/v1/transfers/tr-9/cancel')[0]?.body).toEqual({ reason: 'تغيّر جدول الحفل' });
  // the board of the old venue was read for the checklist
  expect(api.callsTo('GET', `/v1/events/${EVENT_ID}/operations`).length).toBeGreaterThan(0);
});
