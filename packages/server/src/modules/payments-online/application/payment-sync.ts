import type { OnlinePaymentStatus } from '@point/shared';
import { raisePlatformAlert } from '../../../core/alerts/platform-alerts.js';
import { customerAudit } from '../../../core/audit/customer-audit.js';
import { platformAudit } from '../../../core/audit/platform-audit.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import type { GatewayPayment } from '../domain/gateway.js';
import { decideSync } from '../domain/status.js';

type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;

export interface OnlinePaymentRow {
  id: string;
  account_id: string;
  purpose: 'visit' | 'subscription';
  subscription_id: string | null;
  ticket_id: string | null;
  org_id: string | null;
  venue_id: string | null;
  payment_method_id: string | null;
  amount_halalas: number;
  vat_halalas: number;
  refunded_halalas: number;
  currency: string;
  gateway: string;
  given_id: string;
  gateway_payment_id: string | null;
  source_type: string | null;
  card_brand: string | null;
  card_last4: string | null;
  status: OnlinePaymentStatus;
  failure_code: string | null;
  authorized_at: Date | null;
  paid_at: Date | null;
  failed_at: Date | null;
  refunded_at: Date | null;
  gateway_updated_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** Every column, amounts as numbers (bigint halalas stay far below 2^53). */
export const ONLINE_PAYMENT_COLUMNS = `p.id, p.account_id, p.purpose, p.subscription_id, p.ticket_id, p.org_id, p.venue_id,
  p.payment_method_id, p.amount_halalas::float8 AS amount_halalas, p.vat_halalas::float8 AS vat_halalas,
  p.refunded_halalas::float8 AS refunded_halalas, p.currency, p.gateway, p.given_id, p.gateway_payment_id,
  p.source_type, p.card_brand, p.card_last4, p.status, p.failure_code, p.authorized_at, p.paid_at, p.failed_at,
  p.refunded_at, p.gateway_updated_at, p.version, p.created_at, p.updated_at`;

export async function paymentById(q: Q, id: string, lock = false): Promise<OnlinePaymentRow | null> {
  const r = await q.query<OnlinePaymentRow>(
    `SELECT ${ONLINE_PAYMENT_COLUMNS} FROM online_payments p WHERE p.id = $1${lock ? ' FOR NO KEY UPDATE' : ''}`,
    [id],
  );
  return r.rows[0] ?? null;
}

/**
 * The local row of a gateway payment: by its gateway id, else by the id we put in its metadata
 * (`online_payment_id`) — a webhook can arrive before the answer to our own creation call has been written.
 */
export async function paymentOfGateway(
  q: Q,
  gateway: string,
  gp: Pick<GatewayPayment, 'id' | 'metadata'>,
  lock = false,
): Promise<OnlinePaymentRow | null> {
  const suffix = lock ? ' FOR NO KEY UPDATE' : '';
  const byId = await q.query<OnlinePaymentRow>(
    `SELECT ${ONLINE_PAYMENT_COLUMNS} FROM online_payments p WHERE p.gateway = $1 AND p.gateway_payment_id = $2${suffix}`,
    [gateway, gp.id],
  );
  if (byId.rows[0]) return byId.rows[0];
  const ours = gp.metadata.online_payment_id;
  if (!ours || !/^[0-9a-f-]{36}$/i.test(ours)) return null;
  const r = await q.query<OnlinePaymentRow>(
    `SELECT ${ONLINE_PAYMENT_COLUMNS} FROM online_payments p
      WHERE p.id = $1 AND p.gateway = $2 AND (p.gateway_payment_id IS NULL OR p.gateway_payment_id = $3)${suffix}`,
    [ours, gateway, gp.id],
  );
  return r.rows[0] ?? null;
}

export type SyncCause =
  | { kind: 'webhook'; eventId: string; eventType: string }
  | { kind: 'create' }
  | { kind: 'refund'; refundId: string }
  | { kind: 'reconcile'; runId: string };

export interface SyncOutcome {
  outcome: 'applied' | 'unchanged' | 'conflict';
  payment: OnlinePaymentRow;
}

/**
 * Applies what the gateway answered about a payment to its locked row (DEC-512): only forward moves of the machine
 * (decideSync), the gateway's cumulative refunded amount, and the card's brand/last4 the first time. An applied move
 * is audited in platform_audit_log (and the operator's audit_log for a visit, `platformAudit` with its org) and in
 * the customer's customer_audit_log, in this same transaction. A contradiction is not applied: it raises the
 * `payment_mismatch` platform alert for finance. The caller holds the row's lock (`FOR NO KEY UPDATE`).
 */
export async function applyGatewayPayment(
  tx: Tx,
  row: OnlinePaymentRow,
  gp: GatewayPayment,
  cause: SyncCause,
): Promise<SyncOutcome> {
  const decision = decideSync(row, gp);
  const firstAnswer = row.gateway_payment_id === null;
  if (decision.kind === 'conflict') {
    await raisePlatformAlert(tx, {
      type: 'payment_mismatch',
      dedupeKey: `payment_mismatch:${row.id}`,
      onlinePaymentId: row.id,
      details: {
        online_payment_id: row.id,
        gateway_payment_id: gp.id,
        reason: decision.reason,
        local_status: row.status,
        gateway_status: decision.gatewayStatus,
        local_amount_halalas: row.amount_halalas,
        gateway_amount_halalas: gp.amount,
        cause: cause.kind,
      },
    });
    if (firstAnswer) await setGatewayId(tx, row, gp);
    return { outcome: 'conflict', payment: (await paymentById(tx, row.id))! };
  }
  if (decision.kind === 'unchanged') {
    if (firstAnswer) {
      await setGatewayId(tx, row, gp);
      return { outcome: 'unchanged', payment: (await paymentById(tx, row.id))! };
    }
    return { outcome: 'unchanged', payment: row };
  }
  const to = decision.status;
  const failure = to === 'failed' ? gp.source.failureCode : null;
  const updated = await tx.one<OnlinePaymentRow>(
    `UPDATE online_payments p SET
        status = $2,
        refunded_halalas = $3,
        gateway_payment_id = COALESCE(p.gateway_payment_id, $4),
        card_brand = COALESCE(p.card_brand, $5),
        card_last4 = COALESCE(p.card_last4, $6),
        failure_code = CASE WHEN $2 = 'failed' THEN $7 ELSE p.failure_code END,
        authorized_at = CASE WHEN $2 = 'authorized' THEN COALESCE(p.authorized_at, $8) ELSE p.authorized_at END,
        paid_at = CASE WHEN $2 IN ('paid','partially_refunded','refunded') THEN COALESCE(p.paid_at, $8) ELSE p.paid_at END,
        failed_at = CASE WHEN $2 = 'failed' THEN $8 ELSE p.failed_at END,
        refunded_at = CASE WHEN $3 > p.refunded_halalas THEN $8 ELSE p.refunded_at END,
        gateway_updated_at = COALESCE($9::timestamptz, p.gateway_updated_at),
        version = p.version + 1
      WHERE p.id = $1
      RETURNING ${ONLINE_PAYMENT_COLUMNS}`,
    [
      row.id,
      to,
      decision.refunded,
      gp.id,
      validBrand(gp.source.company),
      gp.source.last4,
      failure,
      tx.now,
      validTime(gp.updatedAt),
    ],
  );
  const action = `online_payment.${to}`;
  const metadata = {
    from_status: row.status,
    to_status: to,
    amount_halalas: row.amount_halalas,
    refunded_halalas: decision.refunded,
    gateway: row.gateway,
    gateway_payment_id: gp.id,
    cause: cause.kind,
    ...(cause.kind === 'webhook' ? { event_id: cause.eventId, event_type: cause.eventType } : {}),
    ...(cause.kind === 'refund' ? { refund_id: cause.refundId } : {}),
    ...(cause.kind === 'reconcile' ? { reconciliation_run_id: cause.runId } : {}),
    ...(failure ? { failure_code: failure } : {}),
  };
  await platformAudit(tx, {
    actor: { type: 'system', id: null, name: 'payments' },
    action,
    entityType: 'online_payment',
    entityId: row.id,
    orgId: row.org_id,
    metadata,
  });
  await customerAudit(tx, {
    actor: { type: 'system', name: 'payments' },
    action,
    entityType: 'online_payment',
    entityId: row.id,
    accountId: row.account_id,
    metadata,
  });
  return { outcome: 'applied', payment: updated };
}

async function setGatewayId(tx: Tx, row: OnlinePaymentRow, gp: GatewayPayment) {
  await tx.query(
    `UPDATE online_payments SET gateway_payment_id = $2, card_brand = COALESCE(card_brand, $3),
            card_last4 = COALESCE(card_last4, $4), version = version + 1
      WHERE id = $1 AND gateway_payment_id IS NULL`,
    [row.id, gp.id, validBrand(gp.source.company), gp.source.last4],
  );
}

const validBrand = (b: string | null) => (b && /^[a-z_]{2,20}$/.test(b) ? b : null);
const validTime = (t: string | null) => (t && !Number.isNaN(Date.parse(t)) ? t : null);
