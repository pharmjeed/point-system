import { expect, test, type Page } from '@playwright/test';
import { errorMessagesAr } from '../src/i18n/errors';
import { actorPage, expectCommandContract } from './support/actors';
import { browserStorageDump, runOnlyAt390 } from './support/checks';
import { createFake, errorReply, SEED_IDS } from './support/fake';

/**
 * PNT-023 — setup screens S-08, S-09 and the basic S-05/S-06 against the fake backend (07 shapes, 08 errors).
 * Acceptance 1: the venue RMS is prepared for a full event from the UI — layout by the administration
 * (`venue.manage` is owner/admin only, canon §10; supervisors see S-09 read-only, 02 §2.2), event and shift by
 * the supervisor. Acceptance 2: actions the actor may not take are not shown.
 */
runOnlyAt390();

const RMS = SEED_IDS.venues.RMS;
const sheet = (page: Page) => page.getByRole('dialog');

async function submitSheet(page: Page, label: string) {
  await sheet(page).getByRole('button', { name: label, exact: true }).click();
  await expect(sheet(page)).toBeHidden();
}

test('a supervisor and the administration prepare RMS for a full event from the UI', async ({ browser }) => {
  const fake = createFake({ layout: false, events: [], shifts: false });

  // --- administration: zones, spots, key board and slots (S-09)
  const admin = await actorPage(browser, fake, 'ADM1');
  await admin.page.goto('/venues');
  await admin.page.getByRole('link', { name: /قاعة ريماس/ }).click();
  await expect(admin.page).toHaveURL(new RegExp(`/venues/${RMS}$`));
  await admin.page.getByRole('button', { name: 'إعداد الموقع' }).click();
  await admin.page.getByRole('link', { name: /المناطق والمواقف/ }).click();
  await admin.page.getByRole('button', { name: 'منطقة جديدة' }).click();
  await sheet(admin.page).getByLabel('اسم المنطقة').fill('A');
  await submitSheet(admin.page, 'منطقة جديدة');
  const zone = admin.page.getByRole('article', { name: 'A' });
  await zone.getByRole('button', { name: 'إضافة مواقف' }).click();
  await expect(sheet(admin.page).getByLabel('البادئة')).toHaveValue('A-');
  await sheet(admin.page).getByLabel('إلى').fill('12');
  await submitSheet(admin.page, 'إضافة مواقف');
  await expect(zone.getByRole('button', { name: 'A-12' })).toBeVisible();
  await expect(zone.getByText('المواقف: 12')).toBeVisible();

  await admin.page.getByRole('button', { name: 'رجوع' }).click();
  await admin.page.getByRole('link', { name: /لوحات المفاتيح/ }).click();
  await admin.page.getByRole('button', { name: 'لوحة جديدة' }).click();
  await sheet(admin.page).getByLabel('اسم اللوحة').fill('لوحة 1');
  await submitSheet(admin.page, 'لوحة جديدة');
  const board = admin.page.getByRole('article', { name: 'لوحة 1' });
  await board.getByRole('button', { name: 'إضافة خانات' }).click();
  await sheet(admin.page).getByLabel('إلى').fill('12');
  await submitSheet(admin.page, 'إضافة خانات');
  await expect(board.getByText('الخانات: 12')).toBeVisible();

  // --- supervisor: event and shift (S-08)
  const sup = await actorPage(browser, fake, 'SUP-R');
  await sup.page.goto('/venues');
  await expect(sup.page.getByRole('button', { name: 'موقع جديد' })).toHaveCount(0);
  await sup.page.getByRole('link', { name: /قاعة ريماس/ }).click();
  await expect(sup.page.getByRole('button', { name: 'تعديل الموقع' })).toHaveCount(0);
  await sup.page.getByRole('button', { name: 'حفل جديد' }).click();
  const form = sheet(sup.page);
  await form.getByLabel('اسم الحفل').fill('حفل زواج آل فلان');
  await form.getByLabel('البداية').fill('19:00');
  await form.getByLabel('النهاية').fill('01:30');
  await form.getByRole('radio', { name: 'رسوم لكل مركبة' }).click();
  await form.getByLabel('المبلغ').fill('20');
  await submitSheet(sup.page, 'حفل جديد');
  const event = sup.page.getByRole('article', { name: 'حفل زواج آل فلان' });
  await expect(event.getByText('مسودة')).toBeVisible();
  await expect(event.getByText(/20\.00 ر\.س لكل مركبة/)).toBeVisible();
  await event.getByRole('button', { name: 'فتح' }).click();
  await expect(event.getByText('مفتوح', { exact: true })).toBeVisible();

  await sup.page.getByRole('radio', { name: 'الورديات' }).click();
  await sup.page.getByRole('button', { name: 'وردية جديدة' }).click();
  await sheet(sup.page).getByLabel('اسم الوردية (اختياري)').fill('وردية الخميس');
  await submitSheet(sup.page, 'وردية جديدة');
  const shift = sup.page.getByRole('article', { name: 'وردية الخميس' });
  await expect(shift.getByText('مجدولة')).toBeVisible();
  await shift.getByRole('button', { name: 'فتح الوردية' }).click();
  await expect(shift.getByText('مفتوحة')).toBeVisible();

  // --- the supervisor sees the layout read-only (02 §2.2)
  await sup.page.getByRole('button', { name: 'إعداد الموقع' }).click();
  await sup.page.getByRole('link', { name: /المناطق والمواقف/ }).click();
  await expect(sup.page.getByRole('article', { name: 'A' }).getByText('A-01', { exact: true })).toBeVisible();
  await expect(sup.page.getByRole('button', { name: 'A-01' })).toHaveCount(0);
  await expect(sup.page.getByRole('button', { name: 'منطقة جديدة' })).toHaveCount(0);
  await expect(sup.page.getByRole('button', { name: 'إضافة مواقف' })).toHaveCount(0);

  // --- what the server now holds
  const w = fake.world;
  const created = w.events.find((e) => e.name_ar === 'حفل زواج آل فلان');
  expect(created).toMatchObject({ status: 'open', pricing_mode: 'per_vehicle', fee_halalas: 2000 });
  expect(Date.parse(created?.ends_at ?? '') - Date.parse(created?.starts_at ?? '')).toBe(6.5 * 3600_000);
  expect(w.shifts.find((s) => s.name === 'وردية الخميس')?.status).toBe('open');
  expect(w.spots.filter((s) => s.venue_id === RMS).map((s) => s.label)).toEqual(
    Array.from({ length: 12 }, (_, i) => `A-${String(i + 1).padStart(2, '0')}`),
  );
  expect(w.slots.filter((s) => s.venue_id === RMS)).toHaveLength(12);
  expectCommandContract(fake, [
    'POST /v1/venues/:venueId/parking-zones',
    'POST /v1/venues/:venueId/parking-spots',
    'POST /v1/venues/:venueId/key-boards',
    'POST /v1/key-boards/:boardId/slots',
    'POST /v1/venues/:venueId/events',
    'POST /v1/events/:eventId/open',
    'POST /v1/venues/:venueId/shifts',
    'POST /v1/shifts/:shiftId/open',
  ]);
});

test('buttons the actor may not use are hidden (supervisor vs administration)', async ({ browser }) => {
  const fake = createFake();
  const sup = await actorPage(browser, fake, 'SUP-R');
  // S-09 settings: read-only, no «حفظ»
  await sup.page.goto(`/venues/${RMS}/setup?section=timers`);
  await expect(sup.page.getByLabel('انتهاء العرض الفردي')).toBeDisabled();
  await expect(sup.page.getByRole('button', { name: 'حفظ' })).toHaveCount(0);
  await sup.page.goto(`/venues/${RMS}/setup?section=keys`);
  await expect(sup.page.getByRole('article', { name: 'لوحة 1' })).toBeVisible();
  await expect(sup.page.getByRole('button', { name: 'لوحة جديدة' })).toHaveCount(0);
  await expect(sup.page.getByRole('button', { name: 'إضافة خانات' })).toHaveCount(0);
  await sup.page.goto(`/venues/${RMS}/setup?section=pools`);
  await expect(sup.page.getByRole('button', { name: 'مجموعة جديدة' })).toHaveCount(0);
  // S-05 / S-06: no account management for supervisors
  await sup.page.goto('/drivers');
  await expect(sup.page.getByRole('link', { name: /سائق 1/ })).toBeVisible();
  await expect(sup.page.getByRole('button', { name: 'إضافة سائق' })).toHaveCount(0);
  await sup.page.getByRole('link', { name: /سائق 1/ }).click();
  await expect(sup.page.getByRole('heading', { name: 'سائق 1' })).toBeVisible();
  for (const label of ['تعديل البيانات', 'تعطيل الحساب', 'إعادة تعيين الرقم السري', 'تعيين على موقع'])
    await expect(sup.page.getByRole('button', { name: label })).toHaveCount(0);
  // events and shifts are the supervisor's (event.manage, shift.manage)
  await sup.page.goto(`/venues/${RMS}`);
  await expect(sup.page.getByRole('button', { name: 'حفل جديد' })).toBeVisible();

  const admin = await actorPage(browser, fake, 'ADM1');
  await admin.page.goto(`/venues/${RMS}/setup?section=timers`);
  await expect(admin.page.getByLabel('انتهاء العرض الفردي')).toBeEnabled();
  await expect(admin.page.getByRole('button', { name: 'حفظ' })).toBeVisible();
  await admin.page.goto('/drivers');
  await expect(admin.page.getByRole('button', { name: 'إضافة سائق' })).toBeVisible();
  await admin.page.goto(`/drivers/${SEED_IDS.users.DRV1}`);
  for (const label of ['تعديل البيانات', 'تعطيل الحساب', 'إعادة تعيين الرقم السري'])
    await expect(admin.page.getByRole('button', { name: label })).toBeVisible();
  // the seeded driver has an active assignment: assigning again is not offered (S-07 transfers instead)
  await expect(admin.page.getByRole('button', { name: 'تعيين على موقع' })).toHaveCount(0);
});

test('closing a shift blocked by a driver holding custody lists the blocking driver (SHIFT_CLOSE_BLOCKED)', async ({
  browser,
}) => {
  const fake = createFake();
  const drv1 = fake.userByKey('DRV1');
  const event = fake.world.events.find((e) => e.id === SEED_IDS.events['EVT-R1']);
  fake.world.duties.push({
    id: 'duty-drv1',
    user_id: drv1.id,
    shift_id: SEED_IDS.shifts['SHF-R'],
    venue_id: RMS,
    dispatch_pool_id: SEED_IDS.pools['POOL-R'],
    status: 'on_duty',
    started_at: new Date().toISOString(),
    ended_at: null,
    end_reason: null,
    available_since: null,
    version: 1,
  });
  fake.world.tickets.push({
    ...ticketHeldBy(drv1.id, event?.id ?? ''),
  });
  const sup = await actorPage(browser, fake, 'SUP-R');
  await sup.page.goto(`/venues/${RMS}?tab=shifts`);
  const shift = sup.page.getByRole('article', { name: 'وردية ريماس' });
  await shift.getByRole('button', { name: 'إغلاق الوردية' }).click();
  const dialog = sup.page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'إغلاق الوردية' }).click();
  await expect(dialog.getByText(errorMessagesAr.SHIFT_CLOSE_BLOCKED)).toBeVisible();
  const blocking = dialog.getByTestId('blocking-drivers');
  await expect(blocking).toContainText('سائق 1');
  await expect(blocking).toContainText('D-0001');
  await expect(blocking).toContainText('مركبة');
  await expect(blocking).toContainText('#7');
  expect(fake.world.shifts.find((s) => s.id === SEED_IDS.shifts['SHF-R'])?.status).toBe('open');
});

test('adding a driver shows the temporary PIN once and never stores it', async ({ browser }) => {
  const fake = createFake();
  const admin = await actorPage(browser, fake, 'ADM1');
  await admin.page.goto('/drivers');
  await admin.page.getByRole('button', { name: 'إضافة سائق' }).click();
  const form = sheet(admin.page);
  await form.getByLabel('الاسم الكامل').fill('ماجد الزهراني');
  await form.getByLabel('رقم الجوال').fill('0551119988');
  await form.getByLabel('الموقع الأولي (اختياري)').selectOption({ label: 'قاعة ليلتي' });
  await form.getByRole('button', { name: 'إضافة سائق' }).click();
  const created = fake.world.users.find((u) => u.full_name === 'ماجد الزهراني');
  expect(created).toMatchObject({ phone_e164: '+966551119988', must_change_secret: true });
  const pin = created?.secret ?? '';
  const dialog = admin.page.getByRole('alertdialog');
  await expect(dialog).toContainText(`الرقم السري المؤقت: ${pin}.`);
  expect(fake.world.assignments.find((a) => a.driver_id === created?.id)?.venue_id).toBe(SEED_IDS.venues.LYL);
  expect(await browserStorageDump(admin.page)).not.toContain(pin);
  await dialog.getByRole('button', { name: 'فهمت' }).click();
  await expect(admin.page.getByText(pin)).toHaveCount(0);
  await expect(admin.page.getByRole('link', { name: /ماجد الزهراني/ })).toBeVisible();
});

test('assigning a driver who already has an active assignment shows ASSIGNMENT_CONFLICT', async ({
  browser,
}) => {
  const fake = createFake();
  const free = fake.userByKey('DRV8');
  fake.world.assignments = fake.world.assignments.filter((a) => a.driver_id !== free.id);
  fake.failNext(
    'POST /v1/drivers/:driverId/assignments',
    errorReply('ASSIGNMENT_CONFLICT', { active_assignment_id: 'a-x', venue_id: SEED_IDS.venues.LYL }),
  );
  const admin = await actorPage(browser, fake, 'ADM1');
  await admin.page.goto(`/drivers/${free.id}`);
  await admin.page.getByRole('button', { name: 'تعيين على موقع' }).click();
  await sheet(admin.page).getByLabel('الموقع').selectOption({ label: 'قاعة ريماس' });
  await sheet(admin.page).getByRole('button', { name: 'تعيين على موقع' }).click();
  await expect(sheet(admin.page).getByText(errorMessagesAr.ASSIGNMENT_CONFLICT)).toBeVisible();
  // a second press is a new intent: the real assignment goes through
  await sheet(admin.page).getByRole('button', { name: 'تعيين على موقع' }).click();
  await expect(sheet(admin.page)).toBeHidden();
  expect(fake.world.assignments.find((a) => a.driver_id === free.id)?.venue_id).toBe(RMS);
  const keys = fake
    .callsTo('POST /v1/drivers/:driverId/assignments')
    .map((c) => c.headers['idempotency-key']);
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]);
});

test('disabling a driver who holds a key lists the items (CUSTODY_OPEN); reset-secret shows the PIN once', async ({
  browser,
}) => {
  const fake = createFake();
  const drv2 = fake.userByKey('DRV2');
  fake.world.tickets.push({
    ...ticketHeldBy(drv2.id, SEED_IDS.events['EVT-R1']),
    id: 't-key',
    display_number: 9,
  });
  const admin = await actorPage(browser, fake, 'ADM1');
  await admin.page.goto(`/drivers/${drv2.id}`);
  await admin.page.getByRole('button', { name: 'تعطيل الحساب' }).click();
  const dialog = admin.page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'تعطيل الحساب' }).click();
  await expect(dialog.getByText(errorMessagesAr.REASON_REQUIRED)).toBeVisible();
  await dialog.getByLabel('السبب (إلزامي)').fill('انتهاء العقد');
  await dialog.getByRole('button', { name: 'تعطيل الحساب' }).click();
  await expect(dialog.getByText(errorMessagesAr.CUSTODY_OPEN)).toBeVisible();
  await expect(dialog).toContainText('#9');
  expect(drv2.status).toBe('active');
  await dialog.getByRole('button', { name: 'إلغاء' }).click();

  await admin.page.getByRole('button', { name: 'إعادة تعيين الرقم السري' }).click();
  await expect(admin.page.getByRole('alertdialog')).toContainText(`الرقم السري المؤقت: ${drv2.secret}.`);
  expect(drv2.must_change_secret).toBe(true);
});

test('event form: local pricing checks, server field errors and a cancel with a reason', async ({
  browser,
}) => {
  const fake = createFake();
  const sup = await actorPage(browser, fake, 'SUP-R');
  await sup.page.goto(`/venues/${RMS}`);
  await sup.page.getByRole('button', { name: 'حفل جديد' }).click();
  const form = sheet(sup.page);
  await form.getByLabel('اسم الحفل').fill('حفل تخرج');
  await form.getByRole('radio', { name: 'رسوم لكل مركبة' }).click();
  await form.getByRole('button', { name: 'حفل جديد' }).click();
  await expect(form.getByText('راجع الحقول المظللة.')).toBeVisible(); // amount required when charged
  expect(fake.callsTo('POST /v1/venues/:venueId/events')).toHaveLength(0);
  fake.failNext(
    'POST /v1/venues/:venueId/events',
    errorReply('VALIDATION_FAILED', {
      fields: [{ field: 'name_ar', issue: 'duplicate', message_ar: 'الاسم مستخدم.' }],
    }),
  );
  await form.getByLabel('المبلغ').fill('15');
  await form.getByRole('button', { name: 'حفل جديد' }).click();
  await expect(form.getByText('الاسم مستخدم.')).toBeVisible();
  await form.getByRole('button', { name: 'حفل جديد' }).click();
  await expect(form).toBeHidden();

  const card = sup.page.getByRole('article', { name: 'حفل تخرج' });
  await card.getByRole('button', { name: 'إلغاء' }).click();
  const dialog = sup.page.getByRole('alertdialog');
  await dialog.getByLabel('السبب (إلزامي)').fill('أُلغي الحجز');
  await dialog.getByRole('button', { name: 'إلغاء الحفل' }).click();
  await expect(dialog).toBeHidden();
  await sup.page.getByRole('radio', { name: 'المغلقة' }).click();
  await expect(sup.page.getByRole('article', { name: 'حفل تخرج' }).getByText('ملغى')).toBeVisible();
  expect(fake.world.events.find((e) => e.name_ar === 'حفل تخرج')).toMatchObject({
    status: 'canceled',
    cancel_reason: 'أُلغي الحجز',
    fee_halalas: 1500,
  });
});

test('settings: range checks, save with expected_version, VERSION_CONFLICT keeps the input', async ({
  browser,
}) => {
  const fake = createFake();
  const admin = await actorPage(browser, fake, 'ADM1');
  await admin.page.goto(`/venues/${RMS}/setup?section=timers`);
  const ttl = admin.page.getByLabel('انتهاء العرض الفردي');
  const reminder = admin.page.getByLabel('تذكير العرض الفردي');
  await expect(ttl).toHaveValue('30');
  await reminder.fill('28');
  await admin.page.getByRole('button', { name: 'حفظ' }).click();
  await expect(
    admin.page.getByText('مهلة العرض الفردي أكبر من تذكيره، وكل القيم أعداد موجبة.'),
  ).toBeVisible();
  expect(fake.callsTo('PUT /v1/venues/:venueId/settings')).toHaveLength(0);

  await reminder.fill('20');
  await ttl.fill('45');
  fake.failNext(
    'PUT /v1/venues/:venueId/settings',
    errorReply('VERSION_CONFLICT', { entity: 'venue_settings', id: RMS, current_version: 2 }),
  );
  await admin.page.getByRole('button', { name: 'حفظ' }).click();
  await expect(admin.page.getByText(errorMessagesAr.VERSION_CONFLICT)).toBeVisible();
  await expect(ttl).toHaveValue('45'); // the typed value survives the refetch

  await admin.page.getByRole('button', { name: 'حفظ' }).click();
  await expect(admin.page.getByText('تم الحفظ.')).toBeVisible();
  const venue = fake.world.venues.find((v) => v.id === RMS);
  expect(venue?.settings.dispatch).toMatchObject({ single_offer_ttl_s: 45, single_offer_reminder_s: 20 });
  const puts = fake.callsTo('PUT /v1/venues/:venueId/settings');
  expect(puts.map((c) => (c.body as { expected_version: number }).expected_version)).toEqual([1, 1]);
});

function ticketHeldBy(driverId: string, eventId: string) {
  return {
    id: 't-held',
    display_number: 7,
    event_id: eventId,
    venue_id: RMS,
    status: 'parking' as const,
    channel: 'paper' as const,
    plate_country: 'SA',
    plate_digits: '1234',
    plate_letters_ar: 'ب ح د',
    plate_letters_en: 'B J D',
    plate_raw: null,
    vehicle_make: 'toyota',
    vehicle_model: null,
    vehicle_color: 'white',
    customer_phone: null,
    consent: false,
    wa_link_status: 'none' as const,
    paper_serial: '004521',
    key_tag: '57',
    notes: null,
    inspection_status: 'complete' as const,
    payment_status: 'not_required' as const,
    fee_halalas: 0,
    spot_id: null,
    spot_note: null,
    key_slot_id: null,
    vehicle_holder: { type: 'driver', id: driverId },
    key_holder: { type: 'driver', id: driverId },
    created_by: driverId,
    parked_by: null,
    retrieved_by: null,
    delivered_by: null,
    submitted_at: null,
    parked_at: null,
    delivered_at: null,
    voided_at: null,
    void_reason: null,
    pending_retrieval_at: null,
    claim: null,
    version: 3,
    created_at: new Date().toISOString(),
  };
}
