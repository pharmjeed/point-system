import type { PaymentMethod, PaymentRecordStatus } from '@point/shared';
import { maskPhone } from '../../../core/logging/redact.js';
import type { TicketQueryable } from '../../tickets-custody/index.js';

/**
 * Wire shapes of the payments-reports module (07_openapi components `Payment`, `CashHandover`, `Incident`,
 * `WhatsAppMessage`, `UserRef`). snake_case, ISO-8601 UTC, amounts in halalas (integers).
 */

export const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : new Date(d).toISOString();

export interface UserRefDto {
  id: string;
  full_name: string;
  employee_code?: string;
}

/** Users by id → UserRef (`employee_code` included, 07 `UserRef`). */
export async function loadUserRefs(
  q: TicketQueryable,
  ids: readonly (string | null | undefined)[],
): Promise<Map<string, UserRefDto>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const r = await q.query<{ id: string; full_name: string; employee_code: string | null }>(
    `SELECT id, full_name, employee_code FROM users WHERE id = ANY($1::uuid[])`,
    [unique],
  );
  return new Map(
    r.rows.map((u) => [
      u.id,
      { id: u.id, full_name: u.full_name, ...(u.employee_code ? { employee_code: u.employee_code } : {}) },
    ]),
  );
}

export const refOf = (users: Map<string, UserRefDto>, id: string | null | undefined): UserRefDto | null =>
  id ? (users.get(id) ?? { id, full_name: '' }) : null;

// ------------------------------------------------------------------------------------------------
// payments
// ------------------------------------------------------------------------------------------------

/** `payments` row (docs/06_schema.sql §12). */
export interface PaymentRow {
  id: string;
  org_id: string;
  venue_id: string;
  event_id: string;
  ticket_id: string;
  cycle_id: string | null;
  method: PaymentMethod;
  amount_halalas: number;
  currency: string;
  pos_reference: string | null;
  collected_by: string;
  collected_at: Date;
  status: PaymentRecordStatus;
  reversed_at: Date | null;
  reversed_by: string | null;
  reversal_reason: string | null;
  cash_handover_id: string | null;
  created_at: Date;
}

export function paymentView(p: PaymentRow, users: Map<string, UserRefDto>) {
  return {
    id: p.id,
    ticket_id: p.ticket_id,
    cycle_id: p.cycle_id,
    event_id: p.event_id,
    method: p.method,
    amount_halalas: Number(p.amount_halalas),
    currency: 'SAR' as const,
    pos_reference: p.pos_reference,
    collected_by: refOf(users, p.collected_by)!,
    collected_at: iso(p.collected_at)!,
    status: p.status,
    reversed_at: iso(p.reversed_at),
    reversed_by: refOf(users, p.reversed_by),
    reversal_reason: p.reversal_reason,
    cash_handover_id: p.cash_handover_id,
  };
}

export async function loadPaymentViews(q: TicketQueryable, rows: readonly PaymentRow[]) {
  const users = await loadUserRefs(
    q,
    rows.flatMap((p) => [p.collected_by, p.reversed_by]),
  );
  return rows.map((p) => paymentView(p, users));
}

// ------------------------------------------------------------------------------------------------
// cash handovers
// ------------------------------------------------------------------------------------------------

export interface CashHandoverRow {
  id: string;
  org_id: string;
  venue_id: string;
  event_id: string;
  driver_id: string;
  received_by: string;
  amount_halalas: number;
  expected_halalas: number;
  difference_halalas: number;
  note: string | null;
  handed_at: Date;
  created_at: Date;
}

export function cashHandoverView(
  h: CashHandoverRow,
  users: Map<string, UserRefDto>,
  extra: { payment_ids?: string[]; incident_id?: string | null } = {},
) {
  return {
    id: h.id,
    event_id: h.event_id,
    venue_id: h.venue_id,
    driver: refOf(users, h.driver_id)!,
    received_by: refOf(users, h.received_by)!,
    amount_halalas: Number(h.amount_halalas),
    expected_halalas: Number(h.expected_halalas),
    difference_halalas: Number(h.difference_halalas),
    ...(extra.payment_ids ? { payment_ids: extra.payment_ids } : {}),
    note: h.note,
    handed_at: iso(h.handed_at)!,
    incident_id: extra.incident_id ?? null,
  };
}

// ------------------------------------------------------------------------------------------------
// incidents (the incidents module owns the routes; this is the read shape for S-10 warnings)
// ------------------------------------------------------------------------------------------------

export interface IncidentRow {
  id: string;
  org_id: string;
  venue_id: string;
  event_id: string | null;
  ticket_id: string | null;
  type: string;
  status: string;
  severity: string;
  description: string;
  opened_by: string;
  owner_id: string | null;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export function incidentView(i: IncidentRow, users: Map<string, UserRefDto>) {
  return {
    id: i.id,
    venue_id: i.venue_id,
    event_id: i.event_id,
    ticket_id: i.ticket_id,
    type: i.type,
    status: i.status,
    severity: i.severity,
    description: maskPhonesInText(i.description),
    opened_by: refOf(users, i.opened_by)!,
    owner: refOf(users, i.owner_id),
    resolution: i.resolution === null ? null : maskPhonesInText(i.resolution),
    resolved_by: refOf(users, i.resolved_by),
    resolved_at: iso(i.resolved_at),
    closed_at: iso(i.closed_at),
    version: i.version,
    created_at: iso(i.created_at)!,
    updated_at: iso(i.updated_at),
  };
}

// ------------------------------------------------------------------------------------------------
// WhatsApp messages (redacted record: no phone, no WhatsApp id, no handover code — 07 `WhatsAppMessage`)
// ------------------------------------------------------------------------------------------------

export interface WaMessageRow {
  id: string;
  direction: 'outbound' | 'inbound';
  kind: string;
  purpose: string | null;
  template_name: string | null;
  status: string;
  status_rank: number;
  error_code: string | null;
  error_title: string | null;
  body_redacted: string | null;
  ticket_id: string | null;
  venue_id: string | null;
  queued_at: Date | null;
  sent_at: Date | null;
  delivered_at: Date | null;
  read_at: Date | null;
  failed_at: Date | null;
  received_at: Date | null;
  created_at: Date;
}

export const WA_MESSAGE_COLUMNS = `m.id, m.direction, m.kind, m.purpose, m.template_name, m.status, m.status_rank,
  m.error_code, m.error_title, m.body_redacted, m.ticket_id, m.venue_id, m.queued_at, m.sent_at, m.delivered_at,
  m.read_at, m.failed_at, m.received_at, m.created_at`;

export function waMessageView(m: WaMessageRow) {
  return {
    id: m.id,
    direction: m.direction,
    kind: m.kind,
    purpose: m.purpose,
    template_name: m.template_name,
    status: m.status,
    status_rank: Number(m.status_rank),
    error_code: m.error_code,
    error_title: m.error_title,
    // the stored body already masks the handover code (12 §5.10); phone-like digit runs are masked too
    body_redacted: m.body_redacted === null ? null : maskPhonesInText(m.body_redacted),
    ticket_id: m.ticket_id,
    venue_id: m.venue_id,
    queued_at: iso(m.queued_at),
    sent_at: iso(m.sent_at),
    delivered_at: iso(m.delivered_at),
    read_at: iso(m.read_at),
    failed_at: iso(m.failed_at),
    received_at: iso(m.received_at),
  };
}

/** Phone-like runs (9+ digits, optional `+`, spaces or dashes inside) in free text → `05•••••123` (09 §5.1). */
export function maskPhonesInText(text: string): string {
  return text.replace(/\+?\d[\d\s-]{7,}\d/g, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 9) return m;
    return maskPhone(digits.startsWith('966') ? `+${digits}` : digits) ?? '•••';
  });
}
