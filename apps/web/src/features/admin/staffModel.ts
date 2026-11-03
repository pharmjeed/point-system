import type { Me, RoleScope, Venue } from '@/api/types';
import type { StaffMember } from '@/api/types.staff';

/**
 * S-13 «الموظفون» rules (02 §2.2 table, canon §10 `staff.manage`, 09 §4.6): the administration manages supervisors
 * only, the owner manages the administration and the supervisors; nobody manages himself; the MFA reset is the
 * owner's alone and only for an admin or a supervisor; `can_drive` and venue scopes are for supervisors, the org
 * scope for the administration. The server re-checks every one of them (PERMISSION_DENIED otherwise).
 */
export type StaffRole = 'admin' | 'supervisor';
export type StaffAction = 'edit' | 'scopes' | 'disable' | 'enable' | 'resetMfa';

export const canManageStaff = (me: Pick<Me, 'permissions'>) => me.permissions.includes('staff.manage');

/** The roles this account may create (`POST /v1/staff` `role`). */
export function creatableRoles(me: Pick<Me, 'permissions' | 'user'>): StaffRole[] {
  if (!canManageStaff(me)) return [];
  if (me.user.role === 'owner') return ['supervisor', 'admin'];
  if (me.user.role === 'admin') return ['supervisor'];
  return [];
}

export function canManageMember(me: Pick<Me, 'permissions' | 'user'>, member: StaffMember): boolean {
  if (member.user.id === me.user.id) return false;
  const role = member.user.role;
  return (role === 'admin' || role === 'supervisor') && creatableRoles(me).includes(role);
}

/** The actions offered on one row, in the order of the row's sheet. */
export function staffActions(me: Pick<Me, 'permissions' | 'user'>, member: StaffMember): StaffAction[] {
  if (!canManageMember(me, member)) return [];
  const out: StaffAction[] = ['edit', 'scopes'];
  out.push(member.user.status === 'active' ? 'disable' : 'enable');
  if (me.user.role === 'owner' && member.user.mfa_enabled) out.push('resetMfa');
  return out;
}

export const hasOrgScope = (scopes: readonly RoleScope[]) => scopes.some((s) => s.scope_type === 'org');

export const venueScopeIds = (scopes: readonly RoleScope[]) =>
  scopes.filter((s) => s.scope_type === 'venue' && s.venue_id).map((s) => s.venue_id as string);

/** The `POST /v1/staff/{userId}/scopes` body that turns `current` into `next` (venue ids). */
export function scopeChange(current: readonly string[], next: readonly string[]) {
  const before = new Set(current);
  const after = new Set(next);
  return {
    grant_venue_ids: [...after].filter((v) => !before.has(v)),
    revoke_venue_ids: [...before].filter((v) => !after.has(v)),
  };
}

/** «كل المواقع» for the org scope, else the venue names (unknown ids kept short), or «بلا نطاق». */
export function scopeText(
  scopes: readonly RoleScope[],
  venues: readonly Pick<Venue, 'id' | 'name_ar'>[],
  labels: { all: string; none: string },
): string {
  if (hasOrgScope(scopes)) return labels.all;
  const names = venueScopeIds(scopes).map((id) => venues.find((v) => v.id === id)?.name_ar ?? id.slice(0, 8));
  return names.length ? names.join('، ') : labels.none;
}

export interface StaffFilters {
  role: 'all' | StaffRole;
  status: 'all' | 'active' | 'disabled';
  q: string;
}

/** Name or employee code (case-insensitive); the list is ordered by role then name. */
export function filterMembers(list: readonly StaffMember[], f: StaffFilters): StaffMember[] {
  const q = f.q.trim().toLowerCase();
  return list
    .filter((m) => f.role === 'all' || m.user.role === f.role)
    .filter((m) => f.status === 'all' || m.user.status === f.status)
    .filter(
      (m) =>
        !q || m.user.full_name.toLowerCase().includes(q) || m.user.employee_code.toLowerCase().includes(q),
    )
    .sort(
      (a, b) =>
        (a.user.role === b.user.role ? 0 : a.user.role === 'admin' ? -1 : 1) ||
        a.user.full_name.localeCompare(b.user.full_name, 'ar'),
    );
}
