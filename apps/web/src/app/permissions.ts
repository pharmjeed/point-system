import type { Me } from '@/api/types';

/**
 * Canon §10 permission names the screens check. The UI reads only `GET /v1/me` `permissions` (the
 * effective list for this user, D* included for a supervisor with `can_drive`); it hides what the user
 * cannot do, and the server checks every call anyway (07 §1.10) — hiding is never the protection.
 */
export type UiPermission =
  | 'venue.read'
  | 'venue.manage'
  | 'venue.layout_read'
  | 'event.manage'
  | 'shift.manage'
  | 'driver.read'
  | 'driver.manage'
  | 'driver.assign'
  | 'driver.transfer'
  | 'duty.self'
  | 'ticket.intake'
  | 'offer.accept'
  | 'task.execute'
  | 'handover.verify'
  | 'payment.record';

export function can(me: Pick<Me, 'permissions'>, permission: UiPermission): boolean {
  return me.permissions.includes(permission);
}

/** Every permission in the list. */
export function canAll(me: Pick<Me, 'permissions'>, ...permissions: UiPermission[]): boolean {
  return permissions.every((p) => me.permissions.includes(p));
}
