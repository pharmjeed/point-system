import type { DisplayMode, NotificationPermissionState } from '@/api/types';

/**
 * Device capabilities shown in the D-03 checklist (02 D-03): notification permission (iPhone needs the home
 * screen first), display mode and Screen Wake Lock support. Read-only helpers; requesting a permission
 * happens only from a tap (PNT-070 acceptance 2).
 */
export type NotificationCheck = 'off' | 'on' | 'denied' | 'unsupported' | 'needsInstall';

export function isIos(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua));
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const legacy = (navigator as unknown as { standalone?: boolean }).standalone === true;
  return legacy || (window.matchMedia?.('(display-mode: standalone)').matches ?? false);
}

export const displayMode = (): DisplayMode => (isStandalone() ? 'standalone' : 'browser');

export function notificationCheck(): NotificationCheck {
  if (isIos() && !isStandalone()) return 'needsInstall';
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  const p = Notification.permission;
  return p === 'granted' ? 'on' : p === 'denied' ? 'denied' : 'off';
}

/** Calls `Notification.requestPermission()` from the tap; old Safari uses the callback form. */
export async function requestNotifications(): Promise<NotificationCheck> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  try {
    const result = await new Promise<NotificationPermission>((resolve, reject) => {
      const maybe = Notification.requestPermission(resolve);
      if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject);
    });
    return result === 'granted' ? 'on' : result === 'denied' ? 'denied' : 'off';
  } catch {
    return notificationCheck();
  }
}

/** The device's permission as `devices.notification_permission` (07 `NotificationPermission`). */
export function permissionForServer(check: NotificationCheck): NotificationPermissionState {
  if (check === 'on') return 'granted';
  if (check === 'denied') return 'denied';
  if (check === 'unsupported') return 'unsupported';
  return 'default';
}

export function wakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}
