import { expect, test } from '@playwright/test';
import {
  apiError,
  closeBlockersFixture,
  EVENT_ID,
  eventFixture,
  MockApi,
  mockStaffApi,
  ok,
  reconciliationFixture,
  roleMe,
  SAAD,
  secondsAgo,
} from './support/api';
import { runOnlyAt390 } from './support/checks';

/**
 * S-10 — إغلاق الحفل والمطابقة (PNT-087, 13 §10–§12): start closing, the reconciliation with its blockers
 * (highlighted, «إغلاق الحفل» disabled), the cash handover with its difference, and a refused close
 * (EVENT_CLOSE_BLOCKED) that shows the server's blockers.
 */
runOnlyAt390();

const closing = () => eventFixture({ status: 'closing', closing_started_at: secondsAgo(900), version: 4 });

test('shows the close blockers and keeps «إغلاق الحفل» disabled', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api, { event: closing() });
  await api.install();
  await page.goto(`/events/${EVENT_ID}/close`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('إغلاق الحفل · حفل آل سعيد');

  const summary = page.getByTestId('close-summary');
  await expect(summary).toContainText('تذاكر مفتوحة: 1');
  await expect(summary).toContainText('عهدة لدى سائقين: 1');
  await expect(summary).toContainText('تحصيل مستحق: 1');
  await expect(summary).toContainText('تحصيل غير مسلّم:');
  await expect(summary).toContainText('75.00');
  await expect(summary.getByRole('img', { name: '✗' })).toHaveCount(4);

  const openTickets = page.getByRole('region', { name: 'التذاكر المفتوحة' });
  await expect(openTickets).toContainText('#51');
  await expect(openTickets).toHaveClass(/st-flagged/);
  await expect(page.getByRole('region', { name: 'العهدة لدى السائقين' })).toContainText('مفتاح #39');
  await expect(page.getByRole('region', { name: 'التحصيل المستحق' })).toContainText('#53');
  await expect(page.getByRole('region', { name: 'التحصيل حسب السائق' })).toContainText('سعد الحربي');
  await expect(page.getByText('لا يمكن الإغلاق قبل حل البنود المظللة.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'إغلاق الحفل' })).toBeDisabled();
});

test('«استلام نقد» records the received amount and shows the difference', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api, { event: closing() });
  api.on('POST', '/v1/cash-handovers', (req) =>
    ok(
      {
        id: 'ch-1',
        event_id: EVENT_ID,
        driver: SAAD,
        received_by: { id: 'u-1', full_name: 'نورة القحطاني' },
        amount_halalas: (req.postDataJSON() as { amount_halalas: number }).amount_halalas,
        expected_halalas: 7500,
        difference_halalas: -500,
        handed_at: new Date().toISOString(),
      },
      201,
    ),
  );
  await api.install();
  await page.goto(`/events/${EVENT_ID}/close`);
  const cash = page.getByRole('region', { name: 'التحصيل حسب السائق' });
  await cash.getByRole('button', { name: 'استلام نقد' }).click();
  const sheet = page.getByRole('dialog', { name: 'استلام نقد' });
  await expect(sheet).toContainText('سعد الحربي');
  await expect(sheet).toContainText('75.00');
  await sheet.getByLabel('المبلغ المستلم').fill('70');
  await expect(sheet).toContainText('-5.00');
  await sheet.getByRole('button', { name: 'تأكيد' }).click();
  await expect(sheet).toBeHidden();
  const call = api.callsTo('POST', '/v1/cash-handovers')[0];
  expect(call?.body).toEqual({ event_id: EVENT_ID, driver_id: SAAD.id, amount_halalas: 7000, note: null });
  expect(call?.headers['idempotency-key']).toBeTruthy();
});

test('a refused close (EVENT_CLOSE_BLOCKED) shows the server text and its blockers', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api, { event: closing() });
  api.on('GET', `/v1/events/${EVENT_ID}/reconciliation`, ok(reconciliationFixture(false)));
  const refusal = 'لا يمكن الإغلاق: توجد تذاكر مفتوحة أو تحصيل غير مسلّم.';
  api.on('POST', `/v1/events/${EVENT_ID}/close`, () =>
    apiError('EVENT_CLOSE_BLOCKED', 409, {
      message_ar: refusal,
      details: { blockers: { ...closeBlockersFixture(), keys_not_in_slots: [], unsettled_payments: [] } },
    }),
  );
  await api.install();
  await page.goto(`/events/${EVENT_ID}/close`);
  await expect(page.getByText('لا توجد بنود مانعة.')).toBeVisible();
  const close = page.getByRole('button', { name: 'إغلاق الحفل' });
  await expect(close).toBeEnabled();
  await close.click();
  // 03 §4.5 (audit A-S10-1): `closed` is final, the close is confirmed first — nothing is sent before
  const confirm = page.getByRole('alertdialog', { name: 'إغلاق الحفل' });
  await expect(confirm).toContainText('إغلاق الحفل نهائي');
  expect(api.callsTo('POST', `/v1/events/${EVENT_ID}/close`)).toHaveLength(0);
  await confirm.getByRole('button', { name: 'إغلاق الحفل' }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByRole('alert').filter({ hasText: refusal })).toBeVisible();
  const openTickets = page.getByRole('region', { name: 'التذاكر المفتوحة' });
  await expect(openTickets).toContainText('#51');
  await expect(openTickets).toHaveClass(/st-flagged/);
  await expect(page.getByTestId('close-summary')).toContainText('تذاكر مفتوحة: 1');
  await expect(close).toBeDisabled();
  expect(api.callsTo('POST', `/v1/events/${EVENT_ID}/close`)[0]?.body).toEqual({ expected_version: 4 });
});

test('«بدء الإغلاق» confirms, then the event is closing', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  const state = mockStaffApi(api);
  api.on('POST', `/v1/events/${EVENT_ID}/start-closing`, () => {
    state.event = closing();
    return ok(state.event);
  });
  await api.install();
  await page.goto(`/events/${EVENT_ID}/close`);
  await page.getByRole('button', { name: 'بدء الإغلاق' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'بدء الإغلاق' });
  await expect(dialog).toContainText('يمنع تسجيل مركبات جديدة');
  await dialog.getByRole('button', { name: 'تأكيد' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'إغلاق الحفل' })).toBeVisible();
  expect(api.callsTo('POST', `/v1/events/${EVENT_ID}/start-closing`)[0]?.body).toEqual({
    expected_version: 3,
  });
});
