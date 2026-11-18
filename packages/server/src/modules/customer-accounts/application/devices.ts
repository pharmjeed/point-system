import type { CustomerDevice, CustomerDeviceBody } from '@point/shared/customer';
import type { CustomerActorContext } from '../../../core/actor-context/customer-actor.js';
import { customerAudit } from '../../../core/audit/customer-audit.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { lockCustomerAccount } from './account-service.js';

/**
 * `POST /v1/customer/devices` (V2-016, DEC-519): the Expo push token of the calling session's device — registered or
 * replaced (`push_token`), or removed (`null`, C-19 «الإشعارات» off). One token lives on one live session only
 * (`uq_customer_sessions_push_token`): a token another session still holds (the same phone signed in to another
 * account, a reinstall) moves here, so a device never receives the pushes of an account it left. Sign-out and the
 * account deletion drop it with the session (`ck_customer_sessions_revoked_push`). The token is never returned,
 * logged or written to the trail (only whether one is registered).
 */
export async function registerCustomerDevice(
  tx: Tx,
  actor: CustomerActorContext,
  body: CustomerDeviceBody,
  client: ClientInfo,
): Promise<CustomerDevice> {
  await lockCustomerAccount(tx, actor.accountId);
  const session = await tx.maybeOne<{ id: string; push_token: string | null }>(
    `SELECT id, push_token FROM customer_account_sessions
      WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL FOR NO KEY UPDATE`,
    [actor.sessionId, actor.accountId],
  );
  if (!session) throw new AppError('AUTH_SESSION_REVOKED', { reason: 'revoked' });
  let moved = 0;
  if (body.push_token) {
    const r = await tx.query(
      `UPDATE customer_account_sessions SET push_token = NULL, push_provider = NULL, push_registered_at = NULL
        WHERE push_token = $1 AND id <> $2`,
      [body.push_token, session.id],
    );
    moved = r.rowCount ?? 0;
  }
  const row = await tx.one<{ push_provider: 'expo' | null; push_registered_at: Date | null }>(
    `UPDATE customer_account_sessions
        SET push_token = $2, push_provider = $3, push_registered_at = $4
      WHERE id = $1 RETURNING push_provider, push_registered_at`,
    [session.id, body.push_token, body.push_token ? body.provider : null, body.push_token ? tx.now : null],
  );
  await customerAudit(tx, {
    actor: { type: 'customer', accountId: actor.accountId },
    action: body.push_token ? 'customer.device.push_registered' : 'customer.device.push_removed',
    entityType: 'customer_session',
    entityId: session.id,
    requestId: client.requestId,
    ip: client.ip ?? null,
    userAgent: client.userAgent ?? null,
    metadata: {
      provider: body.provider,
      replaced: !!session.push_token && session.push_token !== body.push_token,
      moved_from_other_sessions: moved,
    },
  });
  return {
    push_registered: row.push_provider !== null,
    provider: row.push_provider,
    registered_at: row.push_registered_at ? new Date(row.push_registered_at).toISOString() : null,
  };
}
