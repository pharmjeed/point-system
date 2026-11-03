import { expect, test, type Page } from '@playwright/test';
import { actorPage, expectCommandContract } from './support/actors';
import { fakeOnly } from './support/backend';
import { browserStorageDump, runOnlyAt390 } from './support/checks';
import {
  arrangeParked,
  arrangeSubmitted,
  EVENT_R1,
  parkTask,
  PHOTO,
  pressCommand,
  REQUIRED_ANGLES,
  requestRetrieval,
  startDuty,
  uploadPhoto,
} from './support/driver';
import { createFake, errorReply, type FakeServer } from './support/fake';

/**
 * GAP-1 — the WhatsApp channel of the intake (02 D-05 «قناة العميل», D-06 «في وضع QR فقط», D-07 modes أ / ب;
 * 07 `PATCH …/intake`, `whatsapp-link`, `whatsapp-link/confirm`, `submit-intake`; 12 §7.1–§7.3, DEC-40):
 * the customer's number with the verbal consent, the QR the customer scans and the driver confirms, the
 * resend / QR / paper fallbacks, the server's refusals, and the safety rules — the number never leaves the
 * current draft (05 §14), the panel shows no staff data, plate or phone (02 D-07), the code is not shown as
 * text (09 §5.1).
 */
runOnlyAt390();
fakeOnly();

/** The customer brand comes from the org settings (canon §1 rule 4): the spec sets it, no source literal. */
const CUSTOMER_BRAND = 'مصاف';
const PHONE = '+966501234567';
const SENDER = '+966509998887';

async function fillVehicle(page: Page): Promise<void> {
  for (const letter of ['ب B', 'ح J', 'د D'])
    await page.getByRole('button', { name: letter, exact: true }).click();
  await page.locator('#plate-digits').fill('1234');
  await page.getByLabel('الشركة المصنعة').selectOption('toyota');
  await page.getByRole('radio', { name: 'أبيض' }).click();
}

async function keyAndPhotos(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/key-photos$/);
  await page.getByLabel('رقم علاقة المفتاح').fill('57');
  for (const angle of REQUIRED_ANGLES) await page.getByLabel(`تصوير ${angle}`).setInputFiles(PHOTO);
  await expect(page.getByRole('heading', { name: 'صور الحالة (4 من 4)' })).toBeVisible({ timeout: 20_000 });
}

function newIntake(fake: FakeServer): { ticketId: string; n: number } {
  startDuty(fake, 'DRV1');
  const created = fake.exec('DRV1', 'POST /v1/tickets', {}, { event_id: EVENT_R1 });
  return { ticketId: created.ticket.id as string, n: created.ticket.display_number as number };
}

/** A WhatsApp ticket submitted without a number, its QR issued in D-06 by DRV1 (02 D-06 QR mode). */
function submittedByQr(fake: FakeServer): { ticketId: string; n: number } {
  const { ticketId, n } = newIntake(fake);
  const version = fake.world.tickets.find((t) => t.id === ticketId)?.version;
  const patched = fake.exec(
    'DRV1',
    'PATCH /v1/tickets/:ticketId/intake',
    { ticketId },
    {
      expected_version: version,
      channel: 'whatsapp',
      customer_phone: null,
      consent: null,
      plate: { country: 'SA', digits: '5678', letters_ar: 'ر س ص', letters_en: 'R S X' },
      vehicle: { make: 'kia', model: null, color: 'red' },
      key_tag: '64',
    },
  );
  for (const kind of ['photo_front', 'photo_rear', 'photo_left', 'photo_right'])
    uploadPhoto(fake, 'DRV1', ticketId, kind);
  fake.exec('DRV1', 'POST /v1/tickets/:ticketId/whatsapp-link', { ticketId }, { method: 'qr' });
  fake.exec(
    'DRV1',
    'POST /v1/tickets/:ticketId/submit-intake',
    { ticketId },
    { expected_version: patched.version },
  );
  return { ticketId, n };
}

const liveCode = (fake: FakeServer, ticketId: string) =>
  fake.whatsapp.linkCodes.find((l) => l.ticket_id === ticketId && l.status === 'active');

test('GAP-1 D-05 → D-07 أ: the number and the verbal consent, W-01 at the submit, «جارٍ الإرسال…» then «أُرسلت»', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const fake = createFake();
  fake.brand = { customer_name_ar: CUSTOMER_BRAND };
  const { ticketId, n } = newIntake(fake);
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/intake/${ticketId}/vehicle`);
  await fillVehicle(page);

  // 02 D-05: WhatsApp by the customer's number by default; the question read to the customer names the
  // business (12 §7.1, F-17) from the settings
  await expect(page.getByRole('radio', { name: 'واتساب' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('radio', { name: 'رقم جوال العميل' })).toBeChecked();
  await expect(
    page.getByText(
      `اسأل العميل: «هل توافق أن تصلك تذكرة السيارة وتحديثاتها من ${CUSTOMER_BRAND} على واتساب؟»`,
    ),
  ).toBeVisible();
  await expect(page.getByLabel('رقم التذكرة الورقية')).toHaveCount(0);

  // the number and the consent are mandatory locally (02 D-05 «الجوال وخانة الموافقة إلزاميان»)
  await page.locator('#intake-next').click();
  await expect(page.getByText('أدخل رقم جوال سعودي صحيح يبدأ بـ 5.')).toBeVisible();
  await expect(page.getByText('لا نرسل واتساب دون موافقة العميل.')).toBeVisible();
  expect(fake.callsTo('PATCH /v1/tickets/:ticketId/intake')).toHaveLength(0);

  await page.getByLabel('جوال العميل', { exact: true }).fill('0501234567');
  await page.getByLabel('وافق العميل على استلام رسائل واتساب لهذه التذكرة').check();
  const step1 = await pressCommand(fake, 'PATCH /v1/tickets/:ticketId/intake', page.locator('#intake-next'));
  expect(step1.body).toMatchObject({
    channel: 'whatsapp',
    customer_phone: PHONE,
    consent: { method: 'verbal_staff_confirmed', confirmed: true },
    paper_serial: null,
  });

  // D-06: the direct link needs no code — the submit sends W-01 (02 D-06)
  await keyAndPhotos(page);
  await pressCommand(fake, 'POST /v1/tickets/:ticketId/submit-intake', page.locator('#intake-submit'));
  expect(fake.callsTo('POST /v1/tickets/:ticketId/whatsapp-link')).toHaveLength(0);

  // D-07 أ: «جارٍ الإرسال…», the last three digits only, then the provider's answer («أُرسلت»)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`ربط واتساب · #${n}`);
  await expect(page.locator('[data-link-mode="direct"]')).toBeVisible();
  await expect(page.getByText('جارٍ الإرسال…')).toBeVisible();
  await expect(page.getByText('أُرسلت تذكرة واتساب إلى الرقم المنتهي بـ 567.')).toBeVisible();
  await expect(page.getByText('يستطيع العميل طلب سيارته من زر «طلب السيارة» في الرسالة.')).toBeVisible();
  fake.whatsapp.w01(ticketId, 'linked');
  await expect(page.locator('[data-link-status="linked"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('أُرسلت', { exact: true })).toBeVisible();

  // 05 §14: the typed number went with the draft; the screen shows the masked tail only
  expect(await page.content()).not.toContain('501234567');
  await expect.poll(async () => (await browserStorageDump(page)).includes('501234567')).toBe(false);

  // «العميل لم تصله الرسالة؟»: a linked ticket offers the number change only (the server refuses the rest)
  await page.getByRole('button', { name: 'العميل لم تصله الرسالة؟' }).click();
  const sheet = page.getByRole('dialog', { name: 'العميل لم تصله الرسالة؟' });
  await expect(sheet.getByText('تأكد مع العميل من الرقم، أو اطلب منه مسح رمز QR.')).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'تغيير رقم الجوال' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'الربط عبر QR' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // «متابعة إلى الصف» is never blocked
  await page.getByRole('button', { name: 'متابعة إلى الصف' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`إتمام الصف · #${n}`);
  expectCommandContract(fake, [
    'PATCH /v1/tickets/:ticketId/intake',
    'POST /v1/tickets/:ticketId/submit-intake',
  ]);
});

test('GAP-1 D-05 → D-06 → D-07 ب: the QR mode — no number, the code issued right before the submit, the panel, «نعم، اربط التذكرة»', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const fake = createFake();
  fake.brand = { customer_name_ar: CUSTOMER_BRAND };
  const { ticketId, n } = newIntake(fake);
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/intake/${ticketId}/vehicle`);
  await fillVehicle(page);
  await page.getByLabel('جوال العميل', { exact: true }).fill('0501234567');
  await page.getByLabel('وافق العميل على استلام رسائل واتساب لهذه التذكرة').check();

  // 02 D-05: switching to QR empties the number and the consent; nothing is asked locally
  await page.getByRole('radio', { name: 'رمز QR يمسحه العميل' }).check();
  await expect(page.getByLabel('جوال العميل', { exact: true })).toHaveCount(0);
  await page.getByRole('radio', { name: 'رقم جوال العميل' }).check();
  await expect(page.getByLabel('جوال العميل', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('وافق العميل على استلام رسائل واتساب لهذه التذكرة')).not.toBeChecked();
  await page.getByRole('radio', { name: 'رمز QR يمسحه العميل' }).check();
  const step1 = await pressCommand(fake, 'PATCH /v1/tickets/:ticketId/intake', page.locator('#intake-next'));
  expect(step1.body).toMatchObject({
    channel: 'whatsapp',
    customer_phone: null,
    consent: null,
    paper_serial: null,
  });

  // D-06: PATCH (key tag) → whatsapp-link {qr} → submit-intake, in that order
  await keyAndPhotos(page);
  await page.locator('#intake-submit').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`ربط واتساب · #${n}`);
  const order = fake.calls
    .filter((c) => c.method !== 'GET' && c.route?.includes('/v1/tickets/:ticketId/'))
    .map((c) => c.route);
  expect(order.slice(-3)).toEqual([
    'PATCH /v1/tickets/:ticketId/intake',
    'POST /v1/tickets/:ticketId/whatsapp-link',
    'POST /v1/tickets/:ticketId/submit-intake',
  ]);
  expect(fake.callsTo('POST /v1/tickets/:ticketId/whatsapp-link')[0]?.body).toEqual({ method: 'qr' });

  // D-07 ب: the panel with the code drawn on the device, the site and the ticket only (02 D-07)
  const panel = page.locator('[data-qr-panel]');
  await expect(panel.locator('.pt-qr__code svg')).toBeVisible();
  await expect(panel.getByText('اربط تذكرة سيارتك على واتساب')).toBeVisible();
  await expect(panel.getByText(/^قاعة ريماس · تذكرة \d+ · صالح لمدة \d+:\d\d$/).first()).toBeVisible();
  await expect(panel.getByText('بانتظار رسالتك…')).toBeVisible();
  await expect(panel.getByRole('img', { name: 'رمز QR لربط التذكرة على واتساب' })).toBeVisible();
  const panelText = await panel.innerText();
  expect(panelText).not.toContain('1234'); // no plate
  expect(panelText).not.toContain('سائق'); // no staff name
  const code = liveCode(fake, ticketId)?.code ?? '';
  expect(code).toHaveLength(6);
  expect(await page.locator('body').innerText()).not.toContain(code); // the code is the QR, not text
  // the reply's QR is used: no second code
  expect(fake.callsTo('POST /v1/tickets/:ticketId/whatsapp-link')).toHaveLength(1);

  // «ملء الشاشة»: the panel alone; «إغلاق» brings the driver area back
  await page.getByRole('button', { name: 'ملء الشاشة' }).click();
  const full = page.locator('[data-qr-fullscreen]');
  await expect(full.locator('.pt-qr__code svg')).toBeVisible();
  await full.getByRole('button', { name: 'إغلاق' }).click();
  await expect(full).toHaveCount(0);

  // the customer sends the code (12 §7.2 step 3): the driver confirms the number in front of him
  fake.whatsapp.customerSends(ticketId, SENDER);
  const dialog = page.getByRole('alertdialog', { name: 'وصلت رسالة الربط من رقم ينتهي بـ 887.' });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText('هل هو جوال العميل الذي أمامك؟')).toBeVisible();
  const confirm = await pressCommand(
    fake,
    'POST /v1/tickets/:ticketId/whatsapp-link/confirm',
    dialog.getByRole('button', { name: 'نعم، اربط التذكرة' }),
  );
  expect(confirm.body).toEqual({ link_code_id: expect.any(String), matches: true });
  await expect(page.getByText('تم الربط — وصلت التذكرة للعميل.')).toBeVisible();
  await expect(page.locator('[data-qr-panel]')).toHaveCount(0);
  // the API links at the confirmation and plans W-01 (12 §7.2 step 6): mode أ with «أُرسلت»
  await expect(page.locator('[data-link-view="status"]')).toBeVisible();
  await expect(page.getByText('أُرسلت', { exact: true })).toBeVisible();
  expect(fake.world.tickets.find((t) => t.id === ticketId)).toMatchObject({
    customer_phone: SENDER,
    wa_link_status: 'linked',
  });
  expectCommandContract(fake, ['POST /v1/tickets/:ticketId/whatsapp-link/confirm']);
});

test('GAP-1 D-07 ب: «لا، ليس هو» rejects the sender, «رمز جديد» issues another code; an expired code says so', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const fake = createFake();
  const { ticketId } = submittedByQr(fake);
  const { page } = await actorPage(browser, fake, 'DRV1');
  // a reload loses the code (09 §5.1: in the issuing reply only) — «رمز جديد» shows a fresh one
  await page.goto(`/d/intake/${ticketId}/link`);
  await expect(page.locator('[data-link-mode="qr"]')).toBeVisible();
  await expect(page.getByText('اضغط «رمز جديد» ليظهر رمز QR للعميل.')).toBeVisible();
  await pressCommand(
    fake,
    'POST /v1/tickets/:ticketId/whatsapp-link',
    page.getByRole('button', { name: 'رمز جديد' }),
  );
  await expect(page.locator('[data-qr-panel] .pt-qr__code svg')).toBeVisible();
  expect(fake.whatsapp.linkCodes.filter((l) => l.ticket_id === ticketId).map((l) => l.status)).toEqual([
    'revoked',
    'active',
  ]);

  // a stranger's message: «لا، ليس هو» → the code is revoked and the link is back to none
  fake.whatsapp.customerSends(ticketId, SENDER);
  const dialog = page.getByRole('alertdialog', { name: 'وصلت رسالة الربط من رقم ينتهي بـ 887.' });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  const no = await pressCommand(
    fake,
    'POST /v1/tickets/:ticketId/whatsapp-link/confirm',
    dialog.getByRole('button', { name: 'لا، ليس هو' }),
  );
  expect(no.body).toMatchObject({ matches: false });
  await expect(dialog).toBeHidden();
  await expect(page.getByText('اضغط «رمز جديد» ليظهر رمز QR للعميل.')).toBeVisible();
  expect(fake.world.tickets.find((t) => t.id === ticketId)?.wa_link_status).toBe('none');

  // 02 D-07 «عند انتهاء المدة»: «انتهت صلاحية الرمز.» with «رمز جديد»
  fake.whatsapp.qrTtlMs = 3000;
  await page.getByRole('button', { name: 'رمز جديد' }).click();
  await expect(page.locator('[data-qr-panel] .pt-qr__code svg')).toBeVisible();
  await expect(page.getByText('انتهت صلاحية الرمز.')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'ملء الشاشة' })).toHaveCount(0);
  fake.whatsapp.qrTtlMs = null;
  await page.getByRole('button', { name: 'رمز جديد' }).click();
  await expect(page.getByText('بانتظار رسالتك…')).toBeVisible();
  expectCommandContract(fake, ['POST /v1/tickets/:ticketId/whatsapp-link']);
});

test('GAP-1 D-07 أ: W-01 refused — «إعادة الإرسال», «الربط عبر QR», then «تذكرة ورقية» (DEC-40)', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const { ticketId, displayNumber } = arrangeSubmitted(fake, 'DRV1', { whatsapp: PHONE, linked: false });
  fake.whatsapp.w01(ticketId, 'failed');
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/intake/${ticketId}/link`);
  await expect(page.locator('[data-link-mode="direct"]')).toBeVisible();
  await expect(page.getByText('تعذر إرسال التذكرة. قد لا يكون الرقم على واتساب.')).toBeVisible();
  await expect(page.getByText('تعذر الإرسال', { exact: true })).toBeVisible();

  // «إعادة الإرسال» → whatsapp-link {direct} (DEC-193) → «جارٍ الإرسال…»
  const resend = await pressCommand(
    fake,
    'POST /v1/tickets/:ticketId/whatsapp-link',
    page.getByRole('button', { name: 'إعادة الإرسال' }),
  );
  expect(resend.body).toEqual({ method: 'direct' });
  await expect(page.getByText('جارٍ الإرسال…')).toBeVisible();

  // refused again → «الربط عبر QR» turns D-07 into the panel
  fake.whatsapp.w01(ticketId, 'failed');
  await expect(page.getByRole('button', { name: 'الربط عبر QR' })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'الربط عبر QR' }).click();
  await expect(page.locator('[data-qr-panel] .pt-qr__code svg')).toBeVisible();
  await expect(page.locator('[data-link-mode="qr"]')).toBeVisible();

  // «تغيير الطريقة» → «تذكرة ورقية»: the stub number while parking (DEC-40) → mode ج
  await page.getByRole('button', { name: 'تغيير الطريقة' }).click();
  await page
    .getByRole('dialog', { name: 'تغيير الطريقة' })
    .getByRole('button', { name: 'تذكرة ورقية' })
    .click();
  const paper = page.getByRole('dialog', { name: 'تذكرة ورقية' });
  await paper.getByRole('button', { name: 'تأكيد' }).click();
  await expect(paper.getByText('راجع الحقول المظللة.')).toBeVisible();
  await paper.getByLabel('رقم التذكرة الورقية').fill('004600');
  const convert = await pressCommand(
    fake,
    'PATCH /v1/tickets/:ticketId/intake',
    paper.getByRole('button', { name: 'تأكيد' }),
  );
  expect(convert.body).toEqual({
    expected_version: expect.any(Number),
    channel: 'paper',
    paper_serial: '004600',
  });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`تذكرة ورقية · #${displayNumber}`);
  await expect(page.getByText('سلّم العميل الكعب رقم 004600، وعلّق الجزء الآخر على المفتاح.')).toBeVisible();
  // the code the panel showed is revoked with the conversion (`channel_paper`)
  expect(fake.whatsapp.linkCodes.every((l) => l.status === 'revoked')).toBe(true);
  expectCommandContract(fake);
});

test('GAP-1 errors: an opted-out number and a channel down send the driver back to D-05 (02 D-05, D-06 tables)', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const fake = createFake();
  const { ticketId } = newIntake(fake);
  fake.whatsapp.optedOut.add(PHONE);
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/intake/${ticketId}/vehicle`);
  await fillVehicle(page);
  await page.getByLabel('جوال العميل', { exact: true }).fill('0501234567');
  await page.getByLabel('وافق العميل على استلام رسائل واتساب لهذه التذكرة').check();
  await page.locator('#intake-next').click();
  await keyAndPhotos(page);
  await pressCommand(fake, 'POST /v1/tickets/:ticketId/submit-intake', page.locator('#intake-submit'), {
    expectStatus: 409,
  });
  // back on D-05: the 08 text under the number; QR and paper are the two other choices on the form
  await expect(page).toHaveURL(/\/vehicle$/);
  await expect(
    page.getByText('أوقف العميل رسائل واتساب. استخدم QR من جوال العميل أو التذكرة الورقية.'),
  ).toBeVisible();

  // QR while the channel is down: WA_CHANNEL_UNAVAILABLE at the code → back to D-05 → paper
  fake.whatsapp.health = 'down';
  await page.getByRole('radio', { name: 'رمز QR يمسحه العميل' }).check();
  await page.locator('#intake-next').click();
  await expect(page).toHaveURL(/\/key-photos$/);
  await pressCommand(fake, 'POST /v1/tickets/:ticketId/whatsapp-link', page.locator('#intake-submit'), {
    expectStatus: 503,
    pending: page.locator('#intake-submit'),
  });
  await expect(page).toHaveURL(/\/vehicle$/);
  await expect(page.getByText('واتساب متعطل حاليًا. استخدم التذكرة الورقية.')).toBeVisible();
  await page.getByRole('radio', { name: 'تذكرة ورقية' }).click();
  await page.getByLabel('رقم التذكرة الورقية').fill('004700');
  const step1 = await pressCommand(fake, 'PATCH /v1/tickets/:ticketId/intake', page.locator('#intake-next'));
  expect(step1.body).toMatchObject({ channel: 'paper', paper_serial: '004700', customer_phone: null });
  await pressCommand(fake, 'POST /v1/tickets/:ticketId/submit-intake', page.locator('#intake-submit'));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^تذكرة ورقية · #\d+$/);
  expectCommandContract(fake);
});

test('GAP-1 D-07 أ «العميل لم تصله الرسالة؟» while W-01 is still pending: «الربط عبر QR» shows the panel, then the confirmation', async ({
  browser,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const { ticketId } = arrangeSubmitted(fake, 'DRV1', { whatsapp: PHONE, linked: false });
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/intake/${ticketId}/link`);
  await expect(page.getByText('جارٍ الإرسال…')).toBeVisible();
  await page.getByRole('button', { name: 'العميل لم تصله الرسالة؟' }).click();
  const sheet = page.getByRole('dialog', { name: 'العميل لم تصله الرسالة؟' });
  for (const name of ['إعادة الإرسال', 'الربط عبر QR', 'تذكرة ورقية'])
    await expect(sheet.getByRole('button', { name })).toBeVisible();
  await sheet.getByRole('button', { name: 'الربط عبر QR' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.locator('[data-qr-panel] .pt-qr__code svg')).toBeVisible();
  await expect(page.locator('[data-link-mode="qr"]')).toBeVisible();
  fake.whatsapp.customerSends(ticketId, PHONE);
  await expect(page.getByRole('alertdialog', { name: 'وصلت رسالة الربط من رقم ينتهي بـ 567.' })).toBeVisible({
    timeout: 10_000,
  });
});

test('02 D-06 INTAKE_INCOMPLETE: back on D-05 the fields of `details.missing` carry the server text', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const fake = createFake();
  const { ticketId } = newIntake(fake);
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/intake/${ticketId}/vehicle`);
  await fillVehicle(page);
  await page.getByLabel('جوال العميل', { exact: true }).fill('0501234567');
  await page.getByLabel('وافق العميل على استلام رسائل واتساب لهذه التذكرة').check();
  await page.locator('#intake-next').click();
  await keyAndPhotos(page);
  fake.failNext(
    'POST /v1/tickets/:ticketId/submit-intake',
    errorReply('INTAKE_INCOMPLETE', { missing: ['customer_phone', 'vehicle.color'] }),
  );
  await page.locator('#intake-submit').click();
  await expect(page).toHaveURL(/\/vehicle$/);
  // under the number and under the colour, not as a form message
  await expect(page.locator('#customer-phone-err')).toHaveText('أكمل بيانات الاستلام الناقصة.');
  await expect(page.getByText('أكمل بيانات الاستلام الناقصة.')).toHaveCount(2);
});

test('GAP-1 D-13 «إعادة الربط بواتساب» opens D-07 for a parked ticket whose W-01 failed; «العودة» returns', async ({
  browser,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const { ticketId } = arrangeParked(fake, 'DRV1', { whatsapp: PHONE, linked: false });
  fake.whatsapp.w01(ticketId, 'failed');
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/vehicles/${ticketId}`);
  await expect(page.locator('[data-row="channel"]')).toHaveText('قناة العميل: واتساب «تعذر الإرسال»');
  await page.getByRole('button', { name: 'إعادة الربط بواتساب' }).click();
  await expect(page).toHaveURL(new RegExp(`/d/intake/${ticketId}/link$`));
  // parked: the resend and the QR are open, the paper conversion is not (DEC-40: during parking only)
  await expect(page.getByRole('button', { name: 'إعادة الإرسال' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'الربط عبر QR' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'تذكرة ورقية' })).toHaveCount(0);
  await page.getByRole('button', { name: 'العودة' }).click();
  await expect(page).toHaveURL(new RegExp(`/d/vehicles/${ticketId}$`));
});

test('GAP-1 02 D-07 «بعد المغادرة»: W-01 refused after the driver left D-07 — «تعذر إرسال تذكرة #n للعميل.» with «فتح» → D-13', async ({
  browser,
}) => {
  const fake = createFake();
  fake.realtime.enable();
  startDuty(fake, 'DRV1');
  const { ticketId, displayNumber } = arrangeSubmitted(fake, 'DRV1', { whatsapp: PHONE, linked: false });
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto('/d');
  await expect.poll(() => fake.realtime.connectedUsers().length).toBe(1);
  fake.whatsapp.w01(ticketId, 'failed');
  const notice = page.locator('[data-notice="waFailed"]');
  await expect(notice).toContainText(`تعذر إرسال تذكرة #${displayNumber} للعميل.`);
  await notice.getByRole('button', { name: 'فتح' }).click();
  await expect(page).toHaveURL(new RegExp(`/d/vehicles/${ticketId}$`));
  await expect(notice).toHaveCount(0);

  // the customer stops the messages (12 §7.6, 14 §5.1): a notice for the drivers concerned
  fake.whatsapp.optOut(PHONE);
  await expect(page.locator('[data-notice="optedOut"]')).toContainText(
    'العميل أوقف رسائل واتساب — سلّمه شفهيًا أو بالتذكرة الورقية',
  );
});

// ---------------------------------------------------------------- review findings (wave 5)

test('review D-07: a QR issued while W-01 is pending expires — «انتهت صلاحية الرمز.» + «رمز جديد», never «تم الربط»; one primary action', async ({
  browser,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const { ticketId } = arrangeSubmitted(fake, 'DRV1', { whatsapp: PHONE, linked: false });
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/intake/${ticketId}/link`);
  await expect(page.getByText('جارٍ الإرسال…')).toBeVisible();
  fake.whatsapp.qrTtlMs = 4000;
  await page.getByRole('button', { name: 'العميل لم تصله الرسالة؟' }).click();
  await page
    .getByRole('dialog', { name: 'العميل لم تصله الرسالة؟' })
    .getByRole('button', { name: 'الربط عبر QR' })
    .click();
  await expect(page.locator('[data-qr-panel] .pt-qr__code svg')).toBeVisible();
  // 02 D-07 «عند انتهاء المدة»: the expired panel with «رمز جديد» while W-01 still waits
  await expect(page.getByText('انتهت صلاحية الرمز.')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'رمز جديد' })).toBeVisible();
  await expect(page.getByText('تم الربط — وصلت التذكرة للعميل.')).toHaveCount(0);
  await expect(page.locator('[data-link-view="panel"]')).toBeVisible();
  expect(fake.world.tickets.find((t) => t.id === ticketId)?.wa_link_status).toBe('pending_send');
  // 03 §1 rule 2: one primary action on the screen
  await expect(page.locator('main .pt-btn--primary')).toHaveCount(1);
  await expect(page.locator('main .pt-btn--primary')).toHaveText('متابعة إلى الصف');
  // W-01 accepted meanwhile (the screen keeps reading the ticket while W-01 waits): mode أ, «تم الربط»
  fake.whatsapp.w01(ticketId, 'linked');
  await expect(page.getByText('تم الربط — وصلت التذكرة للعميل.')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-qr-panel]')).toHaveCount(0);
});

test('review D-07: «لا، ليس هو» leaves one primary action; the full screen «إغلاق» keeps its contrast in the dark theme', async ({
  browser,
}) => {
  const fake = createFake();
  const { ticketId } = submittedByQr(fake);
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`/d/intake/${ticketId}/link`);
  await page.getByRole('button', { name: 'رمز جديد' }).click();
  await expect(page.locator('[data-qr-panel] .pt-qr__code svg')).toBeVisible();
  await page.getByRole('button', { name: 'ملء الشاشة' }).click();
  const close = page.locator('[data-qr-fullscreen] .pt-qr-full__close');
  await expect(close).toBeVisible();
  // WCAG 1.4.11 (03 §1.1): the close glyph against the white panel ≥ 3:1
  const ratio = await close.evaluate((el) => {
    const rgb = (c: string) => (c.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
    const lum = ([r = 0, g = 0, b = 0]: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const fg = lum(rgb(getComputedStyle(el).color));
    const bg = lum(rgb(getComputedStyle(el.closest('.pt-qr-full') as Element).backgroundColor));
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(3);
  await close.click();
  fake.whatsapp.customerSends(ticketId, SENDER);
  const dialog = page.getByRole('alertdialog', { name: 'وصلت رسالة الربط من رقم ينتهي بـ 887.' });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole('button', { name: 'لا، ليس هو' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('اضغط «رمز جديد» ليظهر رمز QR للعميل.')).toBeVisible();
  await expect(page.locator('main .pt-btn--primary')).toHaveCount(1);
  // the code issued at the submit gave way to «رمز جديد» (`regenerated`), the sender was rejected
  expect(fake.whatsapp.linkCodes.filter((l) => l.ticket_id === ticketId).map((l) => l.revoke_reason)).toEqual(
    ['regenerated', 'driver_rejected_match'],
  );
});

test('review D-05/D-06: QR → paper → QR after a refused submit issues a fresh code (the paper save revoked the one kept)', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const fake = createFake();
  const { ticketId, n } = newIntake(fake);
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/intake/${ticketId}/vehicle`);
  await fillVehicle(page);
  await page.getByRole('radio', { name: 'رمز QR يمسحه العميل' }).check();
  await page.locator('#intake-next').click();
  await keyAndPhotos(page);
  // the submit is refused after the code was issued (C1 stays in memory)
  fake.failNext('POST /v1/tickets/:ticketId/submit-intake', errorReply('EVENT_NOT_OPEN'));
  await pressCommand(fake, 'POST /v1/tickets/:ticketId/submit-intake', page.locator('#intake-submit'), {
    expectStatus: 409,
  });
  expect(fake.callsTo('POST /v1/tickets/:ticketId/whatsapp-link')).toHaveLength(1);
  // back to D-05 in the app: paper (C1 revoked, `channel_paper`), then back to WhatsApp + QR
  await page.getByRole('button', { name: 'رجوع' }).click();
  await expect(page).toHaveURL(/\/vehicle$/);
  await page.getByRole('radio', { name: 'تذكرة ورقية' }).click();
  await page.getByLabel('رقم التذكرة الورقية').fill('004800');
  await pressCommand(fake, 'PATCH /v1/tickets/:ticketId/intake', page.locator('#intake-next'));
  expect(fake.whatsapp.linkCodes.filter((l) => l.ticket_id === ticketId).map((l) => l.revoke_reason)).toEqual(
    ['channel_paper'],
  );
  await expect(page).toHaveURL(/\/key-photos$/);
  await page.getByRole('button', { name: 'رجوع' }).click();
  await page.getByRole('radio', { name: 'واتساب' }).click();
  await page.getByRole('radio', { name: 'رمز QR يمسحه العميل' }).check();
  await pressCommand(fake, 'PATCH /v1/tickets/:ticketId/intake', page.locator('#intake-next'));
  await expect(page).toHaveURL(/\/key-photos$/);
  // «إتمام التسجيل» issues a new code, and the submit goes through on the first press (no refused retry)
  await pressCommand(fake, 'POST /v1/tickets/:ticketId/submit-intake', page.locator('#intake-submit'));
  expect(fake.callsTo('POST /v1/tickets/:ticketId/whatsapp-link')).toHaveLength(2);
  expect(fake.callsTo('POST /v1/tickets/:ticketId/submit-intake').map((c) => c.status)).toEqual([409, 200]);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`ربط واتساب · #${n}`);
  await expect(page.locator('[data-qr-panel] .pt-qr__code svg')).toBeVisible();
  const live = fake.whatsapp.linkCodes.filter((l) => l.ticket_id === ticketId && l.status === 'active');
  expect(live).toHaveLength(1);
});

test('review D-06: a code kept in memory but no longer live on the server — one more submit with a fresh code', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const fake = createFake();
  const { ticketId, n } = newIntake(fake);
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/intake/${ticketId}/vehicle`);
  await fillVehicle(page);
  await page.getByRole('radio', { name: 'رمز QR يمسحه العميل' }).check();
  await page.locator('#intake-next').click();
  await keyAndPhotos(page);
  fake.failNext('POST /v1/tickets/:ticketId/submit-intake', errorReply('EVENT_NOT_OPEN'));
  await pressCommand(fake, 'POST /v1/tickets/:ticketId/submit-intake', page.locator('#intake-submit'), {
    expectStatus: 409,
  });
  // the code went on the server meanwhile (another device issued a code, a supervisor action…)
  const kept = fake.whatsapp.linkCodes.find((l) => l.ticket_id === ticketId && l.status === 'active');
  if (!kept) throw new Error('no code');
  kept.status = 'revoked';
  kept.revoke_reason = 'regenerated';
  await page.locator('#intake-submit').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`ربط واتساب · #${n}`);
  // the refused submit (INTAKE_INCOMPLETE customer_phone) and the retry with the second code
  expect(fake.callsTo('POST /v1/tickets/:ticketId/submit-intake').map((c) => c.status)).toEqual([
    409, 422, 200,
  ]);
  expect(fake.callsTo('POST /v1/tickets/:ticketId/whatsapp-link')).toHaveLength(2);
  await expect(page.locator('[data-qr-panel] .pt-qr__code svg')).toBeVisible();
});

test('review D-05: INTAKE_INCOMPLETE about the number in the QR mode shows the server text on the form', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const fake = createFake();
  const { ticketId } = newIntake(fake);
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/intake/${ticketId}/vehicle`);
  await fillVehicle(page);
  await page.getByRole('radio', { name: 'رمز QR يمسحه العميل' }).check();
  await page.locator('#intake-next').click();
  await keyAndPhotos(page);
  fake.failNext(
    'POST /v1/tickets/:ticketId/submit-intake',
    errorReply('INTAKE_INCOMPLETE', { missing: ['customer_phone'] }),
  );
  await page.locator('#intake-submit').click();
  await expect(page).toHaveURL(/\/vehicle$/);
  // the number is not on the QR form: the 08 text as the form message, not lost under a hidden field
  await expect(page.getByRole('alert').getByText('أكمل بيانات الاستلام الناقصة.')).toBeVisible();
  // the next «إتمام التسجيل» issues a fresh code
  await page.locator('#intake-next').click();
  await expect(page).toHaveURL(/\/key-photos$/);
  await pressCommand(fake, 'POST /v1/tickets/:ticketId/submit-intake', page.locator('#intake-submit'));
  expect(fake.callsTo('POST /v1/tickets/:ticketId/whatsapp-link')).toHaveLength(2);
});

test("review D-05: a direct draft resumed without this device's copy keeps the number on record (no retyping)", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const fake = createFake();
  const { ticketId } = newIntake(fake);
  const version = fake.world.tickets.find((t) => t.id === ticketId)?.version;
  // the first step saved from another device with the number and the consent
  fake.exec(
    'DRV1',
    'PATCH /v1/tickets/:ticketId/intake',
    { ticketId },
    {
      expected_version: version,
      channel: 'whatsapp',
      customer_phone: PHONE,
      consent: { method: 'verbal_staff_confirmed', confirmed: true },
      plate: { country: 'SA', digits: '5678', letters_ar: 'ر س ص', letters_en: 'R S X' },
      vehicle: { make: 'kia', model: null, color: 'red' },
    },
  );
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/intake/${ticketId}/vehicle`);
  await expect(page.getByRole('radio', { name: 'رقم جوال العميل' })).toBeChecked();
  const recorded = page.locator('[data-phone-recorded]');
  await expect(recorded).toContainText('الجوال:');
  await expect(recorded).toContainText('567');
  await expect(page.getByLabel('جوال العميل', { exact: true })).toHaveCount(0);
  const step1 = await pressCommand(fake, 'PATCH /v1/tickets/:ticketId/intake', page.locator('#intake-next'));
  // neither the number nor the consent is sent: the server keeps both
  expect(step1.body).not.toHaveProperty('customer_phone');
  expect(step1.body).not.toHaveProperty('consent');
  expect(step1.body).toMatchObject({ channel: 'whatsapp', paper_serial: null });
  expect(fake.world.tickets.find((t) => t.id === ticketId)).toMatchObject({
    customer_phone: PHONE,
    consent: true,
  });
  // «تغيير رقم الجوال» opens the number again; another number needs the consent again
  await page.getByRole('button', { name: 'رجوع' }).click();
  await page.getByRole('button', { name: 'تغيير رقم الجوال' }).click();
  const input = page.getByLabel('جوال العميل', { exact: true });
  await expect(input).toHaveAttribute('autocomplete', 'off');
  await input.fill('0507776666');
  await page.locator('#intake-next').click();
  await expect(page.getByText('لا نرسل واتساب دون موافقة العميل.')).toBeVisible();
});

test('review D-13 → D-07 on a parked ticket: a stale message never answers for the newer code (C1 expired, C2 confirmed)', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const fake = createFake();
  fake.realtime.enable();
  startDuty(fake, 'DRV1');
  const { ticketId } = arrangeParked(fake, 'DRV1', { whatsapp: PHONE, linked: false });
  fake.whatsapp.w01(ticketId, 'failed');
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/vehicles/${ticketId}`);
  await expect.poll(() => fake.realtime.connectedUsers().length).toBe(1);
  await page.getByRole('button', { name: 'إعادة الربط بواتساب' }).click();
  await page.getByRole('button', { name: 'الربط عبر QR' }).click();
  await expect(page.locator('[data-qr-panel] .pt-qr__code svg')).toBeVisible();
  // C1 from …887: the parked ticket's creator hears it (a creator event, 07 §4.3) with the sender's digits
  fake.whatsapp.customerSends(ticketId, SENDER);
  await expect(page.getByRole('alertdialog', { name: 'وصلت رسالة الربط من رقم ينتهي بـ 887.' })).toBeVisible({
    timeout: 10_000,
  });
  // nobody answers: the code expires, the link is back to none
  fake.whatsapp.expireCode(ticketId);
  await expect(page.getByRole('alertdialog')).toBeHidden({ timeout: 10_000 });
  await pressCommand(
    fake,
    'POST /v1/tickets/:ticketId/whatsapp-link',
    page.getByRole('button', { name: 'رمز جديد' }),
  );
  const c2 = fake.whatsapp.linkCodes.find((l) => l.ticket_id === ticketId && l.status === 'active');
  fake.whatsapp.customerSends(ticketId, '+966501112223');
  const dialog = page.getByRole('alertdialog', { name: 'وصلت رسالة الربط من رقم ينتهي بـ 223.' });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  const yes = await pressCommand(
    fake,
    'POST /v1/tickets/:ticketId/whatsapp-link/confirm',
    dialog.getByRole('button', { name: 'نعم، اربط التذكرة' }),
  );
  expect(yes.body).toEqual({ link_code_id: c2?.id, matches: true });
  expect(fake.world.tickets.find((t) => t.id === ticketId)?.wa_link_status).toBe('linked');
  // parked, not in this driver's hands: «العودة» to D-13, never «متابعة إلى الصف»
  await expect(page.getByRole('button', { name: 'متابعة إلى الصف' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'العودة' })).toBeVisible();
});

test("review D-13 → D-07 on another driver's parking ticket: no «تذكرة ورقية», «العودة» instead of «متابعة إلى الصف»", async ({
  browser,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  startDuty(fake, 'DRV2');
  const { ticketId } = arrangeSubmitted(fake, 'DRV1', { whatsapp: PHONE, linked: false });
  fake.whatsapp.w01(ticketId, 'failed');
  const { page } = await actorPage(browser, fake, 'DRV2');
  await page.goto(`/d/vehicles/${ticketId}`);
  await page.getByRole('button', { name: 'إعادة الربط بواتساب' }).click();
  await expect(page).toHaveURL(new RegExp(`/d/intake/${ticketId}/link$`));
  await expect(page.getByRole('button', { name: 'الربط عبر QR' })).toBeVisible();
  // DEC-40's conversion is the parking driver's (PATCH …/intake answers not_ticket_creator otherwise)
  await expect(page.getByRole('button', { name: 'تذكرة ورقية' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'متابعة إلى الصف' })).toHaveCount(0);
  await page.getByRole('button', { name: 'العودة' }).click();
  await expect(page).toHaveURL(new RegExp(`/d/vehicles/${ticketId}$`));
});

test('review D-13: no «إعادة الربط بواتساب» when D-07 could do nothing (requested, no number on record)', async ({
  browser,
}) => {
  const fake = createFake();
  const { ticketId } = submittedByQr(fake);
  const ticket = fake.world.tickets.find((t) => t.id === ticketId);
  const park = fake.world.tasks.find((k) => k.ticket_id === ticketId && k.type === 'park');
  if (!park) throw new Error('no park task');
  // the QR code expired unused, the car parked, then requested
  const code = fake.whatsapp.linkCodes.find((l) => l.ticket_id === ticketId && l.status === 'active');
  if (code) code.status = 'expired';
  parkTask(fake, 'DRV1', park.id, 'A-10', '20');
  requestRetrieval(fake, ticketId);
  expect(ticket?.status).toBe('requested');
  const { page } = await actorPage(browser, fake, 'DRV2');
  startDuty(fake, 'DRV2');
  await page.goto(`/d/vehicles/${ticketId}`);
  await expect(page.locator('[data-row="channel"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'إعادة الربط بواتساب' })).toHaveCount(0);
});

test('review D-07: the channel down while W-01 waits — «واتساب متوقف مؤقتًا. سلّم العميل تذكرة ورقية.» with the paper stub', async ({
  browser,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const { ticketId } = arrangeSubmitted(fake, 'DRV1', { whatsapp: PHONE, linked: false });
  fake.whatsapp.health = 'down';
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/intake/${ticketId}/link`);
  await expect(page.getByText('جارٍ الإرسال…')).toBeVisible();
  await expect(page.getByText('واتساب متوقف مؤقتًا. سلّم العميل تذكرة ورقية.')).toBeVisible();
  // the D-15 ز banner of the frame from the snapshot's channel_health
  await expect(
    page.getByText(
      'رسائل واتساب للعملاء متوقفة مؤقتًا. استقبل الطلبات من العملاء مباشرة واستخدم التذكرة الورقية.',
    ),
  ).toBeVisible();
  await page.locator('[data-link-options]').getByRole('button', { name: 'تذكرة ورقية' }).click();
  await expect(page.getByRole('dialog', { name: 'تذكرة ورقية' })).toBeVisible();
});
