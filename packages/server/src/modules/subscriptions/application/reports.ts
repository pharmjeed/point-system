import {
  planPolicyView,
  type PlanPolicyColumns,
  type PlatformSubscriptionsQuery,
  type PlatformSubscriptionsReportQuery,
} from '@point/shared';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { maskPhone } from '../../../core/logging/redact.js';
import { maskStudentNumber } from './eligibility.js';
import { FREEZE_COLUMNS, type FreezeRow } from './freezes.js';
import {
  iso,
  PERIOD_COLUMNS,
  POLICY_COLUMNS,
  SUBSCRIPTION_COLUMNS,
  UUID,
  type PeriodRow,
  type PlanPolicyRow,
  type Q,
  type SubscriptionRow,
} from './rows.js';
import { remainingDaysNow } from './terms.js';

const DAY_MS = 86_400_000;

interface ListRow extends SubscriptionRow, PlanPolicyRow {
  venue_name_ar: string;
  operator_name_ar: string;
  plan_name_ar: string;
  phone_e164: string | null;
  account_status: string;
  visits: number;
  eligibility_status: string | null;
  student_number: string | null;
}

const LIST_SELECT = `SELECT ${SUBSCRIPTION_COLUMNS}, v.name_ar AS venue_name_ar, o.name_ar AS operator_name_ar,
       p.name_ar AS plan_name_ar, a.phone_e164, a.status AS account_status,
       (SELECT count(*)::int FROM tickets t WHERE t.subscription_id = s.id AND t.org_id = s.org_id) AS visits,
       ${POLICY_COLUMNS('p')}, e.status AS eligibility_status, e.student_number
  FROM subscriptions s
  JOIN venues v ON v.id = s.venue_id AND v.org_id = s.org_id
  JOIN organizations o ON o.id = s.org_id
  JOIN subscription_plans p ON p.id = s.plan_id AND p.org_id = s.org_id
  JOIN customer_accounts a ON a.id = s.account_id
  LEFT JOIN subscription_eligibility e ON e.subscription_id = s.id AND e.org_id = s.org_id`;

/** The monthly-equivalent price of a subscription (MRR: a yearly price counts a twelfth a month). */
const monthly = (s: Pick<SubscriptionRow, 'billing_cycle' | 'price_halalas'>) =>
  s.billing_cycle === 'yearly' ? Math.round(s.price_halalas / 12) : s.price_halalas;

function listView(r: ListRow, now: Date = new Date()) {
  return {
    subscription_id: r.id,
    account_id: r.account_id,
    // V2-D12 / P-06: a customer is never shown in full in the console lists (masked everywhere)
    phone_masked: r.phone_e164 ? maskPhone(r.phone_e164) : null,
    account_status: r.account_status,
    org_id: r.org_id,
    operator_name_ar: r.operator_name_ar,
    venue_id: r.venue_id,
    venue_name_ar: r.venue_name_ar,
    plan_id: r.plan_id,
    plan_name_ar: r.plan_name_ar,
    billing_cycle: r.billing_cycle,
    status: r.status,
    price_halalas: r.price_halalas,
    next_price_halalas: r.next_price_halalas,
    vehicles_included: r.vehicles_included,
    current_period_start: iso(r.current_period_start),
    current_period_end: iso(r.current_period_end),
    cancel_at_period_end: r.cancel_at_period_end,
    grace_ends_at: iso(r.grace_ends_at),
    renewal_attempts: r.renewal_attempts,
    frozen_at: iso(r.frozen_at),
    frozen_reason: r.frozen_reason,
    frozen_days_total: Math.floor(r.frozen_seconds_total / 86_400),
    periods_paid: r.periods_paid,
    visits: r.visits,
    activated_at: iso(r.activated_at),
    ended_at: iso(r.ended_at),
    ended_reason: r.ended_reason,
    created_at: iso(r.created_at)!,
    // 04 §7 (V2-036): the plan's policies, a counted-day term, the application's state (the number masked in lists)
    policy: planPolicyView(r as PlanPolicyColumns),
    service_start_on: r.service_start_on,
    service_end_on: r.service_end_on,
    remaining_days:
      r.service_weekdays_mask === null ? null : remainingDaysNow(now, r, r.service_weekdays_mask),
    eligibility_status: r.eligibility_status,
    student_number_masked: r.student_number ? maskStudentNumber(r.student_number) : null,
    refund_due_at: iso(r.refund_due_at),
  };
}

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown };
    if (typeof v.o === 'number' && Number.isInteger(v.o) && v.o >= 0) return v.o;
  } catch {
    // fall through
  }
  throw new AppError('PAGINATION_CURSOR_INVALID');
}

/**
 * P-07 «الاشتراكات» (V2-035; docs/v2/02 §2 P-07; DEC-537): `platform.subscription_read` (owner and finance). The
 * subscriptions across every operator (the platform's own records: the global statements below carry their org_id
 * column for each row), with the customer masked; the report is counts and amounts only.
 */
export class PlatformSubscriptionsService {
  constructor(private readonly db: Database) {}

  async list(q: PlatformSubscriptionsQuery, now: Date = new Date()) {
    const offset = decodeCursor(q.cursor);
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.status) add('s.status = ?', q.status);
    if (q.venue_id) add('s.venue_id = ?', q.venue_id);
    if (q.org_id) add('s.org_id = ?', q.org_id);
    if (q.billing_cycle) add('s.billing_cycle = ?', q.billing_cycle);
    if (q.renews_before) {
      add('s.current_period_end < ?', new Date(q.renews_before));
      where.push(`s.status = 'active' AND NOT s.cancel_at_period_end`);
    }
    params.push(q.limit + 1, offset);
    const rows = (
      await this.db.query<ListRow>(
        `${LIST_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY ${q.renews_before ? 's.current_period_end, s.id' : 's.created_at DESC, s.id DESC'}
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      )
    ).rows;
    return {
      data: rows.slice(0, q.limit).map((x) => listView(x, now)),
      next_cursor: rows.length > q.limit ? encodeCursor(offset + q.limit) : null,
    };
  }

  /** The detail inside a command's transaction (the state it just wrote). */
  detailIn(tx: Tx, id: string) {
    return this.detail(id, tx.now, tx);
  }

  async detail(id: string, now: Date = new Date(), q: Q = this.db) {
    const r = UUID.test(id) ? (await q.query<ListRow>(`${LIST_SELECT} WHERE s.id = $1`, [id])).rows[0] : null;
    if (!r) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'subscription' });
    // V2-036: the application in full for the reviewer (P-07 is POINT's, never the operator's: V2-D12), the term's
    // freezes, the purchase consents, the refunds
    const eligibility = (
      await q.query<{
        status: string;
        source: string | null;
        student_number: string;
        student_name: string;
        decided_at: Date | null;
        decision_reason: string | null;
        created_at: Date;
      }>(
        `SELECT status, source, student_number, student_name, decided_at, decision_reason, created_at
           FROM subscription_eligibility WHERE subscription_id = $1 AND org_id = $2`,
        [id, r.org_id],
      )
    ).rows[0];
    const freezes = (
      await q.query<FreezeRow>(
        `SELECT ${FREEZE_COLUMNS} FROM subscription_freezes f WHERE f.subscription_id = $1 AND f.org_id = $2
          ORDER BY f.created_at, f.id`,
        [id, r.org_id],
      )
    ).rows;
    const consents = (
      await q.query<{
        period_seq: number;
        terms_version: string;
        privacy_version: string;
        price_halalas: number;
        net_halalas: number;
        vat_halalas: number;
        non_refundable: boolean;
        valuables_notice: boolean;
        online_payment_id: string;
        created_at: Date;
      }>(
        `SELECT period_seq, terms_version, privacy_version, price_halalas::float8 AS price_halalas,
                net_halalas::float8 AS net_halalas, vat_halalas::float8 AS vat_halalas, non_refundable,
                valuables_notice, online_payment_id, created_at
           FROM subscription_purchase_consents WHERE subscription_id = $1 AND org_id = $2 ORDER BY created_at, id`,
        [id, r.org_id],
      )
    ).rows;
    const refunds = (
      await q.query<{
        id: string;
        online_payment_id: string;
        amount_halalas: number;
        status: string;
        kind: string;
        created_at: Date;
        completed_at: Date | null;
      }>(
        `SELECT rf.id, rf.online_payment_id, rf.amount_halalas::float8 AS amount_halalas, rf.status, rf.kind,
                rf.created_at, rf.completed_at
           FROM refunds rf JOIN online_payments op ON op.id = rf.online_payment_id
          WHERE op.subscription_id = $1 AND op.org_id = $2 ORDER BY rf.created_at, rf.id`,
        [id, r.org_id],
      )
    ).rows;
    const periods = (
      await q.query<PeriodRow>(
        `SELECT ${PERIOD_COLUMNS} FROM subscription_periods sp WHERE sp.subscription_id = $1 AND sp.org_id = $2
          ORDER BY sp.seq`,
        [id, r.org_id],
      )
    ).rows;
    const payments = (
      await q.query<{
        id: string;
        status: string;
        amount_halalas: number;
        refunded_halalas: number;
        subscription_period_seq: number | null;
        card_brand: string | null;
        card_last4: string | null;
        failure_code: string | null;
        paid_at: Date | null;
        created_at: Date;
      }>(
        `SELECT id, status, amount_halalas::float8 AS amount_halalas, refunded_halalas::float8 AS refunded_halalas,
                subscription_period_seq, card_brand, card_last4, failure_code, paid_at, created_at
           FROM online_payments WHERE subscription_id = $1 AND org_id = $2 ORDER BY created_at, id`,
        [id, r.org_id],
      )
    ).rows;
    const timeline = (
      await q.query<{
        action: string;
        occurred_at: Date;
        actor_type: string;
        metadata: Record<string, unknown>;
      }>(
        `SELECT action, occurred_at, actor_type, metadata FROM platform_audit_log
          WHERE entity_type = 'subscription' AND entity_id = $1 ORDER BY occurred_at, id`,
        [id],
      )
    ).rows;
    const vehicles = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM subscription_vehicles WHERE subscription_id = $1 AND removed_at IS NULL`,
      [id],
    );
    return {
      ...listView(r, now),
      covered_vehicles: vehicles.rows[0]?.n ?? 0,
      eligibility: eligibility
        ? {
            status: eligibility.status,
            source: eligibility.source,
            student_number: eligibility.student_number,
            student_name: eligibility.student_name,
            decided_at: iso(eligibility.decided_at),
            decision_reason: eligibility.decision_reason,
            created_at: iso(eligibility.created_at)!,
          }
        : null,
      freezes: freezes.map((f) => ({
        freeze_id: f.id,
        period_seq: f.period_seq,
        status: f.status,
        starts_on: f.starts_on,
        returns_on: f.returns_on,
        days: f.days,
        used_days: f.used_days,
        ended_on: f.ended_on,
        end_reason: f.end_reason,
      })),
      purchase_consents: consents.map((c) => ({ ...c, created_at: iso(c.created_at)! })),
      refunds: refunds.map((x) => ({
        refund_id: x.id,
        online_payment_id: x.online_payment_id,
        amount_halalas: x.amount_halalas,
        status: x.status,
        kind: x.kind,
        created_at: iso(x.created_at)!,
        completed_at: iso(x.completed_at),
      })),
      periods: periods.map((p) => ({
        seq: p.seq,
        starts_at: iso(p.starts_at)!,
        ends_at: iso(p.ends_at)!,
        price_halalas: p.price_halalas,
        plan_id: p.plan_id,
        online_payment_id: p.online_payment_id,
        extended_days: Math.floor(p.extended_seconds / 86_400),
      })),
      payments: payments.map((p) => ({
        payment_id: p.id,
        status: p.status,
        amount_halalas: p.amount_halalas,
        refunded_halalas: p.refunded_halalas,
        seq: p.subscription_period_seq,
        card_brand: p.card_brand,
        card_last4: p.card_last4,
        failure_code: p.failure_code,
        paid_at: iso(p.paid_at),
        created_at: iso(p.created_at)!,
      })),
      timeline: timeline.map((t) => ({
        action: t.action,
        occurred_at: iso(t.occurred_at)!,
        actor_type: t.actor_type,
        from_status: (t.metadata?.from_status as string | undefined) ?? null,
        to_status: (t.metadata?.to_status as string | undefined) ?? null,
      })),
    };
  }

  /**
   * The P-07 report (DEC-537), at the server's now: the counts per status; MRR = the monthly-equivalent prices of the
   * `active` subscriptions (a yearly price a twelfth; frozen and past-due ones bring nothing in this month); the
   * renewals due in the next `days` (active, not canceled at the end) and their amount; the churn of the last `days`
   * (subscriptions that had started and ended: canceled at the end, expired, refunded, terminated, deleted) and its
   * rate = churned ÷ (active now + churned); the new subscriptions of the last `days`; and per venue the active,
   * frozen and past-due subscribers and its MRR.
   */
  async report(q: PlatformSubscriptionsReportQuery, now: Date) {
    const from = new Date(now.getTime() - q.days * DAY_MS);
    const to = new Date(now.getTime() + q.days * DAY_MS);
    const counts = (
      await this.db.query<{ status: string; n: number }>(
        `SELECT s.status, count(*)::int AS n FROM subscriptions s GROUP BY s.status`,
      )
    ).rows;
    const live = (
      await this.db.query<
        Pick<SubscriptionRow, 'status' | 'billing_cycle' | 'price_halalas' | 'venue_id' | 'org_id'> & {
          venue_name_ar: string;
          operator_name_ar: string;
        }
      >(
        `SELECT s.status, s.billing_cycle, s.price_halalas::float8 AS price_halalas, s.venue_id, s.org_id,
                v.name_ar AS venue_name_ar, o.name_ar AS operator_name_ar
           FROM subscriptions s
           JOIN venues v ON v.id = s.venue_id AND v.org_id = s.org_id
           JOIN organizations o ON o.id = s.org_id
          WHERE s.status IN ('active','frozen','past_due')`,
      )
    ).rows;
    const due = (
      await this.db.query<{ n: number; amount: number }>(
        `SELECT count(*)::int AS n, COALESCE(sum(COALESCE(s.next_price_halalas, s.price_halalas)), 0)::float8 AS amount
           FROM subscriptions s
          WHERE s.status = 'active' AND NOT s.cancel_at_period_end
            AND s.current_period_end >= $1 AND s.current_period_end < $2`,
        [now, to],
      )
    ).rows[0]!;
    const churn = (
      await this.db.query<{ reason: string; n: number }>(
        `SELECT s.ended_reason AS reason, count(*)::int AS n FROM subscriptions s
          WHERE s.ended_at >= $1 AND s.ended_at < $2 AND s.periods_paid > 0
          GROUP BY s.ended_reason`,
        [from, now],
      )
    ).rows;
    const fresh = (
      await this.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM subscriptions s
          WHERE s.activated_at >= $1 AND s.activated_at < $2`,
        [from, now],
      )
    ).rows[0]!;
    const active = live.filter((s) => s.status === 'active');
    const churned = churn.reduce((a, c) => a + c.n, 0);
    const byVenue = new Map<
      string,
      {
        venue_id: string;
        venue_name_ar: string;
        org_id: string;
        operator_name_ar: string;
        active: number;
        frozen: number;
        past_due: number;
        mrr_halalas: number;
      }
    >();
    for (const s of live) {
      const v = byVenue.get(s.venue_id) ?? {
        venue_id: s.venue_id,
        venue_name_ar: s.venue_name_ar,
        org_id: s.org_id,
        operator_name_ar: s.operator_name_ar,
        active: 0,
        frozen: 0,
        past_due: 0,
        mrr_halalas: 0,
      };
      if (s.status === 'active') {
        v.active++;
        v.mrr_halalas += monthly(s);
      } else if (s.status === 'frozen') v.frozen++;
      else v.past_due++;
      byVenue.set(s.venue_id, v);
    }
    return {
      generated_at: now.toISOString(),
      days: q.days,
      counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      active_subscribers: active.length,
      mrr_halalas: active.reduce((a, s) => a + monthly(s), 0),
      renewals_due: { count: due.n, amount_halalas: due.amount, until: to.toISOString() },
      churn: {
        count: churned,
        rate_bp: churned + active.length > 0 ? Math.round((churned * 10_000) / (churned + active.length)) : 0,
        by_reason: Object.fromEntries(churn.map((c) => [c.reason, c.n])),
        since: from.toISOString(),
      },
      new_subscriptions: fresh.n,
      venues: [...byVenue.values()].sort(
        (a, b) => b.active - a.active || a.venue_id.localeCompare(b.venue_id),
      ),
    };
  }
}
