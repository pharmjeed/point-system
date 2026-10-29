import { expect, test, type Page } from '@playwright/test';
import { actorPage } from './support/actors';
import { fakeOnly } from './support/backend';
import { runOnlyAt390 } from './support/checks';
import { acceptOfferOf, offerOf, requestRetrieval } from './support/driver';
import { audioLog, installFakeAudio } from './support/fakeAudio';
import { createFake } from './support/fake';
import { busyDriver, expectOneOffer, offerCardOf, parkedCars } from './support/live';

/**
 * PNT-066 (in-page sound) and PNT-068 (D-04 and the D-15 system states) on the fake backend with its realtime
 * hub. The AudioContext is a recording stand-in (headless Chromium has no output): it proves that nothing is
 * attempted before the unlock tap, what plays after it, and that a press stops the card's sound at once.
 * Every D-15 banner is produced by a simulated network condition or a server event.
 */
runOnlyAt390();
fakeOnly();

const AUDIO_BANNER = 'الصوت متوقف — اضغط هنا لتفعيله.';

function consoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

test('PNT-066 AC1: no play attempt before the unlock tap; the blocked state is on screen; no console error', async ({
  browser,
}) => {
  const fake = createFake();
  fake.realtime.enable();
  const [first, second] = parkedCars(fake, 2);
  busyDriver(fake, 'DRV1');
  busyDriver(fake, 'DRV2');
  const { page } = await actorPage(browser, fake, 'DRV1');
  await installFakeAudio(page);
  const errors = consoleErrors(page);
  await page.goto('/d');
  const banner = page.getByRole('status').filter({ hasText: AUDIO_BANNER });
  await expect(banner).toBeVisible();
  await expect.poll(() => fake.realtime.connectedUsers().length).toBe(1);

  requestRetrieval(fake, first!.ticketId); // a broadcast arrives before any tap
  await expectOneOffer(page, first!.displayNumber);
  await page.waitForTimeout(300);
  expect(await audioLog(page)).toMatchObject({ contexts: 0, resumes: 0, started: [] });

  // D-15 د: the tap resumes the AudioContext and plays `test`; every sound is decoded once
  await banner.getByRole('button', { name: 'تفعيل الصوت' }).click();
  await expect(banner).toBeHidden();
  await expect.poll(async () => (await audioLog(page)).started).toEqual(['test']);
  expect(await audioLog(page)).toMatchObject({ contexts: 1, resumes: 1 });

  // the next request is announced: `broadcast` with the 02 §1.10 vibration (it replaces the test tone)
  acceptOfferOf(fake, 'DRV2', first!.ticketId);
  requestRetrieval(fake, second!.ticketId);
  await expectOneOffer(page, second!.displayNumber);
  await expect.poll(async () => (await audioLog(page)).started).toEqual(['test', 'broadcast']);
  expect((await audioLog(page)).vibrate).toContainEqual([300, 100, 300, 100, 300]);
  expect(errors).toEqual([]);
});

test('PNT-066 AC2: pressing «حجز كمهمة تالية» stops the card sound before the reply', async ({ browser }) => {
  const fake = createFake();
  fake.realtime.enable();
  const [car] = parkedCars(fake, 1);
  busyDriver(fake, 'DRV1');
  const { page } = await actorPage(browser, fake, 'DRV1');
  await installFakeAudio(page);
  await page.goto('/d');
  await page.getByRole('button', { name: 'تفعيل الصوت' }).click();
  await expect.poll(async () => (await audioLog(page)).started).toEqual(['test']);
  await expect.poll(() => fake.realtime.connectedUsers().length).toBe(1);

  requestRetrieval(fake, car!.ticketId);
  await expectOneOffer(page, car!.displayNumber);
  await expect.poll(async () => (await audioLog(page)).started).toEqual(['test', 'broadcast']);
  fake.delayNext('POST /v1/task-offers/:offerId/accept', 2000);
  await offerCardOf(page).getByRole('button', { name: 'حجز كمهمة تالية' }).click();
  // stopped while the request is still pending
  await expect.poll(async () => (await audioLog(page)).stopped, { timeout: 1000 }).toContain('broadcast');
  expect(fake.callsTo('POST /v1/task-offers/:offerId/accept').at(-1)?.status ?? 0).toBe(0);
  await expect(page.getByText('حُجز الطلب')).toBeVisible();
});

test('PNT-066: a context the browser will not resume stays «blocked» on screen and is recorded on the device', async ({
  browser,
}) => {
  const fake = createFake();
  busyDriver(fake, 'DRV1');
  const { page, session } = await actorPage(browser, fake, 'DRV1');
  await installFakeAudio(page, { resumes: false });
  await page.goto('/d');
  const banner = page.getByRole('status').filter({ hasText: AUDIO_BANNER });
  await banner.getByRole('button', { name: 'تفعيل الصوت' }).click();
  await expect(banner).toBeVisible();
  await expect.poll(() => fake.devices.get(session.deviceId as string)?.audio_test_result).toBe('blocked');
});

test('PNT-068 AC1: every D-15 banner from a simulated network or a server event', async ({ browser }) => {
  test.setTimeout(60_000);
  const fake = createFake();
  fake.realtime.enable();
  busyDriver(fake, 'DRV1');
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.clock.install();
  await page.goto('/d');
  // the driver_state badge with its text (02 §1.3)
  await expect(page.locator('header').getByText('يسجل/يصف')).toBeVisible();
  await expect(page.locator('header').getByRole('button', { name: 'متصل' })).toBeVisible();
  await expect.poll(() => fake.realtime.connectedUsers().length).toBe(1);

  // ز — WhatsApp down from channel.status, gone when healthy again
  const whatsapp = page.getByRole('alert').filter({ hasText: 'رسائل واتساب للعملاء متوقفة مؤقتًا' });
  fake.realtime.emit('DRV1', 'channel.status', {
    cause: 'wa.channel_health_changed',
    whatsapp: 'down',
    changed_at: new Date().toISOString(),
  });
  await expect(whatsapp).toBeVisible();
  fake.realtime.emit('DRV1', 'channel.status', {
    cause: 'wa.channel_health_changed',
    whatsapp: 'healthy',
    changed_at: new Date(Date.now() + 1000).toISOString(),
  });
  await expect(whatsapp).toBeHidden();

  // ب — «الاتصال غير مؤكد»: no confirmation from the server for longer than heartbeat.uncertain_after_s
  fake.realtime.silentAcks = true;
  fake.failNext('GET /v1/me/home', 'abort', 100);
  fake.failNext('POST /v1/me/heartbeat', 'abort', 100);
  await page.clock.fastForward('00:50');
  const uncertain = page.locator('header').getByRole('button', { name: /الاتصال غير مؤكد/ });
  await expect(uncertain).toBeVisible();
  await uncertain.click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('button', { name: 'مزامنة الآن' })).toBeVisible();
  await page.keyboard.press('Escape');

  // أ — offline: the strip with the time of the data on screen
  await page.context().setOffline(true);
  await expect(
    page.getByRole('alert').filter({ hasText: 'لا يوجد اتصال. البيانات المعروضة من' }),
  ).toBeVisible();
  await expect(page.locator('header').getByRole('button', { name: /غير متصل/ })).toBeVisible();
  await page.context().setOffline(false);
  fake.realtime.silentAcks = false;

  // ج — the session ends (account disabled): session.revoked → GET /v1/me → D-15 with the reason
  fake.userByKey('DRV1').status = 'disabled';
  fake.realtime.emit('DRV1', 'session.revoked', { reason: 'disabled' });
  await expect(page).toHaveURL(/\/session-ended$/, { timeout: 15_000 });
  await expect(page.getByText('تم تعطيل حسابك. تواصل مع الإدارة.')).toBeVisible();
});

test('PNT-068 AC2: a refused Screen Wake Lock shows no error; the connection sheet lists it', async ({
  browser,
}) => {
  const fake = createFake();
  busyDriver(fake, 'DRV1');
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.addInitScript(() => {
    (window as unknown as { __wake: number }).__wake = 0;
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: () => {
          (window as unknown as { __wake: number }).__wake += 1;
          return Promise.reject(new DOMException('battery saver', 'NotAllowedError'));
        },
      },
    });
  });
  const errors = consoleErrors(page);
  await page.goto('/d');
  await expect(page.getByRole('button', { name: 'استلام مركبة' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __wake: number }).__wake)).toBe(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.pt-toast')).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.locator('header').getByRole('button', { name: 'متصل' }).click();
  await expect(page.getByRole('dialog').locator('[data-row="wake-lock"]')).toContainText('تعذّر التفعيل');
});

test('PNT-068: the wake lock is held during the duty, released when the D-14 setting is off', async ({
  browser,
}) => {
  const fake = createFake();
  busyDriver(fake, 'DRV1');
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.addInitScript(() => {
    const w = window as unknown as { __locks: { requested: number; released: number } };
    w.__locks = { requested: 0, released: 0 };
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: async () => {
          w.__locks.requested += 1;
          return {
            released: false,
            release() {
              this.released = true;
              w.__locks.released += 1;
              return Promise.resolve();
            },
            addEventListener() {},
          };
        },
      },
    });
  });
  await page.goto('/d');
  const locks = () =>
    page.evaluate(() => (window as unknown as { __locks: { requested: number; released: number } }).__locks);
  await expect.poll(async () => (await locks()).requested).toBe(1);
  await page.locator('header').getByRole('button', { name: 'متصل' }).click();
  await expect(page.getByRole('dialog').locator('[data-row="wake-lock"]')).toContainText('مفعّل');
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'حسابي' }).click();
  await page.getByRole('switch', { name: 'إبقاء الشاشة مضاءة أثناء الوردية' }).click();
  await expect.poll(async () => (await locks()).released).toBe(1);
});

test('PNT-068: D-04 single offer — countdown on server time, the reminder, «انتهى العرض» at zero', async ({
  browser,
}) => {
  const fake = createFake();
  fake.realtime.enable();
  const [car] = parkedCars(fake, 1);
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.clock.install();
  fake.exec('DRV1', 'POST /v1/me/duty/start', {}, {}); // available: the single offer is DRV1's
  await page.goto('/d');
  await expect.poll(() => fake.realtime.connectedUsers().length).toBe(1);
  requestRetrieval(fake, car!.ticketId);
  await expectOneOffer(page, car!.displayNumber);
  const card = offerCardOf(page);
  await expect(card).toContainText('طلب إحضار — لك');
  await expect(card.getByRole('timer')).toBeVisible();
  await expect(card.getByRole('button', { name: 'قبول الطلب' })).toBeEnabled();
  expect(offerOf(fake, car!.ticketId)?.mode).toBe('single');
  // reminder_at is not set by the fake: offer.reminder from the server colours the ring
  const offer = offerOf(fake, car!.ticketId)!;
  fake.realtime.emit('DRV1', 'offer.reminder', {
    cause: 'offer.reminded',
    offer_id: offer.id,
    task_id: offer.task_id,
  });
  await expect(card).toHaveAttribute('data-offer-state', 'reminded');
  await expect(card.locator('.pt-ring--low')).toBeVisible();
  // the round ends: «انتهى العرض», the button stops, then the card leaves
  await page.clock.fastForward('00:31');
  await expect(card).toHaveAttribute('data-offer-state', 'expired');
  await expect(card).toContainText('انتهى العرض');
  await expect(card.getByRole('button', { name: 'قبول الطلب' })).toBeDisabled();
});
