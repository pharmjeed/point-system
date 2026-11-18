import { Inject, Injectable } from '@nestjs/common';
import {
  ONLINE_PAYMENT_REFUNDABLE_STATUSES,
  PLATFORM_REASON_MIN,
  type PlatformAlertsQuery,
  type PlatformPaymentsQuery,
  type PlatformReconciliationRunsQuery,
} from '@point/shared';
import { maskPhone } from '@point/shared/customer';
import type { PlatformActorContext } from '../../../core/actor-context/platform-actor.js';
import { platformAudit } from '../../../core/audit/platform-audit.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { DATABASE } from '../../../http/tokens.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { ListCursorCodec, pageOf } from '../../venues-events/index.js';

type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | string | null | undefined) => (d == null ? null : new Date(d).toISOString());
/** microsecond text of a timestamptz, for keyset cursors (a JS Date would round to the millisecond) */
const US = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' && v.length <= 64 ? v : null);

/** A Riyadh day `YYYY-MM-DD` as the instant it starts (UTC+3, canon §2 rule 10). */
const DAY_START = (p: string) => `(${p}::date::timestamp AT TIME ZONE 'Asia/Riyadh')`;

function assertRange(from?: string, to?: string) {
  if (from && to && from > to)
    throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'to', issue: 'before_from' }] });
}

interface PaymentListRow {
  id: string;
  account_id: string;
  account_phone: string | null;
  account_status: string;
  purpose: 'visit' | 'subscription';
  status: string;
  amount_halalas: number;
  vat_halalas: number;
  refunded_halalas: number;
  currency: string;
  gateway: string;
  gateway_payment_id: string | null;
  source_type: string | null;
  card_brand: string | null;
  card_last4: string | null;
  failure_code: string | null;
  ticket_id: string | null;
  subscription_id: string | null;
  org_id: string | null;
  org_name_ar: string | null;
  venue_id: string | null;
  venue_name_ar: string | null;
  created_at: Date;
  created_at_us: string;
  paid_at: Date | null;
}

const paymentSelect = (extra = '') => `
  SELECT p.id, p.account_id, a.phone_e164 AS account_phone, a.status AS account_status, p.purpose, p.status,
         p.amount_halalas::float8 AS amount_halalas, p.vat_halalas::float8 AS vat_halalas,
         p.refunded_halalas::float8 AS refunded_halalas, p.currency, p.gateway, p.gateway_payment_id, p.source_type,
         p.card_brand, p.card_last4, p.failure_code, p.ticket_id, p.subscription_id, p.org_id,
         o.name_ar AS org_name_ar, p.venue_id, v.name_ar AS venue_name_ar, p.created_at,
         ${US('p.created_at')} AS created_at_us, p.paid_at${extra}
    FROM online_payments p
    JOIN customer_accounts a ON a.id = p.account_id
    LEFT JOIN organizations o ON o.id = p.org_id
    LEFT JOIN venues v ON v.id = p.venue_id AND v.org_id = p.org_id`;

/**
 * One online payment as P-08 lists it: amounts in halalas (VAT included, `vat_halalas` the VAT inside), the card
 * as brand + last four digits, the customer as a masked phone (DEC-529). Never a card token, a full phone or a name.
 */
function paymentListItem(p: PaymentListRow) {
  return {
    id: p.id,
    purpose: p.purpose,
    status: p.status,
    amount_halalas: p.amount_halalas,
    vat_halalas: p.vat_halalas,
    refunded_halalas: p.refunded_halalas,
    currency: p.currency,
    gateway: p.gateway,
    gateway_payment_id: p.gateway_payment_id,
    source_type: p.source_type,
    card_brand: p.card_brand,
    card_last4: p.card_last4,
    failure_code: p.failure_code,
    account: {
      id: p.account_id,
      phone_masked: p.account_phone ? maskPhone(p.account_phone) : null,
      status: p.account_status,
    },
    org: p.org_id ? { id: p.org_id, name_ar: p.org_name_ar } : null,
    venue: p.venue_id ? { id: p.venue_id, name_ar: p.venue_name_ar } : null,
    ticket_id: p.ticket_id,
    subscription_id: p.subscription_id,
    created_at: iso(p.created_at)!,
    paid_at: iso(p.paid_at),
  };
}

interface RunRow {
  id: string;
  gateway: string;
  run_date: string;
  status: string;
  started_at: Date;
  started_at_us: string;
  finished_at: Date | null;
  gateway_count: number | null;
  local_count: number | null;
  matched_count: number | null;
  mismatch_count: number | null;
  gateway_paid_halalas: number | null;
  local_paid_halalas: number | null;
  failure_reason: string | null;
  mismatches?: unknown;
}

const runSelect = (extra = '') => `
  SELECT r.id, r.gateway, r.run_date::text AS run_date, r.status, r.started_at, ${US('r.started_at')} AS started_at_us,
         r.finished_at, r.gateway_count, r.local_count, r.matched_count, r.mismatch_count,
         r.gateway_paid_halalas::float8 AS gateway_paid_halalas, r.local_paid_halalas::float8 AS local_paid_halalas,
         r.failure_reason${extra}
    FROM payment_reconciliation_runs r`;

function runView(r: RunRow) {
  return {
    id: r.id,
    gateway: r.gateway,
    run_date: r.run_date,
    status: r.status,
    started_at: iso(r.started_at)!,
    finished_at: iso(r.finished_at),
    gateway_count: r.gateway_count,
    local_count: r.local_count,
    matched_count: r.matched_count,
    mismatch_count: r.mismatch_count,
    gateway_paid_halalas: r.gateway_paid_halalas,
    local_paid_halalas: r.local_paid_halalas,
    failure_reason: r.failure_reason,
  };
}

interface AlertRow {
  id: string;
  type: string;
  severity: string;
  status: string;
  dedupe_key: string;
  online_payment_id: string | null;
  details: Record<string, unknown>;
  occurrences: number;
  raised_at: Date;
  raised_at_us: string;
  last_seen_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolved_by_name: string | null;
  resolution_note: string | null;
}

const ALERT_SELECT = `
  SELECT al.id, al.type, al.severity, al.status, al.dedupe_key, al.online_payment_id, al.details, al.occurrences,
         al.raised_at, ${US('al.raised_at')} AS raised_at_us, al.last_seen_at, al.resolved_at, al.resolved_by,
         pu.full_name AS resolved_by_name, al.resolution_note
    FROM platform_alerts al LEFT JOIN platform_users pu ON pu.id = al.resolved_by`;

/** A finance alert: ids, amounts and codes only (`details` was redacted when it was raised, DEC-514). */
function alertView(a: AlertRow) {
  return {
    id: a.id,
    type: a.type,
    severity: a.severity,
    status: a.status,
    dedupe_key: a.dedupe_key,
    online_payment_id: a.online_payment_id,
    details: a.details ?? {},
    occurrences: a.occurrences,
    raised_at: iso(a.raised_at)!,
    last_seen_at: iso(a.last_seen_at)!,
    resolved_at: iso(a.resolved_at),
    resolved_by: a.resolved_by ? { id: a.resolved_by, full_name: a.resolved_by_name } : null,
    resolution_note: a.resolution_note,
  };
}

const paymentNotFound = () => new AppError('RESOURCE_NOT_FOUND', { resource: 'online_payment' });

/**
 * P-08 «المدفوعات والاسترداد» (V2-024, docs/v2/04 §3; DEC-529, DEC-530), `platform.payment_read` (finance and the
 * owner): the online payments POINT collected with their gateway timeline, the daily reconciliation runs and the
 * finance alerts, and the resolution of an alert with a note. The refund itself is V2-021's command
 * (`POST /v1/platform/payments/{paymentId}/refunds`, DEC-513). These reads carry no unmasked personal data (a masked
 * phone, a card's brand and last four digits), so they are not audited one by one (DEC-529); the resolution is
 * (`platform_alert.resolve`).
 */
@Injectable()
export class PlatformPaymentsConsole {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly cursors: ListCursorCodec,
  ) {}

  /** `GET /v1/platform/payments`: newest first, filtered by status, purpose, operator, venue, account and Riyadh days. */
  async payments(q: PlatformPaymentsQuery) {
    assertRange(q.from, q.to);
    const scope = [
      'platform-payments',
      q.status,
      q.purpose,
      q.org_id,
      q.venue_id,
      q.account_id,
      q.from,
      q.to,
    ].join('|');
    const after = q.cursor ? this.cursors.decode(q.cursor, scope, 2) : null;
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (cond: (n: string) => string, value: unknown) => {
      params.push(value);
      where.push(cond(`$${params.length}`));
    };
    if (q.status) add((n) => `p.status = ${n}`, q.status);
    if (q.purpose) add((n) => `p.purpose = ${n}`, q.purpose);
    if (q.org_id) add((n) => `p.org_id = ${n}::uuid`, q.org_id);
    if (q.venue_id) add((n) => `p.venue_id = ${n}::uuid`, q.venue_id);
    if (q.account_id) add((n) => `p.account_id = ${n}::uuid`, q.account_id);
    if (q.from) add((n) => `p.created_at >= ${DAY_START(n)}`, q.from);
    if (q.to) add((n) => `p.created_at < ${DAY_START(`(${n}::date + 1)`)}`, q.to);
    if (after) {
      params.push(after[0], after[1]);
      where.push(`(p.created_at, p.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(q.limit + 1);
    // the platform reads every operator's in-app payments (POINT collects them, V2-D03); the org_id filter is optional
    const rows = await this.db.rows<PaymentListRow>(
      `${paymentSelect()} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY p.created_at DESC, p.id DESC LIMIT $${params.length}`,
      params,
    );
    return pageOf(rows, q.limit, paymentListItem, (r) => this.cursors.encode(scope, [r.created_at_us, r.id]));
  }

  /**
   * `GET /v1/platform/payments/{paymentId}`: the payment, what is still refundable, its refunds, its status history
   * (platform_audit_log `online_payment.*`), the gateway's deliveries about it (sanitized: type, times, outcome and the
   * status/amounts the delivery claimed — never the stored body) and its alerts.
   */
  async payment(paymentId: string) {
    if (!UUID.test(paymentId)) throw paymentNotFound();
    const p = (
      await this.db.rows<PaymentListRow & PaymentTimes>(`${paymentSelect(PAYMENT_TIMES)} WHERE p.id = $1`, [
        paymentId,
      ])
    )[0];
    if (!p) throw paymentNotFound();
    const refunds = await this.db.rows<{
      id: string;
      amount_halalas: number;
      reason: string;
      status: string;
      failure_code: string | null;
      issued_by: string | null;
      issued_by_name: string | null;
      kind: 'manual' | 'system';
      created_at: Date;
      sent_at: Date | null;
      completed_at: Date | null;
    }>(
      `SELECT r.id, r.amount_halalas::float8 AS amount_halalas, r.reason, r.status, r.failure_code, r.issued_by, r.kind,
              pu.full_name AS issued_by_name, r.created_at, r.sent_at, r.completed_at
         FROM refunds r LEFT JOIN platform_users pu ON pu.id = r.issued_by
        WHERE r.online_payment_id = $1 ORDER BY r.created_at, r.id`,
      [paymentId],
    );
    const events = await this.db.rows<{
      id: number;
      event_type: string;
      live: boolean | null;
      received_at: Date;
      processed_at: Date | null;
      outcome: string | null;
      claimed_status: unknown;
      claimed_amount: unknown;
      claimed_refunded: unknown;
    }>(
      `SELECT e.id::float8 AS id, e.event_type, e.live, e.received_at, e.processed_at, e.outcome,
              e.payload->'data'->'status' AS claimed_status, e.payload->'data'->'amount' AS claimed_amount,
              e.payload->'data'->'refunded' AS claimed_refunded
         FROM gateway_webhook_events e
        WHERE e.online_payment_id = $1 OR (e.gateway = $2 AND e.gateway_payment_id = $3)
        ORDER BY e.received_at, e.id LIMIT 200`,
      [paymentId, p.gateway, p.gateway_payment_id],
    );
    const history = await this.db.rows<{
      action: string;
      metadata: Record<string, unknown>;
      occurred_at: Date;
    }>(
      `SELECT action, metadata, occurred_at FROM platform_audit_log
        WHERE entity_type = 'online_payment' AND entity_id = $1 ORDER BY occurred_at, id LIMIT 200`,
      [paymentId],
    );
    const alerts = await this.db.rows<AlertRow>(
      `${ALERT_SELECT} WHERE al.online_payment_id = $1 ORDER BY al.raised_at DESC, al.id DESC LIMIT 50`,
      [paymentId],
    );
    const succeeded = refunds
      .filter((r) => r.status === 'succeeded')
      .reduce((s, r) => s + r.amount_halalas, 0);
    const requested = refunds
      .filter((r) => r.status === 'requested')
      .reduce((s, r) => s + r.amount_halalas, 0);
    const refundable = (ONLINE_PAYMENT_REFUNDABLE_STATUSES as readonly string[]).includes(p.status)
      ? Math.max(0, p.amount_halalas - Math.max(p.refunded_halalas, succeeded) - requested)
      : 0;
    return {
      ...paymentListItem(p),
      authorized_at: iso(p.authorized_at),
      failed_at: iso(p.failed_at),
      refunded_at: iso(p.refunded_at),
      gateway_updated_at: iso(p.gateway_updated_at),
      updated_at: iso(p.updated_at)!,
      version: p.version,
      refundable_halalas: refundable,
      refund_pending_halalas: requested,
      refunds: refunds.map((r) => ({
        id: r.id,
        amount_halalas: r.amount_halalas,
        reason: r.reason,
        status: r.status,
        failure_code: r.failure_code,
        // a system refund (V2-022, DEC-523) has no platform user
        kind: r.kind,
        issued_by: { id: r.issued_by, full_name: r.issued_by_name },
        created_at: iso(r.created_at)!,
        sent_at: iso(r.sent_at),
        completed_at: iso(r.completed_at),
      })),
      status_history: history.map((h) => ({
        action: h.action,
        from_status: str(h.metadata?.from_status),
        to_status: str(h.metadata?.to_status),
        cause: str(h.metadata?.cause),
        failure_code: str(h.metadata?.failure_code),
        occurred_at: iso(h.occurred_at)!,
      })),
      webhook_events: events.map((e) => ({
        id: e.id,
        event_type: e.event_type,
        live: e.live,
        received_at: iso(e.received_at)!,
        processed_at: iso(e.processed_at),
        outcome: e.outcome,
        claimed: {
          status: str(e.claimed_status),
          amount_halalas: num(e.claimed_amount),
          refunded_halalas: num(e.claimed_refunded),
        },
      })),
      alerts: alerts.map(alertView),
    };
  }

  /** `GET /v1/platform/reconciliation-runs`: the daily runs, the latest started first. */
  async runs(q: PlatformReconciliationRunsQuery) {
    assertRange(q.from, q.to);
    const scope = ['platform-reconciliation', q.status, q.from, q.to].join('|');
    const after = q.cursor ? this.cursors.decode(q.cursor, scope, 2) : null;
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (cond: (n: string) => string, value: unknown) => {
      params.push(value);
      where.push(cond(`$${params.length}`));
    };
    if (q.status) add((n) => `r.status = ${n}`, q.status);
    if (q.from) add((n) => `r.run_date >= ${n}::date`, q.from);
    if (q.to) add((n) => `r.run_date <= ${n}::date`, q.to);
    if (after) {
      params.push(after[0], after[1]);
      where.push(`(r.started_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(q.limit + 1);
    const rows = await this.db.rows<RunRow>(
      `${runSelect()} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY r.started_at DESC, r.id DESC LIMIT $${params.length}`,
      params,
    );
    return pageOf(rows, q.limit, runView, (r) => this.cursors.encode(scope, [r.started_at_us, r.id]));
  }

  /** `GET /v1/platform/reconciliation-runs/{runId}`: one run with its mismatches (ids, statuses and amounts only). */
  async run(runId: string) {
    const missing = () => new AppError('RESOURCE_NOT_FOUND', { resource: 'payment_reconciliation_run' });
    if (!UUID.test(runId)) throw missing();
    const r = (await this.db.rows<RunRow>(`${runSelect(', r.mismatches')} WHERE r.id = $1`, [runId]))[0];
    if (!r) throw missing();
    const mismatches = Array.isArray(r.mismatches) ? (r.mismatches as Record<string, unknown>[]) : [];
    return {
      ...runView(r),
      mismatches: mismatches.map((m) => ({
        kind: str(m.kind),
        gateway_payment_id: str(m.gateway_payment_id),
        online_payment_id: str(m.online_payment_id),
        point_status: str(m.point_status),
        gateway_status: str(m.gateway_status),
        point_amount_halalas: num(m.point_amount_halalas),
        gateway_amount_halalas: num(m.gateway_amount_halalas),
        point_refunded_halalas: num(m.point_refunded_halalas),
        gateway_refunded_halalas: num(m.gateway_refunded_halalas),
        synced: m.synced === true,
      })),
    };
  }

  /** `GET /v1/platform/alerts`: the finance alerts, the open ones by default, the latest raised first. */
  async alerts(q: PlatformAlertsQuery) {
    const scope = ['platform-alerts', q.status, q.type].join('|');
    const after = q.cursor ? this.cursors.decode(q.cursor, scope, 2) : null;
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.status === 'open') where.push(`al.status <> 'resolved'`);
    if (q.status === 'resolved') where.push(`al.status = 'resolved'`);
    if (q.type) {
      params.push(q.type);
      where.push(`al.type = $${params.length}`);
    }
    if (after) {
      params.push(after[0], after[1]);
      where.push(`(al.raised_at, al.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(q.limit + 1);
    const rows = await this.db.rows<AlertRow>(
      `${ALERT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY al.raised_at DESC, al.id DESC LIMIT $${params.length}`,
      params,
    );
    return pageOf(rows, q.limit, alertView, (r) => this.cursors.encode(scope, [r.raised_at_us, r.id]));
  }

  /**
   * `POST /v1/platform/alerts/{alertId}/resolve` (DEC-530): a person closes a live alert with a note of 3+
   * characters (REASON_REQUIRED on `note`); a resolved alert stays resolved (INVALID_STATE_TRANSITION). The same
   * condition raised again later opens a new alert (one live row per dedupe key, DEC-514). Lock order: the platform
   * idempotency key, the alert row, then platform_audit_log.
   */
  async resolve(
    tx: Tx,
    actor: PlatformActorContext,
    alertId: string,
    body: { note?: string | null | undefined },
    client: ClientInfo,
  ) {
    const note = (body.note ?? '').trim();
    if (note.length < PLATFORM_REASON_MIN)
      throw new AppError('REASON_REQUIRED', { field: 'note', min_length: PLATFORM_REASON_MIN });
    const missing = () => new AppError('RESOURCE_NOT_FOUND', { resource: 'platform_alert' });
    if (!UUID.test(alertId)) throw missing();
    const a = await tx.maybeOne<{ status: string; type: string; online_payment_id: string | null }>(
      `SELECT status, type, online_payment_id FROM platform_alerts WHERE id = $1 FOR NO KEY UPDATE`,
      [alertId],
    );
    if (!a) throw missing();
    if (a.status === 'resolved')
      throw new AppError('INVALID_STATE_TRANSITION', {
        entity: 'platform_alert',
        current_status: 'resolved',
        allowed_from: ['open', 'acknowledged'],
      });
    await tx.query(
      `UPDATE platform_alerts SET status = 'resolved', resolved_at = $2, resolved_by = $3, resolution_note = $4
        WHERE id = $1`,
      [alertId, tx.now, actor.userId, note],
    );
    await platformAudit(tx, {
      actor: { type: 'platform_user', id: actor.userId, role: actor.role },
      action: 'platform_alert.resolve',
      entityType: 'platform_alert',
      entityId: alertId,
      requestId: client.requestId,
      ip: client.ip ?? null,
      userAgent: client.userAgent ?? null,
      reason: note,
      metadata: { type: a.type, from_status: a.status, online_payment_id: a.online_payment_id },
    });
    return alertView((await alertRow(tx, alertId))!);
  }
}

const PAYMENT_TIMES =
  ', p.authorized_at, p.failed_at, p.refunded_at, p.gateway_updated_at, p.updated_at, p.version';

interface PaymentTimes {
  authorized_at: Date | null;
  failed_at: Date | null;
  refunded_at: Date | null;
  gateway_updated_at: Date | null;
  updated_at: Date;
  version: number;
}

async function alertRow(q: Q, id: string): Promise<AlertRow | null> {
  const r = await q.query<AlertRow>(`${ALERT_SELECT} WHERE al.id = $1`, [id]);
  return r.rows[0] ?? null;
}
