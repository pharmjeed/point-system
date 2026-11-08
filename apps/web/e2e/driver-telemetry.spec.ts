import { expect, test, type Page } from '@playwright/test';
import { parseTelemetryEvent } from '../../../packages/shared/src/analytics';
import { actorPage } from './support/actors';
import { fakeOnly } from './support/backend';
import { runOnlyAt390 } from './support/checks';
import { offerOf, requestRetrieval, startDuty } from './support/driver';
import { installFakeAudio } from './support/fakeAudio';
import { createFake, type FakeServer } from './support/fake';
import { parkedCars } from './support/live';
import { stubNotifications } from './support/notifications';

/**
 * Client telemetry (15 §8/§9, DEC-147, DEC-167; contract:F5, decisions:F5): the 15 §8 measurements leave in
 * `POST /v1/telemetry` batches with the CSRF header and the session's device, every event inside the
 * shared catalog's allow-list; and a request card shown while the socket is down is reported there as
 * `offer_card_seen` (`via: sync`, 15 §9.4) — the server then fills `seen_at`, so no reminder push goes to a
 * device that already shows the card.
 */
runOnlyAt390();
fakeOnly();

type Event = { name: string; properties?: Record<string, unknown>; [k: string]: unknown };
const events = (fake: FakeServer): Event[] =>
  fake.telemetry.flatMap((b) => (b.body.events as Event[] | undefined) ?? []);
const names = (fake: FakeServer) => events(fake).map((e) => e.name);

/** The page goes to the background (a flush), then comes back. */
async function hideAndShow(page: Page): Promise<void> {
  for (const v of ['hidden', 'visible'] as const)
    await page.evaluate((state) => {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }, v);
}

test('15 §8: the D-14 audio test, the notification permission, an offline spell and the sync leave in batches inside the catalog', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const { page, session } = await actorPage(browser, fake, 'DRV1');
  await installFakeAudio(page);
  await stubNotifications(page, { permission: 'default', answer: 'granted' });
  await page.goto('/d/account');
  await expect(page.getByRole('heading', { name: 'حسابي' })).toBeVisible();

  await page.getByRole('button', { name: 'تفعيل واختبار الصوت' }).click();
  await page.getByRole('button', { name: 'نعم، سمعتها' }).click();
  await page.getByRole('button', { name: 'تفعيل الإشعارات' }).click();
  await expect(page.locator('[data-row="notifications"]')).toContainText('مفعّلة');

  await page.context().setOffline(true);
  await expect(page.getByText(/لا يوجد اتصال/).first()).toBeVisible({ timeout: 10_000 });
  await page.context().setOffline(false);
  await expect(page.getByText(/لا يوجد اتصال/)).toHaveCount(0, { timeout: 15_000 });
  await hideAndShow(page); // visibilitychange → hidden: the queue leaves now (fetch keepalive)
  await hideAndShow(page); // … and once more, with the page_hidden_during_duty of the first return

  await expect
    .poll(() => names(fake), { timeout: 15_000 })
    .toEqual(
      expect.arrayContaining([
        'app_started',
        'audio_test_completed',
        'notification_permission_changed',
        'connection_changed',
        'sync_completed',
        'page_hidden_during_duty',
      ]),
    );
  const all = events(fake);
  expect(all.find((e) => e.name === 'audio_test_completed')?.properties).toMatchObject({
    result: 'heard',
    context: 'account',
  });
  expect(all.find((e) => e.name === 'notification_permission_changed')?.properties).toMatchObject({
    from: 'default',
    to: 'granted',
    context: 'account',
  });
  expect(all.filter((e) => e.name === 'connection_changed').map((e) => e.properties?.to)).toEqual(
    expect.arrayContaining(['offline', 'online']),
  );
  for (const e of all) expect(parseTelemetryEvent(e).ok, e.name).toBe(true);

  const posts = fake.callsTo('POST /v1/telemetry');
  expect(posts.length).toBeGreaterThan(0);
  for (const post of posts) {
    expect(post.headers['x-requested-with']).toBe('point-web'); // DEC-29
    expect(post.headers['idempotency-key']).toBeUndefined(); // not a command (DEC-149)
    expect(post.status).toBe(202);
    expect(post.body).toMatchObject({ device_id: session.deviceId, app_version: expect.any(String) });
    expect((post.body as { events: unknown[] }).events.length).toBeLessThanOrEqual(50);
  }
  // the seq numbers follow the order the events were taken
  const seqs = all.map((e) => e.seq as number);
  expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
});

test('15 §9.4: a request card shown while the socket is down is reported as offer_card_seen in a telemetry batch', async ({
  browser,
}) => {
  const fake = createFake(); // no realtime: the socket never connects, D-04 polls GET /v1/me/home
  const [car] = parkedCars(fake, 1);
  startDuty(fake, 'DRV1');
  requestRetrieval(fake, car!.ticketId);
  const offer = offerOf(fake, car!.ticketId);
  expect(offer).toBeDefined();
  const { page } = await actorPage(browser, fake, 'DRV1');
  await page.goto('/d');
  await expect(page.locator('section.pt-offer')).toHaveCount(1);
  await expect
    .poll(() => events(fake).filter((e) => e.name === 'offer_card_seen').length, { timeout: 15_000 })
    .toBe(1);
  const seen = events(fake).find((e) => e.name === 'offer_card_seen');
  expect(seen?.properties).toMatchObject({ offer_id: offer!.id, via: 'sync', mode: 'single' });
  expect(parseTelemetryEvent(seen).ok).toBe(true);
  // the next home polls show the same round: it is not reported again
  const reads = fake.callsTo('GET /v1/me/home').length;
  await expect
    .poll(() => fake.callsTo('GET /v1/me/home').length, { timeout: 15_000 })
    .toBeGreaterThan(reads + 1);
  await hideAndShow(page);
  await page.waitForTimeout(500);
  expect(events(fake).filter((e) => e.name === 'offer_card_seen')).toHaveLength(1);
});
