import { clickMessage, planNotification, type PushData } from './pushLogic';

/**
 * The Service Worker of the staff PWA (05 §15.2, 14 §6.4; PNT-070, PNT-072), built to `/sw.js` by the
 * `point-service-worker` plugin of vite.config.ts (which injects the precache list, a version and the staff
 * brand name for the quiet notifications — canon §1: the brand comes from the build configuration).
 *
 * - **Precache the app shell only** (HTML, JS, CSS, fonts, icons, sounds, manifest). Never a `/v1` response,
 *   never `/ws`, `/webhooks`, `/health`: no data is ever served from a cache, and no command runs offline.
 * - Navigations: network first, the cached shell when offline (the app then shows D-15 أ and waits).
 * - Updates: a new worker waits until the user taps «تحديث الآن» (`SKIP_WAITING`, 02 D-15 و).
 * - Push: every message shows a notification planned by ./pushLogic.ts; a click focuses the app (or opens
 *   `/d`) and posts `push.click`, after which the app reads its snapshot before enabling any button.
 *
 * Written without the `webworker` lib (the app's tsconfig is DOM): the few worker globals used are typed here.
 */
declare const __PRECACHE__: string[];
declare const __SW_VERSION__: string;
declare const __BRAND__: string;

interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
  respondWith(response: Promise<Response> | Response): void;
}
interface PushEvent extends ExtendableEvent {
  data: { text(): string } | null;
}
interface NotificationEvent extends ExtendableEvent {
  notification: Notification & { data?: Partial<PushData> };
}
interface WindowClientLike {
  url: string;
  focused: boolean;
  visibilityState: DocumentVisibilityState;
  focus(): Promise<WindowClientLike>;
  postMessage(message: unknown): void;
}
interface Registration {
  showNotification(title: string, options: NotificationOptions & { renotify?: boolean }): Promise<void>;
  getNotifications(filter?: { tag?: string }): Promise<Notification[]>;
}
interface WorkerScope {
  location: Location;
  registration: Registration;
  clients: {
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClientLike[]>;
    openWindow(url: string): Promise<WindowClientLike | null>;
    claim(): Promise<void>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  addEventListener(type: 'push', listener: (event: PushEvent) => void): void;
  addEventListener(type: 'notificationclick', listener: (event: NotificationEvent) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

const sw = self as unknown as WorkerScope;
const CACHE = `point-shell-${__SW_VERSION__}`;
const PRECACHE = new Set(__PRECACHE__);
/** Never cached, never answered from a cache (05 §15.2). */
const PASS_THROUGH = [/^\/v1\//, /^\/ws(\/|$)/, /^\/webhooks\//, /^\/health/, /^\/metrics/, /^\/__e2e/];

sw.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([...PRECACHE])));
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith('point-shell-') && key !== CACHE) await caches.delete(key);
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') void sw.skipWaiting();
});

sw.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin || PASS_THROUGH.some((re) => re.test(url.pathname))) return;
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match('/index.html')) ?? Response.error()),
    );
    return;
  }
  if (!PRECACHE.has(url.pathname)) return;
  event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
});

async function focusedVisibleWindow(): Promise<boolean> {
  const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return windows.some((w) => w.focused && w.visibilityState === 'visible');
}

function pushText(event: PushEvent): string | null {
  try {
    return event.data ? event.data.text() : null;
  } catch {
    return null;
  }
}

sw.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      const plan = planNotification(pushText(event), {
        now: Date.now(),
        brand: __BRAND__,
        focusedVisible: await focusedVisibleWindow(),
      });
      if (plan.closeTag)
        for (const shown of await sw.registration.getNotifications({ tag: plan.closeTag })) shown.close();
      await sw.registration.showNotification(plan.title, plan.options);
    })(),
  );
});

sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const message = clickMessage(event.notification.data, Date.now());
  event.waitUntil(
    (async () => {
      const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const app = windows.find((w) => new URL(w.url).origin === sw.location.origin);
      if (app) {
        await app.focus();
        app.postMessage(message);
        return;
      }
      await sw.clients.openWindow(message.url);
    })(),
  );
});
