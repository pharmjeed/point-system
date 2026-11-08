import type { ApiError } from '@/api/errors';
import type { RevokedReason } from '@/api/types';
import { d15, ui } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import type { SessionEnd } from '@/stores/session';
import { paths } from './paths';

export const SESSION_CODES = [
  'AUTH_UNAUTHENTICATED',
  'AUTH_SESSION_EXPIRED',
  'AUTH_SESSION_REVOKED',
] as const;

export function isSessionEndError(error: ApiError): boolean {
  return (SESSION_CODES as readonly string[]).includes(error.code);
}

/** AUTH_SESSION_REVOKED carries `details.reason` (= auth_sessions.revoked_reason) and the new venue on transfer. */
export function sessionEndFrom(error: ApiError): SessionEnd {
  if (error.code === 'AUTH_SESSION_REVOKED') {
    const reason =
      typeof error.details.reason === 'string' ? (error.details.reason as RevokedReason) : 'admin';
    const venue = error.details.venue_name_ar ?? error.details.venue_name;
    return { reason, venueName: typeof venue === 'string' ? venue : null };
  }
  if (error.code === 'AUTH_SESSION_EXPIRED') return { reason: 'expired' };
  return { reason: 'unauthenticated' };
}

/** 02 §1.6: a driver goes to D-15 (c); supervisors to S-01 with the reason line; no session → login. */
export function sessionEndPath(end: SessionEnd, area: 'driver' | 'staff'): string {
  if (area === 'staff') return paths.staffLogin;
  return end.reason === 'unauthenticated' ? paths.login : paths.sessionEnded;
}

/** The reason sentence of D-15 (c) (also the S-01 reason line). */
export function sessionEndText(end: SessionEnd | null): string {
  if (!end) return d15.sessionReason.expired;
  switch (end.reason) {
    case 'transfer':
      return end.venueName ? fmt(d15.sessionReason.transfer, { venue: end.venueName }) : ui.sessionRevoked;
    case 'disabled':
      return d15.sessionReason.disabled;
    case 'admin':
      return d15.sessionReason.admin;
    case 'expired':
    case 'expired_cleanup':
      return d15.sessionReason.expired;
    case 'unauthenticated':
      return ui.sessionExpired;
    default:
      return ui.sessionRevoked;
  }
}
