/**
 * Wire shapes of 07_openapi.yaml built from the fake world (field names exactly as the contract).
 */
import { fakeNowMs } from './http';
import type { FAssignment, FDuty, FEvent, FShift, FUser, FVenue } from './model';
import type { FakeServer, Session } from './server';

export function mask(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  const national = digits.startsWith('966') ? `0${digits.slice(3)}` : digits;
  return `${national.slice(0, 2)}•••••${national.slice(-3)}`;
}

export function userView(u: FUser, viewer: FUser | null) {
  const full = !!viewer && (viewer.id === u.id || viewer.role === 'admin' || viewer.role === 'owner');
  return {
    id: u.id,
    employee_code: u.employee_code,
    full_name: u.full_name,
    phone_e164: full ? u.phone_e164 : null,
    phone_masked: mask(u.phone_e164),
    role: u.role,
    can_drive: u.can_drive,
    status: u.status,
    mfa_enabled: u.role === 'owner' || u.role === 'admin',
    must_change_secret: u.must_change_secret,
    last_login_at: null,
    disabled_at: u.disabled_at,
    disabled_reason: u.disabled_reason,
    version: u.version,
    created_at: u.created_at,
  };
}

export const userRef = (u: FUser | undefined | null) =>
  u ? { id: u.id, full_name: u.full_name, employee_code: u.employee_code } : null;

export function assignmentView(s: FakeServer, a: FAssignment) {
  return {
    id: a.id,
    driver_id: a.driver_id,
    venue_id: a.venue_id,
    venue_name_ar: s.world.venues.find((v) => v.id === a.venue_id)?.name_ar,
    status: a.status,
    starts_at: a.starts_at,
    ends_at: a.ends_at,
    reason: a.reason,
    transfer_id: null,
  };
}

export function dutyView(d: FDuty) {
  return {
    id: d.id,
    user_id: d.user_id,
    shift_id: d.shift_id,
    venue_id: d.venue_id,
    dispatch_pool_id: d.dispatch_pool_id,
    status: d.status,
    started_at: d.started_at,
    ended_at: d.ended_at,
    end_reason: d.end_reason,
    available_since: d.available_since,
    last_heartbeat_at: null,
    connection_state: 'online',
    version: d.version,
  };
}

export function openDuty(s: FakeServer, userId: string): FDuty | null {
  return s.world.duties.find((d) => d.user_id === userId && d.status !== 'ended') ?? null;
}

/** Derived driver state (canon §5.6): never stored. */
export function driverState(s: FakeServer, userId: string) {
  const duty = openDuty(s, userId);
  if (!duty) return 'off_duty' as const;
  if (duty.status === 'on_break') return 'on_break' as const;
  const mine = s.world.tasks.filter((t) => t.assignee_id === userId);
  const active = mine.find((t) => t.status === 'accepted' || t.status === 'in_progress');
  const next = mine.find((t) => t.status === 'assigned_waiting');
  if (!active) return 'available' as const;
  if (next) return 'busy_with_next' as const;
  return active.type === 'retrieve' ? ('retrieving' as const) : ('intake_parking' as const);
}

export function meView(s: FakeServer, u: FUser, session?: Session) {
  const a = s.activeAssignment(u.id);
  const duty = openDuty(s, u.id);
  const drives = u.role === 'driver' || (u.role === 'supervisor' && u.can_drive);
  return {
    user: userView(u, u),
    permissions: s.permissionsOf(u),
    scopes: u.scopes.map((scope, i) => ({
      id: `${u.id}-scope-${i}`,
      scope_type: scope === 'org' ? 'org' : 'venue',
      venue_id: scope === 'org' ? null : scope,
    })),
    active_assignment: a ? assignmentView(s, a) : null,
    duty_session: duty ? dutyView(duty) : null,
    driver_state: drives ? driverState(s, u.id) : null,
    session: {
      expires_at: new Date(fakeNowMs() + 12 * 3600_000).toISOString(),
      mfa_verified: true,
      restricted: u.must_change_secret,
      pending: u.must_change_secret ? ['secret_change'] : [],
      device_id: session?.deviceId ?? null,
    },
    // no brand literals in e2e support (canon §1): a spec sets them, else the app falls back to VITE_BRAND_*
    brand: { ...s.brand },
    heartbeat: { interval_s: 15, uncertain_after_s: 45, offline_after_s: 120 },
  };
}

export const venueView = (v: FVenue) => ({
  id: v.id,
  code: v.code,
  name_ar: v.name_ar,
  name_en: v.name_en,
  address: v.address,
  city: v.city,
  timezone: v.timezone,
  status: v.status,
  default_dispatch_pool_id: v.default_dispatch_pool_id,
  version: v.version,
  created_at: v.created_at,
});

export const eventView = (e: FEvent) => {
  const { next_display_number: _next, ...rest } = e;
  return {
    ...rest,
    closing_started_at: null,
    closed_at: null,
    close_summary: null,
  };
};

export const shiftView = (sh: FShift) => ({ ...sh });

export function driverListItem(s: FakeServer, u: FUser, viewer: FUser | null) {
  const a = s.activeAssignment(u.id);
  const duty = openDuty(s, u.id);
  const state = driverState(s, u.id);
  const tasks = s.world.tasks.filter((t) => t.assignee_id === u.id);
  return {
    user: userView(u, viewer),
    active_assignment: a ? assignmentView(s, a) : null,
    live: {
      driver: userRef(u),
      driver_state: state,
      connection_state: duty ? 'online' : null,
      last_heartbeat_at: null,
      available_since: duty?.available_since ?? null,
      active_task_id: tasks.find((t) => t.status === 'accepted' || t.status === 'in_progress')?.id ?? null,
      next_task_id: tasks.find((t) => t.status === 'assigned_waiting')?.id ?? null,
      duty_started_at: duty?.started_at ?? null,
    },
  };
}
