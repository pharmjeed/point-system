import { expect, test } from '@playwright/test';
import {
  apiError,
  MockApi,
  mockStaffApi,
  ok,
  roleMe,
  STAFF_USER_ID,
  ticketDetailFixture,
} from './support/api';
import { runOnlyAt390 } from './support/checks';

/**
 * PNT-079 — اعتماد استثناء الفحص ونقل العهدة الرسمي (S-03): both need a reason; the custody transfer picks the
 * subject and the new holder (a driver, the supervisor, a free key slot or spot) and shows CUSTODY_HOLDER_MISMATCH.
 */
runOnlyAt390();

test('«اعتماد استثناء الفحص» for an incomplete inspection, with its reason', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api, {
    ticket: ticketDetailFixture({
      status: 'parked',
      inspection_status: 'incomplete',
      active_cycle: null,
      open_task: null,
    }),
  });
  api.on(
    'POST',
    '/v1/tickets/t-47/inspection-exception',
    ok(ticketDetailFixture({ inspection_status: 'exception_approved' })),
  );
  await api.install();
  await page.goto('/ops/tickets/t-47');
  await expect(page.getByText('«غير مكتمل»')).toBeVisible();
  await page.getByRole('button', { name: 'الإجراءات' }).click();
  await page.getByRole('button', { name: 'اعتماد استثناء الفحص' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'اعتماد استثناء الفحص' });
  const confirm = dialog.getByRole('button', { name: 'تأكيد' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('السبب (إلزامي)').fill('الصور الخلفية تعذرت بسبب الإضاءة');
  await confirm.click();
  await expect(dialog).toBeHidden();
  const call = api.callsTo('POST', '/v1/tickets/t-47/inspection-exception')[0];
  expect(call?.body).toEqual({ reason: 'الصور الخلفية تعذرت بسبب الإضاءة' });
  expect(call?.headers['idempotency-key']).toBeTruthy();
});

test('«نقل عهدة رسمي»: the key to a free slot; the supervisor; CUSTODY_HOLDER_MISMATCH', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  const mismatch = 'العهدة انتقلت قبل طلبك. حدّث الصفحة.';
  api.sequence('POST', '/v1/tickets/t-47/custody-transfers', [
    apiError('CUSTODY_HOLDER_MISMATCH', 409, { message_ar: mismatch }),
    ok({ id: 'cu-9', subject: 'key', to_holder_type: 'supervisor' }, 201),
  ]);
  await api.install();
  await page.goto('/ops/tickets/t-47?action=custodyTransfer');
  const sheet = page.getByRole('dialog', { name: 'نقل عهدة رسمي' });
  await expect(sheet.getByRole('radio', { name: 'المفتاح' })).toBeChecked();
  const confirm = sheet.getByRole('button', { name: 'تأكيد' });
  await sheet.getByRole('radio', { name: 'خانة مفتاح' }).check();
  // only the free slots of the venue's key boards
  await expect(sheet.getByLabel('الحائز', { exact: true }).locator('option')).toHaveText([
    '—',
    'اللوحة 1 · 13',
  ]);
  await sheet.getByLabel('الحائز', { exact: true }).selectOption('ks-13');
  await expect(confirm).toBeDisabled();
  await sheet.getByLabel('السبب (إلزامي)').fill('إعادة المفتاح بعد انقطاع السائق');
  await confirm.click();
  await expect(sheet.getByRole('alert')).toHaveText(mismatch);

  await sheet.getByRole('radio', { name: 'أنا (المشرف)' }).check();
  await confirm.click();
  await expect(sheet).toBeHidden();
  const calls = api.callsTo('POST', '/v1/tickets/t-47/custody-transfers');
  expect(calls[0]?.body).toEqual({
    subject: 'key',
    to_holder_type: 'key_slot',
    to_holder_id: 'ks-13',
    reason: 'إعادة المفتاح بعد انقطاع السائق',
  });
  expect(calls[1]?.body).toEqual({
    subject: 'key',
    to_holder_type: 'supervisor',
    to_holder_id: STAFF_USER_ID,
    reason: 'إعادة المفتاح بعد انقطاع السائق',
  });
});
