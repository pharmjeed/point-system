import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { actorPage } from './support/actors';
import { fakeOnly, uiSignIn } from './support/backend';
import { runOnlyAt390 } from './support/checks';
import { arrangeRetrieval, startDuty } from './support/driver';
import { createFake, type FakeServer } from './support/fake';

/**
 * PNT-070 (installable PWA, app-shell Service Worker) and the Service Worker half of PNT-072 (Web Push), in
 * Chromium with service workers allowed (the other specs block them so `page.route` sees every request):
 * the manifest and the installability report of Chrome (CDP `Page.getInstallabilityErrors`), the precache
 * of the shell without any `/v1` response, the shell from the cache when offline, a push delivered through
 * CDP shown with its tag and replaced quietly by `closed`, a tapped notification (`push.click`) opening its
 * screen with a resync, and the subscription sent with `PUT /v1/me/devices/{deviceId}`; the notifications
 * closed at sign-out and the held subscription re-linked at the next sign-in; and the D-15 و update flow
 * against a stubbed registration with a waiting worker.
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

test('PNT-070 AC1: installable — the brand manifest, a controlling Service Worker, no installability error', async () => {
  // a persistent profile: Playwright's ordinary contexts are off the record, where Chrome never installs
  const fake = createFake();
  const use = test.info().project.use;
  const context = await chromium.launchPersistentContext(test.info().outputPath('profile'), {
    ...(use.launchOptions ?? {}),
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
  const page = context.pages()[0] ?? (await context.newPage());
  await fake.attach(page, 'DRV1', { context: true });
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
  // the permission is already granted, but nothing reaches the device yet: 14 §5.1's line, then «إعداد»
  await expect(page.getByText('الإشعارات لا تصل لجهازك — أعد تفعيلها')).toBeVisible();
  await page.locator('#notifications-setup').click();
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

test('02 D-15 ج / PNT-072: sign-out closes the notifications shown; the next sign-in re-links the subscription the browser holds — no prompt, no new subscription', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const fake = createFake();
  const context = await pwaContext(browser);
  await context.grantPermissions(['notifications']);
  const page = await context.newPage();
  const session = await fake.attach(page, undefined, { context: true });
  // headless Chromium has no push service: the subscription an earlier shift created, held by the browser
  await page.addInitScript(() => {
    const held = {
      endpoint: 'https://push.example.test/send/held',
      toJSON: () => ({
        endpoint: 'https://push.example.test/send/held',
        keys: { p256dh: 'BHeld', auth: 'aGVsZA' },
      }),
    };
    const calls = { subscribe: 0, request: 0 };
    (window as unknown as { __push: typeof calls }).__push = calls;
    PushManager.prototype.getSubscription = () => Promise.resolve(held as unknown as PushSubscription);
    PushManager.prototype.subscribe = () => {
      calls.subscribe += 1;
      return Promise.resolve(held as unknown as PushSubscription);
    };
    const request = Notification.requestPermission.bind(Notification);
    Notification.requestPermission = (callback?: NotificationPermissionCallback) => {
      calls.request += 1;
      return request(callback);
    };
  });
  const endpointOf = (deviceId: string | null) =>
    (deviceId && fake.devices.get(deviceId)?.push_subscription?.endpoint) || null;

  // first sign-in: the frame sends the held subscription to the new device row
  await uiSignIn(page, 'DRV1');
  await controlled(page);
  const first = session.deviceId;
  await expect.poll(() => endpointOf(first)).toBe('https://push.example.test/send/held');

  // a request was notified meanwhile; signing out takes it out of the notification centre
  const deliver = await pushTarget(context, page);
  const task = crypto.randomUUID();
  await deliver({
    v: 1,
    kind: 'offer',
    tag: `task:${task}`,
    title: 'x',
    body: 'تذكرة 125 — افتح التطبيق للقبول',
    ticket_no: 125,
    task_id: task,
    offer_id: crypto.randomUUID(),
    url: '/d',
    renotify: true,
    silent: false,
    sent_at: new Date().toISOString(),
    expires_at: null,
  });
  await expect.poll(() => shownNotifications(page)).toHaveLength(1);
  await page.getByRole('button', { name: 'تسجيل الخروج' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect.poll(() => shownNotifications(page)).toHaveLength(0);

  // the next shift: a new device row, re-linked the same way
  await uiSignIn(page, 'DRV1');
  const second = session.deviceId;
  expect(second).not.toBe(first);
  await expect.poll(() => endpointOf(second)).toBe('https://push.example.test/send/held');
  expect(fake.callsTo('PUT /v1/me/devices/:deviceId').map((c) => c.path)).toEqual([
    `/v1/me/devices/${first}`,
    `/v1/me/devices/${second}`,
  ]);
  expect(await page.evaluate(() => (window as unknown as { __push: unknown }).__push)).toEqual({
    subscribe: 0,
    request: 0,
  });
  await context.close();
});

/**
 * A Service Worker container whose registration holds a waiting worker (a new version installed while the
 * current one controls the page). `SKIP_WAITING` is recorded in sessionStorage and answered with
 * `controllerchange`, as sw.js's `skipWaiting()` + `clients.claim()` do; after that reload nothing waits.
 */
async function stubWaitingWorker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const KEY = '__e2e_sw';
    type Log = { loads: number; skips: number };
    const read = (): Log => JSON.parse(sessionStorage.getItem(KEY) ?? '{"loads":0,"skips":0}') as Log;
    const write = (log: Log) => sessionStorage.setItem(KEY, JSON.stringify(log));
    const log = read();
    log.loads += 1;
    write(log);
    const listeners: Record<string, Array<(e: Event) => void>> = {};
    const noop = () => undefined;
    const script = `${location.origin}/sw.js`;
    const active = { scriptURL: script, state: 'activated', postMessage: noop, addEventListener: noop };
    const waiting =
      log.skips > 0
        ? null
        : {
            scriptURL: script,
            state: 'installed',
            addEventListener: noop,
            postMessage(message: { type?: string } | null) {
              if (message?.type !== 'SKIP_WAITING') return;
              const now = read();
              now.skips += 1;
              write(now);
              setTimeout(() => {
                for (const fn of listeners.controllerchange ?? []) fn(new Event('controllerchange'));
              }, 50);
            },
          };
    const registration = {
      scope: `${location.origin}/`,
      active,
      waiting,
      installing: null,
      addEventListener: noop,
      update: () => Promise.resolve(),
      getNotifications: () => Promise.resolve([]),
      pushManager: { getSubscription: () => Promise.resolve(null) },
    };
    const container = {
      controller: active,
      ready: Promise.resolve(registration),
      register: () => Promise.resolve(registration),
      getRegistration: () => Promise.resolve(registration),
      addEventListener(type: string, fn: (e: Event) => void) {
        (listeners[type] ??= []).push(fn);
      },
      removeEventListener: noop,
    };
    Object.defineProperty(Navigator.prototype, 'serviceWorker', { configurable: true, get: () => container });
  });
}

/** The worker log in sessionStorage; read again once the reload in flight settles (no destroyed context). */
async function swLog(page: Page): Promise<Record<string, number>> {
  const read = () =>
    page.evaluate(() => JSON.parse(sessionStorage.getItem('__e2e_sw') ?? '{}') as Record<string, number>);
  try {
    return await read();
  } catch {
    await page.waitForLoadState('load');
    return read();
  }
}

test('02 D-15 و: the update is not offered during a task; «تحديث الآن» posts SKIP_WAITING and reloads once', async ({
  browser,
}) => {
  const fake = createFake();
  fake.realtime.enable();
  startDuty(fake, 'DRV1');
  const r = arrangeRetrieval(fake, 'DRV1', 'accepted', { serial: '009701', keyTag: '199' });
  const { page } = await actorPage(browser, fake, 'DRV1');
  await stubWaitingWorker(page);
  await page.goto('/d');
  await expect(page.getByRole('heading', { name: 'الرئيسية' })).toBeVisible();
  const update = page.getByRole('status').filter({ hasText: /يتوفر تحديث ل/ });
  await page.waitForTimeout(500);
  await expect(update).toHaveCount(0); // a retrieval is in hand: never during a task (02 D-15 و)

  // the supervisor cancels the request: nothing in hand any more, the update is offered
  const cycle = fake.world.cycles.find((c) => c.ticket_id === r.ticketId && !c.closed_at)!;
  fake.exec(
    'SUP-R',
    'POST /v1/retrieval-cycles/:cycleId/cancel',
    { cycleId: cycle.id },
    { reason: 'العميل غيّر رأيه' },
  );
  await expect(update).toBeVisible({ timeout: 15_000 });
  expect(await swLog(page)).toEqual({ loads: 1, skips: 0 }); // never applied by itself
  await update.getByRole('button', { name: 'تحديث الآن' }).click();
  await expect.poll(() => swLog(page)).toEqual({ loads: 2, skips: 1 });
  await expect(page.getByRole('heading', { name: 'الرئيسية' })).toBeVisible();
  await page.waitForTimeout(500);
  expect(await swLog(page)).toEqual({ loads: 2, skips: 1 }); // one reload
  await expect(update).toHaveCount(0); // the new version runs: nothing waits any more
});

/** A stand-in push service: `subscribe` answers `endpoint`, `getSubscription` the one held (or none). */
async function stubPushManager(page: Page, held: string | null, created: string): Promise<void> {
  await page.addInitScript(
    ({ held, created }) => {
      const sub = (endpoint: string) => ({
        endpoint,
        toJSON: () => ({ endpoint, keys: { p256dh: 'BStaff', auth: 'c3RhZmY' } }),
      });
      const calls = { subscribe: 0, request: 0 };
      (window as unknown as { __push: typeof calls }).__push = calls;
      PushManager.prototype.getSubscription = () =>
        Promise.resolve((held ? sub(held) : null) as unknown as PushSubscription | null);
      PushManager.prototype.subscribe = () => {
        calls.subscribe += 1;
        return Promise.resolve(sub(created) as unknown as PushSubscription);
      };
      const request = Notification.requestPermission.bind(Notification);
      Notification.requestPermission = (callback?: NotificationPermissionCallback) => {
        calls.request += 1;
        return request(callback);
      };
    },
    { held, created },
  );
}
const pushCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __push: { subscribe: number; request: number } }).__push);

test('realtime:RT-5: staff (ADM1) subscribe from a tap in the menu; the next sign-in re-links the held subscription with no prompt', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const fake = createFake();
  const endpointOf = (deviceId: string | null) =>
    (deviceId && fake.devices.get(deviceId)?.push_subscription?.endpoint) || null;

  // first device: nothing held yet; nothing asked on load; the tap asks and subscribes
  const context = await pwaContext(browser);
  await context.grantPermissions(['notifications']);
  const page = await context.newPage();
  const session = await fake.attach(page, 'ADM1', { context: true });
  await stubPushManager(page, null, 'https://push.example.test/send/staff');
  await page.goto('/venues');
  await controlled(page);
  await expect(page.getByRole('heading', { name: /المواقع والحفلات/ })).toBeVisible();
  expect((await pushCalls(page)).request).toBe(0);
  await page.getByRole('button', { name: 'القائمة' }).click();
  const menu = page.getByRole('dialog', { name: 'القائمة' });
  await expect(menu.locator('[data-row="notifications"]')).toContainText('إشعارات الجهاز');
  await menu.getByRole('button', { name: /تفعيل الإشعارات|إعداد/ }).click();
  await expect.poll(() => endpointOf(session.deviceId)).toBe('https://push.example.test/send/staff');
  const put = fake.callsTo('PUT /v1/me/devices/:deviceId').at(-1);
  expect(put?.path).toBe(`/v1/me/devices/${session.deviceId}`);
  expect(put?.body).toMatchObject({ notification_permission: 'granted' });
  expect(await pushCalls(page)).toEqual({ subscribe: 1, request: 1 });
  await context.close();

  // the next sign-in (a new devices row): the frame sends the subscription the browser holds, no prompt
  const next = await pwaContext(browser);
  await next.grantPermissions(['notifications']);
  const again = await next.newPage();
  const second = await fake.attach(again, 'ADM1', { context: true });
  await stubPushManager(again, 'https://push.example.test/send/staff', 'https://push.example.test/send/new');
  await again.goto('/venues');
  await controlled(again);
  expect(second.deviceId).not.toBe(session.deviceId);
  await expect.poll(() => endpointOf(second.deviceId)).toBe('https://push.example.test/send/staff');
  expect(await pushCalls(again)).toEqual({ subscribe: 0, request: 0 });
  await next.close();
});
