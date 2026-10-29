import { expect, test, type Page } from '@playwright/test';
import { errorMessagesAr } from '../src/i18n/errors';
import { actorPage, expectCommandContract } from './support/actors';
import { fakeOnly } from './support/backend';
import { runOnlyAt390 } from './support/checks';
import { acceptOfferOf, arrangeParked, EVENT_R1, requestRetrieval, startDuty } from './support/driver';
import { createFake, SEED_IDS, type FakeServer, type FTicket } from './support/fake';
import { parkedCars } from './support/live';

/**
 * PNT-069 — D-12 «المركبات» and D-13 «تفاصيل المركبة» on the fake backend: the list of the venue's open
 * tickets with the minimal fields, the digits search (300 ms after typing) and the 02 chips, the cursor pages,
 * the field projection of D-13 by viewer (09 §5.1) and the D-13 commands with the 08 texts of their errors.
 */
runOnlyAt390();
fakeOnly();

const ticketOf = (fake: FakeServer, id: string) => fake.world.tickets.find((t) => t.id === id) as FTicket;

/** The D-12 rows, in screen order. */
const rows = (page: Page) => page.getByRole('list', { name: 'المركبات' }).getByRole('listitem');

/** Copies of a parked ticket for the list only (no tasks): `n` older ones with their own numbers. */
function olderCopies(fake: FakeServer, base: FTicket, n: number): void {
  for (let i = 0; i < n; i += 1)
    fake.world.tickets.push({
      ...base,
      id: crypto.randomUUID(),
      display_number: 500 + i,
      plate_digits: String(7000 + i),
      paper_serial: null,
      key_tag: null,
      created_at: new Date(Date.parse(base.created_at) - (i + 1) * 60_000).toISOString(),
    });
}

test('PNT-069: D-12 lists the open tickets of the venue only, newest first, with the minimal fields', async ({
  browser,
}) => {
  const fake = createFake();
  const [a, b, c] = parkedCars(fake, 3); // parked by DRV3 (on break afterwards)
  ticketOf(fake, a!.ticketId).plate_digits = '1234';
  ticketOf(fake, b!.ticketId).plate_digits = '5521';
  ticketOf(fake, c!.ticketId).plate_digits = '880';
  startDuty(fake, 'DRV1');
  requestRetrieval(fake, b!.ticketId); // «مطلوبة» with its waiting time
  ticketOf(fake, c!.ticketId).status = 'delivered'; // closed: never listed for a driver
  startDuty(fake, 'DRV7');
  fake.exec('DRV7', 'POST /v1/tickets', {}, { event_id: SEED_IDS.events['EVT-L1'] }); // another venue
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto('/d/vehicles');
  await expect(rows(page)).toHaveCount(2);
  // newest first: b was created after a
  await expect(rows(page).nth(0)).toContainText(`#${b!.displayNumber}`);
  await expect(rows(page).nth(0)).toContainText('مطلوبة');
  await expect(rows(page).nth(0)).toContainText(/منذ \d+:\d{2}/);
  await expect(rows(page).nth(1)).toContainText(`#${a!.displayNumber}`);
  await expect(rows(page).nth(1)).toContainText('متوقفة');
  await expect(rows(page).nth(1).getByRole('img', { name: 'لوحة: ر س ص، 1234' })).toBeVisible();
  await expect(rows(page).nth(1)).toContainText('شيفروليه · أسود');
  // minimal fields only on the wire (TicketSummary): no phone, no spot, no key slot
  const reply = fake.callsTo('GET /v1/tickets').at(-1)?.reply as { data: Array<Record<string, unknown>> };
  for (const item of reply.data) {
    expect(Object.keys(item)).not.toContain('customer');
    expect(Object.keys(item)).not.toContain('current_key_slot');
    expect(Object.keys(item)).not.toContain('media');
  }
  // a row opens D-13
  await rows(page).nth(1).getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/d/vehicles/${a!.ticketId}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`#${a!.displayNumber}`);
  await page.getByRole('button', { name: 'رجوع' }).click();
  await expect(page).toHaveURL(/\/d\/vehicles$/);
});

test('PNT-069: the digits search runs once 300 ms after typing; the chips filter by the 02 statuses', async ({
  browser,
}) => {
  const fake = createFake();
  const [a, b] = parkedCars(fake, 2); // tickets #1 and #2
  // plates without the digits of any ticket number here, so each search below has one answer
  ticketOf(fake, a!.ticketId).plate_digits = '7777';
  ticketOf(fake, b!.ticketId).plate_digits = '5590';
  startDuty(fake, 'DRV1');
  requestRetrieval(fake, b!.ticketId);
  startDuty(fake, 'DRV2');
  const draft = fake.exec('DRV2', 'POST /v1/tickets', {}, { event_id: EVENT_R1 }); // «قيد التسجيل والصف»
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto('/d/vehicles');
  await expect(rows(page)).toHaveCount(3);
  const lastQuery = (name: string) => () => fake.callsTo('GET /v1/tickets').at(-1)?.query?.get(name) ?? null;

  const search = page.getByRole('searchbox', { name: 'ابحث برقم اللوحة أو رقم التذكرة' });
  await search.pressSequentially('5590', { delay: 40 });
  await expect.poll(lastQuery('q')).toBe('5590');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText(`#${b!.displayNumber}`);
  const searched = fake
    .callsTo('GET /v1/tickets')
    .map((c) => c.query?.get('q'))
    .filter(Boolean);
  expect(searched).toEqual(['5590']); // one request, after the typing stopped

  // the ticket number, typed with Arabic-Indic digits, matches exactly
  await search.fill(String(a!.displayNumber).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)] as string));
  await expect.poll(lastQuery('q')).toBe(String(a!.displayNumber));
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText(`#${a!.displayNumber}`);

  // letters only: nothing can match, nothing is asked
  const before = fake.callsTo('GET /v1/tickets').length;
  await search.fill('abc');
  await expect(page.getByText('لا توجد مركبات مطابقة.')).toBeVisible();
  await page.waitForTimeout(500);
  expect(fake.callsTo('GET /v1/tickets').length).toBe(before);

  await search.fill('');
  await expect(rows(page)).toHaveCount(3);
  const chips = page.getByRole('group', { name: 'تصفية' });
  await chips.getByRole('button', { name: 'مطلوبة' }).click();
  await expect.poll(lastQuery('status')).toBe('requested,assigned,assigned_waiting');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText(`#${b!.displayNumber}`);
  await chips.getByRole('button', { name: 'قيد التسجيل والصف' }).click();
  await expect.poll(lastQuery('status')).toBe('received,parking,reparking');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText(`#${draft.ticket.display_number}`);
  await chips.getByRole('button', { name: 'جاهزة' }).click();
  await expect.poll(lastQuery('status')).toBe('ready');
  await expect(page.getByText('لا توجد مركبات مطابقة.')).toBeVisible();
  // a second tap on the chosen chip goes back to «الكل»
  await chips.getByRole('button', { name: 'جاهزة' }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(chips.getByRole('button', { name: 'الكل' })).toHaveAttribute('aria-pressed', 'true');
});

test('PNT-069: the empty venue, and the next page of 50 when the list end comes into view', async ({
  browser,
}) => {
  const empty = createFake();
  startDuty(empty, 'DRV1');
  const first = await actorPage(browser, empty, 'DRV1');
  await first.page.goto('/d/vehicles');
  await expect(first.page.getByText('لا توجد مركبات مسجلة في الحفلات المفتوحة.')).toBeVisible();

  const fake = createFake();
  const [car] = parkedCars(fake, 1);
  olderCopies(fake, ticketOf(fake, car!.ticketId), 54);
  startDuty(fake, 'DRV1');
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto('/d/vehicles');
  await expect(rows(page)).toHaveCount(50);
  expect(fake.callsTo('GET /v1/tickets').at(-1)?.query?.get('limit')).toBe('50');
  await rows(page).nth(49).scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 4000);
  await expect(rows(page)).toHaveCount(55);
  expect(fake.callsTo('GET /v1/tickets').at(-1)?.query?.get('cursor')).toBeTruthy();
});

test('PNT-069 AC1: a driver who is not assigned gets the minimal projection; the assignee the masked phone and the slot', async ({
  browser,
}) => {
  const fake = createFake();
  const [car] = parkedCars(fake, 1); // created and parked by DRV3 in A-20, key in slot 40
  const t = ticketOf(fake, car!.ticketId);
  t.channel = 'whatsapp';
  t.customer_phone = '+966512345678';
  t.consent = true;
  t.wa_link_status = 'linked';
  t.paper_serial = null;
  t.payment_status = 'due';
  startDuty(fake, 'DRV1');
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/vehicles/${car!.ticketId}`);
  await expect(page.locator('[data-row="channel"]')).toHaveText('قناة العميل: واتساب «مربوطة»');
  await expect(page.locator('[data-row="payment"]')).toHaveText('التحصيل: «مستحق»');
  await expect(page.getByText('متوقفة')).toBeVisible();
  await expect(page.getByText('حفل تجريبي — ريماس 1')).toBeVisible();
  for (const row of ['phone', 'spot', 'key-slot', 'created-by'])
    await expect(page.locator(`[data-row="${row}"]`)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'الصور' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'تغيير رقم الجوال' })).toHaveCount(0);
  const minimal = fake.callsTo('GET /v1/tickets/:ticketId').at(-1)?.reply as {
    data: Record<string, unknown>;
  };
  expect(minimal.data.projection).toBe('minimal');
  for (const field of ['customer', 'current_spot', 'current_key_slot', 'media', 'key_holder', 'paper_serial'])
    expect(minimal.data).not.toHaveProperty(field);
  expect(minimal.data).toMatchObject({
    channel: 'whatsapp',
    wa_link_status: 'linked',
    payment_status: 'due',
  });

  // DRV1 takes the retrieval: the full projection with the phone masked only, the spot and the key slot
  requestRetrieval(fake, car!.ticketId);
  acceptOfferOf(fake, 'DRV1', car!.ticketId);
  await page.reload();
  await expect(page.locator('[data-row="phone"]')).toHaveText('الجوال: 05•••••678');
  await expect(page.locator('[data-row="spot"]')).toHaveText('الموقف A-20');
  await expect(page.locator('[data-row="key-slot"]')).toHaveText('خانة المفتاح 40');
  await expect(page.getByRole('button', { name: 'الصور' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'تغيير رقم الجوال' })).toBeVisible();
  const full = fake.callsTo('GET /v1/tickets/:ticketId').at(-1)?.reply as { data: Record<string, unknown> };
  expect(full.data.projection).toBe('full');
  expect(JSON.stringify(full.data)).not.toContain('512345678'); // never the whole number
  await page.getByRole('button', { name: 'الصور' }).click();
  await expect(page.getByRole('dialog', { name: 'الصور' }).getByRole('img')).toHaveCount(4);
});

test('PNT-069 AC2: «طلب الإحضار نيابة عن العميل» with a reason; its errors with the 08 texts', async ({
  browser,
}) => {
  const fake = createFake();
  const [a, b, c] = parkedCars(fake, 3);
  startDuty(fake, 'DRV1');
  const { page } = await actorPage(browser, fake, 'DRV1');

  // success: «أخرى» needs its text; the request goes with an Idempotency-Key, then «مطلوبة»
  await page.goto(`/d/vehicles/${a!.ticketId}`);
  await page.getByRole('button', { name: 'طلب الإحضار نيابة عن العميل' }).click();
  const sheet = page.getByRole('dialog', { name: 'طلب الإحضار نيابة عن العميل' });
  const confirm = sheet.getByRole('button', { name: 'تأكيد' });
  await expect(confirm).toBeDisabled();
  await sheet.getByText('أخرى').click();
  await expect(confirm).toBeDisabled();
  await sheet.getByRole('textbox', { name: 'السبب (إلزامي)' }).fill('العميل اتصل بالمشرف');
  await confirm.click();
  await expect(page.getByText(`سُجّل طلب الإحضار #${a!.displayNumber}.`)).toBeVisible();
  await expect(page.getByText('مطلوبة')).toBeVisible();
  const sent = fake.callsTo('POST /v1/tickets/:ticketId/retrievals').at(-1);
  expect(sent?.body).toEqual({ reason: 'العميل اتصل بالمشرف' });
  expect(sent?.status).toBe(201);

  // the errors of the command, each with its 08 text (the screen was opened before the change)
  const cases: Array<[string, string, () => void]> = [
    [b!.ticketId, 'RETRIEVAL_ALREADY_ACTIVE', () => void requestRetrieval(fake, b!.ticketId)],
    [c!.ticketId, 'TICKET_NOT_PARKED', () => void (ticketOf(fake, c!.ticketId).status = 'reparking')],
  ];
  for (const [ticketId, code, change] of cases) {
    await page.goto(`/d/vehicles/${ticketId}`);
    await page.getByRole('button', { name: 'طلب الإحضار نيابة عن العميل' }).click();
    await page
      .getByRole('dialog', { name: 'طلب الإحضار نيابة عن العميل' })
      .getByText('العميل حضر بتذكرة ورقية')
      .click();
    change();
    await page.getByRole('dialog').getByRole('button', { name: 'تأكيد' }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText(
      errorMessagesAr[code as keyof typeof errorMessagesAr],
    );
    expect(fake.callsTo('POST /v1/tickets/:ticketId/retrievals').at(-1)?.body).toEqual({
      reason: 'العميل حضر بتذكرة ورقية',
    });
  }
  // TICKET_CLOSED: delivered behind the screen
  ticketOf(fake, c!.ticketId).status = 'parked';
  await page.goto(`/d/vehicles/${c!.ticketId}`);
  await page.getByRole('button', { name: 'طلب الإحضار نيابة عن العميل' }).click();
  await page.getByRole('dialog').getByText('واتساب متوقف').click();
  ticketOf(fake, c!.ticketId).status = 'delivered';
  await page.getByRole('dialog').getByRole('button', { name: 'تأكيد' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText(errorMessagesAr.TICKET_CLOSED);
  expectCommandContract(fake);
});

test('PNT-069: offline, D-12 keeps the last results dimmed and the D-13 commands wait for the network', async ({
  browser,
}) => {
  const fake = createFake();
  const [car] = parkedCars(fake, 1);
  startDuty(fake, 'DRV1');
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto('/d/vehicles');
  await expect(rows(page)).toHaveCount(1);
  await page.context().setOffline(true);
  await expect(
    page.getByRole('alert').filter({ hasText: 'لا يوجد اتصال. البيانات المعروضة من' }),
  ).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await expect(page.locator('.pt-live')).toHaveAttribute('data-stale', 'true');
  await page.context().setOffline(false);
  await rows(page).first().getByRole('link').click();
  const onBehalf = page.getByRole('button', { name: 'طلب الإحضار نيابة عن العميل' });
  await expect(onBehalf).toBeEnabled();
  await page.context().setOffline(true);
  await expect(onBehalf).toBeDisabled();
  await page.context().setOffline(false);
  await expect(onBehalf).toBeEnabled();
  expect(fake.callsTo('POST /v1/tickets/:ticketId/retrievals')).toHaveLength(0);
  expect(page.url()).toContain(car!.ticketId);
});

test('PNT-069: «إلغاء طلب الإحضار» before the assignment; after it the 02 D-13 text', async ({ browser }) => {
  const fake = createFake();
  const [a, b] = parkedCars(fake, 2);
  startDuty(fake, 'DRV1');
  startDuty(fake, 'DRV2');
  fake.exec('DRV2', 'POST /v1/me/duty/break', {}, { active: true }); // DRV1 is the only free driver
  requestRetrieval(fake, a!.ticketId); // single offer to DRV1: offered, not assigned
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/vehicles/${a!.ticketId}`);
  await page.getByRole('button', { name: 'إلغاء طلب الإحضار' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(`إلغاء طلب الإحضار #${a!.displayNumber}؟ سيُبلغ العميل بالإلغاء.`);
  await dialog.getByRole('textbox', { name: 'السبب (إلزامي)' }).fill('العميل غيّر رأيه');
  await dialog.getByRole('button', { name: 'إلغاء طلب الإحضار' }).click();
  await expect(page.getByText('متوقفة')).toBeVisible();
  await expect(page.getByRole('button', { name: 'طلب الإحضار نيابة عن العميل' })).toBeVisible();
  expect(fake.callsTo('POST /v1/retrieval-cycles/:cycleId/cancel').at(-1)?.body).toEqual({
    reason: 'العميل غيّر رأيه',
  });

  // assigned behind the open screen: the server refuses; its 08 text is shown (DEC-80)
  requestRetrieval(fake, b!.ticketId);
  await page.goto(`/d/vehicles/${b!.ticketId}`);
  await page.getByRole('button', { name: 'إلغاء طلب الإحضار' }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('textbox', { name: 'السبب (إلزامي)' })
    .fill('العميل غيّر رأيه');
  fake.exec('DRV2', 'POST /v1/me/duty/break', {}, { active: false });
  acceptOfferOf(fake, 'DRV1', b!.ticketId);
  await page.getByRole('alertdialog').getByRole('button', { name: 'إلغاء طلب الإحضار' }).click();
  await expect(page.getByRole('alertdialog')).toContainText(errorMessagesAr.INVALID_STATE_TRANSITION);
  const refusal = fake.callsTo('POST /v1/retrieval-cycles/:cycleId/cancel').at(-1);
  expect(refusal?.status).toBe(409);
  expect((refusal?.reply as { error: { details: { reason?: string } } }).error.details.reason).toBe(
    'driver_cancel_after_assignment',
  );
});

test('PNT-069: «تغيير رقم الجوال» by the assignee of a WhatsApp ticket; «إبلاغ عن واقعة»', async ({
  browser,
}) => {
  const fake = createFake();
  const [car] = parkedCars(fake, 1);
  const t = ticketOf(fake, car!.ticketId);
  t.channel = 'whatsapp';
  t.customer_phone = '+966512345678';
  t.consent = true;
  t.wa_link_status = 'linked';
  startDuty(fake, 'DRV1');
  requestRetrieval(fake, car!.ticketId);
  acceptOfferOf(fake, 'DRV1', car!.ticketId);
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/vehicles/${car!.ticketId}`);

  await page.getByRole('button', { name: 'تغيير رقم الجوال' }).click();
  const sheet = page.getByRole('dialog', { name: 'تغيير رقم الجوال' });
  await expect(sheet).toContainText('ستُرسل تذكرة جديدة للرقم الجديد، وتتوقف أزرار الرسائل السابقة.');
  const confirm = sheet.getByRole('button', { name: 'تأكيد' });
  await sheet.getByRole('textbox', { name: 'الرقم الجديد' }).fill('12345');
  await sheet.getByText('تحققت من صاحب المركبة أمامي').click();
  await sheet.getByText('وافق العميل على استلام رسائل واتساب لهذه التذكرة').click();
  await sheet.getByRole('textbox', { name: 'السبب (إلزامي)' }).fill('رقم العميل الصحيح');
  await confirm.click();
  await expect(sheet.getByText('أدخل رقم جوال سعودي صحيح يبدأ بـ 5.')).toBeVisible();
  expect(fake.callsTo('PATCH /v1/tickets/:ticketId/customer-phone')).toHaveLength(0);
  await sheet.getByRole('textbox', { name: 'الرقم الجديد' }).fill('0555000111');
  await confirm.click();
  await expect(page.locator('[data-row="channel"]')).toHaveText('قناة العميل: واتساب «جارٍ الإرسال»');
  await expect(page.locator('[data-row="phone"]')).toHaveText('الجوال: 05•••••111');
  expect(fake.callsTo('PATCH /v1/tickets/:ticketId/customer-phone').at(-1)?.body).toEqual({
    expected_version: expect.any(Number),
    customer_phone: '+966555000111',
    consent: { method: 'verbal_staff_confirmed', confirmed: true },
    reason: 'رقم العميل الصحيح',
  });

  await page.getByRole('button', { name: 'إبلاغ عن واقعة' }).click();
  const report = page.getByRole('dialog', { name: 'إبلاغ عن واقعة' });
  await report.getByText('المفتاح غير موجود في الخانة').click();
  await report.getByRole('textbox', { name: 'الوصف' }).fill('الخانة 40 فارغة');
  await report.getByRole('button', { name: 'تأكيد' }).click();
  await expect(page.getByText('أُبلغ المشرف.')).toBeVisible();
  expect(fake.incidents.at(-1)).toMatchObject({
    venue_id: SEED_IDS.venues.RMS,
    ticket_id: car!.ticketId,
    type: 'key_missing',
    description: 'الخانة 40 فارغة',
  });
  expectCommandContract(fake);
});

test('PNT-069: a parked car the driver parked himself shows the minimal fields after the intake', async ({
  browser,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const parked = arrangeParked(fake, 'DRV1'); // DRV1 created it; the intake is over
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/vehicles/${parked.ticketId}`);
  await expect(page.locator('[data-row="channel"]')).toHaveText('قناة العميل: تذكرة ورقية');
  await expect(page.locator('[data-row="key-slot"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'طلب الإحضار نيابة عن العميل' })).toBeVisible();
});
