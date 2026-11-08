/**
 * Web stand-in of ./notifications.ts for the one web export (`export:web`, DEC-550 / DEC-551 as unified in DEC-568):
 * the e2e suite (V2-018) and the store screenshots (V2-052). The customer app ships on iOS and Android only, and
 * expo-notifications throws on web. Without an EAS project (the web export has none) the app behaves as such a build
 * does — «الإشعارات غير متاحة في هذه النسخة» on C-19, no offer on C-12 — and no push is ever registered or tapped
 * here. Push on devices stays with the Maestro flows (e2e/maestro, DEC-553).
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
