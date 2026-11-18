import type { CookieOptions, Response } from 'express';
import { PLATFORM_SECURITY, type PlatformSessionRevokedReason } from '@point/shared';
import type { Env } from '../../../core/config/env.js';
import { randomToken, sha256Hex } from '../../../core/crypto/crypto.js';
import type { Tx } from '../../../core/db/tx.js';

export interface IssuedPlatformSession {
  id: string;
  token: string;
  expiresAt: Date;
}

interface ClientMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Platform sessions (DEC-462): an opaque 256-bit token in the platform cookie, only its sha256 in
 * platform_sessions. Lifetime PLATFORM_SECURITY.session_hours (DEC-464).
 */
export async function issuePlatformSession(
  tx: Tx,
  userId: string,
  opts: ClientMeta & { mfaVerified: boolean },
): Promise<IssuedPlatformSession> {
  const token = randomToken(32);
  const expiresAt = new Date(tx.now.getTime() + PLATFORM_SECURITY.session_hours * 3600_000);
  const r = await tx.one<{ id: string }>(
    `INSERT INTO platform_sessions (platform_user_id, kind, token_hash, mfa_verified, ip, user_agent, created_at, last_seen_at, expires_at)
     VALUES ($1, 'session', $2, $3, $4, $5, $6, $6, $7) RETURNING id`,
    [
      userId,
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

/** The 5-minute single-use step between the password and the TOTP code (never a session). Returns its token. */
export async function issuePlatformMfaChallenge(tx: Tx, userId: string, opts: ClientMeta): Promise<string> {
  const token = randomToken(32);
  await tx.query(
    `INSERT INTO platform_sessions (platform_user_id, kind, token_hash, mfa_verified, ip, user_agent, created_at, last_seen_at, expires_at)
     VALUES ($1, 'mfa_challenge', $2, false, $3, $4, $5, $5, $6)`,
    [
      userId,
      sha256Hex(token),
      opts.ip ?? null,
      opts.userAgent?.slice(0, 512) ?? null,
      tx.now,
      new Date(tx.now.getTime() + PLATFORM_SECURITY.mfa_challenge_minutes * 60_000),
    ],
  );
  return token;
}

/** Revokes the live sessions (and challenges) of a platform account; `onlySessionId` limits it to one. */
export async function revokePlatformSessions(
  tx: Tx,
  userId: string,
  reason: Exclude<PlatformSessionRevokedReason, 'consumed'>,
  opts: { onlySessionId?: string } = {},
): Promise<string[]> {
  const r = await tx.query<{ id: string }>(
    `UPDATE platform_sessions SET revoked_at = $2, revoked_reason = $3
      WHERE platform_user_id = $1 AND revoked_at IS NULL AND expires_at > $2
        AND ($4::uuid IS NULL OR id = $4)
      RETURNING id`,
    [userId, tx.now, reason, opts.onlySessionId ?? null],
  );
  return r.rows.map((x) => x.id);
}

function cookieOptions(env: Env): CookieOptions {
  // __Host- prefix rules: Secure, Path=/, no Domain (09 §9.3); SameSite=Strict: the console is never entered from
  // another site, and the staff cookie keeps Lax for the push-notification links
  return { httpOnly: true, secure: env.SESSION_COOKIE_SECURE, sameSite: 'strict', path: '/' };
}

export function setPlatformSessionCookie(res: Response, env: Env, s: IssuedPlatformSession): void {
  res.cookie(env.PLATFORM_SESSION_COOKIE_NAME, s.token, { ...cookieOptions(env), expires: s.expiresAt });
}

export function clearPlatformSessionCookie(res: Response, env: Env): void {
  res.clearCookie(env.PLATFORM_SESSION_COOKIE_NAME, cookieOptions(env));
}
