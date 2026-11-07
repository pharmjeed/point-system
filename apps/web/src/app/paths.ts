import type { Me } from '@/api/types';
import type { StaffStep } from '@/stores/session';

/** Front-end routes, as approved in 02 §9.1 (+ two aliases kept for the orchestration brief). */
export const paths = {
  login: '/login', // D-01
  changeSecret: '/account/secret', // D-02
  sessionEnded: '/session-ended', // D-15 (c)
  staffLogin: '/staff/login', // S-01
  driverHome: '/d', // D-04
  driverStart: '/d/start', // D-03
  driverVehicles: '/d/vehicles', // D-12
  driverAccount: '/d/account', // D-14
  ops: '/ops', // S-02
  opsAlerts: '/ops/alerts', // S-04
  drivers: '/drivers', // S-05
  venues: '/venues', // S-08
  reports: '/reports', // S-11
  incidents: '/incidents', // S-12
  admin: '/admin', // S-13
  platform: '/platform', // P-01 (V2, docs/v2/02 §2)
  platformLogin: '/platform/login', // V2-002
  platformVenues: '/platform/venues', // P-04 (V2-004)
  platformOperators: '/platform/operators', // P-02 (V2-003); P-03 is /platform/operators/:orgId
  gallery: '/_gallery', // dev only (VITE_ENABLE_GALLERY)
} as const;

const STAFF_PREFIXES = [
  '/staff',
  '/ops',
  '/drivers',
  '/venues',
  '/events',
  '/reports',
  '/incidents',
  '/admin',
  '/s',
  '/platform',
];

/** P-03 — one operator of the platform console (V2-003). */
export const platformOperatorPath = (orgId: string) =>
  `${paths.platformOperators}/${encodeURIComponent(orgId)}`;

/** The V2 platform console: its own session and cookie; never the staff session handling (DEC-462). */
export function isPlatformArea(pathname: string): boolean {
  return pathname === paths.platform || pathname.startsWith(`${paths.platform}/`);
}

/** Which theme/shell area a path belongs to. Login, D-02 and D-15 are driver screens. */
export function areaOf(pathname: string): 'driver' | 'staff' {
  return STAFF_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ? 'staff' : 'driver';
}

export const isStaffRole = (me: Me) => me.user.role !== 'driver';

/** Driver shell: drivers, and supervisors with `can_drive` (DEC-22). */
export const canUseDriverShell = (me: Me) =>
  me.user.role === 'driver' || (me.user.role === 'supervisor' && !!me.user.can_drive);

export const hasOpenDuty = (me: Me) => !!me.duty_session && me.duty_session.status !== 'ended';

/** Permissions that open S-13 (canon §10; 02 §2.2 table). */
export const ADMIN_PERMISSIONS = [
  'staff.manage',
  'audit.read',
  'wa.channel_read',
  'wa.channel_manage',
  'wa.templates_manage',
  'retention.manage',
  'org.settings_manage',
  'venue.manage', // «ملف الموقع العام» (V2-004)
];

export const canAdmin = (me: Me) => me.permissions.some((p) => ADMIN_PERMISSIONS.includes(p));

/** The S-01 step a restricted staff session must finish: secret change first, then MFA setup (PNT-012). */
export function restrictedStaffStep(me: Me): Exclude<StaffStep, 'credentials' | 'mfa'> | null {
  if (me.user.role === 'driver') return null;
  const pending = me.session.pending;
  if (pending)
    return pending[0] === 'secret_change' ? 'password' : pending[0] === 'mfa_setup' ? 'mfa-setup' : null;
  // servers before DEC-82 do not send `pending`
  if (me.user.must_change_secret) return 'password';
  if (me.session.restricted) return 'mfa-setup';
  return null;
}

/**
 * Where a signed-in user goes (02 §2.1, D-01): driver → D-02 if the PIN must change, else D-04 with an
 * open duty, else D-03; staff → S-01 to finish a restricted session, else S-02.
 */
export function homePathFor(me: Me): string {
  if (me.user.role === 'driver') {
    if (me.user.must_change_secret) return paths.changeSecret;
    return hasOpenDuty(me) ? paths.driverHome : paths.driverStart;
  }
  if (restrictedStaffStep(me)) return paths.staffLogin;
  return paths.ops;
}
