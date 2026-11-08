/**
 * Push notifications on the device (V2-016, DEC-519, DEC-520): `expo-notifications` 58.1.8, the version Expo SDK 58
 * bundles (`bundledNativeModules.json`). The token is an Expo push token for the build's EAS project
 * (`extra.eas.projectId`); the server sends through the Expo Push API (APNs / FCM). What arrives on the lock screen is
 * the server's generic text; the app reads only `data` (opaque ids) to open C-12.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { CustomerApi } from '../api/client';
import type { PushPermission } from '../features/push';

/** Notifications that arrive while the app is open are shown too (the live screen also updates by itself). */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function pushPermission(): Promise<PushPermission> {
  const p = await Notifications.getPermissionsAsync();
  return p.granted ? 'granted' : p.canAskAgain ? 'undetermined' : 'denied';
}

/** The Android channel the server names (`channelId: 'visits'`); iOS has none. */
async function ensureChannel(name: string): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('visits', {
    name,
    importance: Notifications.AndroidImportance.HIGH,
  });
}

export type EnableResult = 'enabled' | 'denied' | 'unavailable';

/**
 * Asks the OS (only now, after our own explanation), then registers this device's token for the session
 * (`POST /v1/customer/devices`). `unavailable`: the build has no EAS project, or the device cannot receive pushes
 * (an emulator without Google services).
 */
export async function enablePush(
  api: CustomerApi,
  o: { projectId: string | null; channelName: string; idempotencyKey: string },
): Promise<EnableResult> {
  if (!o.projectId) return 'unavailable';
  const current = await Notifications.getPermissionsAsync();
  const asked = current.granted ? current : await Notifications.requestPermissionsAsync();
  if (!asked.granted) return 'denied';
  await ensureChannel(o.channelName);
  let token: string;
  try {
    token = (await Notifications.getExpoPushTokenAsync({ projectId: o.projectId })).data;
  } catch {
    return 'unavailable';
  }
  await api.registerDevice({ provider: 'expo', push_token: token }, o.idempotencyKey);
  return 'enabled';
}

/** C-19 off: the server forgets the token of this session (the OS permission stays as the customer set it). */
export async function disablePush(api: CustomerApi, idempotencyKey: string): Promise<void> {
  await api.registerDevice({ provider: 'expo', push_token: null }, idempotencyKey);
}

/** A tapped notification (also the one that launched the app) → its `data`. Returns the unsubscribe. */
export function onNotificationTap(open: (data: unknown) => void): () => void {
  const last = Notifications.getLastNotificationResponse();
  if (last) open(last.notification.request.content.data);
  const sub = Notifications.addNotificationResponseReceivedListener((r) =>
    open(r.notification.request.content.data),
  );
  return () => sub.remove();
}
