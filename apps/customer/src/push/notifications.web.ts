/**
 * The e2e web export (V2-018, DEC-551) resolves this file instead of ./notifications.ts: push is native-only
 * (APNs / FCM through Expo, V2-016) and expo-notifications throws on web. The web build behaves like a build
 * without an EAS project — «الإشعارات غير متاحة في هذه النسخة» on C-19, no offer on C-12 — and never taps a
 * notification. The device flows of push stay with the Maestro flows (e2e/maestro, DEC-553).
 */
import type { CustomerApi } from '../api/client';
import type { PushPermission } from '../features/push';

export type EnableResult = 'enabled' | 'denied' | 'unavailable';

export async function pushPermission(): Promise<PushPermission> {
  return 'denied';
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
