import {
  ONLINE_PAYMENT_REFUNDABLE_STATUSES,
  type RefundIssueBody,
  type RefundKind,
  type RefundStatus,
  type SystemRefundReason,
} from '@point/shared';
import { PAYMENT_REFUND_SEND_JOB } from '../domain/jobs.js';
import type { PlatformActorContext } from '../../../core/actor-context/platform-actor.js';
import { raisePlatformAlert } from '../../../core/alerts/platform-alerts.js';
import { customerAudit } from '../../../core/audit/customer-audit.js';
import { platformAudit } from '../../../core/audit/platform-audit.js';
import { newId } from '../../../core/crypto/ids.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { RetryableJobError, backoffMs, type JobHandler } from '../../../core/outbox/dispatcher.js';
import { enqueue } from '../../../core/outbox/outbox-writer.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { retryableFailure } from '../domain/gateway.js';
import { PAN_LIKE } from '../domain/sanitize.js';
import type { PaymentsRuntime } from '../runtime.js';
import { paymentDocumentsHook } from './document-hook.js';
import { applyGatewayPayment, paymentById, type OnlinePaymentRow } from './payment-sync.js';
import { platformOrgId } from './platform-org.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_REASON = 3;

interface RefundRow {
  id: string;
  online_payment_id: string;
  amount_halalas: number;
  reason: string;
  /** NULL for a system refund (DEC-523) */
  issued_by: string | null;
  kind: RefundKind;
  status: RefundStatus;
  failure_code: string | null;
  sent_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
}

const REFUND_COLUMNS = `r.id, r.online_payment_id, r.amount_halalas::float8 AS amount_halalas, r.reason, r.issued_by,
  r.kind, r.status, r.failure_code, r.sent_at, r.completed_at, r.created_at`;

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

export function refundView(r: RefundRow) {
  return {
    id: r.id,
    online_payment_id: r.online_payment_id,
    amount_halalas: r.amount_halalas,
    reason: r.reason,
    issued_by: r.issued_by,
    kind: r.kind,
    status: r.status,
    failure_code: r.failure_code,
    created_at: iso(r.created_at)!,
    completed_at: iso(r.completed_at),
  };
}

export function paymentSummary(p: OnlinePaymentRow) {
  return {
    id: p.id,
    purpose: p.purpose,
    status: p.status,
    amount_halalas: p.amount_halalas,
    vat_halalas: p.vat_halalas,
    refunded_halalas: p.refunded_halalas,
    currency: p.currency,
    gateway: p.gateway,
    ticket_id: p.ticket_id,
    venue_id: p.venue_id,
    paid_at: iso(p.paid_at),
    version: p.version,
  };
}

/** Sum of the refunds still at the gateway or done (what is no longer refundable). */
async function committedRefunds(q: Pick<Tx, 'one'>, paymentId: string, excluding?: string) {
  const r = await q.one<{ requested: number; succeeded: number }>(
    `SELECT COALESCE(sum(amount_halalas) FILTER (WHERE status = 'requested'), 0)::float8 AS requested,
            COALESCE(sum(amount_halalas) FILTER (WHERE status = 'succeeded'), 0)::float8 AS succeeded
       FROM refunds WHERE online_payment_id = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [paymentId, excluding ?? null],
  );
  return r;
}

/**
 * `POST /v1/platform/payments/{paymentId}/refunds` (P-06 / P-08, `platform.refund_issue` for finance and the owner,
 * DEC-465; V2-021, DEC-513): a partial or a full refund (the rest of the payment when no amount is given) with a
 * reason. The transaction locks the payment, checks that it is refundable and that this refund with those still
 * pending never exceeds what is left of it, writes the `requested` refund, both audit logs and
 * `job.payment_refund_send`; the gateway is called by the worker after COMMIT (canon rule 3), one refund of a
 * payment after the other (ordering key).
 */
export class RefundsService {
  async issue(
    tx: Tx,
    actor: PlatformActorContext,
    paymentId: string,
    body: RefundIssueBody,
    client: ClientInfo,
  ) {
    const reason = (body.reason ?? '').trim();
    if (reason.length < MIN_REASON)
      throw new AppError('REASON_REQUIRED', { field: 'reason', min_length: MIN_REASON });
    if (PAN_LIKE.test(reason))
      throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'reason', issue: 'card_number' }] });
    if (!UUID.test(paymentId)) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'online_payment' });
    const p = await paymentById(tx, paymentId, true);
    if (!p) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'online_payment' });
    if (!(ONLINE_PAYMENT_REFUNDABLE_STATUSES as readonly string[]).includes(p.status))
      throw new AppError('PAYMENT_NOT_REFUNDABLE', { online_payment_id: p.id, current_status: p.status });
    const pending = await committedRefunds(tx, p.id);
    const refundable = p.amount_halalas - Math.max(p.refunded_halalas, pending.succeeded) - pending.requested;
    const amount = body.amount_halalas ?? refundable;
    if (refundable <= 0 || amount > refundable)
      throw new AppError('REFUND_AMOUNT_EXCEEDS_PAID', {
        online_payment_id: p.id,
        requested_halalas: amount,
        refundable_halalas: Math.max(0, refundable),
      });
    const orgId = await platformOrgId(tx);
    if (!orgId) throw new AppError('SERVICE_UNAVAILABLE');
    const id = newId();
    const r = await tx.one<RefundRow>(
      `INSERT INTO refunds (id, online_payment_id, amount_halalas, reason, issued_by, request_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${REFUND_COLUMNS.replace(/\br\./g, '')}`,
      [id, p.id, amount, reason, actor.userId, client.requestId, tx.now],
    );
    await enqueue(tx, {
      type: PAYMENT_REFUND_SEND_JOB,
      orgId,
      aggregate: { type: 'refund', id },
      orderingKey: `refund:${p.id}`,
      payload: { refund_id: id },
    });
    const metadata = {
      online_payment_id: p.id,
      amount_halalas: amount,
      payment_amount_halalas: p.amount_halalas,
      full: amount === p.amount_halalas - p.refunded_halalas && pending.requested === 0,
    };
    await platformAudit(tx, {
      actor: { type: 'platform_user', id: actor.userId, role: actor.role },
      action: 'refund.issue',
      entityType: 'refund',
      entityId: id,
      orgId: p.org_id,
      requestId: client.requestId,
      ip: client.ip,
      userAgent: client.userAgent,
      reason,
      metadata,
    });
    await customerAudit(tx, {
      actor: { type: 'system', name: 'platform' },
      action: 'refund.issue',
      entityType: 'refund',
      entityId: id,
      accountId: p.account_id,
      requestId: client.requestId,
      metadata,
    });
    return { refund: refundView(r), payment: paymentSummary(p) };
  }
}

/**
 * A refund the platform issues by itself (V2-022, DEC-523): an online visit payment the gateway charged for a ticket
 * that no longer owes it — collected in cash/POS first (`double_payment`), or not due any more (`not_due`: waived,
 * voided, included) — or a second online payment of a ticket another one already paid (`double_payment`). The whole
 * amount, once per payment (`uq_refunds_system`), through the refund path of DEC-513 (`job.payment_refund_send`
 * after COMMIT), audited for the platform, the operator (a visit) and the customer, with a `payment_double` platform
 * alert for finance. The caller holds the payment row's lock. Returns the refund id, or null when one exists.
 */
export async function issueSystemRefund(
  tx: Tx,
  p: OnlinePaymentRow,
  reason: SystemRefundReason,
  details: Record<string, unknown> = {},
): Promise<string | null> {
  const existing = await tx.maybeOne<{ id: string }>(
    `SELECT id FROM refunds WHERE online_payment_id = $1 AND kind = 'system'`,
    [p.id],
  );
  if (existing) return null;
  const orgId = await platformOrgId(tx);
  if (!orgId) throw new AppError('SERVICE_UNAVAILABLE');
  const id = newId();
  await tx.query(
    `INSERT INTO refunds (id, online_payment_id, amount_halalas, reason, issued_by, kind, created_at)
     VALUES ($1, $2, $3, $4, NULL, 'system', $5)`,
    [id, p.id, p.amount_halalas, reason, tx.now],
  );
  await enqueue(tx, {
    type: PAYMENT_REFUND_SEND_JOB,
    orgId,
    aggregate: { type: 'refund', id },
    orderingKey: `refund:${p.id}`,
    payload: { refund_id: id },
  });
  const metadata = {
    online_payment_id: p.id,
    amount_halalas: p.amount_halalas,
    payment_amount_halalas: p.amount_halalas,
    full: true,
    kind: 'system',
    ticket_id: p.ticket_id,
    ...details,
  };
  await platformAudit(tx, {
    actor: { type: 'system', id: null, name: 'payments' },
    action: 'refund.issue',
    entityType: 'refund',
    entityId: id,
    orgId: p.org_id,
    reason,
    metadata,
  });
  await customerAudit(tx, {
    actor: { type: 'system', name: 'payments' },
    action: 'refund.issue',
    entityType: 'refund',
    entityId: id,
    accountId: p.account_id,
    metadata: { ...metadata, reason },
  });
  await raisePlatformAlert(tx, {
    type: 'payment_double',
    dedupeKey: `payment_double:${p.id}`,
    onlinePaymentId: p.id,
    details: { online_payment_id: p.id, ticket_id: p.ticket_id, refund_id: id, reason, ...details },
  });
  return id;
}

async function finishRefund(
  tx: Tx,
  r: RefundRow,
  payment: OnlinePaymentRow,
  status: 'succeeded' | 'failed',
  failureCode: string | null,
) {
  const done = await tx.maybeOne<{ id: string }>(
    `UPDATE refunds SET status = $2, failure_code = $3, completed_at = $4 WHERE id = $1 AND status = 'requested'
      RETURNING id`,
    [r.id, status, failureCode, tx.now],
  );
  if (!done) return;
  const metadata = {
    online_payment_id: payment.id,
    amount_halalas: r.amount_halalas,
    ...(failureCode ? { failure_code: failureCode } : {}),
  };
  await platformAudit(tx, {
    actor: { type: 'system', id: null, name: 'payments' },
    action: `refund.${status}`,
    entityType: 'refund',
    entityId: r.id,
    orgId: payment.org_id,
    metadata,
  });
  await customerAudit(tx, {
    actor: { type: 'system', name: 'payments' },
    action: `refund.${status}`,
    entityType: 'refund',
    entityId: r.id,
    accountId: payment.account_id,
    metadata,
  });
  // V2-040 (DEC-543): the credit note of the money given back, in this same transaction
  const documents = paymentDocumentsHook();
  if (status === 'succeeded' && documents)
    await documents.afterRefund(
      tx,
      { id: r.id, amount_halalas: r.amount_halalas, reason: r.reason, kind: r.kind },
      payment,
    );
  if (status === 'failed')
    await raisePlatformAlert(tx, {
      type: 'payment_refund_failed',
      dedupeKey: `payment_refund_failed:${r.id}`,
      onlinePaymentId: payment.id,
      details: {
        refund_id: r.id,
        online_payment_id: payment.id,
        amount_halalas: r.amount_halalas,
        failure_code: failureCode,
      },
    });
}

/**
 * `job.payment_refund_send` (mode external, DEC-513). The gateway has no idempotency key for a refund, so the worker
 * reads the payment first: the money the gateway already gave back, against the refunds of the payment that
 * succeeded before this one, tells whether this refund was applied by an earlier attempt whose answer was lost
 * (then it is recorded as succeeded, not sent twice) — or whether money left outside the platform (a refund on the
 * gateway's dashboard), which is not guessed at: the refund fails and finance gets a `payment_mismatch` alert.
 * `sent_at` is written in its own transaction before the call, so a retry knows the refund may have gone out.
 */
export function paymentRefundJob(runtime: () => PaymentsRuntime): JobHandler {
  return {
    type: PAYMENT_REFUND_SEND_JOB,
    mode: 'external',
    async handle({ row, db, clock }) {
      const id = row.payload?.refund_id;
      if (typeof id !== 'string') return;
      const rt = runtime();
      const r = (await db.query<RefundRow>(`SELECT ${REFUND_COLUMNS} FROM refunds r WHERE r.id = $1`, [id]))
        .rows[0];
      if (!r || r.status !== 'requested') return;
      const payment = await paymentById(db, r.online_payment_id);
      if (!payment?.gateway_payment_id) {
        await db.transaction(async (tx) =>
          finishRefund(
            tx,
            r,
            (await paymentById(tx, r.online_payment_id, true))!,
            'failed',
            'no_gateway_payment',
          ),
        );
        return;
      }
      const before = await rt.gateway.fetchPayment(payment.gateway_payment_id);
      if (!before.ok)
        throw new RetryableJobError(`payment fetch failed: ${before.kind}`, backoffMs(row.attempts));
      const prior = await db.transaction((tx) => committedRefunds(tx, r.online_payment_id, r.id));
      const base = prior.succeeded;
      if (before.value.refunded >= base + r.amount_halalas && r.sent_at) {
        // an earlier attempt went through and its answer was lost
        return void (await commit(db, r, before.value));
      }
      if (before.value.refunded > base) {
        await db.transaction(async (tx) => {
          const p = (await paymentById(tx, r.online_payment_id, true))!;
          await raisePlatformAlert(tx, {
            type: 'payment_mismatch',
            dedupeKey: `payment_mismatch:${p.id}`,
            onlinePaymentId: p.id,
            details: {
              online_payment_id: p.id,
              reason: 'refunded_outside_point',
              gateway_refunded_halalas: before.value.refunded,
              point_refunded_halalas: base,
            },
          });
          await finishRefund(tx, r, p, 'failed', 'gateway_already_refunded');
        });
        return;
      }
      await db.query(`UPDATE refunds SET sent_at = $2 WHERE id = $1 AND status = 'requested'`, [
        r.id,
        clock.now(),
      ]);
      const res = await rt.gateway.refund(payment.gateway_payment_id, r.amount_halalas);
      if (!res.ok) {
        if (retryableFailure(res) || res.kind === 'refused')
          throw new RetryableJobError(
            `refund failed: ${res.kind} ${res.status ?? ''}`,
            backoffMs(row.attempts),
          );
        const failureCode =
          `gateway_${(res.type ?? `http_${res.status}`).replace(/[^A-Za-z0-9_]/g, '_')}`.slice(0, 64);
        await db.transaction(async (tx) =>
          finishRefund(tx, r, (await paymentById(tx, r.online_payment_id, true))!, 'failed', failureCode),
        );
        return;
      }
      await commit(db, r, res.value);
    },
  };

  async function commit(db: Database, r: RefundRow, gp: Parameters<typeof applyGatewayPayment>[2]) {
    await db.transaction(async (tx) => {
      const p = (await paymentById(tx, r.online_payment_id, true))!;
      const synced = await applyGatewayPayment(tx, p, gp, { kind: 'refund', refundId: r.id });
      await finishRefund(tx, r, synced.payment, 'succeeded', null);
    });
  }
}
