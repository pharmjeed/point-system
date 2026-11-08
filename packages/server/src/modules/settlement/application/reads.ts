import type { OperatorSettlementsQuery, PlatformSettlementsQuery } from '@point/shared';
import type { Clock } from '../../../core/clock/clock.js';
import type { Database } from '../../../core/db/database.js';
import { operatorInvoices } from '../../invoicing/index.js';
import { ListCursorCodec, pageOf } from '../../venues-events/index.js';
import { STATEMENT_COLUMNS, statementNotFound, statementView, type StatementRow } from './statements.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | string | null | undefined) => (d == null ? null : new Date(d).toISOString());

interface LineRow {
  id: string;
  kind: string;
  line_key: string;
  amount_halalas: number;
  base_halalas: number | null;
  rate_bp: number | null;
  quantity_days: number | null;
  occurred_on: string;
  venue_id: string | null;
  venue_name_ar: string | null;
  ticket_id: string | null;
  ticket_display_number: number | null;
  online_payment_id: string | null;
  refund_id: string | null;
  contract_id: string | null;
  note: string | null;
  created_at: Date;
  released_at: Date | null;
}

async function linesOf(db: Database, statementId: string, orgId: string, withReleased: boolean) {
  const rows = await db.rows<LineRow>(
    `SELECT l.id, l.kind, l.line_key, l.amount_halalas::float8 AS amount_halalas,
            l.base_halalas::float8 AS base_halalas, l.rate_bp, l.quantity_days, l.occurred_on::text AS occurred_on,
            l.venue_id, v.name_ar AS venue_name_ar, l.ticket_id, t.display_number AS ticket_display_number,
            l.online_payment_id, l.refund_id, l.contract_id, l.note, l.created_at, l.released_at
       FROM settlement_lines l
       LEFT JOIN venues v ON v.id = l.venue_id AND v.org_id = l.org_id
       LEFT JOIN tickets t ON t.id = l.ticket_id AND t.org_id = l.org_id
      WHERE l.statement_id = $1 AND l.org_id = $2 ${withReleased ? '' : 'AND l.released_at IS NULL'}
      ORDER BY l.released_at NULLS FIRST, l.kind, l.occurred_on, l.line_key`,
    [statementId, orgId],
  );
  return rows.map((l) => ({
    id: l.id,
    kind: l.kind,
    amount_halalas: l.amount_halalas,
    base_halalas: l.base_halalas,
    rate_bp: l.rate_bp,
    quantity_days: l.quantity_days,
    occurred_on: l.occurred_on,
    venue: l.venue_id ? { id: l.venue_id, name_ar: l.venue_name_ar } : null,
    ticket: l.ticket_id ? { id: l.ticket_id, display_number: l.ticket_display_number } : null,
    online_payment_id: l.online_payment_id,
    refund_id: l.refund_id,
    contract_id: l.contract_id,
    note: l.note,
    created_at: iso(l.created_at)!,
    released_at: iso(l.released_at),
  }));
}

async function invoiceRefs(db: Database, statementId: string, orgId: string) {
  const rows = await db.rows<{
    id: string;
    number: string;
    kind: string;
    zatca_status: string;
    total_halalas: number;
    issued_at: Date;
  }>(
    `SELECT id, number, kind, zatca_status, total_halalas::float8 AS total_halalas, issued_at FROM invoices
      WHERE settlement_statement_id = $1 AND org_id = $2 ORDER BY icv`,
    [statementId, orgId],
  );
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    kind: r.kind,
    status: r.zatca_status,
    total_halalas: r.total_halalas,
    issued_at: iso(r.issued_at)!,
  }));
}

/** P-09 «التسوية» reads (`platform.settlement_manage`). */
export class PlatformSettlementsQueries {
  constructor(
    private readonly db: Database,
    private readonly cursors: ListCursorCodec,
  ) {}

  async list(q: PlatformSettlementsQuery) {
    const scope = ['platform-settlements', q.status, q.org_id, q.period].join('|');
    const after = q.cursor ? this.cursors.decode(q.cursor, scope, 2) : null;
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (cond: (n: string) => string, value: unknown) => {
      params.push(value);
      where.push(cond(`$${params.length}`));
    };
    if (q.status) add((n) => `s.status = ${n}`, q.status);
    if (q.org_id) add((n) => `s.org_id = ${n}::uuid`, q.org_id);
    if (q.period) add((n) => `s.period_start = (${n} || '-01')::date`, q.period);
    if (after) {
      params.push(after[0], after[1]);
      where.push(`(s.period_start, s.id) < ($${params.length - 1}::date, $${params.length}::uuid)`);
    }
    params.push(q.limit + 1);
    // every operator's statements (the platform settles with all of them); org_id is an optional filter
    const rows = await this.db.rows<StatementRow & { org_name_ar: string; operator_status: string }>(
      `SELECT ${STATEMENT_COLUMNS}, o.name_ar AS org_name_ar, o.operator_status
         FROM settlement_statements s JOIN organizations o ON o.id = s.org_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY s.period_start DESC, s.id DESC LIMIT $${params.length}`,
      params,
    );
    return pageOf(
      rows,
      q.limit,
      (r) => ({
        ...statementView(r),
        org: { id: r.org_id, name_ar: r.org_name_ar, operator_status: r.operator_status },
      }),
      (r) => this.cursors.encode(scope, [r.period_start, r.id]),
    );
  }

  async detail(statementId: string) {
    if (!UUID.test(statementId)) throw statementNotFound();
    const s = (
      await this.db.rows<
        StatementRow & { org_name_ar: string; legal_name: string | null; vat_number: string | null }
      >(
        `SELECT ${STATEMENT_COLUMNS}, o.name_ar AS org_name_ar, o.legal_name, o.vat_number
           FROM settlement_statements s JOIN organizations o ON o.id = s.org_id WHERE s.id = $1`,
        [statementId],
      )
    )[0];
    if (!s) throw statementNotFound();
    const history = await this.db.rows<{
      action: string;
      occurred_at: Date;
      actor_type: string;
      actor_name: string | null;
      reason: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT a.action, a.occurred_at, a.actor_type, pu.full_name AS actor_name, a.reason, a.metadata
         FROM platform_audit_log a LEFT JOIN platform_users pu ON pu.id = a.actor_id
        WHERE a.entity_type = 'settlement_statement' AND a.entity_id = $1 AND a.org_id = $2
        ORDER BY a.occurred_at, a.id`,
      [s.id, s.org_id],
    );
    const disputedBy = s.disputed_by
      ? (
          await this.db.rows<{ full_name: string; role: string }>(
            `SELECT full_name, role FROM users WHERE id = $1 AND org_id = $2`,
            [s.disputed_by, s.org_id],
          )
        )[0]
      : undefined;
    return {
      ...statementView(s),
      org: { id: s.org_id, name_ar: s.org_name_ar, legal_name: s.legal_name, vat_number: s.vat_number },
      disputed_by: disputedBy ? { full_name: disputedBy.full_name, role: disputedBy.role } : null,
      lines: await linesOf(this.db, s.id, s.org_id, true),
      invoices: await invoiceRefs(this.db, s.id, s.org_id),
      history: history.map((h) => ({
        action: h.action,
        occurred_at: iso(h.occurred_at)!,
        actor: h.actor_type === 'platform_user' ? h.actor_name : 'system',
        reason: h.reason,
        metadata: h.metadata ?? {},
      })),
    };
  }
}

/** O-05 «كشف التسوية» (`settlement.read`): the operator's own statements, never a draft. */
export class OperatorSettlementQueries {
  constructor(
    private readonly db: Database,
    private readonly cursors: ListCursorCodec,
    private readonly clock: Clock,
  ) {}

  async list(orgId: string, q: OperatorSettlementsQuery) {
    const scope = ['operator-settlements', orgId, q.status].join('|');
    const after = q.cursor ? this.cursors.decode(q.cursor, scope, 2) : null;
    const params: unknown[] = [orgId];
    const where = [`s.org_id = $1`, `s.status <> 'draft'`];
    if (q.status) {
      params.push(q.status);
      where.push(`s.status = $${params.length}`);
    }
    if (after) {
      params.push(after[0], after[1]);
      where.push(`(s.period_start, s.id) < ($${params.length - 1}::date, $${params.length}::uuid)`);
    }
    params.push(q.limit + 1);
    const rows = await this.db.rows<StatementRow>(
      `SELECT ${STATEMENT_COLUMNS} FROM settlement_statements s WHERE ${where.join(' AND ')}
        ORDER BY s.period_start DESC, s.id DESC LIMIT $${params.length}`,
      params,
    );
    return pageOf(rows, q.limit, statementView, (r) => this.cursors.encode(scope, [r.period_start, r.id]));
  }

  async detail(orgId: string, statementId: string) {
    if (!UUID.test(statementId)) throw statementNotFound();
    const s = (
      await this.db.rows<StatementRow>(
        `SELECT ${STATEMENT_COLUMNS} FROM settlement_statements s
          WHERE s.id = $1 AND s.org_id = $2 AND s.status <> 'draft'`,
        [statementId, orgId],
      )
    )[0];
    if (!s) throw statementNotFound();
    return {
      ...statementView(s),
      lines: await linesOf(this.db, s.id, orgId, false),
      invoices: await invoiceRefs(this.db, s.id, orgId),
    };
  }

  /**
   * O-06 «اشتراك النظام» (`settlement.read`): the operator's contract in force (today, Riyadh) and the history, its
   * active venues (what the monthly fee counts) and its invoices from POINT.
   */
  async systemSubscription(orgId: string) {
    const today = new Date(this.clock.now().getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
    const org = (
      await this.db.rows<{
        name_ar: string;
        legal_name: string | null;
        vat_number: string | null;
        cr_number: string | null;
        operator_status: string;
      }>(
        `SELECT name_ar, legal_name, vat_number, cr_number, operator_status FROM organizations WHERE id = $1`,
        [orgId],
      )
    )[0]!;
    const contracts = await this.db.rows<{
      id: string;
      starts_on: string;
      ends_on: string | null;
      saas_fee_halalas_per_venue: number;
      saas_cycle: string;
      subscriber_visit_payout_halalas: number;
      app_payment_commission_bp: number;
    }>(
      `SELECT id, starts_on::text AS starts_on, ends_on::text AS ends_on,
              saas_fee_halalas_per_venue::float8 AS saas_fee_halalas_per_venue, saas_cycle,
              subscriber_visit_payout_halalas::float8 AS subscriber_visit_payout_halalas, app_payment_commission_bp
         FROM operator_contracts WHERE org_id = $1 ORDER BY starts_on DESC, id`,
      [orgId],
    );
    const venues = await this.db.rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM venues WHERE org_id = $1 AND status = 'active'`,
      [orgId],
    );
    const view = contracts.map((c) => ({
      ...c,
      state:
        c.starts_on > today ? 'upcoming' : c.ends_on !== null && c.ends_on <= today ? 'ended' : 'current',
    }));
    return {
      operator: org,
      contract: view.find((c) => c.state === 'current') ?? null,
      contracts: view,
      active_venues: venues[0]?.n ?? 0,
      invoices: await operatorInvoices(this.db, orgId),
    };
  }
}
