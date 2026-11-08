/**
 * Web stand-in of ./notifications.ts, used ONLY by the store-screenshot export (V2-052, DEC-568): the customer app
 * ships on iOS and Android only, and expo-notifications has no web implementation of what the app uses. No push
 * is ever registered from here.
 */
import type { CustomerApi } from '../api/client';
import type { PushPermission } from '../features/push';

export type EnableResult = 'enabled' | 'denied' | 'unavailable';

export async function pushPermission(): Promise<PushPermission> {
  return 'undetermined';
}

export async function enablePush(
  _api: CustomerApi,
  _o: { projectId: string | null; channelName: string; idempotencyKey: string },
): Promise<EnableResult> {
  return 'unavailable';
}

export async function disablePush(api: CustomerApi, idempotencyKey: string): Promise<void> {
  await api.registerDevice({ provider: 'expo', push_token: null }, idempotencyKey);
}

export function onNotificationTap(_open: (data: unknown) => void): () => void {
  return () => {};
}
