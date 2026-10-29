import { expect, test } from '@playwright/test';
import {
  apiError,
  KHALID,
  MockApi,
  mockStaffApi,
  ok,
  roleMe,
  secondsAgo,
  STAFF_USER_ID,
  ticketDetailFixture,
  VENUE_ID,
} from './support/api';
import { runOnlyAt390 } from './support/checks';

/**
 * GAP-2 (docs/runbooks/go-live-checklist.md §2) — the three S-03 recovery actions of 02 S-03: «مطابقة يدوية بعد
 * انقطاع» (`POST /v1/tickets/{ticketId}/manual-reconcile`), «تغيير الجوال» (`PATCH /v1/tickets/{ticketId}/customer-phone`)
 * and «إعادة الربط بواتساب» (`POST /v1/tickets/{ticketId}/whatsapp-link` + `/confirm`). Each press sends one
 * request with an Idempotency-Key; the server's `message_ar` is shown where the input is.
 */
runOnlyAt390();

const BRAND = 'مصاف';

const parkedTicket = (over: Record<string, unknown> = {}) =>
  ticketDetailFixture({
    status: 'parked',
    payment_status: 'not_required',
    active_cycle: null,
    open_task: null,
    ...over,
  });

const spotsReply = () =>
  ok([
    {
      id: 'sp-a03',
      zone_id: 'z-a',
      zone_name: 'المنطقة A',
      label: 'A-03',
      status: 'active',
      occupied: false,
    },
    {
      id: 'sp-a07',
      zone_id: 'z-a',
      zone_name: 'المنطقة A',
      label: 'A-07',
      status: 'active',
      occupied: false,
    },
  ]);

test('«مطابقة يدوية بعد انقطاع» to «متوقفة»: state, paper-log evidence, spot and slot, reason', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('supervisor'));
  const state = mockStaffApi(api, {
    ticket: parkedTicket({ current_spot: null, current_key_slot: null, key_holder: { type: 'unknown' } }),
  });
  api.on('GET', `/v1/venues/${VENUE_ID}/parking-spots`, spotsReply());
  api.sequence('POST', '/v1/tickets/t-47/manual-reconcile', [
    apiError('PARKING_SPOT_OCCUPIED', 409, { details: { parking_spot_id: 'sp-a07' } }),
    () => {
      state.ticket = parkedTicket({ version: 4 });
      return ok(state.ticket);
    },
  ]);
  await api.install();
  await page.goto('/ops/tickets/t-47');
  await page.getByRole('button', { name: 'الإجراءات' }).click();
  await page.getByRole('button', { name: 'مطابقة يدوية بعد انقطاع' }).click();
  const sheet = page.getByRole('dialog', { name: 'مطابقة يدوية بعد انقطاع' });
  await expect(sheet.getByText('لا تُشغّل أوامر مؤجلة ولا تُرسل رسائل عميل قديمة.')).toBeVisible();
  await expect(sheet.getByRole('radio')).toHaveCount(3);
  const confirm = sheet.getByRole('button', { name: 'تأكيد' });
  await expect(confirm).toBeDisabled();
  await sheet.getByRole('radio', { name: 'متوقفة' }).check();
  await sheet.getByLabel('مرجع السجل الورقي').fill('P02-R07');
  await sheet.getByLabel('ملاحظة الدليل (اختياري)').fill('P01-R03 استلام، P02-R07 صف');
  // the free spots of the venue and the free key slots only
  await expect(sheet.getByLabel('الموقف', { exact: true }).locator('option')).toHaveText([
    '—',
    'المنطقة A · A-03',
    'المنطقة A · A-07',
  ]);
  await expect(sheet.getByLabel('خانة المفتاح').locator('option')).toHaveText(['—', 'اللوحة 1 · 13']);
  await sheet.getByLabel('الموقف', { exact: true }).selectOption('sp-a07');
  await sheet.getByLabel('خانة المفتاح').selectOption('ks-13');
  await expect(confirm).toBeDisabled(); // the reason is still missing
  await sheet.getByLabel('السبب (إلزامي)').fill('انقطاع النظام — مطابقة السجل الورقي');
  await confirm.click();
  // the occupied spot is answered under the spot (08 PARKING_SPOT_OCCUPIED)
  await expect(sheet.getByText('الموقف مشغول. اختر موقفًا آخر أو اكتب ملاحظة.')).toBeVisible();
  await sheet.getByLabel('الموقف', { exact: true }).selectOption('sp-a03');
  await confirm.click();
  await expect(sheet).toBeHidden();
  await expect(page.locator('.pt-toast').filter({ hasText: 'تم تنفيذ الإجراء.' })).toBeVisible();
  const calls = api.callsTo('POST', '/v1/tickets/t-47/manual-reconcile');
  expect(calls).toHaveLength(2);
  expect(calls[1]?.body).toEqual({
    target_status: 'parked',
    reason: 'انقطاع النظام — مطابقة السجل الورقي',
    evidence: { paper_log_ref: 'P02-R07', note: 'P01-R03 استلام، P02-R07 صف' },
    expected_version: 3,
    incident_id: null,
    parking_spot_id: 'sp-a03',
    spot_note: null,
    key_slot_id: 'ks-13',
  });
  const [first, second] = calls.map((c) => c.headers['idempotency-key']);
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
  expect(second).toMatch(/^[0-9a-f-]{36}$/);
  expect(second).not.toBe(first); // the input changed after a definitive answer: a new key (02 §1.8 item 4)
});

test('«مطابقة يدوية» to «مُسلّمة» for a due ticket asks for the documented collection and its collector', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api, {
    ticket: ticketDetailFixture({ status: 'ready', payment_status: 'due', fee_halalas: 2500 }),
  });
  api.on('POST', '/v1/tickets/t-47/manual-reconcile', () =>
    ok(ticketDetailFixture({ status: 'delivered', payment_status: 'collected', version: 4 })),
  );
  await api.install();
  await page.goto('/ops/tickets/t-47?action=manualReconcile');
  const sheet = page.getByRole('dialog', { name: 'مطابقة يدوية بعد انقطاع' });
  await sheet.getByRole('radio', { name: 'مُسلّمة' }).check();
  await expect(sheet.getByText('25.00', { exact: false })).toBeVisible();
  await sheet.getByLabel('مرجع السجل الورقي').fill('P03-R12');
  await sheet.getByLabel('السبب (إلزامي)').fill('سُلّمت بالكعب أثناء الانقطاع');
  const confirm = sheet.getByRole('button', { name: 'تأكيد' });
  await expect(confirm).toBeDisabled(); // no collection documented yet (13 §8.5)
  await sheet.getByLabel('وسيلة التحصيل').selectOption('cash');
  await sheet.getByLabel('المحصّل').selectOption(KHALID.id);
  await confirm.click();
  await expect(sheet).toBeHidden();
  const call = api.callsTo('POST', '/v1/tickets/t-47/manual-reconcile')[0];
  expect(call?.body).toEqual({
    target_status: 'delivered',
    reason: 'سُلّمت بالكعب أثناء الانقطاع',
    evidence: { paper_log_ref: 'P03-R12' },
    expected_version: 3,
    incident_id: null,
    payment: { method: 'cash', amount_halalas: 2500, pos_reference: null, collected_by: KHALID.id },
  });
  expect(call?.headers['idempotency-key']).toBeTruthy();
});

test('«مطابقة يدوية»: a paper ticket without its stub only to «ملغاة»; PAYMENT_PENDING is the server text', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('admin'));
  const state = mockStaffApi(api, {
    ticket: parkedTicket({ channel: 'paper', paper_serial: null, customer: null, wa_link_status: 'none' }),
  });
  await api.install();
  await page.goto('/ops/tickets/t-47?action=manualReconcile');
  const sheet = page.getByRole('dialog', { name: 'مطابقة يدوية بعد انقطاع' });
  await expect(sheet.getByRole('radio')).toHaveCount(1);
  await expect(sheet.getByRole('radio', { name: 'ملغاة' })).toBeChecked();
  await expect(sheet.getByText('تذكرة ورقية بلا رقم كعب: «ملغاة» فقط.')).toBeVisible();
  await page.keyboard.press('Escape');

  // a due ticket reconciled to «مُسلّمة» without the collection: the server's PAYMENT_PENDING text in the sheet
  state.ticket = ticketDetailFixture({ status: 'ready', payment_status: 'due', version: 5 });
  api.on('POST', '/v1/tickets/t-47/manual-reconcile', apiError('PAYMENT_PENDING', 409));
  await page.reload();
  await page.getByRole('button', { name: 'الإجراءات' }).click();
  await page.getByRole('button', { name: 'مطابقة يدوية بعد انقطاع' }).click();
  await sheet.getByRole('radio', { name: 'مُسلّمة' }).check();
  await sheet.getByLabel('مرجع السجل الورقي').fill('P04-R01');
  await sheet.getByLabel('وسيلة التحصيل').selectOption('pos');
  await sheet.getByLabel('مرجع جهاز نقاط البيع').fill('A1B2C3');
  await sheet.getByLabel('المحصّل').selectOption(STAFF_USER_ID);
  await sheet.getByLabel('السبب (إلزامي)').fill('سُلّمت بالشبكة أثناء الانقطاع');
  await sheet.getByRole('button', { name: 'تأكيد' }).click();
  await expect(sheet.getByRole('alert')).toContainText('التحصيل');
  expect(api.callsTo('POST', '/v1/tickets/t-47/manual-reconcile')[0]?.body).toMatchObject({
    payment: { method: 'pos', amount_halalas: 2500, pos_reference: 'A1B2C3', collected_by: STAFF_USER_ID },
  });
});

test('«تغيير الجوال»: number, field check, consent and reason; WA_CUSTOMER_OPTED_OUT is the server text', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('supervisor'));
  mockStaffApi(api, { ticket: parkedTicket() });
  api.sequence('PATCH', '/v1/tickets/t-47/customer-phone', [
    apiError('WA_CUSTOMER_OPTED_OUT', 409),
    ok(parkedTicket({ wa_link_status: 'pending_send', version: 4 })),
  ]);
  await api.install();
  await page.goto('/ops/tickets/t-47');
  await page.getByRole('button', { name: 'الإجراءات' }).click();
  await page.getByRole('button', { name: 'تغيير الجوال' }).click();
  const sheet = page.getByRole('dialog', { name: 'تغيير الجوال' });
  const confirm = sheet.getByRole('button', { name: 'تأكيد' });
  await sheet.getByLabel('الرقم الجديد').fill('0551234567');
  await sheet.getByLabel('تحققت من صاحب المركبة أمامي').check();
  await sheet.getByLabel('السبب (إلزامي)').fill('العميل صحّح رقمه');
  await expect(confirm).toBeDisabled(); // the consent is mandatory (07 `consent`)
  await sheet.getByLabel('وافق العميل على استلام رسائل واتساب لهذه التذكرة').check();
  await confirm.click();
  await expect(sheet.getByRole('alert')).toContainText('أوقف العميل رسائل واتساب');
  await sheet.getByLabel('الرقم الجديد').fill('0557654321');
  await confirm.click();
  await expect(sheet).toBeHidden();
  const calls = api.callsTo('PATCH', '/v1/tickets/t-47/customer-phone');
  expect(calls[1]?.body).toEqual({
    expected_version: 3,
    customer_phone: '+966557654321',
    consent: { method: 'verbal_staff_confirmed', confirmed: true },
    reason: 'العميل صحّح رقمه',
  });
  expect(calls[1]?.headers['idempotency-key']).toBeTruthy();
  // the staff screen never names the customer brand outside the S-03 message preview (canon §1 rule 2)
  expect(await page.locator('main').innerHTML()).not.toContain(BRAND);
});

test('«تغيير الجوال» is not offered for a paper ticket or a draft (DEC-211)', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  const state = mockStaffApi(api, { ticket: parkedTicket({ channel: 'paper', paper_serial: '004521' }) });
  await api.install();
  await page.goto('/ops/tickets/t-47');
  await page.getByRole('button', { name: 'الإجراءات' }).click();
  const actions = page.getByRole('dialog', { name: 'الإجراءات' });
  await expect(actions.getByRole('button', { name: 'مطابقة يدوية بعد انقطاع' })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'تغيير الجوال' })).toHaveCount(0);
  await expect(actions.getByRole('button', { name: 'إعادة الربط بواتساب' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  // a WhatsApp draft: its number is edited in D-05 (PATCH /intake); a QR link is still possible
  state.ticket = parkedTicket({ status: 'received', inspection_status: 'pending', wa_link_status: 'none' });
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('تفاصيل التذكرة · #47');
  await page.getByRole('button', { name: 'الإجراءات' }).click();
  await expect(actions.getByRole('button', { name: 'إعادة الربط بواتساب' })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'تغيير الجوال' })).toHaveCount(0);
});

test('«إعادة الربط بواتساب» — «إعادة الإرسال» resends W-01 to the recorded number', async ({ page }) => {
  const api = new MockApi(page, roleMe('supervisor'));
  const state = mockStaffApi(api, { ticket: parkedTicket({ wa_link_status: 'failed' }) });
  api.on('POST', '/v1/tickets/t-47/whatsapp-link', () => {
    state.ticket = parkedTicket({ wa_link_status: 'pending_send', version: 4 });
    return ok({ method: 'direct', wa_link_status: 'pending_send', channel_health: 'healthy', qr: null });
  });
  await api.install();
  await page.goto('/ops/tickets/t-47');
  await expect(page.getByText('«تعذر الإرسال»')).toBeVisible();
  await page.getByRole('button', { name: 'الإجراءات' }).click();
  await page.getByRole('button', { name: 'إعادة الربط بواتساب' }).click();
  const sheet = page.getByRole('dialog', { name: 'إعادة الربط بواتساب' });
  await expect(sheet.getByText('تأكد مع العميل من الرقم، أو اطلب منه مسح رمز QR.')).toBeVisible();
  await sheet.getByRole('button', { name: 'إعادة الإرسال' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.locator('.pt-toast').filter({ hasText: 'تم تنفيذ الإجراء.' })).toBeVisible();
  await expect(page.getByText('«جارٍ الإرسال»')).toBeVisible();
  const call = api.callsTo('POST', '/v1/tickets/t-47/whatsapp-link')[0];
  expect(call?.body).toEqual({ method: 'direct' });
  expect(call?.headers['idempotency-key']).toBeTruthy();
});

test('«إعادة الربط بواتساب» — «الربط عبر QR»: the customer panel, the match question, «نعم، اربط التذكرة»', async ({
  page,
}) => {
  const api = new MockApi(page, { ...roleMe('supervisor'), brand: { customer_name_ar: BRAND } });
  const state = mockStaffApi(api, {
    ticket: parkedTicket({
      wa_link_status: 'opted_out',
      customer: { phone_masked: '05•••••123', opted_out: true },
    }),
  });
  api.on('POST', '/v1/tickets/t-47/whatsapp-link', () =>
    ok({
      method: 'qr',
      wa_link_status: 'opted_out',
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
  api.on('POST', '/v1/tickets/t-47/whatsapp-link/confirm', () => {
    state.ticket = parkedTicket({ wa_link_status: 'linked', wa_link_pending: null, version: 5 });
    return ok(state.ticket);
  });
  await api.install();
  await page.goto('/ops/tickets/t-47?action=relinkWhatsApp');
  const sheet = page.getByRole('dialog', { name: 'إعادة الربط بواتساب' });
  // an opt-out comes back only by the customer's own QR message (12 §7.6): no direct resend
  await expect(sheet.getByRole('button', { name: 'إعادة الإرسال' })).toHaveCount(0);
  await sheet.getByRole('button', { name: 'الربط عبر QR' }).click();
  const panel = sheet.locator('.pt-qr');
  await expect(panel.getByRole('img', { name: 'رمز QR لربط التذكرة على واتساب' })).toBeVisible();
  await expect(sheet.getByText('بانتظار رسالتك…')).toBeVisible();
  // in the sheet the customer brand is only inside the customer-facing panel (canon §1 rule 2; the timeline's
  // message preview behind it is the other allowed S-03 surface)
  const sheetOutsidePanel = await page.evaluate(() => {
    const sheetHtml = document.querySelector('.pt-sheet')?.innerHTML ?? '';
    const qrHtml = document.querySelector('.pt-qr')?.outerHTML ?? '';
    return qrHtml ? sheetHtml.replace(qrHtml, '') : 'no panel';
  });
  expect(sheetOutsidePanel).not.toContain(BRAND);
  expect(sheetOutsidePanel).not.toBe('no panel');
  expect(await panel.innerHTML()).toContain(BRAND);

  // the customer sent the message: the ticket waits for the supervisor's match (DEC-198)
  state.ticket = parkedTicket({
    wa_link_status: 'pending_confirmation',
    wa_link_pending: { link_code_id: 'lc-1', inbound_phone_masked: '05•••••777', received_at: secondsAgo(2) },
    version: 4,
  });
  await expect(sheet.getByText('وصلت رسالة الربط من رقم ينتهي بـ 777.')).toBeVisible({ timeout: 8000 });
  await expect(sheet.getByText('هل هو جوال العميل الذي أمامك؟')).toBeVisible();
  await sheet.getByRole('button', { name: 'نعم، اربط التذكرة' }).click();
  await expect(sheet.getByText('تم الربط — وصلت التذكرة للعميل.')).toBeVisible();
  const calls = api.callsTo('POST', '/v1/tickets/t-47/whatsapp-link/confirm');
  expect(calls[0]?.body).toEqual({ link_code_id: 'lc-1', matches: true });
  expect(calls[0]?.headers['idempotency-key']).toBeTruthy();
  expect(api.callsTo('POST', '/v1/tickets/t-47/whatsapp-link')[0]?.body).toEqual({ method: 'qr' });
});

test('«لا، ليس هو» rejects the match and offers «رمز جديد»; WA_CHANNEL_UNAVAILABLE is the server text', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('supervisor'));
  const state = mockStaffApi(api, {
    ticket: parkedTicket({
      wa_link_status: 'pending_confirmation',
      wa_link_pending: {
        link_code_id: 'lc-2',
        inbound_phone_masked: '05•••••888',
        received_at: secondsAgo(4),
      },
    }),
  });
  api.on('POST', '/v1/tickets/t-47/whatsapp-link/confirm', () => {
    state.ticket = parkedTicket({ wa_link_status: 'none', wa_link_pending: null, version: 4 });
    return ok(state.ticket);
  });
  api.on('POST', '/v1/tickets/t-47/whatsapp-link', apiError('WA_CHANNEL_UNAVAILABLE', 503));
  await api.install();
  await page.goto('/ops/tickets/t-47?action=relinkWhatsApp');
  const sheet = page.getByRole('dialog', { name: 'إعادة الربط بواتساب' });
  await expect(sheet.getByText('وصلت رسالة الربط من رقم ينتهي بـ 888.')).toBeVisible();
  await sheet.getByRole('button', { name: 'لا، ليس هو' }).click();
  await expect(sheet.getByRole('button', { name: 'رمز جديد' })).toBeVisible();
  expect(api.callsTo('POST', '/v1/tickets/t-47/whatsapp-link/confirm')[0]?.body).toEqual({
    link_code_id: 'lc-2',
    matches: false,
  });
  await sheet.getByRole('button', { name: 'رمز جديد' }).click();
  await expect(sheet.getByRole('alert')).toContainText('واتساب');
});

test('the administration has no «إعادة الربط بواتساب» (wa.link is the supervisor’s, canon §10)', async ({
  page,
}) => {
  const api = new MockApi(page, roleMe('admin'));
  mockStaffApi(api, { ticket: parkedTicket({ wa_link_status: 'failed' }) });
  await api.install();
  await page.goto('/ops/tickets/t-47');
  await page.getByRole('button', { name: 'الإجراءات' }).click();
  const actions = page.getByRole('dialog', { name: 'الإجراءات' });
  await expect(actions.getByRole('button', { name: 'تغيير الجوال' })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'مطابقة يدوية بعد انقطاع' })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'إعادة الربط بواتساب' })).toHaveCount(0);
});
