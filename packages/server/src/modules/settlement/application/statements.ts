import {
  PLATFORM_REASON_MIN,
  SETTLEMENT_ADJUSTABLE_STATUSES,
  SETTLEMENT_TRANSITIONS,
  type SettlementCommand,
  type SettlementStatus,
} from '@point/shared';
import type { InvoiceLine } from '@point/shared/customer';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import type { PlatformActorContext } from '../../../core/actor-context/platform-actor.js';
import { audit } from '../../../core/audit/audit-writer.js';
import { platformAudit, type PlatformAuditEntry } from '../../../core/audit/platform-audit.js';
import { newId } from '../../../core/crypto/ids.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { invoiceById, issueDocument, issueFullCreditNote, type InvoiceRow } from '../../invoicing/index.js';
import {
  computeLines,
  monthBounds,
  totalsOf,
  type ComputedLine,
  type ContractTerms,
  type MonthBounds,
  type StatementTotals,
} from '../domain/compute.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAN_LIKE = /[0-9]{13,}/;

export interface StatementRow extends StatementTotals {
  id: string;
  org_id: string;
  period_start: string;
  period_end: string;
  status: SettlementStatus;
  currency: 'SAR';
  computed_at: Date;
  computed_by: string | null;
  issued_at: Date | null;
  issued_by: string | null;
  disputed_at: Date | null;
  disputed_by: string | null;
  dispute_reason: string | null;
  dispute_resolved_at: Date | null;
  dispute_resolved_by: string | null;
  dispute_resolution: string | null;
  paid_at: Date | null;
  paid_on: string | null;
  paid_reference: string | null;
  paid_recorded_by: string | null;
  voided_at: Date | null;
  voided_by: string | null;
  void_reason: string | null;
  saas_invoice_id: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export const STATEMENT_COLUMNS = `s.id, s.org_id, s.period_start::text AS period_start, s.period_end::text AS period_end,
  s.status, s.currency, s.subscriber_visit_count, s.subscriber_payout_halalas::float8 AS subscriber_payout_halalas,
  s.app_payment_count, s.app_gross_halalas::float8 AS app_gross_halalas,
  s.app_commission_halalas::float8 AS app_commission_halalas, s.app_refund_halalas::float8 AS app_refund_halalas,
  s.app_refund_commission_halalas::float8 AS app_refund_commission_halalas,
  s.saas_fee_halalas::float8 AS saas_fee_halalas, s.saas_vat_halalas::float8 AS saas_vat_halalas,
  s.adjustments_halalas::float8 AS adjustments_halalas, s.net_payable_halalas::float8 AS net_payable_halalas,
  s.computed_at, s.computed_by, s.issued_at, s.issued_by, s.disputed_at, s.disputed_by, s.dispute_reason,
  s.dispute_resolved_at, s.dispute_resolved_by, s.dispute_resolution, s.paid_at, s.paid_on::text AS paid_on,
  s.paid_reference, s.paid_recorded_by, s.voided_at, s.voided_by, s.void_reason, s.saas_invoice_id, s.version,
  s.created_at, s.updated_at`;

export const statementNotFound = () =>
  new AppError('RESOURCE_NOT_FOUND', { resource: 'settlement_statement' });

function reasonOf(raw: string | null | undefined, field: string): string {
  const reason = (raw ?? '').trim();
  if (reason.length < PLATFORM_REASON_MIN)
    throw new AppError('REASON_REQUIRED', { field, min_length: PLATFORM_REASON_MIN });
  if (PAN_LIKE.test(reason))
    throw new AppError('VALIDATION_FAILED', { fields: [{ field, issue: 'card_number' }] });
  return reason;
}

const RIYADH = (col: string) => `(${col} AT TIME ZONE 'Asia/Riyadh')`;
const DAY_START = (p: string) => `(${p}::date::timestamp AT TIME ZONE 'Asia/Riyadh')`;

/** The source rows of an operator's month (each query filters by the operator, 09 §1 rule 4). */
async function sourcesOf(tx: Tx, orgId: string, m: MonthBounds) {
  const visits = await tx.rows<{ ticket_id: string; venue_id: string; day: string }>(
    `SELECT t.id AS ticket_id, t.venue_id, ${RIYADH('t.delivered_at')}::date::text AS day
       FROM tickets t
      WHERE t.org_id = $1 AND t.entitlement = 'subscription' AND t.status = 'delivered'
        AND t.delivered_at >= ${DAY_START('$2')} AND t.delivered_at < ${DAY_START('$3')}
      ORDER BY t.delivered_at, t.id`,
    [orgId, m.start, m.end],
  );
  const payments = await tx.rows<{
    payment_id: string;
    venue_id: string;
    day: string;
    amount_halalas: number;
  }>(
    `SELECT p.id AS payment_id, p.venue_id, ${RIYADH('p.paid_at')}::date::text AS day,
            p.amount_halalas::float8 AS amount_halalas
       FROM online_payments p
      WHERE p.org_id = $1 AND p.purpose = 'visit' AND p.status IN ('paid','partially_refunded','refunded')
        AND p.paid_at >= ${DAY_START('$2')} AND p.paid_at < ${DAY_START('$3')}
      ORDER BY p.paid_at, p.id`,
    [orgId, m.start, m.end],
  );
  const refunds = await tx.rows<{
    refund_id: string;
    payment_id: string;
    venue_id: string;
    day: string;
    paid_day: string;
    amount_halalas: number;
  }>(
    `SELECT r.id AS refund_id, p.id AS payment_id, p.venue_id, ${RIYADH('r.completed_at')}::date::text AS day,
            ${RIYADH('p.paid_at')}::date::text AS paid_day, r.amount_halalas::float8 AS amount_halalas
       FROM refunds r JOIN online_payments p ON p.id = r.online_payment_id
      WHERE p.org_id = $1 AND p.purpose = 'visit' AND r.status = 'succeeded'
        AND r.completed_at >= ${DAY_START('$2')} AND r.completed_at < ${DAY_START('$3')}
      ORDER BY r.completed_at, r.id`,
    [orgId, m.start, m.end],
  );
  const venues = await tx.rows<{ venue_id: string; from_day: string }>(
    `SELECT v.id AS venue_id, ${RIYADH('v.created_at')}::date::text AS from_day
       FROM venues v
      WHERE v.org_id = $1 AND v.status = 'active' AND v.created_at < ${DAY_START('$2')}
      ORDER BY v.created_at, v.id`,
    [orgId, m.end],
  );
  const contracts = await tx.rows<ContractTerms>(
    `SELECT c.id, c.starts_on::text AS starts_on, c.ends_on::text AS ends_on,
            c.saas_fee_halalas_per_venue::float8 AS saas_fee_halalas_per_venue, c.saas_cycle,
            c.subscriber_visit_payout_halalas::float8 AS subscriber_visit_payout_halalas, c.app_payment_commission_bp
       FROM operator_contracts c WHERE c.org_id = $1 ORDER BY c.starts_on, c.id`,
    [orgId],
  );
  return { visits, payments, refunds, venues, contracts };
}

async function insertLines(tx: Tx, statementId: string, orgId: string, lines: readonly ComputedLine[]) {
  for (const l of lines) {
    await tx.query(
      `INSERT INTO settlement_lines (id, statement_id, org_id, kind, line_key, amount_halalas, base_halalas, rate_bp,
                                     quantity_days, occurred_on, venue_id, ticket_id, online_payment_id, refund_id,
                                     contract_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        newId(),
        statementId,
        orgId,
        l.kind,
        l.line_key,
        l.amount_halalas,
        l.base_halalas,
        l.rate_bp,
        l.quantity_days,
        l.occurred_on,
        l.venue_id,
        l.ticket_id,
        l.online_payment_id,
        l.refund_id,
        l.contract_id,
        tx.now,
      ],
    );
  }
}

/** Rewrites the header from the statement's active lines (the deferred trigger checks the same at COMMIT). */
async function refreshTotals(tx: Tx, statementId: string, extra = ''): Promise<StatementRow> {
  const lines = await tx.rows<{ kind: ComputedLine['kind']; amount_halalas: number }>(
    `SELECT kind, amount_halalas::float8 AS amount_halalas FROM settlement_lines
      WHERE statement_id = $1 AND released_at IS NULL`,
    [statementId],
  );
  const t = totalsOf(lines);
  return tx.one<StatementRow>(
    `UPDATE settlement_statements s SET subscriber_visit_count = $2, subscriber_payout_halalas = $3,
            app_payment_count = $4, app_gross_halalas = $5, app_commission_halalas = $6, app_refund_halalas = $7,
            app_refund_commission_halalas = $8, saas_fee_halalas = $9, saas_vat_halalas = $10,
            adjustments_halalas = $11, net_payable_halalas = $12, version = s.version + 1${extra}
      WHERE s.id = $1 RETURNING ${STATEMENT_COLUMNS}`,
    [
      statementId,
      t.subscriber_visit_count,
      t.subscriber_payout_halalas,
      t.app_payment_count,
      t.app_gross_halalas,
      t.app_commission_halalas,
      t.app_refund_halalas,
      t.app_refund_commission_halalas,
      t.saas_fee_halalas,
      t.saas_vat_halalas,
      t.adjustments_halalas,
      t.net_payable_halalas,
    ],
  );
}

export type GenerateOutcome =
  | { org_id: string; outcome: 'created' | 'recomputed'; statement: StatementRow }
  | {
      org_id: string;
      outcome: 'skipped';
      reason: 'not_draft' | 'nothing_to_settle';
      statement_id: string | null;
    };

/**
 * Computes (or recomputes) one operator's draft for a closed month (V2-041, DEC-544): under the organization row lock
 * (`FOR NO KEY UPDATE`, alone like the other platform commands), then the statement row. A draft releases its computed
 * lines and takes the new ones (its adjustments stay); an issued, disputed or paid statement is never recomputed; an
 * operator with no contract and nothing to settle in the month gets no statement.
 */
export async function generateForOrg(
  tx: Tx,
  orgId: string,
  period: string,
  vatRateBp: number,
  actor: PlatformAuditEntry['actor'],
  requestId: string | null = null,
): Promise<GenerateOutcome> {
  const m = monthBounds(period);
  await tx.query(`SELECT id FROM organizations WHERE id = $1 FOR NO KEY UPDATE`, [orgId]);
  const existing = await tx.maybeOne<StatementRow>(
    `SELECT ${STATEMENT_COLUMNS} FROM settlement_statements s
      WHERE s.org_id = $1 AND s.period_start = $2 AND s.status <> 'void' FOR NO KEY UPDATE`,
    [orgId, m.start],
  );
  if (existing && existing.status !== 'draft')
    return { org_id: orgId, outcome: 'skipped', reason: 'not_draft', statement_id: existing.id };
  const src = await sourcesOf(tx, orgId, m);
  const lines = computeLines(src, src.contracts, m, vatRateBp);
  const contractInMonth = src.contracts.some(
    (c) => c.starts_on < m.end && (c.ends_on === null || c.ends_on > m.start),
  );
  if (!existing && !lines.length && !contractInMonth)
    return { org_id: orgId, outcome: 'skipped', reason: 'nothing_to_settle', statement_id: null };
  let id: string;
  if (existing) {
    id = existing.id;
    await tx.query(
      `UPDATE settlement_lines SET released_at = $2
        WHERE statement_id = $1 AND released_at IS NULL AND kind <> 'adjustment'`,
      [id, tx.now],
    );
  } else {
    id = newId();
    await tx.query(
      `INSERT INTO settlement_statements (id, org_id, period_start, period_end, computed_at, computed_by, created_at,
                                          updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $5, $5)`,
      [id, orgId, m.start, m.end, tx.now, actor.type === 'platform_user' ? actor.id : null],
    );
  }
  await insertLines(tx, id, orgId, lines);
  await tx.query(`UPDATE settlement_statements SET computed_at = $2, computed_by = $3 WHERE id = $1`, [
    id,
    tx.now,
    actor.type === 'platform_user' ? actor.id : null,
  ]);
  const statement = await refreshTotals(tx, id);
  await platformAudit(tx, {
    actor,
    action: existing ? 'settlement.recompute' : 'settlement.generate',
    entityType: 'settlement_statement',
    entityId: id,
    orgId,
    requestId,
    metadata: {
      period,
      lines: lines.length,
      net_payable_halalas: statement.net_payable_halalas,
      ...(existing ? { previous_net_payable_halalas: existing.net_payable_halalas } : {}),
    },
  });
  return { org_id: orgId, outcome: existing ? 'recomputed' : 'created', statement };
}

/** The operators a month is settled with: every organization POINT does not run itself (V2-D04). */
export async function settledOrganizations(db: Pick<Database, 'rows'> | Pick<Tx, 'rows'>): Promise<string[]> {
  // global on purpose: the platform's monthly run over every operator (each statement is then scoped by org_id)
  const r = await db.rows<{ id: string }>(
    `SELECT id FROM organizations WHERE is_platform_operated = false ORDER BY created_at, id`,
  );
  return r.map((x) => x.id);
}

async function lockStatement(tx: Tx, statementId: string): Promise<StatementRow> {
  if (!UUID.test(statementId)) throw statementNotFound();
  const s = await tx.maybeOne<StatementRow>(
    `SELECT ${STATEMENT_COLUMNS} FROM settlement_statements s WHERE s.id = $1 FOR NO KEY UPDATE`,
    [statementId],
  );
  if (!s) throw statementNotFound();
  return s;
}

function guard(s: StatementRow, command: SettlementCommand | 'adjust', expectedVersion: number) {
  if (s.version !== expectedVersion)
    throw new AppError('VERSION_CONFLICT', {
      entity: 'settlement_statement',
      id: s.id,
      current_version: s.version,
    });
  const allowed =
    command === 'adjust'
      ? (SETTLEMENT_ADJUSTABLE_STATUSES as readonly string[])
      : (SETTLEMENT_TRANSITIONS[command].from as readonly string[]);
  if (!allowed.includes(s.status))
    throw new AppError('INVALID_STATE_TRANSITION', {
      entity_type: 'settlement_statement',
      entity_id: s.id,
      command,
      current_status: s.status,
    });
}

const platformActor = (a: PlatformActorContext): PlatformAuditEntry['actor'] => ({
  type: 'platform_user',
  id: a.userId,
  role: a.role,
});

/**
 * The tax invoice of the operator's system subscription for the statement's month (V2-042, DEC-546): one line per
 * venue and contract share (net and VAT exactly the statement's `saas_fee` / `saas_vat` lines), bought by the
 * operator (its legal name, VAT and CR numbers — the legal name is required on a standard invoice).
 */
async function issueSaasInvoice(
  tx: Tx,
  s: StatementRow,
  actor: PlatformAuditEntry['actor'],
  vatRateBp: number,
  requestId: string | null,
): Promise<InvoiceRow | null> {
  if (s.saas_fee_halalas <= 0) return null;
  const org = await tx.one<{
    name_ar: string;
    legal_name: string | null;
    vat_number: string | null;
    cr_number: string | null;
  }>(`SELECT name_ar, legal_name, vat_number, cr_number FROM organizations WHERE id = $1`, [s.org_id]);
  if (!org.legal_name?.trim())
    throw new AppError('VALIDATION_FAILED', {
      fields: [{ field: 'operator.legal_name', issue: 'required_for_tax_invoice' }],
    });
  const rows = await tx.rows<{
    line_key: string;
    kind: 'saas_fee' | 'saas_vat';
    amount_halalas: number;
    quantity_days: number | null;
    venue_name_ar: string | null;
    venue_name_en: string | null;
  }>(
    `SELECT l.line_key, l.kind, l.amount_halalas::float8 AS amount_halalas, l.quantity_days,
            v.name_ar AS venue_name_ar, v.name_en AS venue_name_en
       FROM settlement_lines l LEFT JOIN venues v ON v.id = l.venue_id AND v.org_id = l.org_id
      WHERE l.statement_id = $1 AND l.org_id = $2 AND l.released_at IS NULL AND l.kind IN ('saas_fee','saas_vat')
      ORDER BY l.line_key`,
    [s.id, s.org_id],
  );
  const vatOf = new Map(
    rows
      .filter((r) => r.kind === 'saas_vat')
      .map((r) => [r.line_key.slice('saas_vat:'.length), -r.amount_halalas]),
  );
  const lines: InvoiceLine[] = rows
    .filter((r) => r.kind === 'saas_fee')
    .map((r) => {
      const net = -r.amount_halalas;
      const vat = vatOf.get(r.line_key.slice('saas_fee:'.length)) ?? 0;
      return {
        description_ar: `اشتراك نظام التشغيل — ${r.venue_name_ar ?? ''} — ${s.period_start.slice(0, 7)} (${r.quantity_days} يومًا)`,
        description_en: `Operating system subscription — ${r.venue_name_en ?? r.venue_name_ar ?? ''} — ${s.period_start.slice(0, 7)} (${r.quantity_days} days)`,
        quantity: 1,
        unit_price_halalas: net,
        net_halalas: net,
        vat_rate_bp: vatRateBp,
        vat_halalas: vat,
        total_halalas: net + vat,
      };
    });
  return issueDocument(tx, {
    series: 'standard',
    kind: 'operator_standard',
    orgId: s.org_id,
    statementId: s.id,
    supplyDate: s.period_start,
    periodStart: s.period_start,
    periodEnd: s.period_end,
    buyer: {
      kind: 'operator',
      legal_name_ar: org.legal_name,
      legal_name_en: null,
      vat_number: org.vat_number,
      cr_number: org.cr_number,
      operator_name_ar: org.name_ar,
    },
    lines,
    vatRateBp,
    actor,
    requestId,
  });
}

/** P-09 commands (`platform.settlement_manage`: finance and the owner), each with its Idempotency-Key. */
export class SettlementCommands {
  constructor(private readonly vatRateBp: () => number) {}

  async adjust(
    tx: Tx,
    actor: PlatformActorContext,
    statementId: string,
    body: { expected_version: number; amount_halalas: number; reason?: string | null | undefined },
    client: ClientInfo,
  ) {
    const reason = reasonOf(body.reason, 'reason');
    const s = await lockStatement(tx, statementId);
    guard(s, 'adjust', body.expected_version);
    const id = newId();
    await tx.query(
      `INSERT INTO settlement_lines (id, statement_id, org_id, kind, line_key, amount_halalas, occurred_on, note,
                                     created_by, created_at)
       VALUES ($1, $2, $3, 'adjustment', $4, $5, ($6::timestamptz AT TIME ZONE 'Asia/Riyadh')::date, $7, $8, $6)`,
      [id, s.id, s.org_id, `adjustment:${id}`, body.amount_halalas, tx.now, reason, actor.userId],
    );
    const updated = await refreshTotals(tx, s.id);
    await platformAudit(tx, {
      actor: platformActor(actor),
      action: 'settlement.adjust',
      entityType: 'settlement_statement',
      entityId: s.id,
      orgId: s.org_id,
      requestId: client.requestId,
      ip: client.ip,
      userAgent: client.userAgent,
      reason,
      metadata: {
        line_id: id,
        amount_halalas: body.amount_halalas,
        net_payable_halalas: updated.net_payable_halalas,
      },
    });
    return { statement: statementView(updated), line_id: id };
  }

  async issue(
    tx: Tx,
    actor: PlatformActorContext,
    statementId: string,
    expectedVersion: number,
    client: ClientInfo,
  ) {
    const s = await lockStatement(tx, statementId);
    guard(s, 'issue', expectedVersion);
    const invoice = await issueSaasInvoice(tx, s, platformActor(actor), this.vatRateBp(), client.requestId);
    const updated = await tx.one<StatementRow>(
      `UPDATE settlement_statements s SET status = 'issued', issued_at = $2, issued_by = $3, saas_invoice_id = $4,
              version = s.version + 1
        WHERE s.id = $1 RETURNING ${STATEMENT_COLUMNS}`,
      [s.id, tx.now, actor.userId, invoice?.id ?? null],
    );
    await platformAudit(tx, {
      actor: platformActor(actor),
      action: 'settlement.issue',
      entityType: 'settlement_statement',
      entityId: s.id,
      orgId: s.org_id,
      requestId: client.requestId,
      ip: client.ip,
      userAgent: client.userAgent,
      metadata: {
        period: s.period_start.slice(0, 7),
        net_payable_halalas: updated.net_payable_halalas,
        saas_invoice_number: invoice?.number ?? null,
      },
    });
    return {
      statement: statementView(updated),
      saas_invoice: invoice ? { id: invoice.id, number: invoice.number } : null,
    };
  }

  async recordPayment(
    tx: Tx,
    actor: PlatformActorContext,
    statementId: string,
    body: { expected_version: number; reference?: string | null | undefined; paid_on: string },
    client: ClientInfo,
  ) {
    const reference = reasonOf(body.reference, 'reference');
    const s = await lockStatement(tx, statementId);
    guard(s, 'record_payment', body.expected_version);
    const updated = await tx.one<StatementRow>(
      `UPDATE settlement_statements s SET status = 'paid', paid_at = $2, paid_on = $3, paid_reference = $4,
              paid_recorded_by = $5, version = s.version + 1
        WHERE s.id = $1 RETURNING ${STATEMENT_COLUMNS}`,
      [s.id, tx.now, body.paid_on, reference, actor.userId],
    );
    await platformAudit(tx, {
      actor: platformActor(actor),
      action: 'settlement.record_payment',
      entityType: 'settlement_statement',
      entityId: s.id,
      orgId: s.org_id,
      requestId: client.requestId,
      ip: client.ip,
      userAgent: client.userAgent,
      metadata: { paid_on: body.paid_on, net_payable_halalas: s.net_payable_halalas },
    });
    return { statement: statementView(updated) };
  }

  async resolveDispute(
    tx: Tx,
    actor: PlatformActorContext,
    statementId: string,
    body: { expected_version: number; reason?: string | null | undefined },
    client: ClientInfo,
  ) {
    const note = reasonOf(body.reason, 'reason');
    const s = await lockStatement(tx, statementId);
    guard(s, 'resolve_dispute', body.expected_version);
    const updated = await tx.one<StatementRow>(
      `UPDATE settlement_statements s SET status = 'issued', dispute_resolved_at = $2, dispute_resolved_by = $3,
              dispute_resolution = $4, version = s.version + 1
        WHERE s.id = $1 RETURNING ${STATEMENT_COLUMNS}`,
      [s.id, tx.now, actor.userId, note],
    );
    await platformAudit(tx, {
      actor: platformActor(actor),
      action: 'settlement.resolve_dispute',
      entityType: 'settlement_statement',
      entityId: s.id,
      orgId: s.org_id,
      requestId: client.requestId,
      ip: client.ip,
      userAgent: client.userAgent,
      reason: note,
      metadata: { net_payable_halalas: updated.net_payable_halalas },
    });
    return { statement: statementView(updated) };
  }

  /**
   * Void (DEC-546): the statement and its lines are kept, the lines released so the month can be settled again;
   * an issued SaaS invoice is taken back by a full credit note in the same transaction.
   */
  async void(
    tx: Tx,
    actor: PlatformActorContext,
    statementId: string,
    body: { expected_version: number; reason?: string | null | undefined },
    client: ClientInfo,
  ) {
    const reason = reasonOf(body.reason, 'reason');
    const s = await lockStatement(tx, statementId);
    guard(s, 'void', body.expected_version);
    const updated = await tx.one<StatementRow>(
      `UPDATE settlement_statements s SET status = 'void', voided_at = $2, voided_by = $3, void_reason = $4,
              version = s.version + 1
        WHERE s.id = $1 RETURNING ${STATEMENT_COLUMNS}`,
      [s.id, tx.now, actor.userId, reason],
    );
    await tx.query(
      `UPDATE settlement_lines SET released_at = $2 WHERE statement_id = $1 AND released_at IS NULL`,
      [s.id, tx.now],
    );
    let credit: InvoiceRow | null = null;
    if (s.saas_invoice_id) {
      const invoice = await invoiceById(tx, s.saas_invoice_id);
      if (invoice)
        credit = await issueFullCreditNote(tx, invoice, reason, platformActor(actor), client.requestId);
    }
    await platformAudit(tx, {
      actor: platformActor(actor),
      action: 'settlement.void',
      entityType: 'settlement_statement',
      entityId: s.id,
      orgId: s.org_id,
      requestId: client.requestId,
      ip: client.ip,
      userAgent: client.userAgent,
      reason,
      metadata: { from_status: s.status, credit_note_number: credit?.number ?? null },
    });
    return {
      statement: statementView(updated),
      credit_note: credit ? { id: credit.id, number: credit.number } : null,
    };
  }

  /** O-05 (`settlement.dispute`, the operator's owner or admin): an issued statement of its own, with a reason. */
  async dispute(
    tx: Tx,
    actor: ActorContext,
    statementId: string,
    body: { expected_version: number; reason?: string | null | undefined },
    client: ClientInfo,
  ) {
    const reason = reasonOf(body.reason, 'reason');
    if (!UUID.test(statementId)) throw statementNotFound();
    const s = await tx.maybeOne<StatementRow>(
      `SELECT ${STATEMENT_COLUMNS} FROM settlement_statements s
        WHERE s.id = $1 AND s.org_id = $2 AND s.status <> 'draft' FOR NO KEY UPDATE`,
      [statementId, actor.orgId],
    );
    if (!s) throw statementNotFound();
    guard(s, 'dispute', body.expected_version);
    const updated = await tx.one<StatementRow>(
      `UPDATE settlement_statements s SET status = 'disputed', disputed_at = $3, disputed_by = $4, dispute_reason = $5,
              dispute_resolved_at = NULL, dispute_resolved_by = NULL, dispute_resolution = NULL,
              version = s.version + 1
        WHERE s.id = $1 AND s.org_id = $2 RETURNING ${STATEMENT_COLUMNS}`,
      [s.id, actor.orgId, tx.now, actor.userId, reason],
    );
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'settlement.dispute',
      entityType: 'settlement_statement',
      entityId: s.id,
      requestId: client.requestId,
      ip: client.ip,
      userAgent: client.userAgent,
      reason,
      metadata: { period: s.period_start.slice(0, 7), net_payable_halalas: s.net_payable_halalas },
    });
    return statementView(updated);
  }
}

const iso = (d: Date | string | null | undefined) => (d == null ? null : new Date(d).toISOString());

/** A statement header as P-09 and O-05 show it. */
export function statementView(s: StatementRow) {
  return {
    id: s.id,
    org_id: s.org_id,
    period: s.period_start.slice(0, 7),
    period_start: s.period_start,
    period_end: s.period_end,
    status: s.status,
    currency: s.currency,
    subscriber_visit_count: s.subscriber_visit_count,
    subscriber_payout_halalas: s.subscriber_payout_halalas,
    app_payment_count: s.app_payment_count,
    app_gross_halalas: s.app_gross_halalas,
    app_commission_halalas: s.app_commission_halalas,
    app_refund_halalas: s.app_refund_halalas,
    app_refund_commission_halalas: s.app_refund_commission_halalas,
    saas_fee_halalas: s.saas_fee_halalas,
    saas_vat_halalas: s.saas_vat_halalas,
    adjustments_halalas: s.adjustments_halalas,
    net_payable_halalas: s.net_payable_halalas,
    computed_at: iso(s.computed_at)!,
    issued_at: iso(s.issued_at),
    disputed_at: iso(s.disputed_at),
    dispute_reason: s.dispute_reason,
    dispute_resolved_at: iso(s.dispute_resolved_at),
    dispute_resolution: s.dispute_resolution,
    paid_at: iso(s.paid_at),
    paid_on: s.paid_on,
    paid_reference: s.paid_reference,
    voided_at: iso(s.voided_at),
    void_reason: s.void_reason,
    saas_invoice_id: s.saas_invoice_id,
    version: s.version,
  };
}
