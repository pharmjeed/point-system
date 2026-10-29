import { expect, test } from '@playwright/test';
import { actorPage } from './support/actors';
import { fakeOnly } from './support/backend';
import { runOnlyAt390 } from './support/checks';
import { acceptOfferOf, offerOf, requestRetrieval } from './support/driver';
import { errorMessagesAr } from '../src/i18n/errors';
import { createFake, errorReply } from './support/fake';
import { airplaneOff, airplaneOn, busyDriver, expectOneOffer, offerCardOf, parkedCars } from './support/live';

/**
 * PNT-065 (sync protocol) and PNT-067 (the live D-09 card) on the fake backend with its realtime hub
 * (`fake.realtime`: Socket.IO frames over `page.routeWebSocket`, published from the fake world like the API's
 * planners): a resync before any command after airplane mode, a return to the foreground and `sync.required`;
 * the oldest request only; a stale card pressed in a second browser context handled without a stuck state;
 * the 08 texts of the D-09 refusals.
 */
runOnlyAt390();
fakeOnly();

/** 08 §4 texts (the server's `message_ar`, DEC-80). */
const TEXT = {
  TASK_ALREADY_CLAIMED: errorMessagesAr.TASK_ALREADY_CLAIMED,
  OFFER_EXPIRED: errorMessagesAr.OFFER_EXPIRED,
  OLDER_REQUEST_PENDING: errorMessagesAr.OLDER_REQUEST_PENDING,
  NEXT_TASK_ALREADY_RESERVED: errorMessagesAr.NEXT_TASK_ALREADY_RESERVED,
} as const;

const reserveButton = (page: import('@playwright/test').Page) =>
  offerCardOf(page).getByRole('button', { name: 'حجز كمهمة تالية' });

test('PNT-065 AC1: after 2 minutes in airplane mode the return shows the right state before any command', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const fake = createFake();
  fake.realtime.enable();
  const [first, second] = parkedCars(fake, 2);
  busyDriver(fake, 'DRV1');
  busyDriver(fake, 'DRV2');
  requestRetrieval(fake, first!.ticketId); // nobody available: a broadcast, «حجز كمهمة تالية»
  const drv1 = await actorPage(browser, fake, 'DRV1');
  const page = drv1.page;
  await page.clock.install();
  await page.goto('/d');
  await expectOneOffer(page, first!.displayNumber);
  await expect(reserveButton(page)).toBeEnabled();

  await airplaneOn(page, fake, 'DRV1');
  const offline = page.getByRole('alert').filter({ hasText: 'لا يوجد اتصال. البيانات المعروضة من' });
  await expect(offline).toBeVisible();
  await expect(offline).toContainText('القبول والتسليم متوقفان حتى عودة الاتصال.');
  // the stale card stays on screen, dimmed, and cannot be acted on
  await expect(page.locator('.pt-live')).toHaveAttribute('data-stale', 'true');
  // 02 D-09 «بلا اتصال: الزر معطل والنص «لا يمكن القبول دون اتصال»» (03 §6: 02's text)
  await expect(offerCardOf(page).getByRole('button', { name: 'لا يمكن القبول دون اتصال' })).toBeDisabled();

  // two minutes pass; meanwhile DRV2 reserves the request and a newer one comes in
  await page.clock.fastForward('02:00');
  acceptOfferOf(fake, 'DRV2', first!.ticketId);
  requestRetrieval(fake, second!.ticketId);
  const acceptsBefore = fake.callsTo('POST /v1/task-offers/:offerId/accept').length;

  // back: the resync is slow on purpose — the old card must not be actionable meanwhile
  fake.delayNext('GET /v1/me/home', 2500, 3);
  await airplaneOff(page, fake);
  await expect(offline).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'جارٍ المزامنة…' })).toBeVisible();
  await expect(reserveButton(page)).toBeDisabled();

  // the right state: the claimed request is gone, the newer one is offered, and only now enabled
  await expectOneOffer(page, second!.displayNumber);
  await expect(reserveButton(page)).toBeEnabled({ timeout: 15_000 });
  await expect(page.locator('.pt-live')).toHaveAttribute('data-stale', 'false');
  expect(fake.callsTo('POST /v1/task-offers/:offerId/accept')).toHaveLength(acceptsBefore);
  await drv1.page.context().close();
});

test('PNT-065 AC2: sync.required and a return to the foreground disable commands until the snapshot is read', async ({
  browser,
}) => {
  const fake = createFake();
  fake.realtime.enable();
  const [car] = parkedCars(fake, 1);
  busyDriver(fake, 'DRV1');
  requestRetrieval(fake, car!.ticketId);
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto('/d');
  await expect(reserveButton(page)).toBeEnabled();
  await expect.poll(() => fake.realtime.connectedUsers().length).toBe(1);

  // sync.required (07 §4.3): full resync before any command
  const homes = fake.callsTo('GET /v1/me/home').length;
  fake.delayNext('GET /v1/me/home', 1500);
  fake.realtime.emit('DRV1', 'sync.required', { reason: 'test', scope: 'home' });
  await expect(reserveButton(page)).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: 'جارٍ المزامنة…' })).toBeVisible();
  await expect(reserveButton(page)).toBeEnabled({ timeout: 10_000 });
  expect(fake.callsTo('GET /v1/me/home').length).toBeGreaterThan(homes);

  // back from the background (visibilitychange → visible)
  fake.delayNext('GET /v1/me/home', 1500);
  await page.evaluate(() => {
    const set = (v: string) => {
      Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    set('hidden');
    set('visible');
  });
  await expect(reserveButton(page)).toBeDisabled();
  await expect(reserveButton(page)).toBeEnabled({ timeout: 10_000 });

  // a dropped socket reconnects and resyncs too
  const before = fake.callsTo('GET /v1/me/home').length;
  fake.realtime.drop('DRV1');
  await expect.poll(() => fake.realtime.connectedUsers().length, { timeout: 15_000 }).toBe(1);
  await expect
    .poll(() => fake.callsTo('GET /v1/me/home').length, { timeout: 10_000 })
    .toBeGreaterThan(before);
  await expect(reserveButton(page)).toBeEnabled();
  // the heartbeat carries the canon fields (07 §4.4)
  await expect.poll(() => fake.realtime.heartbeats.length, { timeout: 20_000 }).toBeGreaterThan(0);
  expect(fake.realtime.heartbeats[0]?.payload).toMatchObject({
    visible: true,
    audio_unlocked: false,
    app_version: expect.any(String),
  });
  expect(fake.realtime.heartbeats[0]?.payload).toHaveProperty('last_event_id');
});

test('PNT-067 AC1: only the oldest request the driver may act on is shown; client.offer_seen once', async ({
  browser,
}) => {
  const fake = createFake();
  fake.realtime.enable();
  const [older, newer] = parkedCars(fake, 2);
  busyDriver(fake, 'DRV1');
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto('/d');
  await expect(page.getByText('لا توجد طلبات إحضار الآن')).toBeVisible();
  await expect.poll(() => fake.realtime.connectedUsers().length).toBe(1);

  requestRetrieval(fake, older!.ticketId); // pushed as task.broadcast
  await expectOneOffer(page, older!.displayNumber);
  requestRetrieval(fake, newer!.ticketId); // newer: never replaces the head
  await page.waitForTimeout(500);
  await expectOneOffer(page, older!.displayNumber);
  await expect.poll(() => fake.realtime.offersSeen.length).toBe(1);
  expect(fake.realtime.offersSeen[0]?.payload.offer_id).toBe(offerOf(fake, older!.ticketId)?.id);

  // the older one is claimed elsewhere → the next oldest takes its place, without a stuck card
  startDutyAndReserve(fake, older!.ticketId);
  await expectOneOffer(page, newer!.displayNumber);
});

function startDutyAndReserve(fake: ReturnType<typeof createFake>, ticketId: string) {
  busyDriver(fake, 'DRV4');
  acceptOfferOf(fake, 'DRV4', ticketId);
}

test('PNT-067 AC2: a stale card pressed in another context is handled gracefully (two browser contexts)', async ({
  browser,
}) => {
  const fake = createFake();
  fake.realtime.enable();
  const [car, later] = parkedCars(fake, 2);
  busyDriver(fake, 'DRV1');
  busyDriver(fake, 'DRV2');
  requestRetrieval(fake, car!.ticketId);
  const drv1 = await actorPage(browser, fake, 'DRV1');
  const drv2 = await actorPage(browser, fake, 'DRV2');
  await drv1.page.goto('/d');
  await drv2.page.goto('/d');
  await expectOneOffer(drv1.page, car!.displayNumber);
  await expectOneOffer(drv2.page, car!.displayNumber);

  // DRV1 loses its realtime deliveries: its card goes stale while DRV2 reserves the request
  fake.realtime.muted.add(fake.userByKey('DRV1').id);
  await reserveButton(drv2.page).click();
  await expect(drv2.page.getByText(`حُجز الطلب`)).toBeVisible();
  await expect(offerCardOf(drv2.page)).toHaveCount(0);
  await expectOneOffer(drv1.page, car!.displayNumber); // still on DRV1's screen (no event)

  // pressing the stale card: the server's 08 text, the card leaves, nothing stays busy
  await reserveButton(drv1.page).click();
  await expect(drv1.page.getByText(TEXT.TASK_ALREADY_CLAIMED)).toBeVisible();
  await expect(offerCardOf(drv1.page)).toHaveCount(0);
  await expect(drv1.page.getByText('لا توجد طلبات إحضار الآن')).toBeVisible();
  await expect(drv1.page.locator('[aria-busy="true"]')).toHaveCount(0);

  // with the deliveries back, the next request arrives live and can be reserved
  fake.realtime.muted.clear();
  requestRetrieval(fake, later!.ticketId);
  await expectOneOffer(drv1.page, later!.displayNumber);
  await reserveButton(drv1.page).click();
  await expect(drv1.page.getByText('حُجز الطلب')).toBeVisible();

  // and when the deliveries work, task.claimed removes the card on the other screen with the 02 toast
  await drv1.page.context().close();
  await drv2.page.context().close();
});

test('PNT-067: task.claimed removes a visible card with «قبل الطلب سائق آخر»; offer.reminder colours it', async ({
  browser,
}) => {
  const fake = createFake();
  fake.realtime.enable();
  const [car] = parkedCars(fake, 1);
  busyDriver(fake, 'DRV1');
  busyDriver(fake, 'DRV2');
  requestRetrieval(fake, car!.ticketId);
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto('/d');
  await expectOneOffer(page, car!.displayNumber);
  await expect.poll(() => fake.realtime.connectedUsers().length).toBe(1);

  const offer = offerOf(fake, car!.ticketId)!;
  fake.realtime.emit('DRV1', 'offer.reminder', {
    cause: 'offer.reminded',
    offer_id: offer.id,
    task_id: offer.task_id,
  });
  await expect(offerCardOf(page)).toHaveAttribute('data-offer-state', 'reminded');
  await expect(offerCardOf(page)).toContainText('تذكير: الطلب ما زال بانتظار قبولك');

  acceptOfferOf(fake, 'DRV2', car!.ticketId); // the hub publishes task.claimed to DRV1
  await expect(offerCardOf(page)).toHaveCount(0);
  await expect(page.getByText('قبل الطلب سائق آخر', { exact: true })).toBeVisible();
  const claimed = fake.realtime.delivered.find((d) => d.type === 'task.claimed');
  expect(claimed?.frame.payload).toMatchObject({ task_id: offer.task_id, offer_ids: [offer.id] });
});

test('PNT-067 (02 §7 item 9): one assertive announcement per transition — arrival, reminder — never the ticking clock', async ({
  browser,
}) => {
  const fake = createFake();
  fake.realtime.enable();
  const [car] = parkedCars(fake, 1);
  busyDriver(fake, 'DRV1');
  requestRetrieval(fake, car!.ticketId);
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto('/d');
  await expectOneOffer(page, car!.displayNumber);
  await expect.poll(() => fake.realtime.connectedUsers().length).toBe(1);
  const card = offerCardOf(page);
  const live = card.locator('[aria-live]');
  await expect(live).toHaveCount(1); // the card itself is not a live region
  await expect(live).toHaveAttribute('aria-live', 'assertive');
  await expect(live).toHaveText(`طلب إحضار جديد، تذكرة ${car!.displayNumber}`);
  await expect(card).toContainText(/ينتظر منذ/);
  const said = await live.textContent();
  await page.waitForTimeout(2200); // the waiting clock ticks meanwhile
  expect(await live.textContent()).toBe(said);

  const offer = offerOf(fake, car!.ticketId)!;
  fake.realtime.emit('DRV1', 'offer.reminder', {
    cause: 'offer.reminded',
    offer_id: offer.id,
    task_id: offer.task_id,
  });
  await expect(live).toHaveText('تذكير: الطلب ما زال بانتظار قبولك');
});

test('PNT-067 (02 D-09): OLDER_REQUEST_PENDING — the resync shows the older request with «يوجد طلب أقدم يجب قبوله أولًا.»', async ({
  browser,
}) => {
  const fake = createFake();
  fake.realtime.enable();
  const [newer, older] = parkedCars(fake, 2);
  busyDriver(fake, 'DRV1');
  requestRetrieval(fake, newer!.ticketId);
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto('/d');
  await expectOneOffer(page, newer!.displayNumber);
  await expect.poll(() => fake.realtime.connectedUsers().length).toBe(1);

  // the server queues a request older than the one on screen; DRV1 has not heard of it yet
  fake.realtime.muted.add(fake.userByKey('DRV1').id);
  requestRetrieval(fake, older!.ticketId);
  const taskOf = (ticketId: string) =>
    fake.world.tasks.find((k) => k.ticket_id === ticketId && k.type === 'retrieve')!;
  const earlier = new Date(Date.parse(taskOf(newer!.ticketId).priority_at) - 60_000).toISOString();
  taskOf(older!.ticketId).priority_at = earlier;
  fake.world.cycles.find((c) => c.ticket_id === older!.ticketId && !c.closed_at)!.requested_at = earlier;

  fake.failNext('POST /v1/task-offers/:offerId/accept', errorReply('OLDER_REQUEST_PENDING'));
  await reserveButton(page).click();
  // the text goes with the head card the resync shows (it is not lost with the old card)
  await expectOneOffer(page, older!.displayNumber);
  await expect(offerCardOf(page).getByText(TEXT.OLDER_REQUEST_PENDING)).toBeVisible();
  await expect(reserveButton(page)).toBeEnabled({ timeout: 10_000 });
  fake.realtime.muted.clear();
});

test('PNT-067: the D-09 refusals show the 08 texts (OFFER_EXPIRED, OLDER_REQUEST_PENDING, NEXT_TASK_ALREADY_RESERVED)', async ({
  browser,
}) => {
  const fake = createFake();
  fake.realtime.enable();
  const [car] = parkedCars(fake, 1);
  busyDriver(fake, 'DRV1');
  requestRetrieval(fake, car!.ticketId);
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto('/d');
  await expectOneOffer(page, car!.displayNumber);

  for (const code of ['OLDER_REQUEST_PENDING', 'NEXT_TASK_ALREADY_RESERVED'] as const) {
    fake.failNext('POST /v1/task-offers/:offerId/accept', errorReply(code));
    await reserveButton(page).click();
    await expect(offerCardOf(page).getByText(TEXT[code])).toBeVisible();
    await expect(reserveButton(page)).toBeEnabled({ timeout: 10_000 }); // synced, the card is still offered
  }
  fake.failNext('POST /v1/task-offers/:offerId/accept', errorReply('OFFER_EXPIRED'));
  await reserveButton(page).click();
  await expect(page.getByText(TEXT.OFFER_EXPIRED)).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
});
