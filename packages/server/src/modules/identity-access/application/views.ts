import { effectivePermissions, type ActorContext } from '../../../core/actor-context/actor-context.js';
import type { Env } from '../../../core/config/env.js';
import type { Tx } from '../../../core/db/tx.js';
import type { Database } from '../../../core/db/database.js';
import { maskPhone } from '../../../core/logging/redact.js';
import { parseOrgSettings, type Role } from '@point/shared';

type Q = Pick<Tx, 'query'> | Pick<Database, 'query'>;
const iso = (d: Date | string | null | undefined) => (d == null ? null : new Date(d).toISOString());

export interface UserRow {
  id: string;
  org_id: string;
  employee_code: string;
  full_name: string;
  phone_e164: string;
  role: Role;
  can_drive: boolean;
  status: 'active' | 'disabled';
  secret_kind: 'pin' | 'password';
  secret_hash: string;
  must_change_secret: boolean;
  mfa_enabled: boolean;
  mfa_secret_enc: string | null;
  mfa_last_step: number | null;
  failed_login_count: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  disabled_at: Date | null;
  disabled_reason: string | null;
  version: number;
  created_at: Date;
}

/** User schema (07). The full phone is visible to its owner and to admin/owner; masked for others (09 §5.2). */
export function userView(u: UserRow, opts: { fullPhone: boolean }) {
  return {
    id: u.id,
    employee_code: u.employee_code,
    full_name: u.full_name,
    phone_e164: opts.fullPhone ? u.phone_e164 : null,
    phone_masked: maskPhone(u.phone_e164),
    role: u.role,
    can_drive: u.can_drive,
    status: u.status,
    mfa_enabled: u.mfa_enabled,
    must_change_secret: u.must_change_secret,
    last_login_at: iso(u.last_login_at),
    disabled_at: iso(u.disabled_at),
    disabled_reason: u.disabled_reason,
    version: u.version,
    created_at: iso(u.created_at),
  };
}

export function canSeeFullPhone(viewer: Pick<ActorContext, 'userId' | 'role'>, subjectId: string): boolean {
  return viewer.userId === subjectId || viewer.role === 'admin' || viewer.role === 'owner';
}

export interface DeviceRow {
  id: string;
  label: string | null;
  platform: string;
  display_mode: string;
  notification_permission: string;
  push_endpoint: string | null;
  audio_tested_at: Date | null;
  audio_test_result: string | null;
  last_seen_at: Date | null;
  created_at: Date;
}

export function deviceView(d: DeviceRow) {
  return {
    id: d.id,
    label: d.label,
    platform: d.platform,
    display_mode: d.display_mode,
    notification_permission: d.notification_permission,
    push_subscribed: d.push_endpoint != null,
    audio_tested_at: iso(d.audio_tested_at),
    audio_test_result: d.audio_test_result,
    last_seen_at: iso(d.last_seen_at),
    created_at: iso(d.created_at),
  };
}

export function assignmentView(a: {
  id: string;
  driver_id: string;
  venue_id: string;
  venue_name_ar?: string | null;
  status: string;
  starts_at: Date;
  ends_at: Date | null;
  reason: string | null;
  transfer_id: string | null;
}) {
  return {
    id: a.id,
    driver_id: a.driver_id,
    venue_id: a.venue_id,
    venue_name_ar: a.venue_name_ar ?? undefined,
    status: a.status,
    starts_at: iso(a.starts_at),
    ends_at: iso(a.ends_at),
    reason: a.reason,
    transfer_id: a.transfer_id,
  };
}

/** Me schema (07): user, effective permissions, scopes, assignment, duty, driver state, session, brand, heartbeat. */
export async function buildMe(q: Q, env: Env, sessionId: string, userId: string) {
  // sequential: `q` may be a transaction client, which must not run concurrent queries
  const userRes = await q.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [userId]);
  const sessionRes = await q.query<{ expires_at: Date; mfa_verified: boolean; device_id: string | null }>(
    `SELECT expires_at, mfa_verified, device_id FROM auth_sessions WHERE id = $1`,
    [sessionId],
  );
  const scopes = await q.query(
    `SELECT id, scope_type, venue_id, granted_at FROM role_scopes WHERE user_id = $1 AND revoked_at IS NULL ORDER BY granted_at`,
    [userId],
  );
  const assignment = await q.query(
    `SELECT a.*, v.name_ar AS venue_name_ar FROM driver_assignments a JOIN venues v ON v.id = a.venue_id WHERE a.driver_id = $1 AND a.status = 'active'`,
    [userId],
  );
  const duty = await q.query(
    `SELECT d.*, s.driver_state FROM duty_sessions d LEFT JOIN v_driver_state s ON s.duty_session_id = d.id
      WHERE d.user_id = $1 AND d.status <> 'ended'`,
    [userId],
  );
  const orgRes = await q.query<{ settings: unknown }>(
    `SELECT o.settings FROM organizations o JOIN users u ON u.org_id = o.id WHERE u.id = $1`,
    [userId],
  );
  const u = userRes.rows[0]!;
  const session = sessionRes.rows[0];
  const settings = parseOrgSettings(orgRes.rows[0]?.settings ?? {});
  const mfaRequired =
    u.role === 'owner' ||
    u.role === 'admin' ||
    (u.role === 'supervisor' && settings.security.supervisor_mfa_required);
  const d = duty.rows[0];
  const a = assignment.rows[0];
  return {
    user: userView(u, { fullPhone: true }),
    permissions: effectivePermissions({ role: u.role, canDrive: u.can_drive }),
    scopes: scopes.rows.map((s: any) => ({
      id: s.id,
      scope_type: s.scope_type,
      venue_id: s.venue_id,
      granted_at: iso(s.granted_at),
    })),
    active_assignment: a ? assignmentView(a) : null,
    duty_session: d
      ? {
          id: d.id,
          user_id: d.user_id,
          shift_id: d.shift_id,
          venue_id: d.venue_id,
          dispatch_pool_id: d.dispatch_pool_id,
          status: d.status,
          started_at: iso(d.started_at),
          ended_at: iso(d.ended_at),
          end_reason: d.end_reason,
          available_since: iso(d.available_since),
          last_heartbeat_at: iso(d.last_heartbeat_at),
          connection_state: d.connection_state,
          version: d.version,
        }
      : null,
    driver_state: d ? (d.driver_state ?? null) : u.role === 'driver' || u.can_drive ? 'off_duty' : null,
    session: {
      expires_at: iso(session?.expires_at),
      mfa_verified: session?.mfa_verified ?? false,
      // the devices row this sign-in linked (09 §9.5): the id POST /v1/me/audio-test and
      // PUT /v1/me/devices/{deviceId} need (docs/progress/notes/s5-web.md DEC-PROPOSED-1)
      device_id: session?.device_id ?? null,
      restricted: u.must_change_secret || (mfaRequired && !u.mfa_enabled),
      // DEC-82: what the restricted session must do, in order
      pending: [
        ...(u.must_change_secret ? (['secret_change'] as const) : []),
        ...(mfaRequired && !u.mfa_enabled ? (['mfa_setup'] as const) : []),
      ],
    },
    brand: {
      staff_name_ar: env.BRAND_STAFF_NAME_AR,
      staff_name_en: env.BRAND_STAFF_NAME_EN,
      customer_name_ar: env.BRAND_CUSTOMER_NAME_AR,
    },
    heartbeat: {
      interval_s: settings.heartbeat.interval_s,
      uncertain_after_s: settings.heartbeat.uncertain_after_s,
      offline_after_s: settings.heartbeat.offline_after_s,
    },
  };
}
