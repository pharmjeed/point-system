import { expect, test } from '@playwright/test';
import {
  apiError,
  KHALID,
  MockApi,
  mockStaffApi,
  ok,
  roleMe,
  secondsAgo,
  ticketDetailFixture,
} from './support/api';
import { runOnlyAt390 } from './support/checks';

/**
 * PNT-078 — التسليم الاستثنائي دون رمز (S-03, 07 `handover-exception`): two documented identity checks at least
 * (the plate alone never), the mandatory reason, the due fee with the collector; VALIDATION_FAILED lands on its
 * field.
 */
runOnlyAt390();

const readyTicket = () =>
  ticketDetailFixture({
    status: 'ready',
    payment_status: 'due',
    open_task: {
      id: 'k-47',
      ticket_id: 't-47',
      type: 'retrieve',
      status: 'in_progress',
      priority_at: secondsAgo(600),
      seq: 3,
      assignee: KHALID,
      accepted_at: secondsAgo(500),
      key_picked_up_at: secondsAgo(450),
      started_at: secondsAgo(400),
      version: 4,
    },
  });

test('two identity checks, the reason and the payment are required; the server field error is shown', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api, { ticket: readyTicket() });
  const mismatch = 'آخر 4 أرقام لا تطابق جوال العميل.';
  api.sequence('POST', '/v1/tickets/t-47/handover-exception', [
    apiError('VALIDATION_FAILED', 422, {
      details: {
        fields: [{ field: 'identity_checks.phone_last4', issue: 'mismatch', message_ar: mismatch }],
      },
    }),
    ok({ ticket: { ...readyTicket(), status: 'delivered' }, cycle: {}, payment: null }),
  ]);
  await api.install();
  await page.goto('/ops/tickets/t-47');
  await page.getByRole('button', { name: 'الإجراءات' }).click();
  await page.getByRole('button', { name: 'تسليم استثنائي دون رمز' }).click();
  const sheet = page.getByRole('dialog', { name: 'تسليم دون رمز (استثناء)' });
  await expect(sheet).toContainText('اختر طريقتي تحقق على الأقل؛ رقم اللوحة وحده لا يكفي.');
  const confirm = sheet.getByRole('button', { name: 'تأكيد التسليم الاستثنائي' });

  await sheet.getByLabel('مطابقة آخر 4 أرقام من جوال العميل').check();
  await sheet.getByLabel('آخر 4 أرقام', { exact: true }).fill('1299');
  await sheet.getByLabel('السبب (إلزامي)').fill('نفدت بطارية جوال العميل');
  await expect(confirm).toBeDisabled(); // one check only
  await sheet.getByLabel('وصف محتويات المركبة').check();
  await expect(confirm).toBeDisabled(); // the fee is due: a method is needed
  await expect(sheet).toContainText('25.00');
  await sheet.getByLabel('وسيلة التحصيل').selectOption('cash');
  await expect(sheet.getByLabel('المحصّل')).toHaveValue(KHALID.id);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(sheet.locator('#act-exc-last4-err')).toHaveText(mismatch);

  await sheet.getByLabel('آخر 4 أرقام', { exact: true }).fill('0123');
  await confirm.click();
  await expect(sheet).toBeHidden();
  const calls = api.callsTo('POST', '/v1/tickets/t-47/handover-exception');
  expect(calls).toHaveLength(2);
  expect(calls[1]?.body).toEqual({
    reason: 'نفدت بطارية جوال العميل',
    identity_checks: { phone_last4: '0123', vehicle_description_confirmed: true },
    payment: { method: 'cash', amount_halalas: 2500, pos_reference: null, collected_by: KHALID.id },
    expected_version: 3,
  });
  expect(calls[0]?.headers['idempotency-key']).not.toBe(calls[1]?.headers['idempotency-key']);
});

test('the exception is offered only when the vehicle is ready, to whoever holds handover.exception', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api); // #47 is requested, not ready
  await api.install();
  await page.goto('/ops/tickets/t-47');
  await page.getByRole('button', { name: 'الإجراءات' }).click();
  const sheet = page.getByRole('dialog', { name: 'الإجراءات' });
  await expect(sheet.getByRole('button', { name: 'فتح واقعة' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'تسليم استثنائي دون رمز' })).toHaveCount(0);
});
