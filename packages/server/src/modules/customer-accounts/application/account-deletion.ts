import type { CustomerAccountDeleteBody, CustomerAccountDeleted } from '@point/shared/customer';
import {
  customerTokenHash,
  customerTokenSession,
  type CustomerActorContext,
} from '../../../core/actor-context/customer-actor.js';
import { customerAudit } from '../../../core/audit/customer-audit.js';
import { hmacHex, safeEqual } from '../../../core/crypto/crypto.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { listAccountVisits } from './visits.js';

type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;

/**
 * The irreversible stand-in for the number of a deleted account (0011, DEC-508): HMAC-SHA256 with the server
 * pepper, so a leaked table cannot be reversed by trying the ~10^8 Saudi mobiles, while support (holding the pepper
 * through the server) can still answer «did this number have an account before».
 */
export function deletedPhoneHash(pepper: string, phoneE164: string): string {
  return hmacHex(pepper, `customer_phone:${phoneE164}`);
}

/**
 * A visit in progress of the account (C-15, C-20): an open ticket of one of its linked `customers` rows (V2-D12) —
 * paper, WhatsApp or the entry pass (an app intake links the row itself, V2-013). The one definition of «a visit of
 * the account» is {@link listAccountVisits} (DEC-504), which C-06's current visit reads too.
 */
export async function hasVisitInProgress(q: Q, accountId: string): Promise<boolean> {
  return (await listAccountVisits(q, accountId, { openOnly: true, limit: 1 })).length > 0;
}

/**
 * `DELETE /v1/customer/me` (C-20; V2-017, DEC-507, DEC-508). In one transaction, after the account row lock
 * (DEC-497) and the session's single-use re-verification proof:
 *
 * - refused while a visit is in progress (`CUSTOMER_ACCOUNT_VISIT_ACTIVE`): the car is still with the operator;
 * - `customer_accounts`: `status = 'deleted'`, `deleted_at`, the name erased, the number replaced by its keyed hash
 *   (`phone_hash`), so the same number can sign up again as a new account;
 * - every vehicle removed (`removed_at`), every session revoked (`account_closed`) and its push token dropped, an
 *   open sign-in code of the number closed, the account's stored command answers (which may hold the profile)
 *   dropped from `customer_idempotency_keys`;
 * - kept: `customer_audit_log`, `customer_account_consents` (append-only, no personal data), and the operators'
 *   own `customers` rows and tickets, which follow each operator's V1 retention (V2-D12): nothing cascades into
 *   operator data.
 */
export async function deleteCustomerAccount(
  tx: Tx,
  pepper: string,
  actor: CustomerActorContext,
  body: CustomerAccountDeleteBody,
  client: ClientInfo,
): Promise<CustomerAccountDeleted> {
  // the lock order of the sign-in codes (DEC-496): the number first, then the account row; a code of the number being
  // verified at the same time therefore commits before or after the deletion, never against it
  const before = await tx.maybeOne<{ phone_e164: string | null }>(
    `SELECT phone_e164 FROM customer_accounts WHERE id = $1`,
    [actor.accountId],
  );
  if (before?.phone_e164)
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `customer_otp:${before.phone_e164}`,
    ]);
  const a = await tx.maybeOne<{ phone_e164: string | null; status: string }>(
    `SELECT phone_e164, status FROM customer_accounts WHERE id = $1 FOR NO KEY UPDATE`,
    [actor.accountId],
  );
  if (!a) throw new AppError('AUTH_UNAUTHENTICATED');
  if (a.status === 'deleted' || !a.phone_e164) throw new AppError('ACCOUNT_DELETED');
  if (a.status !== 'active') throw new AppError('AUTH_ACCOUNT_DISABLED');

  // the proof must be the live one of this very session (a proof of another device or session does not count)
  const s = await tx.one<{ reauth_hash: string | null; reauth_expires_at: Date | null }>(
    `SELECT reauth_hash, reauth_expires_at FROM customer_account_sessions WHERE id = $1 FOR NO KEY UPDATE`,
    [actor.sessionId],
  );
  if (
    customerTokenSession('reauth', body.reauth_token) !== actor.sessionId ||
    !s.reauth_hash ||
    !safeEqual(customerTokenHash(body.reauth_token), s.reauth_hash)
  )
    throw new AppError('CUSTOMER_REAUTH_REQUIRED', { reason: 'invalid' });
  if (!s.reauth_expires_at || s.reauth_expires_at.getTime() <= tx.now.getTime())
    throw new AppError('CUSTOMER_REAUTH_REQUIRED', { reason: 'expired' });

  if (await hasVisitInProgress(tx, actor.accountId)) throw new AppError('CUSTOMER_ACCOUNT_VISIT_ACTIVE');

  const phone = a.phone_e164;
  await tx.query(
    `UPDATE customer_accounts SET status = 'deleted', deleted_at = $2, display_name = NULL, phone_e164 = NULL,
            phone_hash = $3
      WHERE id = $1`,
    [actor.accountId, tx.now, deletedPhoneHash(pepper, phone)],
  );
  const vehicles = await tx.query(
    `UPDATE customer_vehicles SET removed_at = $2 WHERE account_id = $1 AND removed_at IS NULL`,
    [actor.accountId, tx.now],
  );
  // V2-021: the saved cards (gateway tokens) can never be charged again; deleting the token at the gateway itself
  // comes with C-18 (V2-023). The online payments stay: financial records are kept (DEC-508).
  await tx.query(
    `UPDATE customer_payment_methods SET removed_at = $2, is_default = false WHERE account_id = $1 AND removed_at IS NULL`,
    [actor.accountId, tx.now],
  );
  const sessions = await tx.query(
    `UPDATE customer_account_sessions SET revoked_at = $2, revoked_reason = 'account_closed',
            push_token = NULL, push_provider = NULL, push_registered_at = NULL
      WHERE account_id = $1 AND revoked_at IS NULL`,
    [actor.accountId, tx.now],
  );
  await tx.query(
    `UPDATE customer_account_sessions SET push_token = NULL, push_provider = NULL, push_registered_at = NULL, reauth_hash = NULL, reauth_expires_at = NULL
      WHERE account_id = $1 AND (push_token IS NOT NULL OR reauth_hash IS NOT NULL)`,
    [actor.accountId],
  );
  await tx.query(
    `UPDATE customer_otp_challenges SET status = 'superseded', closed_at = $2, code_ciphertext = NULL,
            delivery_status = CASE WHEN delivery_status = 'queued' THEN 'skipped' ELSE delivery_status END
      WHERE phone_e164 = $1 AND status = 'open'`,
    [phone, tx.now],
  );
  // the answers kept with past keys may hold the name and number (CustomerMe); this command's own key is in progress
  await tx.query(`DELETE FROM customer_idempotency_keys WHERE account_id = $1 AND status = 'completed'`, [
    actor.accountId,
  ]);
  // V2-015 (DEC-518): the stars of C-13 stay with the operator's visit, the free-text note is the customer's own
  await tx.query(`UPDATE customer_visit_ratings SET note = NULL WHERE account_id = $1 AND note IS NOT NULL`, [
    actor.accountId,
  ]);
  // V2-016 (DEC-519): nothing more is pushed to the account's devices
  await tx.query(
    `UPDATE customer_push_messages SET status = 'skipped', skipped_reason = 'account_unavailable', updated_at = $2
      WHERE account_id = $1 AND status = 'pending'`,
    [actor.accountId, tx.now],
  );
  const linked = await tx.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM customers c WHERE c.customer_account_id = $1`,
    [actor.accountId],
  );
  await customerAudit(tx, {
    actor: { type: 'customer', accountId: actor.accountId },
    action: 'customer.account.deleted',
    entityType: 'customer_account',
    entityId: actor.accountId,
    requestId: client.requestId,
    ip: client.ip ?? null,
    userAgent: client.userAgent ?? null,
    metadata: {
      vehicles_removed: vehicles.rowCount ?? 0,
      sessions_revoked: sessions.rowCount ?? 0,
      // the operators' rows stay theirs (V2-D12): only how many, never which
      operator_customer_rows_kept: linked.n,
    },
  });
  return { deleted: true, deleted_at: tx.now.toISOString() };
}
