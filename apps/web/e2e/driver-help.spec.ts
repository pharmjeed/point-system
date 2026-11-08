import { expect, test, type Locator } from '@playwright/test';
import { actorPage, expectCommandContract } from './support/actors';
import { fakeOnly } from './support/backend';
import { runOnlyAt390 } from './support/checks';
import { arrangeRetrieval, pressCommand, startDuty } from './support/driver';
import { createFake, SEED_IDS, type FakeServer } from './support/fake';

/**
 * GAP-7 (02 D-10 «إبلاغ عن مشكلة», «فشل رسالة العميل») and GAP-8 (02 D-11 «العميل لم يصله الرمز؟ │ إعادة
 * الإرسال (متبقٍ n)», the Sheet with «طلب المشرف (تحقق يدوي)» → a `manual_verification` incident, DEC-210;
 * the D-11 banners of 14 §5.1). The handover code is never shown (DEC-38).
 */
runOnlyAt390();
fakeOnly();

const PHONE = '+966501234567';
const claimOf = (fake: FakeServer, ticketId: string) =>
  fake.world.tickets.find((t) => t.id === ticketId)?.claim;

test('GAP-7 D-10 «إبلاغ عن مشكلة»: a type and a mandatory description → POST /v1/incidents with the ticket', async ({
  browser,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const { ticketId, taskId } = arrangeRetrieval(fake, 'DRV1', 'accepted');
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/tasks/${taskId}`);
  await page.getByRole('button', { name: 'إبلاغ عن مشكلة' }).click();
  const sheet = page.getByRole('dialog', { name: 'إبلاغ عن مشكلة' });
  for (const type of [
    'المفتاح غير موجود في الخانة',
    'ضرر لم يُسجّل',
    'المركبة ليست في الموقف / مركبة خاطئة',
    'أخرى',
  ])
    await expect(sheet.getByRole('radio', { name: type })).toBeVisible();
  const confirm = sheet.getByRole('button', { name: 'تأكيد' });
  await expect(confirm).toBeDisabled();
  await sheet.getByRole('radio', { name: 'المفتاح غير موجود في الخانة' }).check();
  await expect(confirm).toBeDisabled(); // the description is mandatory
  await sheet.getByLabel('الوصف').fill('الخانة 20 فارغة');
  const call = await pressCommand(fake, 'POST /v1/incidents', confirm);
  expect(call.body).toEqual({
    venue_id: SEED_IDS.venues.RMS,
    event_id: expect.any(String),
    ticket_id: ticketId,
    type: 'key_missing',
    description: 'الخانة 20 فارغة',
  });
  await expect(page.getByText('أُبلغ المشرف.')).toBeVisible();
  await expect(sheet).toBeHidden();
  expect(fake.incidents).toHaveLength(1);
  expect(fake.incidents[0]).toMatchObject({ type: 'key_missing', ticket_id: ticketId });
  expectCommandContract(fake, ['POST /v1/incidents']);
});

test('GAP-7 D-10: a W-05 the provider refused — «تعذر إرسال الرسالة للعميل. أُبلغ المشرف.» (ticket.updated `message`)', async ({
  browser,
}) => {
  const fake = createFake();
  fake.realtime.enable();
  startDuty(fake, 'DRV1');
  const { ticketId, taskId } = arrangeRetrieval(fake, 'DRV1', 'ready', { whatsapp: PHONE });
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/tasks/${taskId}`);
  await expect.poll(() => fake.realtime.connectedUsers().length).toBe(1);
  await expect(page.getByRole('button', { name: 'التسليم' })).toBeVisible();
  await expect(page.getByText('تعذر إرسال الرسالة للعميل. أُبلغ المشرف.')).toHaveCount(0);
  // the message state does not move the ticket's version: the runtime reads the ticket again
  fake.whatsapp.w05(ticketId, 'failed');
  await expect(page.getByText('تعذر إرسال الرسالة للعميل. أُبلغ المشرف.')).toBeVisible();
  // work goes on; D-11 offers the resend
  await page.getByRole('button', { name: 'التسليم' }).click();
  await expect(
    page.getByText('تعذر إرسال رمز التسليم للعميل. أعد الإرسال أو اطلب استثناء المشرف.'),
  ).toBeVisible();
  await expect(page.locator('#code-resend')).toBeEnabled();
});

test('GAP-8 D-11 «إعادة الإرسال (متبقٍ 3)»: a new code, 30 s apart; «طلب المشرف (تحقق يدوي)» opens a manual_verification incident', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const { ticketId } = arrangeRetrieval(fake, 'DRV1', 'ready', { whatsapp: PHONE });
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.clock.install();
  await page.goto(`/d/tickets/${ticketId}/handover`);
  const first = claimOf(fake, ticketId)?.code ?? '';
  expect(first).toHaveLength(6);

  const resend = page.locator('#code-resend');
  await expect(page.getByRole('button', { name: 'العميل لم يصله الرمز؟' })).toBeVisible();
  await expect(resend).toHaveText('إعادة الإرسال (متبقٍ 3)');
  await pressCommand(fake, 'POST /v1/tickets/:ticketId/handover-code/resend', resend);
  await expect(page.getByText('أُرسل رمز جديد للعميل. الرمز السابق لم يعد صالحًا.')).toBeVisible();
  await expect(resend).toHaveText('إعادة الإرسال (متبقٍ 2)');
  await expect(resend).toBeDisabled(); // 02 D-11 «مع تعطيل الرابط 30 ث بعد كل إرسال»
  await page.clock.fastForward(31_000);
  await expect(resend).toBeEnabled();
  const second = claimOf(fake, ticketId)?.code ?? '';
  expect(second).not.toBe(first);
  // DEC-38: the code is never on the staff screen
  for (const code of [first, second]) expect(await page.content()).not.toContain(code);

  // «العميل لم يصله الرمز؟» → the Sheet: «إعادة إرسال الرمز» / «طلب المشرف (تحقق يدوي)»
  await page.getByRole('button', { name: 'العميل لم يصله الرمز؟' }).click();
  const sheet = page.getByRole('dialog', { name: 'العميل لم يصله الرمز؟' });
  await expect(sheet.getByRole('button', { name: 'إعادة إرسال الرمز' })).toBeEnabled();
  await sheet.getByRole('button', { name: 'طلب المشرف (تحقق يدوي)' }).click();
  const confirm = sheet.getByRole('button', { name: 'تأكيد' });
  await expect(confirm).toBeDisabled(); // a mandatory description
  await sheet.getByLabel('الوصف').fill('العميل أمامي وجواله دون شبكة');
  const call = await pressCommand(fake, 'POST /v1/incidents', confirm);
  expect(call.body).toMatchObject({
    ticket_id: ticketId,
    type: 'manual_verification',
    description: 'العميل أمامي وجواله دون شبكة',
  });
  await expect(page.getByText('أُبلغ المشرف.')).toBeVisible();
  await expect(sheet).toBeHidden();
  expect(fake.incidents[0]).toMatchObject({ type: 'manual_verification', ticket_id: ticketId });

  // the Sheet's resend is the same command (and the same 30 s)
  await page.getByRole('button', { name: 'العميل لم يصله الرمز؟' }).click();
  await pressCommand(
    fake,
    'POST /v1/tickets/:ticketId/handover-code/resend',
    sheet.getByRole('button', { name: 'إعادة إرسال الرمز' }),
  );
  await expect(resend).toHaveText('إعادة الإرسال (متبقٍ 1)');
  expectCommandContract(fake, ['POST /v1/tickets/:ticketId/handover-code/resend', 'POST /v1/incidents']);
});

test('GAP-8 D-11 banners (14 §5.1): the code expired by server time with «إرسال رمز جديد», then locked; the customer who stopped the messages', async ({
  browser,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const { ticketId } = arrangeRetrieval(fake, 'DRV1', 'ready', { whatsapp: PHONE });
  const claim = claimOf(fake, ticketId);
  if (!claim) throw new Error('no claim');
  claim.expires_at = new Date(Date.now() - 1000).toISOString();
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/tickets/${ticketId}/handover`);
  await expect(page.getByText('انتهت صلاحية رمز التسليم — أعد الإرسال للعميل')).toBeVisible();
  await expect(page.locator('#code-resend')).toHaveCount(0);
  await pressCommand(
    fake,
    'POST /v1/tickets/:ticketId/handover-code/resend',
    page.getByRole('button', { name: 'إرسال رمز جديد' }),
  );
  await expect(page.getByText('انتهت صلاحية رمز التسليم — أعد الإرسال للعميل')).toHaveCount(0);
  await expect(page.locator('#code-resend')).toBeVisible();

  // locked (too many wrong codes): the input and the handover stop, «تواصل مع المشرف»
  const live = claimOf(fake, ticketId);
  if (live) live.locked_at = new Date().toISOString();
  await page.reload();
  await expect(page.getByText('تجاوز العميل عدد المحاولات — تواصل مع المشرف')).toBeVisible();
  await expect(page.locator('#handover-submit')).toBeDisabled();
  await expect(page.locator('#code-resend')).toHaveCount(0);
});

test('GAP-8 D-11: the customer stopped the messages — the 14 §5.1 banner; a resend answers WA_CUSTOMER_OPTED_OUT', async ({
  browser,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const { ticketId } = arrangeRetrieval(fake, 'DRV1', 'ready', { whatsapp: PHONE });
  fake.whatsapp.optOut(PHONE);
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/tickets/${ticketId}/handover`);
  await expect(page.getByText('العميل أوقف رسائل واتساب — سلّمه شفهيًا أو بالتذكرة الورقية')).toBeVisible();
  await pressCommand(fake, 'POST /v1/tickets/:ticketId/handover-code/resend', page.locator('#code-resend'), {
    expectStatus: 409,
  });
  await expect(
    page.getByText('أوقف العميل رسائل واتساب. استخدم QR من جوال العميل أو التذكرة الورقية.'),
  ).toBeVisible();
});

// ---------------------------------------------------------------- review findings (wave 5)

/** «طلب المشرف (تحقق يدوي)» in an open Sheet: the mandatory description, then the incident (DEC-210). */
async function askSupervisor(fake: FakeServer, sheet: Locator, ticketId: string): Promise<void> {
  const confirm = sheet.getByRole('button', { name: 'تأكيد' });
  await expect(confirm).toBeDisabled();
  await sheet.getByLabel('الوصف').fill('العميل أمامي ولا رمز معه');
  const call = await pressCommand(fake, 'POST /v1/incidents', confirm);
  expect(call.body).toMatchObject({ ticket_id: ticketId, type: 'manual_verification' });
}

test('review D-11: the code expired and no resend is left — the supervisor request stays open', async ({
  browser,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const { ticketId } = arrangeRetrieval(fake, 'DRV1', 'ready', { whatsapp: PHONE });
  const claim = claimOf(fake, ticketId);
  if (!claim) throw new Error('no claim');
  claim.expires_at = new Date(Date.now() - 1000).toISOString();
  claim.resend_no = claim.max_resends;
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/tickets/${ticketId}/handover`);
  await expect(page.getByText('انتهت صلاحية رمز التسليم — أعد الإرسال للعميل')).toBeVisible();
  await expect(page.getByRole('button', { name: 'إرسال رمز جديد' })).toBeDisabled();
  // 08 RESEND_LIMIT_REACHED: why the resend is off, and the way to the supervisor
  await expect(page.getByText('وصلت للحد الأقصى لإعادة إرسال الرمز. اتصل بالمشرف.')).toBeVisible();
  await page.getByRole('button', { name: 'العميل لم يصله الرمز؟' }).click();
  const sheet = page.getByRole('dialog', { name: 'العميل لم يصله الرمز؟' });
  await expect(sheet.getByRole('button', { name: 'إعادة إرسال الرمز' })).toBeDisabled();
  await sheet.getByRole('button', { name: 'طلب المشرف (تحقق يدوي)' }).click();
  await askSupervisor(fake, sheet, ticketId);
  await expect(page.getByText('أُبلغ المشرف.')).toBeVisible();
  expect(fake.callsTo('POST /v1/tickets/:ticketId/handover-code/resend')).toHaveLength(0);
});

test('review D-11: a WhatsApp ticket not linked at `ready` has no code — no code input, «طلب المشرف (تحقق يدوي)»', async ({
  browser,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const { ticketId } = arrangeRetrieval(fake, 'DRV1', 'ready', { whatsapp: PHONE, linked: false });
  expect(claimOf(fake, ticketId)).toBeNull(); // the API issues a code for a linked ticket only
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/tickets/${ticketId}/handover`);
  await expect(page.getByText('التذكرة غير مربوطة بواتساب.')).toBeVisible();
  await expect(page.locator('#handover-code-0')).toHaveCount(0);
  await expect(page.getByText('الرمز من 6 أرقام ووصل العميل في رسالة واتساب.')).toHaveCount(0);
  await expect(page.locator('#code-resend')).toHaveCount(0);
  await expect(page.locator('#handover-submit')).toBeDisabled();
  await page.getByRole('button', { name: 'طلب المشرف (تحقق يدوي)' }).click();
  const sheet = page.getByRole('dialog', { name: 'طلب المشرف (تحقق يدوي)' });
  await expect(sheet.getByRole('button', { name: 'إعادة إرسال الرمز' })).toHaveCount(0);
  await askSupervisor(fake, sheet, ticketId);
  await expect(page.getByText('أُبلغ المشرف.')).toBeVisible();
});

test('review D-11: a ticket linked after `ready` gets its first code from «إرسال رمز جديد»', async ({
  browser,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const { ticketId } = arrangeRetrieval(fake, 'DRV1', 'ready', { whatsapp: PHONE, linked: false });
  fake.whatsapp.w01(ticketId, 'linked');
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/tickets/${ticketId}/handover`);
  await expect(page.locator('[data-code-none]')).toBeVisible();
  await expect(page.locator('#handover-code-0')).toHaveCount(0);
  await pressCommand(
    fake,
    'POST /v1/tickets/:ticketId/handover-code/resend',
    page.getByRole('button', { name: 'إرسال رمز جديد' }),
  );
  await expect(page.locator('#handover-code-0')).toBeVisible();
  await expect(page.locator('#code-resend')).toHaveText('إعادة الإرسال (متبقٍ 3)');
  const code = claimOf(fake, ticketId)?.code ?? '';
  expect(await page.content()).not.toContain(code); // DEC-38
});

test('audit A-driver-1 D-11: a code the supervisor reissued after the lock opens the input again («أُرسل الرمز للعميل»)', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const fake = createFake();
  fake.realtime.enable();
  startDuty(fake, 'DRV1');
  const { ticketId, taskId } = arrangeRetrieval(fake, 'DRV1', 'ready', { whatsapp: PHONE });
  const locked = claimOf(fake, ticketId);
  if (!locked) throw new Error('no claim');
  locked.locked_at = new Date().toISOString();
  locked.attempts = locked.max_attempts;
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/tickets/${ticketId}/handover`);
  await expect.poll(() => fake.realtime.connectedUsers().length).toBe(1);
  await expect(page.getByText('تجاوز العميل عدد المحاولات — تواصل مع المشرف')).toBeVisible();
  await expect(page.locator('#handover-submit')).toBeDisabled();
  // DEC-207: the supervisor reissues the locked code (S-03); the assignee gets ticket.updated (14 §3.4)
  fake.exec('SUP-R', 'POST /v1/tickets/:ticketId/handover-code/resend', { ticketId }, {});
  await expect(page.getByText('أُرسل الرمز للعميل')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('تجاوز العميل عدد المحاولات — تواصل مع المشرف')).toHaveCount(0);
  await expect(page.getByText(/^المحاولات المتبقية: 5 · صالح حتى/)).toBeVisible();
  const fresh = claimOf(fake, ticketId)?.code ?? '';
  await expect(page.locator('#handover-code-0')).toBeEnabled();
  await page.locator('#handover-code-0').fill(fresh);
  await pressCommand(fake, 'POST /v1/tickets/:ticketId/handover', page.locator('#handover-submit'));
  await expect(page.locator('#handover-done')).toBeVisible();
  expect(fake.world.tasks.find((k) => k.id === taskId)?.status).toBe('completed');
});
