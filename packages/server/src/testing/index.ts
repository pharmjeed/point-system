import { randomToken, sha256Hex } from '../core/crypto/crypto.js';
import type { Database } from '../core/db/database.js';

/**
 * Test helper: opens a session for a user directly in auth_sessions (no login round-trip) and returns the
 * cookie header value. Tests of modules other than identity use it; login itself is tested by PNT-011.
 */
export async function createSessionCookie(
  db: Pick<Database, 'query'>,
  userId: string,
  opts: { cookieName?: string; hours?: number; mfaVerified?: boolean; now?: Date } = {},
): Promise<{ cookie: string; token: string; sessionId: string }> {
  const token = randomToken(32);
  const now = opts.now ?? new Date();
  const r = await db.query<{ id: string }>(
    `INSERT INTO auth_sessions (org_id, user_id, token_hash, mfa_verified, created_at, last_seen_at, expires_at)
     SELECT org_id, id, $2, $3, $4, $4, $4::timestamptz + make_interval(hours => $5) FROM users WHERE id = $1
     RETURNING id`,
    [userId, sha256Hex(token), opts.mfaVerified ?? true, now, opts.hours ?? 12],
  );
  if (!r.rows[0]) throw new Error(`no user ${userId}`);
  return { cookie: `${opts.cookieName ?? 'point_sid'}=${token}`, token, sessionId: r.rows[0].id };
}

/**
 * The seed enables MFA only for OWN1/ADM1 (DEC-54) while security.supervisor_mfa_required defaults to true;
 * tests that act as a supervisor without going through MFA setup turn the requirement off explicitly.
 */
export async function setSupervisorMfaRequired(
  db: Pick<Database, 'query'>,
  orgId: string,
  required: boolean,
): Promise<void> {
  await db.query(
    `UPDATE organizations SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{security}',
       coalesce(settings->'security', '{}'::jsonb) || jsonb_build_object('supervisor_mfa_required', $2::boolean)) WHERE id = $1`,
    [orgId, required],
  );
}

export { startFreezeProxy, type FreezeProxy } from './freeze-proxy.js';
