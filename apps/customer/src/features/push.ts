/**
 * Push notifications in the app (V2-016, DEC-519, DEC-520), the pure part: where a tapped notification leads, and
 * when to ask for the permission. The native part (expo-notifications) is ../push/notifications.ts.
 *
 * The permission is asked at the right moment, never at launch: on C-12 when the customer has a visit (that is when
 * «سيارتك جاهزة» is worth something) — once, with our own explanation first — or from C-19 «الإشعارات» at any time.
 */
import { CustomerPushDataSchema } from '@point/shared/customer';

export type PushPermission = 'granted' | 'denied' | 'undetermined';

/** A tapped notification → the screen to open (C-12 of the visit), or null for anything we did not send. */
export function pushRoute(
  data: unknown,
): { pathname: '/visit/[ticketId]'; params: { ticketId: string } } | null {
  const r = CustomerPushDataSchema.safeParse(data);
  return r.success ? { pathname: '/visit/[ticketId]', params: { ticketId: r.data.visit_id } } : null;
}

/** C-12's offer card: a visit is open, the build can receive pushes, the OS has not been asked, we did not offer yet. */
export function shouldOfferPush(s: {
  available: boolean;
  permission: PushPermission;
  offered: boolean;
  visitOpen: boolean;
}): boolean {
  return s.available && s.visitOpen && !s.offered && s.permission === 'undetermined';
}

export type PushSettingState = 'on' | 'off' | 'blocked' | 'unavailable';

/** C-19 «الإشعارات»: on (registered), off, blocked in the OS settings, or not available in this build. */
export function pushSettingState(s: {
  available: boolean;
  permission: PushPermission;
  registered: boolean;
}): PushSettingState {
  if (!s.available) return 'unavailable';
  if (s.permission === 'denied') return 'blocked';
  return s.permission === 'granted' && s.registered ? 'on' : 'off';
}
