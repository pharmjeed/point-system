import { useUpdateStore } from './updates';

/**
 * Service Worker registration (05 §15.2; PNT-070): production builds only, after the page loaded, scope `/`.
 * A worker that finishes installing while another controls the page is offered as «يتوفر تحديث» (applied by a
 * tap, ./updates.ts); the app also checks for one when it returns to the foreground. A `push.click` message
 * from the worker (a notification was tapped, 14 §6.4.5) is re-dispatched as the DOM event
 * `point:push-click`, which the router layer turns into a navigation and a full resync.
 */
export const PUSH_CLICK_EVENT = 'point:push-click';

function watch(registration: ServiceWorkerRegistration): void {
  const offer = (worker: ServiceWorker | null) => {
    if (worker && navigator.serviceWorker.controller) useUpdateStore.getState().setWaiting(worker);
  };
  offer(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    installing?.addEventListener('statechange', () => {
      if (installing.state === 'installed') offer(installing);
    });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void registration.update().catch(() => undefined);
  });
}

/**
 * 02 D-15 ج «عند الإبطال: … إغلاق أي إشعار نظامي قديم ممكن» (and sign-out, 02 D-14): the system
 * notifications this app's worker showed (tags `task:<id>` / `alert:<id>`) are closed, best effort — no
 * worker, no permission or no API simply leaves nothing to close.
 */
export async function closeShownNotifications(): Promise<number> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return 0;
    const registration = await navigator.serviceWorker.getRegistration('/');
    const shown = (await registration?.getNotifications()) ?? [];
    for (const notification of shown) notification.close();
    return shown.length;
  } catch {
    return 0;
  }
}

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string } | null;
    if (data?.type === 'push.click')
      window.dispatchEvent(new CustomEvent(PUSH_CLICK_EVENT, { detail: data }));
  });
  const start = () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then(watch)
      .catch(() => undefined); // blocked (private mode, tests): the app works without it
  };
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}
