import { parseOrgSettings, type Role } from '@point/shared';
import type { Database } from '../db/database.js';
import type { Tx } from '../db/tx.js';
import { sha256Hex } from '../crypto/crypto.js';
import { AppError } from '../errors/app-error.js';
import type { ActorContext } from './actor-context.js';

type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;

interface SessionRow {
  session_id: string;
  user_id: string;
  org_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: string | null;
  last_seen_at: Date;
  mfa_verified: boolean;
  role: Role;
  can_drive: boolean;
  status: 'active' | 'disabled';
  must_change_secret: boolean;
  mfa_enabled: boolean;
  employee_code: string;
  full_name: string;
  org_settings: unknown;
}

/** MFA is mandatory for owner/admin and for supervisors when security.supervisor_mfa_required (DEC-09). */
export function mfaRequiredFor(role: Role, orgSettings: unknown): boolean {
  if (role === 'owner' || role === 'admin') return true;
  if (role === 'supervisor') return parseOrgSettings(orgSettings ?? {}).security.supervisor_mfa_required;
  return false;
}

/**
 * Cookie token → auth_sessions (sha256) → user → scopes, active assignment, open duty (04 §5.1, 09 §8.3).
 * Errors in the canonical order: AUTH_UNAUTHENTICATED, AUTH_SESSION_EXPIRED, AUTH_SESSION_REVOKED,
 * AUTH_ACCOUNT_DISABLED.
 */
export async function loadActor(q: Q, token: string | undefined, now: Date): Promise<ActorContext> {
  if (!token) throw new AppError('AUTH_UNAUTHENTICATED');
  const r = await q.query<SessionRow>(
    `SELECT s.id AS session_id, s.user_id, s.org_id, s.expires_at, s.revoked_at, s.revoked_reason, s.last_seen_at, s.mfa_verified,
            u.role, u.can_drive, u.status, u.must_change_secret, u.mfa_enabled, u.employee_code, u.full_name,
            o.settings AS org_settings
       FROM auth_sessions s JOIN users u ON u.id = s.user_id JOIN organizations o ON o.id = s.org_id
      WHERE s.token_hash = $1`,
    [sha256Hex(token)],
  );
  const s = r.rows[0];
  if (!s) throw new AppError('AUTH_UNAUTHENTICATED');
  if (s.revoked_at) {
    // a consumed MFA challenge row (revoked_reason NULL) is not a session
    if (!s.revoked_reason) throw new AppError('AUTH_UNAUTHENTICATED');
    throw new AppError('AUTH_SESSION_REVOKED', { reason: s.revoked_reason });
  }
  if (s.expires_at.getTime() <= now.getTime()) throw new AppError('AUTH_SESSION_EXPIRED');
  if (s.status !== 'active') throw new AppError('AUTH_ACCOUNT_DISABLED');
  const settings = parseOrgSettings(s.org_settings ?? {});
  if (
    (s.role === 'owner' || s.role === 'admin') &&
    now.getTime() - s.last_seen_at.getTime() > settings.security.admin_idle_minutes * 60_000
  ) {
    throw new AppError('AUTH_SESSION_EXPIRED', { reason: 'idle' });
  }
  const mfaRequired = mfaRequiredFor(s.role, s.org_settings);
  // a session of an MFA-enabled account is only issued after /v1/auth/mfa/verify (mfa_verified = true)
  if (s.mfa_enabled && !s.mfa_verified) throw new AppError('AUTH_UNAUTHENTICATED');

  // sequential on purpose: `q` may be a transaction client (no concurrent queries on one client)
  const scopes = await q.query<{ scope_type: 'org' | 'venue'; venue_id: string | null }>(
    `SELECT scope_type, venue_id FROM role_scopes WHERE user_id = $1 AND revoked_at IS NULL`,
    [s.user_id],
  );
  const assignment = await q.query<{ id: string; venue_id: string }>(
    `SELECT id, venue_id FROM driver_assignments WHERE driver_id = $1 AND status = 'active'`,
    [s.user_id],
  );
  const duty = await q.query<{
    id: string;
    venue_id: string;
    dispatch_pool_id: string;
    shift_id: string;
    status: 'on_duty' | 'on_break';
    version: number;
  }>(
    `SELECT id, venue_id, dispatch_pool_id, shift_id, status, version FROM duty_sessions WHERE user_id = $1 AND status <> 'ended'`,
    [s.user_id],
  );
  // 09 §4 rule 1: the owner and the admin reach nothing without an active `org` scope row (revoking it freezes
  // their access without deleting the account) — no role is exempt
  const orgScope = scopes.rows.some((x) => x.scope_type === 'org');
  const venueIds = new Set<string>();
  if (orgScope) {
    const v = await q.query<{ id: string }>(`SELECT id FROM venues WHERE org_id = $1`, [s.org_id]);
    for (const row of v.rows) venueIds.add(row.id);
  } else if (s.role === 'driver') {
    for (const a of assignment.rows) venueIds.add(a.venue_id);
  } else {
    for (const x of scopes.rows) if (x.venue_id) venueIds.add(x.venue_id);
  }
  const a = assignment.rows[0] ?? null;
  const d = duty.rows[0] ?? null;
  return {
    sessionId: s.session_id,
    userId: s.user_id,
    orgId: s.org_id,
    role: s.role,
    canDrive: s.can_drive,
    employeeCode: s.employee_code,
    fullName: s.full_name,
    venueIds,
    orgScope,
    assignment: a ? { id: a.id, venueId: a.venue_id } : null,
    duty: d
      ? {
          id: d.id,
          venueId: d.venue_id,
          poolId: d.dispatch_pool_id,
          shiftId: d.shift_id,
          status: d.status,
          version: d.version,
        }
      : null,
    mustChangeSecret: s.must_change_secret,
    secretKind: s.role === 'driver' ? 'pin' : 'password',
    mfaSetupRequired: mfaRequired && !s.mfa_enabled,
    venueId: a?.venue_id ?? [...venueIds][0] ?? null,
  };
}

/** last_seen_at is refreshed at most once a minute (07 §1.2). */
export async function touchSession(q: Q, sessionId: string, now: Date): Promise<void> {
  await q.query(
    `UPDATE auth_sessions SET last_seen_at = $2 WHERE id = $1 AND last_seen_at < $2::timestamptz - interval '1 minute'`,
    [sessionId, now],
  );
}
