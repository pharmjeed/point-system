import {
  PLATFORM_ROLE_PERMISSIONS,
  PLATFORM_SECURITY,
  hasPlatformPermission,
  type PlatformPermission,
  type PlatformRole,
} from '@point/shared';
import { sha256Hex } from '../crypto/crypto.js';
import type { Database } from '../db/database.js';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors/app-error.js';

type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;

/**
 * Who calls a `/v1/platform/*` route (V2-002, DEC-462): a platform account, loaded fresh on every request from the
 * platform cookie. It carries no organization, venue, duty or assignment: a platform account is never a member of
 * an operator organization, so no staff policy can ever accept it.
 */
export interface PlatformActorContext {
  kind: 'platform';
  sessionId: string;
  userId: string;
  role: PlatformRole;
  fullName: string;
  /** the temporary password of the bootstrap (or a reset) must be changed first */
  mustChangeSecret: boolean;
  /** MFA is mandatory: a session that has not passed TOTP (first sign-in before the set-up) is restricted */
  mfaVerified: boolean;
  mfaEnabled: boolean;
}

interface PlatformSessionRow {
  session_id: string;
  user_id: string;
  kind: 'session' | 'mfa_challenge';
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: string | null;
  last_seen_at: Date;
  mfa_verified: boolean;
  role: PlatformRole;
  status: 'active' | 'disabled';
  must_change_secret: boolean;
  mfa_enabled: boolean;
  full_name: string;
}

/**
 * Platform cookie token → platform_sessions (sha256) → platform_users. Errors in the canonical order of 08 §2 step 3:
 * PLATFORM_AUTH_REQUIRED (no cookie, unknown token, an MFA challenge or a consumed one), AUTH_SESSION_REVOKED,
 * AUTH_SESSION_EXPIRED (absolute or idle), AUTH_ACCOUNT_DISABLED. It never reads auth_sessions: a staff session
 * cookie is not a platform session (and the staff loader never reads platform_sessions).
 */
export async function loadPlatformActor(
  q: Q,
  token: string | undefined,
  now: Date,
): Promise<PlatformActorContext> {
  if (!token) throw new AppError('PLATFORM_AUTH_REQUIRED');
  const r = await q.query<PlatformSessionRow>(
    `SELECT s.id AS session_id, s.platform_user_id AS user_id, s.kind, s.expires_at, s.revoked_at, s.revoked_reason,
            s.last_seen_at, s.mfa_verified, u.role, u.status, u.must_change_secret, u.mfa_enabled, u.full_name
       FROM platform_sessions s JOIN platform_users u ON u.id = s.platform_user_id
      WHERE s.token_hash = $1`,
    [sha256Hex(token)],
  );
  const s = r.rows[0];
  if (!s || s.kind !== 'session') throw new AppError('PLATFORM_AUTH_REQUIRED');
  if (s.revoked_at) throw new AppError('AUTH_SESSION_REVOKED', { reason: s.revoked_reason ?? 'admin' });
  if (s.expires_at.getTime() <= now.getTime()) throw new AppError('AUTH_SESSION_EXPIRED');
  if (s.status !== 'active') throw new AppError('AUTH_ACCOUNT_DISABLED');
  if (now.getTime() - s.last_seen_at.getTime() > PLATFORM_SECURITY.idle_minutes * 60_000) {
    throw new AppError('AUTH_SESSION_EXPIRED', { reason: 'idle' });
  }
  // a session of an MFA-enabled account is only issued by /v1/platform/auth/mfa/verify (mfa_verified = true)
  if (s.mfa_enabled && !s.mfa_verified) throw new AppError('PLATFORM_AUTH_REQUIRED');
  return {
    kind: 'platform',
    sessionId: s.session_id,
    userId: s.user_id,
    role: s.role,
    fullName: s.full_name,
    mustChangeSecret: s.must_change_secret,
    mfaVerified: s.mfa_verified,
    mfaEnabled: s.mfa_enabled,
  };
}

/** A restricted platform session: only `platform.self` routes until the password is changed and TOTP set up. */
export function platformPending(a: Pick<PlatformActorContext, 'mustChangeSecret' | 'mfaVerified'>) {
  return [
    ...(a.mustChangeSecret ? (['secret_change'] as const) : []),
    ...(!a.mfaVerified ? (['mfa_setup'] as const) : []),
  ];
}

/** The platform permissions a session holds now: `platform.self` only while restricted. */
export function effectivePlatformPermissions(
  a: Pick<PlatformActorContext, 'role' | 'mustChangeSecret' | 'mfaVerified'>,
): PlatformPermission[] {
  if (platformPending(a).length) return ['platform.self'];
  return [...PLATFORM_ROLE_PERMISSIONS[a.role]];
}

export function assertPlatformPermission(a: PlatformActorContext, p: PlatformPermission): void {
  if (!hasPlatformPermission(a.role, p)) throw new AppError('PERMISSION_DENIED', { permission: p });
}

/** last_seen_at is refreshed at most once a minute, like the staff sessions (07 §1.2). */
export async function touchPlatformSession(q: Q, sessionId: string, now: Date): Promise<void> {
  await q.query(
    `UPDATE platform_sessions SET last_seen_at = $2
      WHERE id = $1 AND last_seen_at < $2::timestamptz - interval '1 minute'`,
    [sessionId, now],
  );
}
