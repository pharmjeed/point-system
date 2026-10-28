import type { CookieOptions, Response } from 'express';
import { parseOrgSettings, type Role } from '@point/shared';
import type { Env } from '../../../core/config/env.js';
import { randomToken, sha256Hex } from '../../../core/crypto/crypto.js';
import type { Tx } from '../../../core/db/tx.js';

export interface IssuedSession {
  id: string;
  token: string;
  expiresAt: Date;
}

/**
 * Server-side sessions (DEC-09): an opaque 256-bit token in the cookie, only its sha256 stored. Lifetime from
 * org settings: security.driver_session_hours (14) for drivers, security.staff_session_hours (12) for staff.
 */
export async function issueSession(
  tx: Tx,
  user: { id: string; org_id: string; role: Role },
  opts: { mfaVerified: boolean; ip?: string | null; userAgent?: string | null; deviceId?: string | null },
): Promise<IssuedSession> {
  const org = await tx.one<{ settings: unknown }>(`SELECT settings FROM organizations WHERE id = $1`, [
    user.org_id,
  ]);
  const s = parseOrgSettings(org.settings ?? {});
  const hours = user.role === 'driver' ? s.security.driver_session_hours : s.security.staff_session_hours;
  const token = randomToken(32);
  const expiresAt = new Date(tx.now.getTime() + hours * 3600_000);
  const r = await tx.one<{ id: string }>(
    `INSERT INTO auth_sessions (org_id, user_id, device_id, token_hash, mfa_verified, ip, user_agent, created_at, last_seen_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9) RETURNING id`,
    [
      user.org_id,
      user.id,
      opts.deviceId ?? null,
      sha256Hex(token),
      opts.mfaVerified,
      opts.ip ?? null,
      opts.userAgent?.slice(0, 512) ?? null,
      tx.now,
      expiresAt,
    ],
  );
  return { id: r.id, token, expiresAt };
}

/** Revokes sessions of a user; `exceptSessionId` keeps one (e.g. the caller's). Returns the revoked ids. */
export async function revokeSessions(
  tx: Tx,
  userId: string,
  reason: 'logout' | 'transfer' | 'disabled' | 'secret_reset' | 'admin' | 'expired_cleanup',
  opts: { exceptSessionId?: string; onlySessionId?: string } = {},
): Promise<string[]> {
  const r = await tx.query<{ id: string }>(
    `UPDATE auth_sessions SET revoked_at = $2, revoked_reason = $3
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2
        AND ($4::uuid IS NULL OR id <> $4) AND ($5::uuid IS NULL OR id = $5)
      RETURNING id`,
    [userId, tx.now, reason, opts.exceptSessionId ?? null, opts.onlySessionId ?? null],
  );
  return r.rows.map((x) => x.id);
}

export function sessionCookieOptions(env: Env, expires: Date): CookieOptions {
  // __Host- prefix rules: Secure, Path=/, no Domain (09 §9.3)
  return { httpOnly: true, secure: env.SESSION_COOKIE_SECURE, sameSite: 'lax', path: '/', expires };
}

export function setSessionCookie(res: Response, env: Env, session: IssuedSession): void {
  res.cookie(env.SESSION_COOKIE_NAME, session.token, sessionCookieOptions(env, session.expiresAt));
}

export function clearSessionCookie(res: Response, env: Env): void {
  res.clearCookie(env.SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
  });
}

/** Guess the device platform from the user agent (devices.platform). */
export function platformFromUserAgent(
  ua: string | undefined | null,
): 'ios' | 'android' | 'desktop' | 'other' {
  if (!ua) return 'other';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Windows|Macintosh|Linux|CrOS/i.test(ua)) return 'desktop';
  return 'other';
}
