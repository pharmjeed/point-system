import { expect, test } from '@playwright/test';
import { MockApi, mockStaffApi, ok, roleMe, waChannelFixture } from './support/api';
import { runOnlyAt390 } from './support/checks';

/**
 * S-13 — الإدارة (PNT-091/092): the sections follow the role; organization settings check the bounds and the
 * heartbeat order inline and show the server's VALIDATION_FAILED fields on the same inputs; outbox retry, the
 * audit log, the retention policy and the WhatsApp channel/templates (one of the surfaces allowed to show the
 * customer brand, canon §1 rule 2).
 */
runOnlyAt390();

const CUSTOMER = 'مصاف';

test('the sections follow the role: admin and owner', async ({ page }) => {
  const api = new MockApi(page, roleMe('admin'));
  mockStaffApi(api);
  await api.install();
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('الإدارة');
  for (const name of ['قناة واتساب', 'القوالب', 'صندوق الأحداث', 'سجل التدقيق'])
    await expect(page.getByRole('link', { name })).toBeVisible();
  await expect(page.getByText('الموظفون')).toBeVisible();

  api.me = roleMe('supervisor');
  await page.goto('/admin');
  await expect(page.getByText('لا تملك صلاحية عرض هذه الصفحة.')).toBeVisible();
});

test('outbox: failed and dead events with «إعادة المحاولة»', async ({ page }) => {
  const api = new MockApi(page, roleMe('admin'));
  mockStaffApi(api);
  api.on('POST', '/v1/admin/outbox/ob-1/retry', ok({ id: 'ob-1', status: 'pending' }));
  await api.install();
  await page.goto('/admin/outbox');
  await expect(page.getByText('job.whatsapp.send').filter({ visible: true })).toBeVisible();
  await expect(page.getByText('DEPENDENCY_TIMEOUT').filter({ visible: true })).toBeVisible();
  // failed and dead by default (repeated `status` values)
  await expect(page.getByText('job.push.send').filter({ visible: true })).toBeVisible();
  await page.getByRole('group', { name: 'الحالة' }).getByRole('button', { name: 'متوقف نهائيًا' }).click();
  await expect(page.getByText('job.push.send').filter({ visible: true })).toHaveCount(0);
  await expect(page.getByText('job.whatsapp.send').filter({ visible: true })).toBeVisible();
  await page.getByRole('button', { name: 'إعادة المحاولة' }).first().click();
  await expect(page.locator('.pt-toast').filter({ hasText: 'تم تنفيذ الإجراء.' })).toBeVisible();
  expect(api.callsTo('POST', '/v1/admin/outbox/ob-1/retry')[0]?.headers['idempotency-key']).toBeTruthy();
});

test('audit log: read only, before/after on demand', async ({ page }) => {
  const api = new MockApi(page, roleMe('admin'));
  mockStaffApi(api);
  await api.install();
  await page.goto('/admin/audit');
  await expect(page.getByText('ticket.reveal_phone').filter({ visible: true })).toBeVisible();
  await page.locator('summary').filter({ hasText: 'قبل / بعد' }).filter({ visible: true }).click();
  await expect(page.getByText('"revealed": true').filter({ visible: true })).toBeVisible();
});

test('WhatsApp channel and templates show the customer brand; secrets are references only', async ({
  page,
}) => {
  const me = { ...roleMe('owner'), brand: { customer_name_ar: CUSTOMER } };
  const api = new MockApi(page, me);
  mockStaffApi(api);
  api.on('GET', '/v1/admin/whatsapp/channel', ok({ ...waChannelFixture(), display_name: CUSTOMER }));
  api.on(
    'POST',
    '/v1/admin/whatsapp/templates/sync',
    ok([
      {
        id: 'tp-1',
        name: 'ticket_issued',
        language: 'ar',
        category: 'UTILITY',
        status: 'approved',
        components: [{ type: 'BODY', text: 'تم استلام سيارتك.' }],
        last_synced_at: new Date().toISOString(),
      },
    ]),
  );
  await api.install();
  await page.goto('/admin/channel');
  await expect(page.getByText(CUSTOMER).first()).toBeVisible();
  await expect(page.getByText('سليمة')).toBeVisible();
  await expect(page.getByText('محاكي')).toBeVisible();
  await expect(page.getByText(/رمز الوصول: مضبوط/)).toBeVisible();

  await page.goto('/admin/templates');
  const first = page.getByRole('article', { name: 'ticket_issued' });
  await expect(first).toContainText('معتمد');
  await expect(first.locator('.st-bubble')).toContainText(CUSTOMER);
  await expect(first.locator('.st-bubble')).toContainText('تم استلام سيارتك. رقم التذكرة {{1}}.');
  await page.getByRole('button', { name: 'مزامنة من Meta' }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
  expect(
    api.callsTo('POST', '/v1/admin/whatsapp/templates/sync')[0]?.headers['idempotency-key'],
  ).toBeTruthy();
});
