import { randomToken, safeEqual, sha256Hex } from '../crypto/crypto.js';
import type { Database } from '../db/database.js';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors/app-error.js';

type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;

/**
 * Who calls a `/v1/customer/*` route (V2-010, DEC-497): a customer account of the platform, loaded on every request
 * from the `Authorization: Bearer` access token. It carries no organization, venue, role or duty: a customer
 * account is never a member of an operator organization, so no staff or platform policy can accept it, and the
 * staff and platform guards never read this header (they read their own cookies only).
 */
export interface CustomerActorContext {
  kind: 'customer';
  sessionId: string;
  accountId: string;
  deviceId: string;
}

/**
 * Opaque customer tokens: `<kind>.<session id>.<256-bit secret>` (base64url). The session id lets the server find
 * the row without an index on the secret; only sha256 of the whole token is stored (`access_hash`,
 * `refresh_hash`). The two kinds have their own prefixes, so one can never stand in for the other.
 */
export const CUSTOMER_ACCESS_PREFIX = 'pca';
export const CUSTOMER_REFRESH_PREFIX = 'pcr';
/** The single-use re-verification proof of C-20 (V2-017, DEC-507), bound to one session like the other two. */
export const CUSTOMER_REAUTH_PREFIX = 'pcv';

export type CustomerTokenKind = 'access' | 'refresh' | 'reauth';
const PREFIX: Readonly<Record<CustomerTokenKind, string>> = {
  access: CUSTOMER_ACCESS_PREFIX,
  refresh: CUSTOMER_REFRESH_PREFIX,
  reauth: CUSTOMER_REAUTH_PREFIX,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function newCustomerToken(kind: CustomerTokenKind, sessionId: string): string {
  return `${PREFIX[kind]}.${sessionId}.${randomToken(32)}`;
}

/** The session id of a well-formed token of that kind, or null. */
export function customerTokenSession(
  kind: CustomerTokenKind,
  token: string | null | undefined,
): string | null {
  if (typeof token !== 'string' || token.length > 200) return null;
  const parts = token.split('.');
  const prefix = PREFIX[kind];
  if (
    parts.length !== 3 ||
    parts[0] !== prefix ||
    !UUID.test(parts[1]!) ||
    !/^[A-Za-z0-9_-]{43}$/.test(parts[2]!)
  )
    return null;
  return parts[1]!;
}

export const customerTokenHash = (token: string) => sha256Hex(token);

/** The Bearer token of a request header (`Authorization: Bearer <token>`), or null. */
export function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return null;
  const m = /^Bearer ([^\s]+)$/i.exec(value.trim());
  return m?.[1] ?? null;
}

interface CustomerSessionRow {
  session_id: string;
  account_id: string;
  device_id: string;
  access_hash: string;
  access_expires_at: Date;
  refresh_expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: string | null;
  last_seen_at: Date | null;
  status: 'active' | 'suspended' | 'deleted';
}

/**
 * Access token → customer_account_sessions → customer_accounts. Errors (DEC-482, DEC-497):
 * AUTH_UNAUTHENTICATED (no or malformed token, unknown session), AUTH_SESSION_REVOKED (revoked, or past the refresh
 * lifetime: signing in again is the only way back), AUTH_SESSION_EXPIRED (past its 15 minutes, or an access token
 * the last refresh replaced — a call that crossed a refresh in flight; the app refreshes once and retries),
 * ACCOUNT_DELETED (the current token of a deleted account, before the revocation the deletion wrote),
 * AUTH_ACCOUNT_DISABLED. It never reads a cookie: a staff or platform session is not a customer
 * session.
 */
export async function loadCustomerActor(
  q: Q,
  header: string | string[] | undefined,
  now: Date,
): Promise<CustomerActorContext> {
  const token = bearerToken(header);
  const sessionId = customerTokenSession('access', token);
  if (!token || !sessionId) throw new AppError('AUTH_UNAUTHENTICATED');
  const r = await q.query<CustomerSessionRow>(
    `SELECT s.id AS session_id, s.account_id, s.device_id, s.access_hash, s.access_expires_at, s.refresh_expires_at,
            s.revoked_at, s.revoked_reason, s.last_seen_at, a.status
       FROM customer_account_sessions s JOIN customer_accounts a ON a.id = s.account_id
      WHERE s.id = $1`,
    [sessionId],
  );
  const s = r.rows[0];
  if (!s) throw new AppError('AUTH_UNAUTHENTICATED');
  const hashMatches = safeEqual(customerTokenHash(token), s.access_hash);
  // a deleted account (C-20) revoked every session as it went: its own last token learns why (V2-017, DEC-508)
  if (s.status === 'deleted' && hashMatches) throw new AppError('ACCOUNT_DELETED');
  if (s.revoked_at) throw new AppError('AUTH_SESSION_REVOKED', { reason: s.revoked_reason ?? 'logout' });
  if (s.refresh_expires_at.getTime() <= now.getTime())
    throw new AppError('AUTH_SESSION_REVOKED', { reason: 'expired' });
  if (!hashMatches || s.access_expires_at.getTime() <= now.getTime())
    throw new AppError('AUTH_SESSION_EXPIRED');
  if (s.status === 'deleted') throw new AppError('ACCOUNT_DELETED');
  if (s.status !== 'active') throw new AppError('AUTH_ACCOUNT_DISABLED');
  return { kind: 'customer', sessionId: s.session_id, accountId: s.account_id, deviceId: s.device_id };
}

/** last_seen_at is refreshed at most once a minute, like the staff sessions (07 §1.2). */
export async function touchCustomerSession(q: Q, sessionId: string, now: Date): Promise<void> {
  await q.query(
    `UPDATE customer_account_sessions SET last_seen_at = $2
      WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < $2::timestamptz - interval '1 minute')`,
    [sessionId, now],
  );
}
