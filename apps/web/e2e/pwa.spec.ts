import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { fakeOnly } from './support/backend';
import { runOnlyAt390 } from './support/checks';
import { startDuty } from './support/driver';
import { createFake, type FakeServer } from './support/fake';

/**
 * PNT-070 (installable PWA, app-shell Service Worker) and the Service Worker half of PNT-072 (Web Push), in
 * Chromium with service workers allowed (the other specs block them so `page.route` sees every request):
 * the manifest and the installability report of Chrome (CDP `Page.getInstallabilityErrors`), the precache
 * of the shell without any `/v1` response, the shell from the cache when offline, a push delivered through
 * CDP shown with its tag and replaced quietly by `closed`, a tapped notification (`push.click`) opening its
 * screen with a resync, and the subscription sent with `PUT /v1/me/devices/{deviceId}`.
 */
runOnlyAt390();
fakeOnly();

async function pwaContext(browser: Browser): Promise<BrowserContext> {
  const use = test.info().project.use;
  return browser.newContext({
    baseURL: use.baseURL,
    viewport: use.viewport,
    userAgent: use.userAgent,
    deviceScaleFactor: use.deviceScaleFactor,
    isMobile: use.isMobile,
    hasTouch: use.hasTouch,
    locale: use.locale,
    timezoneId: use.timezoneId,
    serviceWorkers: 'allow',
  });
}

/** Waits for `/sw.js` to control the page (installed, activated, `clients.claim()`). */
async function controlled(page: Page): Promise<string> {
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, undefined, { timeout: 20_000 });
  return page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? '');
}

async function driverPage(browser: Browser, fake: FakeServer) {
  const context = await pwaContext(browser);
  const page = await context.newPage();
  const session = await fake.attach(page, 'DRV1', { context: true });
  return { context, page, session };
}

test('PNT-070 AC1: installable — the brand manifest, a controlling Service Worker, no installability error', async ({
  browser,
}) => {
  const fake = createFake();
  const { context, page } = await driverPage(browser, fake);
  await page.goto('/login');
  expect(await controlled(page)).toMatch(/\/sw\.js$/);
  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  expect(installabilityErrors).toEqual([]);
  const manifest = (await (await page.request.get('/manifest.webmanifest')).json()) as Record<
    string,
    unknown
  >;
  expect(manifest).toMatchObject({
    start_url: '/?source=pwa',
    display: 'standalone',
    dir: 'rtl',
    lang: 'ar',
    theme_color: '#015AFE',
  });
  expect(String(manifest.name)).toMatch(/ — نظام الفاليت$/);
  const icons = manifest.icons as Array<{ sizes: string; purpose: string }>;
  expect(icons.some((i) => i.sizes === '192x192' && i.purpose === 'any')).toBe(true);
  expect(icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable')).toBe(true);
  await context.close();
});

test('PNT-070: the shell is precached, no /v1 answer is ever cached, the shell opens offline', async ({
  browser,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const { context, page } = await driverPage(browser, fake);
  await page.goto('/d');
  await controlled(page);
  await expect(page.getByRole('heading', { name: 'الرئيسية' })).toBeVisible();
  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const urls: string[] = [];
    for (const name of names)
      for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname);
    return { names, urls };
  });
  expect(cached.names).toHaveLength(1);
  expect(cached.names[0]).toMatch(/^point-shell-[0-9a-f]{16}$/);
  expect(cached.urls).toContain('/index.html');
  expect(cached.urls).toContain('/manifest.webmanifest');
  expect(cached.urls).toContain('/icons/icon-192.png');
  expect(cached.urls).toContain('/sounds/point-offer.mp3');
  expect(cached.urls.some((u) => /^\/assets\/index-[^/]+\.js$/.test(u))).toBe(true);
  expect(cached.urls.filter((u) => u.startsWith('/v1'))).toEqual([]);
  expect(fake.calls.some((c) => c.path === '/v1/me/home')).toBe(true); // the app did read the API

  // offline: the navigation is served from the cached shell; the app says it has no connection
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await context.setOffline(false);
  await context.close();
});

/** The registration id of `/sw.js` for CDP `ServiceWorker.deliverPushMessage`. */
async function pushTarget(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  const origin = new URL(page.url()).origin;
  const registrationId = new Promise<string>((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
      const hit = registrations.find((r) => r.scopeURL.startsWith(origin) && !r.isDeleted);
      if (hit) resolve(hit.registrationId);
    });
  });
  await cdp.send('ServiceWorker.enable');
  const id = await registrationId;
  return (data: unknown) =>
    cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId: id, data: JSON.stringify(data) });
}

function shownNotifications(page: Page) {
  return page.evaluate(async () =>
    (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({
      title: n.title,
      body: n.body,
      tag: n.tag,
      silent: n.silent,
      data: n.data as Record<string, unknown>,
    })),
  );
}

test('PNT-072: a push shows the ticket number only, under the task tag; «closed» replaces it quietly', async ({
  browser,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const { context, page } = await driverPage(browser, fake);
  await context.grantPermissions(['notifications']);
  await page.goto('/d');
  await controlled(page);
  const deliver = await pushTarget(context, page);
  const task = crypto.randomUUID();
  const brand = 'العلامة';
  const base = {
    v: 1,
    tag: `task:${task}`,
    ticket_no: 125,
    task_id: task,
    offer_id: crypto.randomUUID(),
    url: '/d',
    sent_at: new Date().toISOString(),
  };
  await deliver({
    ...base,
    kind: 'offer',
    title: `${brand} — طلب إحضار`, // 14 §6.3, as the API builds it
    body: 'تذكرة 125 — افتح التطبيق للقبول',
    renotify: true,
    silent: false,
    expires_at: new Date(Date.now() + 30_000).toISOString(),
  });
  await expect.poll(() => shownNotifications(page)).toHaveLength(1);
  const [offer] = await shownNotifications(page);
  expect(offer).toMatchObject({
    title: `${brand} — طلب إحضار`,
    body: 'تذكرة 125 — افتح التطبيق للقبول',
    tag: `task:${task}`,
  });
  expect(offer?.data).toMatchObject({ url: '/d', kind: 'offer', task_id: task, ticket_no: 125 });

  // the round is taken: the same tag now says so, quietly
  await deliver({
    ...base,
    kind: 'closed',
    title: brand,
    body: 'تم قبول الطلب',
    renotify: false,
    silent: true,
    expires_at: null,
  });
  await expect
    .poll(async () => (await shownNotifications(page)).map((n) => n.body))
    .toEqual(['تم قبول الطلب']);

  // a payload outside the strict canon schema (a plate) never reaches the lock screen
  await deliver({
    ...base,
    tag: `task:${crypto.randomUUID()}`,
    kind: 'offer',
    title: 'x',
    body: 'y',
    plate: '1234 ب ح د',
    renotify: true,
    silent: false,
    expires_at: null,
  });
  await expect.poll(() => shownNotifications(page)).toHaveLength(2);
  expect(JSON.stringify(await shownNotifications(page))).not.toContain('1234');
  await context.close();
});

test('PNT-072: a tapped notification opens its screen and resyncs; the subscription reaches the device', async ({
  browser,
}) => {
  const fake = createFake();
  startDuty(fake, 'DRV1');
  const { context, page, session } = await driverPage(browser, fake);
  await context.grantPermissions(['notifications']);
  // headless Chromium has no push service: a stand-in subscription with the shape of the real one
  await page.addInitScript(() => {
    const fake = {
      endpoint: 'https://push.example.test/send/abc',
      toJSON: () => ({
        endpoint: 'https://push.example.test/send/abc',
        keys: { p256dh: 'BPk3', auth: 'YXV0aA' },
      }),
    };
    PushManager.prototype.getSubscription = () => Promise.resolve(null);
    PushManager.prototype.subscribe = () => Promise.resolve(fake as unknown as PushSubscription);
  });
  await page.goto('/d/account');
  await controlled(page);
  await page.getByRole('button', { name: 'تفعيل الإشعارات' }).click();
  await expect
    .poll(() => fake.devices.get(session.deviceId as string)?.push_subscription ?? null)
    .toEqual({ endpoint: 'https://push.example.test/send/abc', keys: { p256dh: 'BPk3', auth: 'YXV0aA' } });
  const put = fake.callsTo('PUT /v1/me/devices/:deviceId').at(-1);
  expect(put?.body).toMatchObject({ notification_permission: 'granted' });

  // the worker posts `push.click` (what its notificationclick handler does): D-04 opens and reads its snapshot
  const homeReads = fake.callsTo('GET /v1/me/home').length;
  const [worker] = context.serviceWorkers();
  await worker!.evaluate(async () => {
    const scope = self as unknown as {
      clients: { matchAll(o: object): Promise<Array<{ postMessage(m: unknown): void }>> };
    };
    const clients = await scope.clients.matchAll({ type: 'window' });
    for (const client of clients)
      client.postMessage({ type: 'push.click', url: '/d', kind: 'offer', age_ms: 900 });
  });
  await expect(page).toHaveURL(/\/d$/);
  await expect.poll(() => fake.callsTo('GET /v1/me/home').length).toBeGreaterThan(homeReads);
  await context.close();
});
