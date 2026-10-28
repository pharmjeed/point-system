import { expect, test } from '@playwright/test';
import { apiError, MockApi, mockStaffApi, ok, roleMe } from './support/api';
import { browserStorageDump, runOnlyAt390 } from './support/checks';

/**
 * PNT-077 — كشف الجوال المبرر (S-03, 09 §5.1): «إظهار الرقم» needs a reason from the list («أخرى» → text), is
 * audited server-side, shows the number for 60 s with a call link and keeps it nowhere (no storage, URL, history,
 * toast or cache); RATE_LIMITED shows the server text.
 */
runOnlyAt390();

const PHONE = '+966501234123';
const DIGITS = '501234123';

test('a reason is required, the number shows for 60 s and is never stored', async ({ page }) => {
  await page.clock.install();
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  api.on('POST', '/v1/tickets/t-47/reveal-phone', () =>
    ok({ phone_e164: PHONE, revealed_at: new Date().toISOString() }),
  );
  await api.install();
  await page.goto('/ops/tickets/t-47');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('تفاصيل التذكرة · #47');
  await expect(page.getByText('05•••••123')).toBeVisible();

  await page.getByRole('button', { name: 'إظهار الرقم' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'إظهار الجوال' });
  await expect(dialog).toContainText('يُسجّل هذا الإجراء في سجل التدقيق.');
  const confirm = dialog.getByRole('button', { name: 'تأكيد' });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole('radio', { name: 'أخرى' }).check();
  await expect(confirm).toBeDisabled(); // «أخرى» needs the text
  await dialog.getByLabel('السبب (إلزامي)').fill('تأكيد موعد الخروج');
  await confirm.click();

  const revealed = page.getByTestId('revealed-phone');
  await expect(revealed).toContainText(PHONE);
  await expect(revealed.getByRole('link', { name: 'اتصال' })).toHaveAttribute('href', `tel:${PHONE}`);
  await expect(revealed).toContainText(/يعود الرقم مقنّعًا خلال \d+ ث/);
  const calls = api.callsTo('POST', '/v1/tickets/t-47/reveal-phone');
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body).toEqual({ reason: 'تأكيد موعد الخروج' });
  expect(calls[0]?.headers['idempotency-key']).toBeTruthy();

  // nowhere in browser storage, the URL or history while it is shown; no toast either
  expect(await browserStorageDump(page)).not.toContain(DIGITS);
  await expect(page.locator('.pt-toast')).toHaveCount(0);

  await page.clock.runFor(61_000);
  await expect(revealed).toHaveCount(0);
  await expect(page.getByText('05•••••123')).toBeVisible();
  expect(await page.content()).not.toContain(DIGITS);
  expect(await browserStorageDump(page)).not.toContain(DIGITS);
});

test('a listed reason is enough; RATE_LIMITED shows the server text', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  api.sequence('POST', '/v1/tickets/t-47/reveal-phone', [
    apiError('RATE_LIMITED', 429, { headers: { 'Retry-After': '60' } }),
    ok({ phone_e164: PHONE, revealed_at: new Date().toISOString() }),
  ]);
  await api.install();
  await page.goto('/ops/tickets/t-47');
  await page.getByRole('button', { name: 'إظهار الرقم' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'إظهار الجوال' });
  await dialog.getByRole('radio', { name: 'التواصل مع العميل لعدم الحضور' }).check();
  await dialog.getByRole('button', { name: 'تأكيد' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('revealed-phone')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'تأكيد' }).click();
  await expect(page.getByTestId('revealed-phone')).toContainText(PHONE);
  expect(api.callsTo('POST', '/v1/tickets/t-47/reveal-phone')[1]?.body).toEqual({
    reason: 'التواصل مع العميل لعدم الحضور',
  });
});

test('«إظهار الرقم» follows ticket.reveal_phone: the owner has it, without it only the mask', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('owner'));
  mockStaffApi(api);
  await api.install();
  await page.goto('/ops/tickets/t-47');
  await expect(page.getByRole('button', { name: 'إظهار الرقم' })).toBeVisible();

  api.me = roleMe('supervisor', { remove: ['ticket.reveal_phone'] });
  await page.reload();
  await expect(page.getByText('05•••••123')).toBeVisible();
  await expect(page.getByRole('button', { name: 'إظهار الرقم' })).toHaveCount(0);
});
