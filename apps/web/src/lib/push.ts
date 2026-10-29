import type { PushSubscriptionBody } from '@/api/field';

/**
 * Web Push subscription of this device (05 §15.3, 14 §6.4.1; PNT-072): only after a direct tap granted the
 * permission, with `userVisibleOnly: true` and the VAPID public key of the build (`VITE_VAPID_PUBLIC_KEY`);
 * the result is sent with `PUT /v1/me/devices/{deviceId}`. Without a key, a Service Worker or the Push API
 * (iPhone outside the home screen, an old browser) there is no subscription and the app stays in the in-page
 * alert mode (AC-22) — never an error.
 */
export function vapidPublicKey(): string | null {
  const key = (import.meta.env.VITE_VAPID_PUBLIC_KEY ?? '').trim();
  return key || null;
}

/** RFC 8292 keys are URL-safe base64 without padding; the Push API wants the raw bytes. */
export function urlBase64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** `PushSubscription.toJSON()` → the 07 body; null when a key is missing. */
export function subscriptionBody(json: PushSubscriptionJSON | null | undefined): PushSubscriptionBody | null {
  const endpoint = json?.endpoint;
  const p256dh = json?.keys?.p256dh;
  const auth = json?.keys?.auth;
  if (!endpoint || !p256dh || !auth) return null;
  return { endpoint, keys: { p256dh, auth } };
}

export function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window
  );
}

const READY_TIMEOUT_MS = 5000;

async function readyRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  const existing = await navigator.serviceWorker.getRegistration('/').catch(() => undefined);
  if (!existing) return null; // development builds and blocked workers: no Service Worker
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), READY_TIMEOUT_MS)),
  ]);
}

/** Subscribes (or reuses the subscription) once the permission is granted; null when not possible. */
export async function subscribePush(): Promise<PushSubscriptionBody | null> {
  const key = vapidPublicKey();
  if (!key || typeof Notification === 'undefined' || Notification.permission !== 'granted') return null;
  const registration = await readyRegistration();
  if (!registration) return null;
  try {
    const current = await registration.pushManager.getSubscription();
    const subscription =
      current ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBytes(key),
      }));
    return subscriptionBody(subscription.toJSON());
  } catch {
    return null; // the push service refused (offline, no FCM): in-page alerts only
  }
}
