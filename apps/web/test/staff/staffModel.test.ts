import { describe, expect, it } from 'vitest';
import type { StaffMember } from '@/api/types.staff';
import {
  canManageMember,
  creatableRoles,
  filterMembers,
  scopeChange,
  scopeText,
  staffActions,
} from '@/features/admin/staffModel';
import { meWith } from './fixtures';

/**
 * S-13 «الموظفون» (GAP-3) × canon §10 `staff.manage`: the administration manages supervisors only, the owner the
 * administration and the supervisors, nobody himself; the MFA reset is the owner's alone (09 §4.6, §9.1).
 */
const owner = meWith('owner');
const admin = meWith('admin');
const supervisor = meWith('supervisor');

const member = (id: string, over: Partial<StaffMember['user']> = {}, scopes: StaffMember['scopes'] = []) =>
  ({
    user: {
      id,
      employee_code: id.toUpperCase(),
      full_name: `موظف ${id}`,
      role: 'supervisor',
      status: 'active',
      mfa_enabled: true,
      version: 1,
      ...over,
    },
    scopes,
  }) as StaffMember;

describe('who manages whom', () => {
  it('creatable roles follow the caller', () => {
    expect(creatableRoles(owner)).toEqual(['supervisor', 'admin']);
    expect(creatableRoles(admin)).toEqual(['supervisor']);
    expect(creatableRoles(supervisor)).toEqual([]);
  });

  it('the administration manages supervisors only; nobody manages himself', () => {
    const sup = member('s-1');
    const adm = member('a-1', { role: 'admin' });
    expect(canManageMember(admin, sup)).toBe(true);
    expect(canManageMember(admin, adm)).toBe(false);
    expect(canManageMember(owner, adm)).toBe(true);
    expect(canManageMember(owner, sup)).toBe(true);
    expect(canManageMember(owner, member(owner.user.id, { role: 'admin' }))).toBe(false);
    expect(canManageMember(supervisor, sup)).toBe(false);
  });

  it('row actions: disable or enable by status; the MFA reset for the owner and an enabled MFA only', () => {
    const sup = member('s-1');
    expect(staffActions(admin, sup)).toEqual(['edit', 'scopes', 'disable']);
    expect(staffActions(owner, sup)).toEqual(['edit', 'scopes', 'disable', 'resetMfa']);
    expect(staffActions(owner, member('s-2', { status: 'disabled' }))).toEqual([
      'edit',
      'scopes',
      'enable',
      'resetMfa',
    ]);
    expect(staffActions(owner, member('s-3', { mfa_enabled: false }))).toEqual(['edit', 'scopes', 'disable']);
    expect(staffActions(admin, member('a-1', { role: 'admin' }))).toEqual([]);
  });
});

describe('scopes', () => {
  it('the grant/revoke body is the difference', () => {
    expect(scopeChange(['v-1', 'v-2'], ['v-2', 'v-3'])).toEqual({
      grant_venue_ids: ['v-3'],
      revoke_venue_ids: ['v-1'],
    });
    expect(scopeChange(['v-1'], ['v-1'])).toEqual({ grant_venue_ids: [], revoke_venue_ids: [] });
  });

  it('the scope line: «كل المواقع», the venue names, or «بلا نطاق»', () => {
    const venues = [
      { id: 'v-1', name_ar: 'قاعة ريماس' },
      { id: 'v-2', name_ar: 'قاعة ليالي' },
    ];
    const labels = { all: 'كل المواقع', none: 'بلا نطاق' };
    expect(scopeText([{ id: 'r', scope_type: 'org', venue_id: null }], venues, labels)).toBe('كل المواقع');
    expect(
      scopeText(
        [
          { id: 'r1', scope_type: 'venue', venue_id: 'v-1' },
          { id: 'r2', scope_type: 'venue', venue_id: 'v-2' },
        ],
        venues,
        labels,
      ),
    ).toBe('قاعة ريماس، قاعة ليالي');
    expect(scopeText([], venues, labels)).toBe('بلا نطاق');
  });
});

describe('filters', () => {
  it('role, status and a name or employee-code search; the administration first, then by name', () => {
    const list = [
      member('s-2', { full_name: 'ياسر' }),
      member('a-1', { role: 'admin', full_name: 'نورة' }),
      member('s-1', { full_name: 'أحمد', status: 'disabled' }),
    ];
    expect(filterMembers(list, { role: 'all', status: 'all', q: '' }).map((m) => m.user.id)).toEqual([
      'a-1',
      's-1',
      's-2',
    ]);
    expect(
      filterMembers(list, { role: 'supervisor', status: 'active', q: '' }).map((m) => m.user.id),
    ).toEqual(['s-2']);
    expect(filterMembers(list, { role: 'all', status: 'all', q: 'S-1' }).map((m) => m.user.id)).toEqual([
      's-1',
    ]);
  });
});
