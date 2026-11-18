import { customerAudit } from '../../../core/audit/customer-audit.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { RetryableJobError, backoffMs, type JobHandler } from '../../../core/outbox/dispatcher.js';
import { enqueue } from '../../../core/outbox/outbox-writer.js';
import { retryableFailure } from '../domain/gateway.js';
import { PAYMENT_METHOD_TOKEN_DELETE_JOB } from '../domain/jobs.js';
import type { PaymentsRuntime } from '../runtime.js';
import type { OnlinePaymentRow } from './payment-sync.js';
import { platformOrgId } from './platform-org.js';

/**
 * Saved cards and their gateway tokens (V2-023, C-18; DEC-524). A card saved with a payment («حفظ البطاقة» in the pay
 * sheet) is written with that payment and stays pending — hidden from C-18 and never charged — until the payment is
 * paid; a payment that fails drops it. A card removed here (C-18, a failed payment, the account's deletion) is
 * soft-removed in the command's transaction, and its token is deleted at the gateway by
 * `job.payment_method_token_delete` after COMMIT (no network call inside a transaction, canon rule 3).
 */

/** The payment that saved a pending card was paid: the card is on file now (the default one if it is the first). */
export async function confirmPendingCard(tx: Tx, payment: OnlinePaymentRow): Promise<void> {
  const r = await tx.maybeOne<{ id: string; account_id: string }>(
    `UPDATE customer_payment_methods SET pending_payment_id = NULL
      WHERE pending_payment_id = $1 AND removed_at IS NULL RETURNING id, account_id`,
    [payment.id],
  );
  if (!r) return;
  await tx.query(
    `UPDATE customer_payment_methods SET is_default = true
      WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM customer_payment_methods d
                                     WHERE d.account_id = $2 AND d.is_default AND d.removed_at IS NULL)`,
    [r.id, r.account_id],
  );
  await customerAudit(tx, {
    actor: { type: 'system', name: 'payments' },
    action: 'customer.payment_method.saved',
    entityType: 'customer_payment_method',
    entityId: r.id,
    accountId: r.account_id,
    metadata: { online_payment_id: payment.id, via: 'payment' },
  });
}

/** The payment that saved a pending card failed: the card is dropped and its token deleted at the gateway. */
export async function dropPendingCard(tx: Tx, payment: OnlinePaymentRow): Promise<void> {
  const r = await tx.maybeOne<{ id: string; account_id: string }>(
    `UPDATE customer_payment_methods SET removed_at = $2
      WHERE pending_payment_id = $1 AND removed_at IS NULL RETURNING id, account_id`,
    [payment.id, tx.now],
  );
  if (!r) return;
  await customerAudit(tx, {
    actor: { type: 'system', name: 'payments' },
    action: 'customer.payment_method.dropped',
    entityType: 'customer_payment_method',
    entityId: r.id,
    accountId: r.account_id,
    metadata: { online_payment_id: payment.id, reason: 'payment_failed' },
  });
  await queueTokenDeletion(tx, [r.id]);
}

/** Queues the gateway deletion of removed cards' tokens (ids only in the payload). */
export async function queueTokenDeletion(tx: Tx, paymentMethodIds: readonly string[]): Promise<void> {
  if (!paymentMethodIds.length) return;
  const orgId = await platformOrgId(tx);
  if (!orgId) return;
  for (const id of paymentMethodIds)
    await enqueue(tx, {
      type: PAYMENT_METHOD_TOKEN_DELETE_JOB,
      orgId,
      aggregate: { type: 'customer_payment_method', id },
      dedupeKey: `payment_method_token_delete:${id}`,
      payload: { payment_method_id: id },
    });
}

interface MethodTokenRow {
  id: string;
  gateway_token: string;
  removed_at: Date | null;
  gateway_deleted_at: Date | null;
}

/**
 * `job.payment_method_token_delete` (mode external, DEC-524): deletes a removed card's token at the gateway, then
 * records when. A token the gateway no longer knows counts as deleted; an unreachable gateway is retried with
 * backoff; any other refusal (the gateway does not allow it) is logged and left without `gateway_deleted_at`, so
 * the card stays visibly not deleted there — the token is unusable by us anyway (the card is removed).
 */
export function paymentMethodTokenDeleteJob(runtime: () => PaymentsRuntime): JobHandler {
  return {
    type: PAYMENT_METHOD_TOKEN_DELETE_JOB,
    mode: 'external',
    async handle({ row, db, clock }) {
      const id = row.payload?.payment_method_id;
      if (typeof id !== 'string') return;
      const rt = runtime();
      const m = await methodRow(db, id);
      if (!m || !m.removed_at || m.gateway_deleted_at) return;
      const res = await rt.gateway.deleteToken(m.gateway_token);
      if (!res.ok && !(res.kind === 'http' && res.status === 404)) {
        if (retryableFailure(res) || res.kind === 'refused')
          throw new RetryableJobError(`token delete failed: ${res.kind}`, backoffMs(row.attempts));
        rt.logger.warn(
          { payment_method_id: id, status: res.status, type: res.type },
          'gateway refused to delete a saved card token',
        );
        return;
      }
      await db.query(
        `UPDATE customer_payment_methods SET gateway_deleted_at = $2
          WHERE id = $1 AND removed_at IS NOT NULL AND gateway_deleted_at IS NULL`,
        [id, clock.now()],
      );
    },
  };
}

async function methodRow(db: Database, id: string): Promise<MethodTokenRow | null> {
  const r = await db.query<MethodTokenRow>(
    `SELECT id, gateway_token, removed_at, gateway_deleted_at FROM customer_payment_methods WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}
