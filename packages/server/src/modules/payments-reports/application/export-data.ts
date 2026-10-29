import { vehicleColorLabelAr, vehicleMakeLabelAr, type ExportKind } from '@point/shared';
import { maskPhone, redact } from '../../../core/logging/redact.js';
import { plateView, type TicketQueryable } from '../../tickets-custody/index.js';
import { formatRiyadh, formatSar } from '../domain/payment-rules.js';
import { toCsv, type CsvColumn } from '../infra/csv.js';
import { driverReportRow, driverReportRows, eventSummaryReport } from './reports.js';
import { maskPhonesInText } from './views.js';

/**
 * The content of each export kind (PNT-089; 13 §13 for `payments`). Every export is limited to the requester's
 * venues at generation time and to the stored filters; no export carries a handover code, a raw phone (masked
 * only), a key position or a photo (09 §3, §5.1 rule 3); free text written by staff has phone-like runs masked.
 */
export interface ExportFilters {
  venue_id?: string;
  event_id?: string;
  from?: string;
  to?: string;
}

export interface ExportScope {
  orgId: string;
  venueIds: string[];
  now: Date;
}

/** Above this many rows the export fails (`too_many_rows`) instead of producing a partial file (09 §3 «حد صفوف»). */
export const EXPORT_MAX_ROWS = 50_000;

export class ExportTooLarge extends Error {
  constructor(readonly rows: number) {
    super(`export has ${rows} rows (limit ${EXPORT_MAX_ROWS})`);
  }
}

const venueSet = (s: ExportScope, f: ExportFilters) =>
  f.venue_id ? s.venueIds.filter((v) => v === f.venue_id) : s.venueIds;

const riyadh = (d: Date | string | null | undefined) => formatRiyadh(d);
const text = (v: string | null | undefined) => (v == null ? '' : maskPhonesInText(v));

async function capped<R>(q: TicketQueryable, sql: string, params: unknown[]): Promise<R[]> {
  const r = await q.query(`${sql} LIMIT ${EXPORT_MAX_ROWS + 1}`, params);
  if (r.rows.length > EXPORT_MAX_ROWS) throw new ExportTooLarge(r.rows.length);
  return r.rows as R[];
}

// ------------------------------------------------------------------------------------------------
// payments (13 §13: fixed column order)
// ------------------------------------------------------------------------------------------------

interface PaymentExportRow {
  payment_id: string;
  event_name: string;
  event_date: string;
  venue_code: string;
  ticket_number: number;
  method: string;
  amount_halalas: number;
  status: string;
  collected_by_code: string;
  collected_by_name: string;
  collected_at: Date;
  pos_reference: string | null;
  reversed_at: Date | null;
  reversed_by_code: string | null;
  reversal_reason: string | null;
  cash_handover_id: string | null;
}

export const PAYMENT_COLUMNS: CsvColumn<PaymentExportRow>[] = [
  { name: 'payment_id', value: (r) => r.payment_id },
  { name: 'event_name', value: (r) => r.event_name, text: true },
  { name: 'event_date', value: (r) => r.event_date },
  { name: 'venue_code', value: (r) => r.venue_code },
  { name: 'ticket_number', value: (r) => r.ticket_number },
  { name: 'method', value: (r) => r.method },
  { name: 'amount_sar', value: (r) => formatSar(r.amount_halalas) },
  { name: 'status', value: (r) => r.status },
  { name: 'collected_by_code', value: (r) => r.collected_by_code },
  { name: 'collected_by_name', value: (r) => r.collected_by_name, text: true },
  { name: 'collected_at_riyadh', value: (r) => riyadh(r.collected_at) },
  { name: 'pos_reference', value: (r) => r.pos_reference, text: true },
  { name: 'reversed_at_riyadh', value: (r) => riyadh(r.reversed_at) },
  { name: 'reversed_by_code', value: (r) => r.reversed_by_code },
  { name: 'reversal_reason', value: (r) => text(r.reversal_reason), text: true },
  { name: 'cash_handover_id', value: (r) => r.cash_handover_id },
];

async function paymentsCsv(q: TicketQueryable, s: ExportScope, f: ExportFilters) {
  const rows = await capped<PaymentExportRow>(
    q,
    `SELECT p.id AS payment_id, e.name_ar AS event_name, e.event_date::text AS event_date, v.code AS venue_code,
            t.display_number AS ticket_number, p.method, p.amount_halalas, p.status,
            cu.employee_code AS collected_by_code, cu.full_name AS collected_by_name, p.collected_at,
            p.pos_reference, p.reversed_at, ru.employee_code AS reversed_by_code, p.reversal_reason, p.cash_handover_id
       FROM payments p
       JOIN events e ON e.id = p.event_id
       JOIN venues v ON v.id = p.venue_id
       JOIN tickets t ON t.id = p.ticket_id
       JOIN users cu ON cu.id = p.collected_by
       LEFT JOIN users ru ON ru.id = p.reversed_by
      WHERE p.org_id = $1 AND p.venue_id = ANY($2::uuid[]) AND ($3::uuid IS NULL OR p.event_id = $3::uuid)
        AND ($4::timestamptz IS NULL OR p.collected_at >= $4::timestamptz)
        AND ($5::timestamptz IS NULL OR p.collected_at < $5::timestamptz)
      ORDER BY p.collected_at, p.id`,
    [s.orgId, venueSet(s, f), f.event_id ?? null, f.from ?? null, f.to ?? null],
  );
  return { csv: toCsv(PAYMENT_COLUMNS, rows), rowCount: rows.length };
}

// ------------------------------------------------------------------------------------------------
// tickets (plates are an operational need of the venue staff, 06 ERD §7.3; never the stub, the key or a spot)
// ------------------------------------------------------------------------------------------------

interface TicketExportRow {
  display_number: number;
  event_name: string;
  event_date: string;
  venue_code: string;
  status: string;
  channel: string;
  wa_link_status: string;
  plate_country: string;
  plate_digits: string | null;
  plate_letters_ar: string | null;
  plate_letters_en: string | null;
  plate_raw: string | null;
  vehicle_make: string | null;
  vehicle_color: string | null;
  customer_phone: string | null;
  payment_status: string;
  fee_halalas: number;
  created_at: Date;
  parked_at: Date | null;
  delivered_at: Date | null;
  voided_at: Date | null;
  created_by_code: string | null;
  parked_by_code: string | null;
  retrieved_by_code: string | null;
  delivered_by_code: string | null;
  void_reason: string | null;
}

const TICKET_COLUMNS: CsvColumn<TicketExportRow>[] = [
  { name: 'ticket_number', value: (r) => r.display_number },
  { name: 'event_name', value: (r) => r.event_name, text: true },
  { name: 'event_date', value: (r) => r.event_date },
  { name: 'venue_code', value: (r) => r.venue_code },
  { name: 'status', value: (r) => r.status },
  { name: 'channel', value: (r) => r.channel },
  { name: 'wa_link_status', value: (r) => r.wa_link_status },
  { name: 'plate', value: (r) => plateView(r).display, text: true },
  // stored as the 02 §8.4 keys (DEC-350): the file carries their Arabic labels, typed text as is
  { name: 'vehicle_make', value: (r) => vehicleMakeLabelAr(r.vehicle_make), text: true },
  { name: 'vehicle_color', value: (r) => vehicleColorLabelAr(r.vehicle_color), text: true },
  { name: 'customer_phone_masked', value: (r) => maskPhone(r.customer_phone) },
  { name: 'payment_status', value: (r) => r.payment_status },
  { name: 'fee_sar', value: (r) => formatSar(r.fee_halalas) },
  { name: 'created_at_riyadh', value: (r) => riyadh(r.created_at) },
  { name: 'parked_at_riyadh', value: (r) => riyadh(r.parked_at) },
  { name: 'delivered_at_riyadh', value: (r) => riyadh(r.delivered_at) },
  { name: 'voided_at_riyadh', value: (r) => riyadh(r.voided_at) },
  { name: 'created_by_code', value: (r) => r.created_by_code },
  { name: 'parked_by_code', value: (r) => r.parked_by_code },
  { name: 'retrieved_by_code', value: (r) => r.retrieved_by_code },
  { name: 'delivered_by_code', value: (r) => r.delivered_by_code },
  { name: 'void_reason', value: (r) => text(r.void_reason), text: true },
];

async function ticketsCsv(q: TicketQueryable, s: ExportScope, f: ExportFilters) {
  const rows = await capped<TicketExportRow>(
    q,
    `SELECT t.display_number, e.name_ar AS event_name, e.event_date::text AS event_date, v.code AS venue_code,
            t.status, t.channel, t.wa_link_status, t.plate_country, t.plate_digits, t.plate_letters_ar,
            t.plate_letters_en, t.plate_raw, t.vehicle_make, t.vehicle_color, c.phone_e164 AS customer_phone,
            t.payment_status, t.fee_halalas, t.created_at, t.parked_at, t.delivered_at, t.voided_at,
            cb.employee_code AS created_by_code, pb.employee_code AS parked_by_code,
            rb.employee_code AS retrieved_by_code, db.employee_code AS delivered_by_code, t.void_reason
       FROM tickets t
       JOIN events e ON e.id = t.event_id
       JOIN venues v ON v.id = t.venue_id
       LEFT JOIN customers c ON c.id = t.customer_id
       LEFT JOIN users cb ON cb.id = t.created_by
       LEFT JOIN users pb ON pb.id = t.parked_by
       LEFT JOIN users rb ON rb.id = t.retrieved_by
       LEFT JOIN users db ON db.id = t.delivered_by
      WHERE t.org_id = $1 AND t.venue_id = ANY($2::uuid[]) AND ($3::uuid IS NULL OR t.event_id = $3::uuid)
        AND ($4::timestamptz IS NULL OR t.created_at >= $4::timestamptz)
        AND ($5::timestamptz IS NULL OR t.created_at < $5::timestamptz)
      ORDER BY e.event_date, e.id, t.display_number`,
    [s.orgId, venueSet(s, f), f.event_id ?? null, f.from ?? null, f.to ?? null],
  );
  return { csv: toCsv(TICKET_COLUMNS, rows), rowCount: rows.length };
}

// ------------------------------------------------------------------------------------------------
// event_summary (one row per event: the KPIs of the event report)
// ------------------------------------------------------------------------------------------------

async function eventSummaryCsv(q: TicketQueryable, s: ExportScope, f: ExportFilters) {
  const events = await capped<{ id: string; venue_code: string }>(
    q,
    `SELECT e.id, v.code AS venue_code FROM events e JOIN venues v ON v.id = e.venue_id
      WHERE e.org_id = $1 AND e.venue_id = ANY($2::uuid[]) AND ($3::uuid IS NULL OR e.id = $3::uuid)
        AND ($4::timestamptz IS NULL OR e.event_date >= ($4::timestamptz AT TIME ZONE 'Asia/Riyadh')::date)
        AND ($5::timestamptz IS NULL OR e.event_date <= ($5::timestamptz AT TIME ZONE 'Asia/Riyadh')::date)
      ORDER BY e.event_date, e.id`,
    [s.orgId, venueSet(s, f), f.event_id ?? null, f.from ?? null, f.to ?? null],
  );
  const rows: (Awaited<ReturnType<typeof eventSummaryReport>> & { venue_code: string })[] = [];
  for (const e of events) rows.push({ ...(await eventSummaryReport(q, e.id)), venue_code: e.venue_code });
  type R = (typeof rows)[number];
  const cols: CsvColumn<R>[] = [
    { name: 'event_id', value: (r) => r.event.id },
    { name: 'event_name', value: (r) => r.event.name_ar, text: true },
    { name: 'event_date', value: (r) => r.event.event_date },
    { name: 'venue_code', value: (r) => r.venue_code },
    { name: 'status', value: (r) => r.event.status },
    { name: 'pricing_mode', value: (r) => r.event.pricing_mode },
    { name: 'tickets_total', value: (r) => r.counts.tickets_total },
    { name: 'delivered', value: (r) => r.counts.delivered },
    { name: 'voided', value: (r) => r.counts.voided },
    { name: 'open', value: (r) => r.counts.open },
    { name: 'reparks', value: (r) => r.counts.reparks },
    { name: 'canceled_requests', value: (r) => r.counts.canceled_requests },
    { name: 'whatsapp_linked', value: (r) => r.counts.whatsapp_linked },
    { name: 'paper', value: (r) => r.counts.paper },
    { name: 'accept_p50_s', value: (r) => r.timings_seconds.accept.p50 },
    { name: 'request_to_ready_p50_s', value: (r) => r.timings_seconds.request_to_ready.p50 },
    { name: 'ready_to_delivered_p50_s', value: (r) => r.timings_seconds.ready_to_delivered.p50 },
    { name: 'offers_expired', value: (r) => r.offers.expired },
    { name: 'escalations', value: (r) => r.offers.escalations },
    { name: 'messages_failed', value: (r) => r.messages.failed },
    { name: 'cash_sar', value: (r) => formatSar(r.payments.cash_halalas) },
    { name: 'pos_sar', value: (r) => formatSar(r.payments.pos_halalas) },
    { name: 'waived_count', value: (r) => r.payments.waived },
    { name: 'outstanding_count', value: (r) => r.payments.outstanding },
    { name: 'incidents_open', value: (r) => r.incidents.open },
    { name: 'incidents_resolved', value: (r) => r.incidents.resolved },
    { name: 'closed_at_riyadh', value: (r) => riyadh(r.event.closed_at) },
  ];
  return { csv: toCsv(cols, rows), rowCount: rows.length };
}

// ------------------------------------------------------------------------------------------------
// drivers (the driver report rows)
// ------------------------------------------------------------------------------------------------

async function driversCsv(q: TicketQueryable, s: ExportScope, f: ExportFilters) {
  let venues = venueSet(s, f);
  if (f.event_id) {
    const ev = (
      await q.query<{ venue_id: string }>(`SELECT venue_id FROM events WHERE id = $1`, [f.event_id])
    ).rows[0];
    venues = venues.filter((v) => v === ev?.venue_id);
  }
  const raw = await driverReportRows(q, {
    venueIds: venues,
    from: f.from ?? '1970-01-01T00:00:00.000Z',
    // without `to`, everything up to the generation time included (the report's period is half-open)
    to: f.to ?? new Date(s.now.getTime() + 1).toISOString(),
    now: s.now,
    limit: EXPORT_MAX_ROWS + 1,
  });
  if (raw.length > EXPORT_MAX_ROWS) throw new ExportTooLarge(raw.length);
  const codes = new Map(
    (
      await q.query<{ id: string; code: string }>(`SELECT id, code FROM venues WHERE id = ANY($1::uuid[])`, [
        venues,
      ])
    ).rows.map((v) => [v.id, v.code]),
  );
  const rows = raw.map((r) => ({ ...driverReportRow(r), venue_code: codes.get(r.venue_id) ?? '' }));
  type R = (typeof rows)[number];
  const cols: CsvColumn<R>[] = [
    { name: 'employee_code', value: (r) => r.driver.employee_code },
    { name: 'full_name', value: (r) => r.driver.full_name, text: true },
    { name: 'venue_code', value: (r) => r.venue_code },
    { name: 'duty_hours', value: (r) => r.duty_hours.toFixed(2) },
    { name: 'parked', value: (r) => r.parked },
    { name: 'retrieved', value: (r) => r.retrieved },
    { name: 'delivered', value: (r) => r.delivered },
    { name: 'offers_received', value: (r) => r.offers_received },
    { name: 'offers_expired', value: (r) => r.offers_expired },
    { name: 'accept_p50_s', value: (r) => r.accept_p50_s },
    { name: 'handover_code_failures', value: (r) => r.handover_code_failures },
  ];
  return { csv: toCsv(cols, rows), rowCount: rows.length };
}

// ------------------------------------------------------------------------------------------------
// messages (status records only: no recipient, no WhatsApp id, no body)
// ------------------------------------------------------------------------------------------------

interface MessageExportRow {
  id: string;
  created_at: Date;
  direction: string;
  kind: string;
  purpose: string | null;
  template_name: string | null;
  status: string;
  error_code: string | null;
  error_title: string | null;
  ticket_number: number | null;
  event_name: string | null;
  venue_code: string | null;
}

const MESSAGE_COLUMNS: CsvColumn<MessageExportRow>[] = [
  { name: 'message_id', value: (r) => r.id },
  { name: 'created_at_riyadh', value: (r) => riyadh(r.created_at) },
  { name: 'direction', value: (r) => r.direction },
  { name: 'kind', value: (r) => r.kind },
  { name: 'purpose', value: (r) => r.purpose },
  { name: 'template_name', value: (r) => r.template_name },
  { name: 'status', value: (r) => r.status },
  { name: 'error_code', value: (r) => r.error_code },
  { name: 'error_title', value: (r) => r.error_title, text: true },
  { name: 'ticket_number', value: (r) => r.ticket_number },
  { name: 'event_name', value: (r) => r.event_name, text: true },
  { name: 'venue_code', value: (r) => r.venue_code },
];

async function messagesCsv(q: TicketQueryable, s: ExportScope, f: ExportFilters) {
  const rows = await capped<MessageExportRow>(
    q,
    `SELECT m.id, m.created_at, m.direction, m.kind, m.purpose, m.template_name, m.status, m.error_code,
            m.error_title, t.display_number AS ticket_number, e.name_ar AS event_name, v.code AS venue_code
       FROM whatsapp_messages m
       LEFT JOIN tickets t ON t.id = m.ticket_id
       LEFT JOIN events e ON e.id = m.event_id
       LEFT JOIN venues v ON v.id = m.venue_id
      WHERE m.org_id = $1 AND m.venue_id = ANY($2::uuid[]) AND ($3::uuid IS NULL OR m.event_id = $3::uuid)
        AND ($4::timestamptz IS NULL OR m.created_at >= $4::timestamptz)
        AND ($5::timestamptz IS NULL OR m.created_at < $5::timestamptz)
      ORDER BY m.created_at, m.id`,
    [s.orgId, venueSet(s, f), f.event_id ?? null, f.from ?? null, f.to ?? null],
  );
  return { csv: toCsv(MESSAGE_COLUMNS, rows), rowCount: rows.length };
}

// ------------------------------------------------------------------------------------------------
// audit (owner and admin only: `audit.read`)
// ------------------------------------------------------------------------------------------------

interface AuditExportRow {
  id: number;
  occurred_at: Date;
  actor_type: string;
  actor_code: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  venue_code: string | null;
  request_id: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
}

const json = (v: unknown) => (v == null ? '' : JSON.stringify(redact(v)));

const AUDIT_COLUMNS: CsvColumn<AuditExportRow>[] = [
  { name: 'id', value: (r) => Number(r.id) },
  { name: 'occurred_at_riyadh', value: (r) => riyadh(r.occurred_at) },
  { name: 'actor_type', value: (r) => r.actor_type },
  { name: 'actor_code', value: (r) => r.actor_code },
  { name: 'action', value: (r) => r.action },
  { name: 'entity_type', value: (r) => r.entity_type },
  { name: 'entity_id', value: (r) => r.entity_id },
  { name: 'venue_code', value: (r) => r.venue_code },
  { name: 'request_id', value: (r) => r.request_id },
  { name: 'reason', value: (r) => text(r.reason), text: true },
  { name: 'before', value: (r) => json(r.before), text: true },
  { name: 'after', value: (r) => json(r.after), text: true },
  { name: 'metadata', value: (r) => json(r.metadata), text: true },
];

async function auditCsv(q: TicketQueryable, s: ExportScope, f: ExportFilters) {
  const rows = await capped<AuditExportRow>(
    q,
    `SELECT a.id, a.occurred_at, a.actor_type, u.employee_code AS actor_code, a.action, a.entity_type, a.entity_id,
            v.code AS venue_code, a.request_id, a.reason, a.before, a.after, a.metadata
       FROM audit_log a
       LEFT JOIN users u ON a.actor_type = 'user' AND u.id::text = a.actor_id
       LEFT JOIN venues v ON v.id = a.venue_id
      WHERE a.org_id = $1 AND ($2::uuid IS NULL OR a.venue_id = $2::uuid)
        AND ($3::timestamptz IS NULL OR a.occurred_at >= $3::timestamptz)
        AND ($4::timestamptz IS NULL OR a.occurred_at < $4::timestamptz)
      ORDER BY a.id`,
    [s.orgId, f.venue_id ?? null, f.from ?? null, f.to ?? null],
  );
  return { csv: toCsv(AUDIT_COLUMNS, rows), rowCount: rows.length };
}

const BUILDERS: Record<
  ExportKind,
  (q: TicketQueryable, s: ExportScope, f: ExportFilters) => Promise<{ csv: string; rowCount: number }>
> = {
  payments: paymentsCsv,
  tickets: ticketsCsv,
  event_summary: eventSummaryCsv,
  drivers: driversCsv,
  messages: messagesCsv,
  audit: auditCsv,
};

export function buildExport(q: TicketQueryable, kind: ExportKind, s: ExportScope, f: ExportFilters) {
  return BUILDERS[kind](q, s, f);
}
