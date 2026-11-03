import { expect, test } from '@playwright/test';
import { actorPage } from './support/actors';
import { fakeOnly } from './support/backend';
import { runOnlyAt390 } from './support/checks';
import {
  acceptOfferOf,
  arrangeParked,
  arrangeRetrieval,
  arrangeSubmitted,
  EVENT_R1,
  EVENT_R2,
  offerOf,
  parkTask,
  PHOTO,
  pressCommand,
  requestRetrieval,
  startDuty,
} from './support/driver';
import { createFake, errorReply, SEED_IDS, STORAGE_PREFIX } from './support/fake';

/**
 * PNT-035 acceptance 3: the driver screens of the first vertical path show the 08 texts (the server's
 * `message_ar`, DEC-80) with the 08 §4 handling — inline under the field, a dialog, or a toast and a sync.
 * Most errors come from real conflicts in the fake's world (a second actor, a closed shift); a few are
 * injected (`failNext`). Each command press is checked for its contract (one request, Idempotency-Key,
 * button disabled until the reply).
 */
runOnlyAt390();
fakeOnly();

/** 08 §4 «النص العربي» of the codes below, word for word. */
const TEXT = {
  SHIFT_NOT_OPEN: 'لا توجد وردية مفتوحة في موقعك. راجع المشرف.',
  TASK_ALREADY_CLAIMED: 'قبل الطلب سائق آخر.',
  PAPER_SERIAL_IN_USE: 'رقم التذكرة الورقية مستخدم في هذا الحفل.',
  KEY_TAG_IN_USE: 'رقم علاقة المفتاح مستخدم لمركبة أخرى.',
  MEDIA_UPLOAD_INCOMPLETE: 'لم يكتمل رفع الصورة. أعد المحاولة.',
  DRAFT_HAS_DATA: 'المسودة فيها بيانات؛ يلزم إلغاؤها من المشرف.',
  PARKING_SPOT_OCCUPIED: 'الموقف مشغول. اختر موقفًا آخر أو اكتب ملاحظة.',
  CUSTODY_HOLDER_MISMATCH: 'هذه العهدة ليست لديك.',
  PAPER_STUB_MISMATCH: 'رقم كعب التذكرة لا يطابق.',
  HANDOVER_CODE_LOCKED: 'قُفل التحقق بعد محاولات خاطئة. اتصل بالمشرف.',
  PAYMENT_PENDING: 'سجّل التحصيل قبل التسليم.',
} as const;

const RMS = SEED_IDS.venues.RMS;

test('D-03: no open shift shows the 02 state with «تحديث»; a start after it closed answers SHIFT_NOT_OPEN', async ({
  page,
}) => {
  const fake = createFake();
  const shifts = fake.world.shifts.filter((s) => s.venue_id === RMS);
  const setShift = (status: 'open' | 'closed') => shifts.forEach((s) => (s.status = status));
  setShift('closed');
  await fake.attach(page, 'DRV1');
  await page.goto('/d/start');
  const notOpen = page.getByText('لا توجد وردية مفتوحة في قاعة ريماس الآن. اطلب من المشرف فتح الوردية.');
  await expect(notOpen).toBeVisible();
  await expect(page.locator('#duty-start')).toBeDisabled();

  // the supervisor opens the shift; «تحديث» re-reads it
  setShift('open');
  await page.getByRole('button', { name: 'تحديث', exact: true }).click();
  await expect(page.getByText(/^الوردية: مفتوحة منذ/)).toBeVisible();
  await expect(page.locator('#duty-start')).toBeEnabled();

  // …and closes it again before the press: the server refuses, the screen follows the server
  setShift('closed');
  await page.locator('#duty-start').click();
  await pressCommand(
    fake,
    'POST /v1/me/duty/start',
    page.getByRole('alertdialog').getByRole('button', { name: 'البدء دون اختبار' }),
    { pending: page.locator('#duty-start'), expectStatus: 409 },
  );
  await expect(page.getByText(TEXT.SHIFT_NOT_OPEN)).toBeVisible();
  await expect(notOpen).toBeVisible();
  await expect(page.locator('#duty-start')).toBeDisabled();
  await expect(page).toHaveURL(/\/d\/start$/);
  expect(fake.world.duties).toHaveLength(0);
});

test('D-09: a broadcast taken first by another driver — TASK_ALREADY_CLAIMED removes the card with the 08 text', async ({
  browser,
}) => {
  const fake = createFake();
  // DRV3 parks a car and takes a break; DRV1 and DRV2 are each busy with an intake → the request is broadcast
  startDuty(fake, 'DRV3');
  const parked = arrangeParked(fake, 'DRV3');
  fake.exec('DRV3', 'POST /v1/me/duty/break', {}, { active: true });
  for (const driver of ['DRV1', 'DRV2'] as const) {
    startDuty(fake, driver);
    fake.exec(driver, 'POST /v1/tickets', {}, { event_id: EVENT_R1 });
  }
  requestRetrieval(fake, parked.ticketId);
  expect(offerOf(fake, parked.ticketId)).toMatchObject({ mode: 'broadcast' });

  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto('/d');
  const offer = page.getByRole('region', { name: `طلب إحضار جديد، تذكرة ${parked.displayNumber}` });
  await expect(offer).toContainText('طلب إحضار — لكل السائقين');
  // DRV2 reserves it while DRV1's press is still on the wire
  fake.delayNext('POST /v1/task-offers/:offerId/accept', 800);
  await offer.getByRole('button', { name: 'حجز كمهمة تالية' }).click();
  acceptOfferOf(fake, 'DRV2', parked.ticketId);
  await expect(page.getByText(TEXT.TASK_ALREADY_CLAIMED)).toBeVisible();
  await expect(offer).toHaveCount(0);
  await expect(page.getByText('لا توجد طلبات إحضار الآن')).toBeVisible();
  const calls = fake.callsTo('POST /v1/task-offers/:offerId/accept');
  expect(calls).toHaveLength(1);
  expect(calls[0]?.status).toBe(409);
  expect(
    fake.world.tasks.find((k) => k.ticket_id === parked.ticketId && k.type === 'retrieve'),
  ).toMatchObject({ status: 'assigned_waiting', assignee_id: SEED_IDS.users.DRV2 });
});

test('D-05/D-06: serial and key tag in use inline, a dropped photo upload retaken, an acknowledged incomplete inspection', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const fake = createFake();
  startDuty(fake, 'DRV2');
  arrangeSubmitted(fake, 'DRV2', { serial: '004522', keyTag: '61' }); // an open ticket of the same event
  startDuty(fake, 'DRV1');
  await fake.attach(page, 'DRV1');
  await page.goto('/d');
  await page.locator('#intake-start').click();
  await page
    .getByRole('dialog', { name: 'لأي حفل هذه المركبة؟' })
    .getByRole('button', { name: /حفل تجريبي — ريماس 1/ })
    .click();
  await expect(page).toHaveURL(/\/vehicle$/);

  // D-05 — the stub number of the other ticket
  for (const letter of ['ب B', 'ح J', 'د D'])
    await page.getByRole('button', { name: letter, exact: true }).click();
  await page.locator('#plate-digits').fill('1234');
  await page.getByLabel('الشركة المصنعة').selectOption('toyota');
  await page.getByRole('radio', { name: 'أبيض' }).click();
  await page.getByRole('radio', { name: 'تذكرة ورقية' }).click();
  await page.getByLabel('رقم التذكرة الورقية').fill('004522');
  await pressCommand(fake, 'PATCH /v1/tickets/:ticketId/intake', page.locator('#intake-next'), {
    expectStatus: 409,
  });
  await expect(page.getByText(TEXT.PAPER_SERIAL_IN_USE)).toBeVisible();
  await expect(page).toHaveURL(/\/vehicle$/);
  await page.getByLabel('رقم التذكرة الورقية').fill('004530');
  await pressCommand(fake, 'PATCH /v1/tickets/:ticketId/intake', page.locator('#intake-next'));
  await expect(page).toHaveURL(/\/key-photos$/);

  // D-06 — an upload that drops twice (the automatic retry included) fails with the 08 text; a retake works
  fake.failNext(`PUT ${STORAGE_PREFIX}:mediaId`, 'abort', 2);
  await page.getByLabel('تصوير الأمام').setInputFiles(PHOTO);
  await expect(page.getByText(`الأمام: ${TEXT.MEDIA_UPLOAD_INCOMPLETE}`)).toBeVisible({ timeout: 15_000 });
  await page.getByLabel('إعادة تصوير الأمام').setInputFiles(PHOTO);
  await page.getByLabel('تصوير الخلف').setInputFiles(PHOTO);
  await expect(page.getByRole('heading', { name: 'صور الحالة (2 من 4)' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('الفحص غير مكتمل: 2 من 4 صور.')).toBeVisible();

  // the key tag of the other open ticket
  await page.getByLabel('رقم علاقة المفتاح').fill('61');
  await pressCommand(fake, 'PATCH /v1/tickets/:ticketId/intake', page.locator('#intake-submit'), {
    expectStatus: 409,
  });
  await expect(page.getByText(TEXT.KEY_TAG_IN_USE)).toBeVisible();
  await page.getByLabel('رقم علاقة المفتاح').fill('62');
  await pressCommand(fake, 'POST /v1/tickets/:ticketId/submit-intake', page.locator('#intake-submit'), {
    expectStatus: 409,
  });

  // INSPECTION_INCOMPLETE: continue and notify the supervisor (DEC-31)
  const dialog = page.getByRole('alertdialog', {
    name: 'الفحص غير مكتمل (2 من 4 صور). المتابعة ستُبلغ المشرف لاعتماد استثناء.',
  });
  await expect(dialog).toBeVisible();
  const call = await pressCommand(
    fake,
    'POST /v1/tickets/:ticketId/submit-intake',
    dialog.getByRole('button', { name: 'متابعة وإبلاغ المشرف' }),
    { pending: page.locator('#intake-submit') },
  );
  expect(call.body).toMatchObject({ acknowledge_incomplete_inspection: true });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('تذكرة ورقية · #2');
  const ticket = fake.world.tickets.find((t) => t.created_by === SEED_IDS.users.DRV1);
  expect(ticket).toMatchObject({
    status: 'parking',
    paper_serial: '004530',
    key_tag: '62',
    inspection_status: 'incomplete',
  });
});

test('D-05: an empty draft is cancelled; a draft with data answers DRAFT_HAS_DATA and stays', async ({
  page,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  await fake.attach(page, 'DRV1');
  const startIntake = async () => {
    await page.goto('/d');
    await page.locator('#intake-start').click();
    await page
      .getByRole('dialog', { name: 'لأي حفل هذه المركبة؟' })
      .getByRole('button', { name: /حفل تجريبي — ريماس 1/ })
      .click();
    await expect(page).toHaveURL(/\/vehicle$/);
  };
  const cancel = async (status: number) => {
    await page.locator('#intake-cancel').click();
    const confirm = page.getByRole('alertdialog', { name: 'إلغاء الاستلام؟' });
    await pressCommand(
      fake,
      'POST /v1/tickets/:ticketId/discard-draft',
      confirm.getByRole('button', { name: 'إلغاء الاستلام' }),
      { expectStatus: status },
    );
  };

  await startIntake();
  await cancel(200);
  await expect(page.getByText('أُلغي الاستلام')).toBeVisible();
  await expect(page).toHaveURL(/\/d$/);
  expect(fake.world.tickets[0]).toMatchObject({ status: 'voided', void_reason: 'empty_draft' });

  await startIntake();
  for (const letter of ['ر R', 'س S', 'ص X'])
    await page.getByRole('button', { name: letter, exact: true }).click();
  await page.locator('#plate-digits').fill('77');
  await page.getByLabel('الشركة المصنعة').selectOption('kia');
  await page.getByRole('radio', { name: 'أسود' }).click();
  await page.getByRole('radio', { name: 'تذكرة ورقية' }).click();
  await page.getByLabel('رقم التذكرة الورقية').fill('004540');
  await pressCommand(fake, 'PATCH /v1/tickets/:ticketId/intake', page.locator('#intake-next'));
  await expect(page).toHaveURL(/\/key-photos$/);
  await cancel(409);
  const ack = page.getByRole('alertdialog', { name: TEXT.DRAFT_HAS_DATA });
  await expect(ack).toBeVisible();
  await ack.getByRole('button', { name: 'فهمت' }).click();
  await expect(ack).toHaveCount(0);
  await expect(page).toHaveURL(/\/key-photos$/);
  expect(fake.world.tickets[1]).toMatchObject({ status: 'received' });
});

test('D-08: the spot taken meanwhile — PARKING_SPOT_OCCUPIED under the grid, which re-reads the occupancy', async ({
  page,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  startDuty(fake, 'DRV2');
  const mine = arrangeSubmitted(fake, 'DRV1', { serial: '004601', keyTag: '71' });
  const other = arrangeSubmitted(fake, 'DRV2', { serial: '004602', keyTag: '72' });
  await fake.attach(page, 'DRV1');
  await page.goto(`/d/tasks/${mine.parkTaskId}/park`);
  await expect(page.getByRole('radio', { name: 'A-03', exact: true })).toBeEnabled();

  // DRV2 parks in A-03 while DRV1's grid still shows it free
  parkTask(fake, 'DRV2', other.parkTaskId, 'A-03', '13');
  await page.getByRole('radio', { name: 'A-03', exact: true }).click();
  await page.getByRole('radio', { name: '12', exact: true }).click();
  await page.getByLabel('أودعت المفتاح في الخانة المختارة').check();
  await pressCommand(fake, 'POST /v1/tasks/:taskId/complete-parking', page.locator('#park-submit'), {
    expectStatus: 409,
  });
  await expect(page.getByText(TEXT.PARKING_SPOT_OCCUPIED)).toBeVisible();
  await expect(page.getByRole('radio', { name: 'A-03 مشغول' })).toBeDisabled();

  await page.getByRole('radio', { name: 'A-04', exact: true }).click();
  await pressCommand(fake, 'POST /v1/tasks/:taskId/complete-parking', page.locator('#park-submit'));
  await expect(page.getByText(`تم صف #${mine.displayNumber}`)).toBeVisible();
  const spot = (label: string) => fake.world.spots.find((s) => s.label === label && s.venue_id === RMS);
  expect(spot('A-03')?.ticket_id).toBe(other.ticketId);
  expect(spot('A-04')?.ticket_id).toBe(mine.ticketId);
});

test('D-10: the key is not where the system has it — CUSTODY_HOLDER_MISMATCH stops on a dialog', async ({
  page,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const r = arrangeRetrieval(fake, 'DRV1', 'accepted');
  await fake.attach(page, 'DRV1');
  await page.goto(`/d/tasks/${r.taskId}`);
  fake.failNext(
    'POST /v1/tasks/:taskId/key-pickup',
    errorReply('CUSTODY_HOLDER_MISMATCH', { subject: 'key', current_holder_type: 'supervisor' }),
  );
  await pressCommand(
    fake,
    'POST /v1/tasks/:taskId/key-pickup',
    page.getByRole('button', { name: 'استلمت المفتاح' }),
    { expectStatus: 409 },
  );
  const dialog = page.getByRole('alertdialog', { name: TEXT.CUSTODY_HOLDER_MISMATCH });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'فهمت' }).click();
  await expect(dialog).toHaveCount(0);
  // nothing moved: the step is still the key, with the press available again
  await expect(page.getByRole('button', { name: 'استلمت المفتاح' })).toBeEnabled();
  expect(fake.world.tickets.find((t) => t.id === r.ticketId)?.key_holder.type).toBe('key_slot');
});

test('D-11: the collection is checked first, a wrong stub shows inline, then cash and the handover', async ({
  page,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const r = arrangeRetrieval(fake, 'DRV1', 'ready', { eventId: EVENT_R2, serial: '007001' });
  await fake.attach(page, 'DRV1');
  await page.goto(`/d/tickets/${r.ticketId}/handover`);
  await expect(page.getByText(/المبلغ المستحق: 20\.00/)).toBeVisible();
  await page.getByLabel('رقم الكعب').fill('007009');

  // «استلمت المبلغ» not ticked: refused locally with the 08 text, nothing sent
  await page.locator('#handover-submit').click();
  await expect(page.getByText(TEXT.PAYMENT_PENDING)).toBeVisible();
  expect(fake.callsTo('POST /v1/tickets/:ticketId/handover')).toHaveLength(0);

  await page.getByLabel('استلمت المبلغ').check();
  await pressCommand(fake, 'POST /v1/tickets/:ticketId/handover', page.locator('#handover-submit'), {
    expectStatus: 422,
  });
  await expect(page.getByText(TEXT.PAPER_STUB_MISMATCH)).toBeVisible();

  await page.getByLabel('رقم الكعب').fill('007001');
  const call = await pressCommand(
    fake,
    'POST /v1/tickets/:ticketId/handover',
    page.locator('#handover-submit'),
  );
  expect(call.body).toMatchObject({
    verification: { method: 'paper_stub', paper_serial: '007001' },
    payment: { method: 'cash', amount_halalas: 2000 },
  });
  await expect(page.getByText(`تم تسليم #${r.displayNumber}`)).toBeVisible();
  expect(fake.world.payments).toEqual([
    expect.objectContaining({
      ticket_id: r.ticketId,
      method: 'cash',
      amount_halalas: 2000,
      collected_by: SEED_IDS.users.DRV1,
    }),
  ]);
});

test('D-11: wrong stubs count against handover.max_attempts; the lock stops the handover', async ({
  page,
}) => {
  const fake = createFake();
  const rms = fake.world.venues.find((v) => v.id === RMS);
  if (rms) rms.settings = { handover: { max_attempts: 2 } };
  startDuty(fake, 'DRV1');
  const r = arrangeRetrieval(fake, 'DRV1', 'ready', { serial: '007101' });
  await fake.attach(page, 'DRV1');
  await page.goto(`/d/tickets/${r.ticketId}/handover`);
  const stub = page.getByLabel('رقم الكعب');
  await stub.fill('007100');
  await pressCommand(fake, 'POST /v1/tickets/:ticketId/handover', page.locator('#handover-submit'), {
    expectStatus: 422,
  });
  await expect(page.getByText(TEXT.PAPER_STUB_MISMATCH)).toBeVisible();
  await stub.fill('007102');
  await pressCommand(fake, 'POST /v1/tickets/:ticketId/handover', page.locator('#handover-submit'), {
    expectStatus: 423,
  });
  await expect(page.getByText(TEXT.HANDOVER_CODE_LOCKED)).toBeVisible();
  await expect(stub).toBeDisabled();
  await expect(page.locator('#handover-submit')).toBeDisabled();
  expect(fake.world.tickets.find((t) => t.id === r.ticketId)?.status).toBe('ready');
});
