import { expect, test } from '@playwright/test';
import {
  apiError,
  MockApi,
  mockStaffApi,
  ok,
  orgSettingsFixture,
  roleMe,
  waChannelFixture,
} from './support/api';
import { runOnlyAt390 } from './support/checks';

/**
 * S-13 — الإدارة (PNT-091/092): the sections follow the role; organization settings check the bounds and the
 * heartbeat order inline and show the server's VALIDATION_FAILED fields on the same inputs; outbox retry, the
 * audit log, the retention policy and the WhatsApp channel/templates (one of the surfaces allowed to show the
 * customer brand, canon §1 rule 2).
 */
runOnlyAt390();

const CUSTOMER = 'مصاف';
const RULE = 'الفاصل أقل من حد «غير مؤكد»، وحد «غير مؤكد» أقل من حد «منقطع».';

test('organization settings: bad heartbeat order inline, then the server VALIDATION_FAILED fields', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('owner'));
  mockStaffApi(api);
  const serverText = 'يجب ألا يقل عدد المحاولات عن 5 في سياسة مؤسستك.';
  api.sequence('PUT', '/v1/admin/org-settings', [
    apiError('VALIDATION_FAILED', 422, {
      details: {
        fields: [{ field: 'security.max_login_attempts', issue: 'too_small', message_ar: serverText }],
      },
    }),
    ok({ ...orgSettingsFixture(), security: { ...orgSettingsFixture().security, max_login_attempts: 6 } }),
  ]);
  await api.install();
  await page.goto('/admin/org');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('إعدادات المؤسسة');
  const uncertain = page.locator('#org-heartbeat-uncertain_after_s');
  await expect(uncertain).toHaveValue('45');

  await uncertain.fill('150'); // offline is 120
  await expect(page.locator('#org-heartbeat-uncertain_after_s-err')).toHaveText(RULE);
  await expect(page.locator('#org-heartbeat-offline_after_s-err')).toHaveText(RULE);
  const save = page.getByRole('button', { name: 'حفظ' });
  await expect(save).toBeDisabled();
  await page.locator('#org-security-max_login_attempts').fill('2');
  await expect(page.locator('#org-security-max_login_attempts-err')).toHaveText('الحد الأدنى 3');
  expect(api.callsTo('PUT', '/v1/admin/org-settings')).toHaveLength(0);

  await uncertain.fill('45');
  await page.locator('#org-security-max_login_attempts').fill('4');
  await expect(page.locator('#org-heartbeat-uncertain_after_s-err')).toHaveCount(0);
  await save.click();
  await expect(page.locator('#org-security-max_login_attempts-err')).toHaveText(serverText);
  const first = api.callsTo('PUT', '/v1/admin/org-settings')[0];
  expect(first?.headers['idempotency-key']).toBeTruthy();
  expect(first?.body).toMatchObject({
    security: { max_login_attempts: 4, supervisor_mfa_required: true },
    heartbeat: { interval_s: 15, uncertain_after_s: 45, offline_after_s: 120 },
  });
  expect((first?.body as { security: Record<string, unknown> }).security).not.toHaveProperty('pin_length');

  // editing clears the server's field error; the next save is a new intent
  await page.locator('#org-security-max_login_attempts').fill('6');
  await expect(page.locator('#org-security-max_login_attempts-err')).toHaveCount(0);
  await save.click();
  await expect(page.locator('.pt-toast').filter({ hasText: 'تم تنفيذ الإجراء.' })).toBeVisible();
  const keys = api.callsTo('PUT', '/v1/admin/org-settings').map((c) => c.headers['idempotency-key']);
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]);
});

test('the sections follow the role: admin without organization settings, owner with them', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('admin'));
  mockStaffApi(api);
  await api.install();
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('الإدارة');
  for (const name of ['قناة واتساب', 'القوالب', 'صندوق الأحداث', 'سجل التدقيق', 'سياسة الاحتفاظ'])
    await expect(page.getByRole('link', { name })).toBeVisible();
  await expect(page.getByRole('link', { name: 'إعدادات المؤسسة' })).toHaveCount(0);
  await page.goto('/admin/org');
  await expect(page.getByText('لا تملك صلاحية عرض هذه الصفحة.')).toBeVisible();

  api.me = roleMe('owner');
  await page.goto('/admin');
  await expect(page.getByRole('link', { name: 'إعدادات المؤسسة' })).toBeVisible();
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
  // the reply says what happened (DEC-150; audit A-S13-2): requeued here
  await expect(
    page.locator('.pt-toast').filter({ hasText: 'أُعيد الحدث إلى الطابور: «معلّق».' }),
  ).toBeVisible();
  expect(api.callsTo('POST', '/v1/admin/outbox/ob-1/retry')[0]?.headers['idempotency-key']).toBeTruthy();
});

test('audit A-S13-2: a stale job.* row closed `canceled` by the retry says so, with its reason', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('admin'));
  mockStaffApi(api);
  api.on(
    'POST',
    '/v1/admin/outbox/ob-1/retry',
    ok({ id: 'ob-1', status: 'canceled', last_error: 'canceled_stale: ticket version changed' }),
  );
  await api.install();
  await page.goto('/admin/outbox');
  await page.getByRole('button', { name: 'إعادة المحاولة' }).first().click();
  await expect(
    page
      .locator('.pt-toast')
      .filter({ hasText: 'أُغلق الحدث «ملغى» دون إعادة: canceled_stale: ticket version changed' }),
  ).toBeVisible();
  await expect(page.locator('.pt-toast').filter({ hasText: 'تم تنفيذ الإجراء.' })).toHaveCount(0);
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

test('retention: the admin reads it, the owner edits it within its bounds', async ({ page }) => {
  const api = new MockApi(page, roleMe('admin'));
  mockStaffApi(api);
  api.on('PUT', '/v1/admin/retention-policy', (req) =>
    ok({ ...(req.postDataJSON() as object), approved_by_owner: true }),
  );
  await api.install();
  await page.goto('/admin/retention');
  await expect(page.getByText('قيم مقترحة بانتظار اعتماد المالك')).toBeVisible();
  await expect(page.locator('#retention-photos_days')).toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: 'حفظ' })).toHaveCount(0);

  api.me = roleMe('owner');
  await page.reload();
  await page.locator('#retention-photos_days').fill('0');
  await expect(page.locator('#retention-photos_days-err')).toHaveText('الحد الأدنى 1');
  await page.locator('#retention-photos_days').fill('120');
  await page.getByRole('button', { name: 'حفظ' }).click();
  await expect(page.getByText('معتمدة من المالك')).toBeVisible();
  expect(api.callsTo('PUT', '/v1/admin/retention-policy')[0]?.body).toEqual({
    photos_days: 120,
    wa_messages_days: 180,
    tickets_months: 24,
    audit_months: 36,
    wa_raw_days: 30,
    analytics_months: 24,
  });
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

test('audit A-S13-1: no channel yet — «لم تُضبط القناة بعد.», the owner creates it with PUT, the admin reads only', async ({
  page,
}) => {
  const me = { ...roleMe('owner'), brand: { customer_name_ar: CUSTOMER } };
  const api = new MockApi(page, me);
  mockStaffApi(api);
  let channel: Record<string, unknown> | null = null;
  // 07 §2.7 / DEC-142: GET answers RESOURCE_NOT_FOUND until the first PUT creates the only channel
  api.on('GET', '/v1/admin/whatsapp/channel', () =>
    channel ? ok(channel) : apiError('RESOURCE_NOT_FOUND', 404),
  );
  api.on('PUT', '/v1/admin/whatsapp/channel', (req) => {
    const body = req.postDataJSON() as Record<string, unknown>;
    channel = {
      ...waChannelFixture(),
      display_name: body.display_name,
      business_account_id: body.business_account_id,
      phone_number_id: body.phone_number_id,
      phone_display: body.phone_display,
      api_version: body.api_version,
      mode: body.mode,
    };
    return ok(channel);
  });
  await api.install();
  await page.goto('/admin/channel');
  await expect(page.getByText('لم تُضبط القناة بعد.')).toBeVisible();
  // not the generic not-found state of a 404 read
  await expect(page.getByText('لم نجد هذا العنصر')).toHaveCount(0);
  const save = page.getByRole('button', { name: 'حفظ' });
  await expect(save).toBeDisabled();
  await expect(page.getByRole('button', { name: 'إلغاء' })).toHaveCount(0);
  await expect(page.locator('#wa-display_name')).toHaveValue(CUSTOMER);
  await page.locator('#wa-business_account_id').fill('102030405060708');
  await page.locator('#wa-phone_number_id').fill('908070605040302');
  await page.locator('#wa-api_version').fill('v26.0');
  await page.locator('#wa-access_token_secret_ref').fill('env://A');
  await page.locator('#wa-app_secret_ref').fill('env://B');
  await page.locator('#wa-verify_token_secret_ref').fill('env://C');
  await save.click();
  await expect(page.getByText('لم تُضبط القناة بعد.')).toHaveCount(0);
  await expect(page.getByText('سليمة')).toBeVisible();
  await expect(page.locator('#wa-business_account_id')).toHaveCount(0);
  const put = api.callsTo('PUT', '/v1/admin/whatsapp/channel')[0];
  expect(put?.headers['idempotency-key']).toBeTruthy();
  expect(put?.body).toEqual({
    display_name: CUSTOMER,
    business_account_id: '102030405060708',
    phone_number_id: '908070605040302',
    phone_display: null,
    api_version: 'v26.0',
    mode: 'simulator',
    access_token_secret_ref: 'env://A',
    app_secret_ref: 'env://B',
    verify_token_secret_ref: 'env://C',
  });

  // the administration (wa.channel_read only) sees the empty state and no form
  channel = null;
  api.me = { ...roleMe('admin'), brand: { customer_name_ar: CUSTOMER } };
  await page.reload();
  await expect(page.getByText('لم تُضبط القناة بعد.')).toBeVisible();
  await expect(page.locator('#wa-business_account_id')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'فتح' })).toHaveCount(0);
});
