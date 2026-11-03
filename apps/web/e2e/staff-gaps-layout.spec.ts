import { expect, test, type Page } from '@playwright/test';
import {
  driverItemFixture,
  eventFixture,
  MockApi,
  mockStaffApi,
  ok,
  roleMe,
  SAAD,
  secondsAgo,
  ticketDetailFixture,
  VENUE_ID,
  venueFixture,
} from './support/api';
import { expectMobileLayout } from './support/checks';

/**
 * The screens, sheets and dialogs of the staff gaps (GAP-2 … GAP-6 and the S-05 sweep) at 360, 390 and 430 px
 * (one Playwright project each; 17 TC-059, TC-060): no horizontal scroll, RTL, 16px base and inputs, ≥44px targets.
 */

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await expectMobileLayout(page);
}

const parkedTicket = (over: Record<string, unknown> = {}) =>
  ticketDetailFixture({
    status: 'parked',
    payment_status: 'not_required',
    active_cycle: null,
    open_task: null,
    ...over,
  });

test('S-03 «مطابقة يدوية بعد انقطاع», «تغيير الجوال» and «إعادة الربط بواتساب» (QR panel included)', async ({
  page,
}) => {
  const api = new MockApi(page, { ...roleMe('supervisor'), brand: { customer_name_ar: 'مصاف' } });
  mockStaffApi(api, { ticket: parkedTicket({ wa_link_status: 'failed' }) });
  api.on('GET', `/v1/venues/${VENUE_ID}/parking-spots`, ok([]));
  api.on('POST', '/v1/tickets/t-47/whatsapp-link', () =>
    ok({
      method: 'qr',
      wa_link_status: 'failed',
      channel_health: 'healthy',
      qr: {
        link_code_id: 'lc-1',
        code: 'K7Q29F',
        status: 'active',
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        wa_me_url: 'https://wa.me/966110000000?text=K7Q29F',
        prefilled_text: 'K7Q29F',
        qr_text: 'https://wa.me/966110000000?text=K7Q29F',
      },
    }),
  );
  await api.install();

  await page.goto('/ops/tickets/t-47?action=manualReconcile');
  const reconcile = page.getByRole('dialog', { name: 'مطابقة يدوية بعد انقطاع' });
  await reconcile.getByRole('radio', { name: 'متوقفة' }).check();
  await expect(reconcile.getByLabel('مرجع السجل الورقي')).toBeVisible();
  await settle(page);

  await page.goto('/ops/tickets/t-47?action=changePhone');
  await expect(page.getByRole('dialog', { name: 'تغيير الجوال' })).toBeVisible();
  await settle(page);

  await page.goto('/ops/tickets/t-47?action=relinkWhatsApp');
  const relink = page.getByRole('dialog', { name: 'إعادة الربط بواتساب' });
  await expect(relink.getByRole('button', { name: 'إعادة الإرسال' })).toBeVisible();
  await settle(page);
  await relink.getByRole('button', { name: 'الربط عبر QR' }).click();
  await expect(relink.locator('.pt-qr')).toBeVisible();
  await settle(page);
});

test('S-13 «الموظفون»: the list, a member sheet and «إضافة موظف»', async ({ page }) => {
  const api = new MockApi(page, roleMe('owner'));
  mockStaffApi(api);
  api.on(
    'GET',
    '/v1/staff',
    ok([
      {
        user: {
          id: 'u-sup-rim',
          employee_code: 'S-0003',
          full_name: 'ريم الشهري',
          phone_masked: '05•••••003',
          role: 'supervisor',
          can_drive: true,
          status: 'active',
          mfa_enabled: true,
          last_login_at: secondsAgo(3600),
          version: 2,
        },
        scopes: [{ id: 'rs-1', scope_type: 'venue', venue_id: VENUE_ID }],
      },
      {
        user: {
          id: 'u-adm-sara',
          employee_code: 'A-0002',
          full_name: 'سارة العنزي',
          phone_masked: '05•••••002',
          role: 'admin',
          status: 'disabled',
          mfa_enabled: false,
          last_login_at: null,
          version: 1,
        },
        scopes: [{ id: 'rs-2', scope_type: 'org', venue_id: null }],
      },
    ]),
  );
  await api.install();
  await page.goto('/admin/staff');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('الموظفون');
  // DataTable renders the table and the cards; below 1024 px the cards are shown (03 §3.16)
  const rim = page.locator('.pt-table-cards li', { hasText: 'ريم الشهري' });
  await expect(rim).toBeVisible();
  await settle(page);
  await rim.getByRole('button', { name: 'الإجراءات' }).click();
  await expect(page.getByRole('dialog', { name: 'ريم الشهري' })).toBeVisible();
  await settle(page);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'إضافة موظف' }).click();
  await expect(page.getByRole('dialog', { name: 'إضافة موظف' })).toBeVisible();
  await settle(page);
});

test('S-06 actions, «إنهاء المناوبة قسرًا» (supervisor) and «تعطيل الحساب» (administration) with the snapshot', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  api.on(
    'GET',
    `/v1/drivers/${SAAD.id}`,
    ok(
      driverItemFixture({
        live: {
          driver: SAAD,
          driver_state: 'busy_with_next',
          connection_state: 'online',
          duty_started_at: secondsAgo(3 * 3600),
          duty_session_id: 'ds-saad',
        },
      }),
    ),
  );
  await api.install();
  await page.goto(`/drivers/${SAAD.id}`);
  await expect(page.getByRole('button', { name: 'نقل إلى موقع آخر' })).toBeVisible();
  await settle(page);
  await page.getByRole('button', { name: 'إنهاء المناوبة قسرًا' }).click();
  await expect(page.getByRole('alertdialog').getByTestId('custody-checklist')).toBeVisible();
  await settle(page);

  api.me = roleMe('admin');
  await page.reload();
  await page.getByRole('button', { name: 'تعطيل الحساب' }).click();
  await expect(page.getByRole('alertdialog').getByTestId('custody-checklist')).toBeVisible();
  await settle(page);
});

test('S-08 event cards with the ways to S-10, and the reopen confirmation', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  const events = [
    eventFixture(),
    eventFixture({ id: 'e-rms-2', name_ar: 'حفل آل فهد', status: 'closing', version: 4 }),
  ];
  api
    .on('GET', `/v1/venues/${VENUE_ID}`, ok(venueFixture()))
    .on('GET', `/v1/venues/${VENUE_ID}/dispatch-pools`, ok([]))
    .on('GET', `/v1/venues/${VENUE_ID}/events`, ok(events));
  await api.install();
  await page.goto(`/venues/${VENUE_ID}`);
  await expect(page.getByRole('button', { name: 'بدء الإغلاق' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'إغلاق الحفل والمطابقة' })).toBeVisible();
  await settle(page);
  await page.getByRole('button', { name: 'إعادة فتح الحفل' }).click();
  await expect(page.getByRole('alertdialog', { name: 'إعادة فتح الحفل' })).toBeVisible();
  await settle(page);
});

test('S-05 rows with the state, «منذ» and the connection', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api);
  api.on(
    'GET',
    '/v1/drivers',
    ok([
      driverItemFixture({
        live: {
          driver: SAAD,
          driver_state: 'available',
          connection_state: 'uncertain',
          available_since: secondsAgo(250),
        },
      }),
    ]),
  );
  await api.install();
  await page.goto('/drivers');
  await expect(page.getByRole('link', { name: /سعد الحربي/ })).toContainText('الاتصال غير مؤكد');
  await settle(page);
});
