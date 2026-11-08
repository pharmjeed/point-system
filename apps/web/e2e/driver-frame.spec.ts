import { expect, test, type Page } from '@playwright/test';
import { errorMessagesAr } from '../src/i18n/errors';
import { actorPage } from './support/actors';
import { fakeOnly } from './support/backend';
import { runOnlyAt390 } from './support/checks';
import {
  acceptOfferOf,
  arrangeRetrieval,
  arrangeSubmitted,
  EVENT_R1,
  EVENT_R2,
  requestRetrieval,
  startDuty,
} from './support/driver';
import { audioLog, installFakeAudio } from './support/fakeAudio';
import { createFake, errorReply, type FakeServer } from './support/fake';
import { busyDriver, expectOneOffer, offerCardOf, parkedCars } from './support/live';

/**
 * The live parts the driver frame owns on every screen (the S5 review): a request on D-12/D-13/D-14 (the
 * banner, the badge on «الرئيسية», D-09 in a Sheet), the promotion of the reserved next task away from D-04
 * (`next_due` + «بدأت مهمتك التالية»), the 14 §5.1 notices (cancel without a sound, withdrawal with
 * `reminder`, the DEC-30 repark → D-08 with `next_due`, the early request during parking with `reminder`),
 * D-15 ح on SERVICE_UNAVAILABLE, «الاتصال غير مؤكد» closing accept/reserve and handover (03 §4.4), and a
 * socket the server closed (`io server disconnect`) connected again.
 */
runOnlyAt390();
fakeOnly();

const NAV_HOME = (page: Page) => page.getByRole('navigation').getByRole('link', { name: /الرئيسية/ });

async function unlockSound(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'تفعيل الصوت' }).click();
  await expect.poll(async () => (await audioLog(page)).started).toContain('test');
}

async function connected(fake: FakeServer): Promise<void> {
  await expect.poll(() => fake.realtime.connectedUsers().length).toBe(1);
}

test('PNT-067: a request while on D-12 — the banner, the badge on «الرئيسية», D-09 in a Sheet; no «قبل الطلب سائق آخر» for a card never shown', async ({
  browser,
}) => {
  const fake = createFake();
  fake.realtime.enable();
  const [car, other] = parkedCars(fake, 2);
  busyDriver(fake, 'DRV1'); // an intake in hand: a broadcast offers «حجز كمهمة تالية»
  busyDriver(fake, 'DRV2');
  const { page } = await actorPage(browser, fake, 'DRV1');
  await installFakeAudio(page);
  await page.goto('/d/vehicles');
  await unlockSound(page);
  await connected(fake);
  await expect(NAV_HOME(page).locator('.pt-bottomnav__badge')).toHaveCount(0);

  requestRetrieval(fake, car!.ticketId);
  // 02 D-05's sentence (reserve as the next task), with «عرض»; the sound is the broadcast's
  const banner = page.getByRole('status').filter({ hasText: 'طلب إحضار مفتوح — يمكنك حجزه كمهمة تالية' });
  await expect(banner).toBeVisible();
  await expect(NAV_HOME(page).locator('.pt-bottomnav__badge')).toHaveText('1'); // 02 §1.4
  await expect.poll(async () => (await audioLog(page)).started).toContain('broadcast');
  await expect(offerCardOf(page)).toHaveCount(0); // D-12 stays on screen

  // taken by another driver while only the banner is up: it leaves quietly (02 D-09 «فقط إذا كانت البطاقة ظاهرة»)
  acceptOfferOf(fake, 'DRV2', car!.ticketId);
  await expect(banner).toBeHidden();
  await expect(NAV_HOME(page).locator('.pt-bottomnav__badge')).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(page.getByText('قبل الطلب سائق آخر', { exact: true })).toHaveCount(0);

  // the next one: «عرض» opens D-09 over D-12, the reservation is made from the Sheet
  requestRetrieval(fake, other!.ticketId);
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'عرض' }).click();
  const sheet = page.getByRole('dialog', { name: 'طلبات الإحضار' });
  await expectOneOffer(page, other!.displayNumber);
  await sheet.getByRole('button', { name: 'حجز كمهمة تالية' }).click();
  await expect(page.getByText('حُجز الطلب')).toBeVisible();
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(/\/d\/vehicles$/);
  expect(fake.world.tasks.find((k) => k.ticket_id === other!.ticketId && k.type === 'retrieve')?.status).toBe(
    'assigned_waiting',
  );
});

test('PNT-067/068: the promotion of the reserved next task is announced on D-14 — next_due and «بدأت مهمتك التالية»', async ({
  browser,
}) => {
  const fake = createFake();
  fake.realtime.enable();
  startDuty(fake, 'DRV1');
  const current = arrangeRetrieval(fake, 'DRV1', 'ready', { serial: '009101', keyTag: '191' });
  const [next] = parkedCars(fake, 1);
  requestRetrieval(fake, next!.ticketId); // DRV1 is busy: a broadcast DRV1 reserves as the next task
  const nextTask = acceptOfferOf(fake, 'DRV1', next!.ticketId);
  const { page } = await actorPage(browser, fake, 'DRV1');
  await installFakeAudio(page);
  await page.goto('/d/account');
  await unlockSound(page);
  await connected(fake);

  // the current handover is recorded elsewhere (the supervisor's exceptional handover, another device…)
  const ticket = fake.world.tickets.find((t) => t.id === current.ticketId)!;
  fake.exec(
    'DRV1',
    'POST /v1/tickets/:ticketId/handover',
    { ticketId: current.ticketId },
    { verification: { method: 'paper_stub', paper_serial: '009101' }, expected_version: ticket.version },
  );
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(`بدأت مهمتك التالية: #${next!.displayNumber}`);
  await expect.poll(async () => (await audioLog(page)).started).toContain('next_due');
  expect((await audioLog(page)).vibrate).toContainEqual([100, 60, 100, 60, 200]);
  await expect(page).toHaveURL(/\/d\/account$/); // D-14 is still the screen, under the modal dialog
  await dialog.getByRole('button', { name: 'الانتقال' }).click();
  await expect(page).toHaveURL(new RegExp(`/d/tasks/${nextTask}$`));
  // announced once: back on D-04 nothing is shown again
  await page.getByRole('button', { name: 'رجوع' }).click();
  await expect(page.getByRole('heading', { name: 'الرئيسية' })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect((await audioLog(page)).started.filter((s) => s === 'next_due')).toHaveLength(1);
});

test('PNT-068: a cancel of the current retrieval says so without a sound; a withdrawal is red with `reminder`', async ({
  browser,
}) => {
  const fake = createFake();
  fake.realtime.enable();
  startDuty(fake, 'DRV1');
  const first = arrangeRetrieval(fake, 'DRV1', 'accepted', { serial: '009201', keyTag: '192' });
  const { page } = await actorPage(browser, fake, 'DRV1');
  await installFakeAudio(page);
  await page.goto('/d/vehicles');
  await unlockSound(page);
  await connected(fake);
  const soundsBefore = (await audioLog(page)).started.length;

  // the supervisor cancels the request before the movement (14 §3.1 ticket.retrieval_canceled)
  const cycle = fake.world.cycles.find((c) => c.ticket_id === first.ticketId && !c.closed_at)!;
  fake.exec(
    'SUP-R',
    'POST /v1/retrieval-cycles/:cycleId/cancel',
    { cycleId: cycle.id },
    { reason: 'العميل غيّر رأيه' },
  );
  const canceled = page.locator('[data-notice="canceled"]');
  await expect(canceled).toContainText(`أُلغي طلب الإحضار — تذكرة ${first.displayNumber}`);
  await page.waitForTimeout(300);
  expect((await audioLog(page)).started).toHaveLength(soundsBefore); // «لافتة بلا صوت»
  await canceled.getByRole('button', { name: 'فهمت' }).click();
  await expect(canceled).toHaveCount(0);

  // a withdrawal before the movement (14 §3.2 task.withdrawn: a Task view without the assignee)
  const second = arrangeRetrieval(fake, 'DRV1', 'accepted', {
    serial: '009202',
    keyTag: '193',
    spot: 'A-11',
    slot: '21',
  });
  await expect
    .poll(() => fake.realtime.delivered.some((d) => d.frame.payload?.task?.id === second.taskId))
    .toBe(true);
  const soundsAtWithdrawal = (await audioLog(page)).started.length;
  // the supervisor withdraws it (10 §9): back to the queue without an assignee; the hub publishes the
  // Task view to the old assignee, as the API's planner does
  const task = fake.world.tasks.find((k) => k.id === second.taskId)!;
  task.assignee_id = null;
  task.status = 'queued';
  task.version += 1;
  fake.realtime.afterChange();
  const withdrawn = page.locator('[data-notice="withdrawn"]');
  await expect(withdrawn).toContainText(
    `سحب المشرف المهمة — تذكرة ${second.displayNumber}. لا تُحضر السيارة.`,
  );
  await expect(withdrawn.getByRole('alert')).toBeVisible();
  // `reminder` for the withdrawal (the task goes back to the queue: its next round may sound after it)
  await expect
    .poll(async () => (await audioLog(page)).started.slice(soundsAtWithdrawal))
    .toContain('reminder');
});

test('PNT-068 (DEC-30): the repark after a cancel during the movement → D-08 with next_due; the early request during parking with `reminder`', async ({
  browser,
}) => {
  const fake = createFake();
  fake.realtime.enable();
  startDuty(fake, 'DRV1');
  const moving = arrangeRetrieval(fake, 'DRV1', 'retrieving', { serial: '009301', keyTag: '194' });
  const { page } = await actorPage(browser, fake, 'DRV1');
  await installFakeAudio(page);
  await page.goto('/d');
  await unlockSound(page);
  await connected(fake);

  // TT-20b: the supervisor cancels after the start — the car stays with DRV1, who parks it again
  const w = fake.world;
  const retrieve = w.tasks.find((k) => k.id === moving.taskId)!;
  retrieve.status = 'canceled';
  retrieve.cancel_reason = 'supervisor_cancel';
  retrieve.version += 1;
  const ticket = w.tickets.find((t) => t.id === moving.ticketId)!;
  ticket.status = 'reparking';
  ticket.version += 1;
  const reparkId = crypto.randomUUID();
  w.tasks.push({
    ...retrieve,
    id: reparkId,
    cycle_id: null,
    type: 'repark',
    status: 'in_progress',
    assignee_id: fake.userByKey('DRV1').id,
    cancel_reason: null,
    canceled_at: null,
    started_at: new Date().toISOString(),
    version: 1,
  });
  fake.realtime.afterChange();
  await expect(page.locator('[data-notice="canceled"]')).toContainText(
    `أُلغي طلب الإحضار — تذكرة ${moving.displayNumber}`,
  );
  const repark = page.locator('[data-notice="repark"]');
  await expect(repark).toContainText(
    `أعد سيارة تذكرة ${moving.displayNumber} إلى الموقف وسجّل الموقف والمفتاح`,
  );
  await expect.poll(async () => (await audioLog(page)).started).toContain('next_due');
  await repark.getByRole('button', { name: 'فتح' }).click();
  await expect(page).toHaveURL(new RegExp(`/d/tasks/${reparkId}/park$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`إعادة الصف · #${moving.displayNumber}`);

  // a second driver submits an intake; the customer asks for the car while it is being parked
  const fake2 = createFake();
  fake2.realtime.enable();
  startDuty(fake2, 'DRV2');
  const parking = arrangeSubmitted(fake2, 'DRV2', { serial: '009302', keyTag: '195' });
  const drv2 = await actorPage(browser, fake2, 'DRV2');
  await installFakeAudio(drv2.page);
  await drv2.page.goto('/d');
  await unlockSound(drv2.page);
  await expect.poll(() => fake2.realtime.connectedUsers().length).toBe(1);
  const t = fake2.world.tickets.find((x) => x.id === parking.ticketId)!;
  t.pending_retrieval_at = new Date().toISOString();
  t.version += 1;
  const summary = (
    fake2.exec('DRV2', 'GET /v1/tickets') as Array<{ id: string } & Record<string, unknown>>
  ).find((x) => x.id === parking.ticketId)!;
  fake2.realtime.emit('DRV2', 'ticket.updated', { cause: 'ticket.retrieval_requested_early', ...summary });
  const early = drv2.page.locator('[data-notice="early"]');
  await expect(early).toContainText('العميل طلب السيارة أثناء الصف. سيُنشأ طلب الإحضار فور إتمام الصف.');
  await expect.poll(async () => (await audioLog(drv2.page)).started.at(-1)).toBe('reminder');
  // on that D-08 the screen's own banner says it — once
  await drv2.page.getByRole('button', { name: 'إتمام الصف' }).click();
  await expect(drv2.page).toHaveURL(new RegExp(`/d/tasks/${parking.parkTaskId}/park$`));
  await expect(
    drv2.page.getByText('العميل طلب السيارة أثناء الصف. سيُنشأ طلب الإحضار فور إتمام الصف.'),
  ).toHaveCount(1);
});

test('PNT-068 D-15 ح: SERVICE_UNAVAILABLE is a full screen with «إعادة المحاولة»; the tap brings D-04 back', async ({
  browser,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto('/d');
  await expect(page.getByRole('heading', { name: 'الرئيسية' })).toBeAttached();
  fake.failNext('GET /v1/me/home', errorReply('SERVICE_UNAVAILABLE'), 1000);
  await page.evaluate(() => window.dispatchEvent(new Event('online'))); // a resync now
  const screen = page.locator('[data-screen="d15-service"]');
  await expect(screen).toContainText('النظام غير متاح مؤقتًا. اتبع الإجراء الورقي حتى عودة الخدمة.', {
    timeout: 15_000,
  });
  await expect(screen).toHaveAttribute('role', 'alert');
  await expect(page.getByRole('navigation')).toHaveCount(0); // nothing else to work with meanwhile
  await expect(page.getByRole('button', { name: 'استلام مركبة' })).toHaveCount(0);

  fake.clearFaults('GET /v1/me/home'); // the service is back
  await screen.getByRole('button', { name: 'إعادة المحاولة' }).click();
  await expect(screen).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'استلام مركبة' })).toBeVisible();
  await expect(page.getByRole('navigation')).toBeVisible();
});

/** Records whether D-15 ح was ever on screen (a MutationObserver from the first paint). */
async function watchServiceScreen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __d15Seen?: boolean };
    w.__d15Seen = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-screen="d15-service"]')) w.__d15Seen = true;
    }).observe(document, { childList: true, subtree: true });
  });
}
const serviceScreenSeen = (page: Page) =>
  page.evaluate(() => (window as unknown as { __d15Seen?: boolean }).__d15Seen === true);

test('decisions:F1-d15h: one SERVICE_UNAVAILABLE keeps D-11 and what was typed; D-15 ح only when it persists, and the form survives it', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const r = arrangeRetrieval(fake, 'DRV1', 'ready', { eventId: EVENT_R2, serial: '007001' });
  const { page } = await actorPage(browser, fake, 'DRV1');
  await watchServiceScreen(page);
  await page.goto(`/d/tickets/${r.ticketId}/handover`);
  await expect(page.getByText(/المبلغ المستحق: 20\.00/)).toBeVisible();
  const stub = page.getByLabel('رقم الكعب');
  await stub.fill('0070');
  await page.getByLabel('استلمت المبلغ').check();

  // a transient 503 (a pool wait, a statement timeout): the retry answers, nothing is lost
  const before = fake.callsTo('GET /v1/me/home').length;
  fake.failNext('GET /v1/me/home', errorReply('SERVICE_UNAVAILABLE'), 1);
  await page.evaluate(() => window.dispatchEvent(new Event('online'))); // a resync now
  await expect
    .poll(
      () =>
        fake
          .callsTo('GET /v1/me/home')
          .slice(before)
          .findIndex((c) => c.status === 503) !== -1 &&
        fake.callsTo('GET /v1/me/home').at(-1)?.status === 200,
      { timeout: 15_000 }, // the resync is tried again after RESYNC_RETRY_MS (5 s)
    )
    .toBe(true);
  expect(fake.callsTo('GET /v1/me/home').some((c) => c.status === 503)).toBe(true);
  await page.waitForTimeout(300);
  expect(await serviceScreenSeen(page)).toBe(false);
  await expect(stub).toHaveValue('0070');
  await expect(page.getByLabel('استلمت المبلغ')).toBeChecked();

  // the outage persists: D-15 ح covers the frame; D-11 stays mounted underneath, its state kept
  fake.failNext('GET /v1/me/home', errorReply('SERVICE_UNAVAILABLE'), 1000);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  const screen = page.locator('[data-screen="d15-service"]');
  await expect(screen).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#handover-submit')).toBeHidden();
  fake.clearFaults('GET /v1/me/home');
  await screen.getByRole('button', { name: 'إعادة المحاولة' }).click();
  await expect(screen).toHaveCount(0);
  await expect(stub).toHaveValue('0070');
  await expect(page.getByLabel('استلمت المبلغ')).toBeChecked();
});

test('int-web review: a request that arrives under D-15 ح is not reported as seen until the screen comes back', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const fake = createFake();
  fake.realtime.enable();
  const [car] = parkedCars(fake, 1);
  busyDriver(fake, 'DRV1');
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto('/d');
  await expect(page.getByText('لا توجد طلبات إحضار الآن')).toBeVisible();
  await connected(fake);

  // the outage persists: D-15 ح covers D-04, which stays mounted (hidden, inert) underneath
  fake.failNext('GET /v1/me/home', errorReply('SERVICE_UNAVAILABLE'), 1000);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  const screen = page.locator('[data-screen="d15-service"]');
  await expect(screen).toBeVisible({ timeout: 20_000 });

  // a request reaches the socket meanwhile: the card lands in the hidden D-04, never on screen
  requestRetrieval(fake, car!.ticketId);
  await expect(offerCardOf(page)).toHaveCount(1);
  await expect(offerCardOf(page)).toBeHidden();
  await page.waitForTimeout(1500);
  expect(fake.realtime.offersSeen).toHaveLength(0); // 15 §9.4: seen_at stays empty, the reminder still goes
  expect(fake.telemetry.flatMap((b) => (b.body.events as Array<{ name: string }>) ?? [])).not.toContainEqual(
    expect.objectContaining({ name: 'offer_card_seen' }),
  );

  // the service is back: D-04 shows the card, and only now is it reported once
  fake.clearFaults('GET /v1/me/home');
  await screen.getByRole('button', { name: 'إعادة المحاولة' }).click();
  await expect(screen).toHaveCount(0);
  await expectOneOffer(page, car!.displayNumber);
  await expect(offerCardOf(page)).toBeVisible();
  await expect.poll(() => fake.realtime.offersSeen.length).toBe(1);
});

test('PNT-065 / 03 §4.4: «الاتصال غير مؤكد» closes D-09 reserve and D-11 handover, dims the cards; the next confirmation reopens them', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const fake = createFake();
  fake.realtime.enable();
  startDuty(fake, 'DRV1');
  const ready = arrangeRetrieval(fake, 'DRV1', 'ready', { serial: '009401', keyTag: '196' });
  const [car] = parkedCars(fake, 1);
  requestRetrieval(fake, car!.ticketId); // DRV1 busy: «حجز كمهمة تالية»
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.clock.install();
  await page.goto(`/d/tickets/${ready.ticketId}/handover`);
  await expect(page.locator('#handover-submit')).toBeEnabled();
  await connected(fake);

  // no confirmation from the server for longer than heartbeat.uncertain_after_s (45 s)
  fake.realtime.silentAcks = true;
  for (const route of ['GET /v1/me/home', 'POST /v1/me/heartbeat', 'GET /v1/tickets/:ticketId', 'GET /v1/me'])
    fake.failNext(route, 'abort', 1000);
  await page.clock.fastForward('00:50');
  await expect(page.locator('header').getByRole('button', { name: /الاتصال غير مؤكد/ })).toBeVisible();
  await expect(page.locator('#handover-submit')).toBeDisabled();
  await expect(page.getByText('لا يمكن التسليم دون اتصال. انتظر عودة الاتصال أو اطلب المشرف.')).toBeVisible();

  // D-04 (D-11 → D-10 → D-04 in the app): the request card is dimmed and cannot be reserved
  await page.getByRole('button', { name: 'رجوع' }).click();
  await page.getByRole('button', { name: 'رجوع' }).click();
  await expect(page.getByRole('heading', { name: 'الرئيسية' })).toBeAttached();
  await expect(page.locator('.pt-live')).toHaveAttribute('data-stale', 'true');
  await expect(offerCardOf(page).getByRole('button', { name: 'لا يمكن القبول دون اتصال' })).toBeDisabled();
  expect(fake.callsTo('POST /v1/task-offers/:offerId/accept')).toHaveLength(0);

  // the server answers again: after the resync the buttons are back
  fake.realtime.silentAcks = false;
  fake.clearFaults();
  await page.clock.fastForward('00:16'); // the next heartbeat
  await expect(page.locator('header').getByRole('button', { name: 'متصل' })).toBeVisible({ timeout: 15_000 });
  await expect(offerCardOf(page).getByRole('button', { name: 'حجز كمهمة تالية' })).toBeEnabled({
    timeout: 15_000,
  });
  await expect(page.locator('.pt-live')).toHaveAttribute('data-stale', 'false');
});

test('PNT-065 (DEC-PROPOSED-5): on D-05 «التالي» and «إلغاء الاستلام» wait while a resync is pending', async ({
  browser,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const draft = fake.exec('DRV1', 'POST /v1/tickets', {}, { event_id: EVENT_R1 });
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto(`/d/intake/${draft.ticket.id}/vehicle`);
  const next = page.locator('#intake-next');
  const discard = page.locator('#intake-cancel');
  await expect(next).toBeEnabled();
  await expect(discard).toBeEnabled();

  // back online: a full resync before any command (the snapshot is slow on purpose)
  fake.delayNext('GET /v1/me/home', 2500);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(next).toBeDisabled();
  await expect(discard).toBeDisabled();
  await expect(next).toBeEnabled({ timeout: 10_000 });
  await expect(discard).toBeEnabled();
  expect(fake.callsTo('PATCH /v1/tickets/:ticketId/intake')).toHaveLength(0);
});

test('PNT-065: a socket the server closed (`io server disconnect`) is checked and connected again; live events flow again', async ({
  browser,
}) => {
  const fake = createFake();
  fake.realtime.enable();
  const [car] = parkedCars(fake, 1);
  busyDriver(fake, 'DRV1');
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto('/d');
  await connected(fake);
  const meChecks = fake.callsTo('GET /v1/me').length;

  expect(fake.realtime.serverDisconnect('DRV1')).toBe(1);
  await expect.poll(() => fake.callsTo('GET /v1/me').length).toBeGreaterThan(meChecks); // the session check
  await expect.poll(() => fake.realtime.connectedUsers().length, { timeout: 10_000 }).toBe(1);

  const delivered = fake.realtime.delivered.length;
  requestRetrieval(fake, car!.ticketId);
  await expect
    .poll(() => fake.realtime.delivered.slice(delivered).some((d) => d.type === 'task.broadcast'))
    .toBe(true);
  await expectOneOffer(page, car!.displayNumber);
  // still signed in, nothing ended
  await expect(page).toHaveURL(/\/d$/);
  await expect(page.getByText(errorMessagesAr.AUTH_SESSION_REVOKED)).toHaveCount(0);
});
