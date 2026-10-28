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
