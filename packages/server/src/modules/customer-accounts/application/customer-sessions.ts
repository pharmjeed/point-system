import {
  CUSTOMER_ACCESS_TTL_S,
  CUSTOMER_REFRESH_TTL_DAYS,
  type CustomerDevicePlatform,
  type CustomerTokens,
} from '@point/shared/customer';
import {
  customerTokenHash,
  customerTokenSession,
  newCustomerToken,
} from '../../../core/actor-context/customer-actor.js';
import { customerAudit } from '../../../core/audit/customer-audit.js';
import { newId } from '../../../core/crypto/ids.js';
import { safeEqual } from '../../../core/crypto/crypto.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';

const DAY_MS = 86_400_000;

interface SessionRow {
  id: string;
  account_id: string;
  device_id: string;
  refresh_hash: string;
  refresh_expires_at: Date;
  revoked_at: Date | null;
  status: 'active' | 'suspended' | 'deleted';
}

function tokensOf(
  access: string,
  refresh: string,
  accessExpiresAt: Date,
  refreshExpiresAt: Date,
): CustomerTokens {
  return {
    token_type: 'Bearer',
    access_token: access,
    access_expires_at: accessExpiresAt.toISOString(),
    refresh_token: refresh,
    refresh_expires_at: refreshExpiresAt.toISOString(),
  };
}

/**
 * A new session for an account on a device (V2-010, DEC-497): the previous live session of the same device is
 * revoked first (`signed_in_again`; uq_customer_sessions_live_device), then a pair of opaque tokens is issued.
 * The refresh token lives 60 days from the sign-in and is never extended (the contract of DEC-482).
 */
export async function issueCustomerSession(
  tx: Tx,
  accountId: string,
  device: { id: string; platform: CustomerDevicePlatform },
): Promise<{ sessionId: string; tokens: CustomerTokens }> {
  await tx.query(
    `UPDATE customer_account_sessions SET revoked_at = $3, revoked_reason = 'signed_in_again'
      WHERE account_id = $1 AND device_id = $2 AND revoked_at IS NULL`,
    [accountId, device.id, tx.now],
  );
  const id = newId();
  const access = newCustomerToken('access', id);
  const refresh = newCustomerToken('refresh', id);
  const accessExpiresAt = new Date(tx.now.getTime() + CUSTOMER_ACCESS_TTL_S * 1000);
  const refreshExpiresAt = new Date(tx.now.getTime() + CUSTOMER_REFRESH_TTL_DAYS * DAY_MS);
  await tx.query(
    `INSERT INTO customer_account_sessions (id, account_id, device_id, platform, refresh_hash, access_hash,
            access_expires_at, refresh_expires_at, created_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
    [
      id,
      accountId,
      device.id,
      device.platform,
      customerTokenHash(refresh),
      customerTokenHash(access),
      accessExpiresAt,
      refreshExpiresAt,
      tx.now,
    ],
  );
  return { sessionId: id, tokens: tokensOf(access, refresh, accessExpiresAt, refreshExpiresAt) };
}

/**
 * `POST /v1/customer/auth/refresh`: rotates both tokens. Anything but the current refresh token of a live session
 * of that device answers `401 AUTH_SESSION_REVOKED`; a token of a live session that is no longer its current one
 * (rotated away) or presented by another device revokes the session — whoever holds the stolen copy and the
 * device lose it together, and the device signs in again (theft detection, DEC-482). The revocation commits
 * although the request is refused (`keepEffects`).
 */
export async function refreshCustomerSession(
  tx: Tx,
  body: { refresh_token: string; device_id: string },
  client: ClientInfo,
): Promise<CustomerTokens> {
  const sessionId = customerTokenSession('refresh', body.refresh_token);
  if (!sessionId) throw new AppError('AUTH_SESSION_REVOKED', { reason: 'unknown' });
  const s = await tx.maybeOne<SessionRow>(
    `SELECT s.id, s.account_id, s.device_id, s.refresh_hash, s.refresh_expires_at, s.revoked_at, a.status
       FROM customer_account_sessions s JOIN customer_accounts a ON a.id = s.account_id
      WHERE s.id = $1 FOR NO KEY UPDATE OF s`,
    [sessionId],
  );
  if (!s || s.revoked_at) throw new AppError('AUTH_SESSION_REVOKED', { reason: s ? 'revoked' : 'unknown' });
  if (s.refresh_expires_at.getTime() <= tx.now.getTime())
    throw new AppError('AUTH_SESSION_REVOKED', { reason: 'expired' });
  const reuse = !safeEqual(customerTokenHash(body.refresh_token), s.refresh_hash);
  if (reuse || s.device_id !== body.device_id) {
    const reason = reuse ? 'refresh_reuse' : 'device_mismatch';
    await tx.query(
      `UPDATE customer_account_sessions SET revoked_at = $2, revoked_reason = $3 WHERE id = $1 AND revoked_at IS NULL`,
      [s.id, tx.now, reason],
    );
    await customerAudit(tx, {
      actor: { type: 'system', name: 'customer.session_guard' },
      accountId: s.account_id,
      action: 'customer.session.revoked',
      entityType: 'customer_account_session',
      entityId: s.id,
      requestId: client.requestId,
      ip: client.ip ?? null,
      userAgent: client.userAgent ?? null,
      metadata: { reason },
    });
    throw new AppError('AUTH_SESSION_REVOKED', { reason }, { keepEffects: true });
  }
  if (s.status === 'deleted') throw new AppError('ACCOUNT_DELETED');
  if (s.status !== 'active') throw new AppError('AUTH_ACCOUNT_DISABLED');
  const access = newCustomerToken('access', s.id);
  const refresh = newCustomerToken('refresh', s.id);
  const accessExpiresAt = new Date(tx.now.getTime() + CUSTOMER_ACCESS_TTL_S * 1000);
  await tx.query(
    `UPDATE customer_account_sessions SET refresh_hash = $2, access_hash = $3, access_expires_at = $4,
            rotation_count = rotation_count + 1, refreshed_at = $5, last_seen_at = $5
      WHERE id = $1`,
    [s.id, customerTokenHash(refresh), customerTokenHash(access), accessExpiresAt, tx.now],
  );
  return tokensOf(access, refresh, accessExpiresAt, s.refresh_expires_at);
}

/**
 * `POST /v1/customer/auth/logout` (Bearer): revokes the caller's session when the refresh token is its own. A
 * refresh token of another session is ignored (one device never signs another out); the answer is the same.
 */
export async function logoutCustomer(
  tx: Tx,
  actor: { sessionId: string; accountId: string },
  body: { refresh_token: string },
  client: ClientInfo,
): Promise<{ logged_out: true }> {
  const own = customerTokenSession('refresh', body.refresh_token) === actor.sessionId;
  const r = own
    ? await tx.query(
        `UPDATE customer_account_sessions SET revoked_at = $2, revoked_reason = 'logout'
          WHERE id = $1 AND revoked_at IS NULL AND refresh_hash = $3`,
        [actor.sessionId, tx.now, customerTokenHash(body.refresh_token)],
      )
    : { rowCount: 0 };
  await customerAudit(tx, {
    actor: { type: 'customer', accountId: actor.accountId },
    action: 'customer.auth.logout',
    entityType: 'customer_account_session',
    entityId: actor.sessionId,
    requestId: client.requestId,
    ip: client.ip ?? null,
    userAgent: client.userAgent ?? null,
    metadata: { revoked: (r.rowCount ?? 0) > 0 },
  });
  return { logged_out: true };
}
