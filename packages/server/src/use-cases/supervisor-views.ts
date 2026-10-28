import type { TicketQueryable } from '../modules/tickets-custody/index.js';

/**
 * Read models shared by the S6 supervisor reads (operations board, ticket timeline): the WhatsAppMessage,
 * CustodyEvent and Payment schemas of 07, with the redactions of 09 §5 and 12 §5.10.
 */

const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : new Date(d).toISOString();

export const MASK = '••••••';

/** 6+ digits, also written with spaces or dashes and in Arabic-Indic digits: phone numbers, handover codes. */
const DIGIT_RUN = /[0-9٠-٩۰-۹](?:[\s-]?[0-9٠-٩۰-۹]){5,}/g;
/** A standalone 6-character token of the link-code alphabet mixing letters and digits (`K7Q29F`, 12 §6.6). */
const LINK_TOKEN =
  /(?<![A-Za-z0-9])(?=[A-HJ-NP-Z2-9]*[2-9])(?=[A-HJ-NP-Z2-9]*[A-HJ-NP-Z])[A-HJ-NP-Z2-9]{6}(?![A-Za-z0-9])/g;

/**
 * What a supervisor sees of a customer's free text (S-03 «الرسائل»): inbound bodies are stored as received
 * (12 §6.5, ≤ 1000 characters), so phone numbers, codes and link codes typed by the customer are masked here.
 * Outbound bodies are already stored with the handover code masked (12 §5.10).
 */
export function maskCustomerText(text: string | null): string | null {
  if (text == null) return null;
  return text.replace(DIGIT_RUN, MASK).replace(LINK_TOKEN, MASK);
}

export interface WaMessageRow {
  id: string;
  direction: 'inbound' | 'outbound';
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

/** WhatsAppMessage (07): no phone, no WhatsApp id, no handover code; `body` = null hides the text entirely. */
export function waMessageView(m: WaMessageRow, opts: { body?: boolean } = {}) {
  const body = opts.body ?? true;
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
    body_redacted: !body
      ? null
      : m.direction === 'inbound'
        ? maskCustomerText(m.body_redacted)
        : m.body_redacted,
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

export interface CustodyEventRow {
  id: string;
  ticket_id: string;
  subject: 'vehicle' | 'key';
  from_holder_type: string;
  from_holder_id: string | null;
  to_holder_type: string;
  to_holder_id: string | null;
  reason: string;
  task_id: string | null;
  actor_id: string;
  actor_full_name: string | null;
  actor_employee_code: string | null;
  note: string | null;
  occurred_at: Date;
}

export const CUSTODY_EVENT_SELECT = `SELECT ce.id, ce.ticket_id, ce.subject, ce.from_holder_type, ce.from_holder_id,
       ce.to_holder_type, ce.to_holder_id, ce.reason, ce.task_id, ce.actor_id, u.full_name AS actor_full_name,
       u.employee_code AS actor_employee_code, ce.note, ce.occurred_at
  FROM custody_events ce LEFT JOIN users u ON u.id = ce.actor_id`;

/** CustodyEvent (07). */
export function custodyEventView(c: CustodyEventRow) {
  return {
    id: c.id,
    ticket_id: c.ticket_id,
    subject: c.subject,
    from_holder_type: c.from_holder_type,
    from_holder_id: c.from_holder_id,
    to_holder_type: c.to_holder_type,
    to_holder_id: c.to_holder_id,
    reason: c.reason,
    task_id: c.task_id,
    actor: {
      id: c.actor_id,
      full_name: c.actor_full_name ?? '',
      ...(c.actor_employee_code ? { employee_code: c.actor_employee_code } : {}),
    },
    note: c.note,
    occurred_at: iso(c.occurred_at)!,
  };
}

export async function loadCustodyEvent(q: TicketQueryable, id: string) {
  const r = await q.query<CustodyEventRow>(`${CUSTODY_EVENT_SELECT} WHERE ce.id = $1`, [id]);
  return r.rows[0] ? custodyEventView(r.rows[0]) : null;
}

export interface PaymentRow {
  id: string;
  ticket_id: string;
  cycle_id: string | null;
  event_id: string;
  method: string;
  amount_halalas: number;
  currency: string;
  pos_reference: string | null;
  collected_by: string;
  collected_by_full_name: string;
  collected_by_employee_code: string | null;
  collected_at: Date;
  status: string;
  reversed_at: Date | null;
  reversed_by: string | null;
  reversed_by_full_name: string | null;
  reversed_by_employee_code: string | null;
  reversal_reason: string | null;
  cash_handover_id: string | null;
}

export const PAYMENT_SELECT = `SELECT p.id, p.ticket_id, p.cycle_id, p.event_id, p.method, p.amount_halalas, p.currency,
       p.pos_reference, p.collected_by, cu.full_name AS collected_by_full_name, cu.employee_code AS collected_by_employee_code,
       p.collected_at, p.status, p.reversed_at, p.reversed_by, ru.full_name AS reversed_by_full_name,
       ru.employee_code AS reversed_by_employee_code, p.reversal_reason, p.cash_handover_id
  FROM payments p JOIN users cu ON cu.id = p.collected_by LEFT JOIN users ru ON ru.id = p.reversed_by`;

const ref = (id: string | null, name: string | null, code: string | null) =>
  id ? { id, full_name: name ?? '', ...(code ? { employee_code: code } : {}) } : null;

/** Payment (07); `pos_reference` only for staff (13 §5.6). */
export function paymentView(p: PaymentRow, opts: { staff: boolean }) {
  return {
    id: p.id,
    ticket_id: p.ticket_id,
    cycle_id: p.cycle_id,
    event_id: p.event_id,
    method: p.method,
    amount_halalas: Number(p.amount_halalas),
    currency: p.currency,
    pos_reference: opts.staff ? p.pos_reference : null,
    collected_by: ref(p.collected_by, p.collected_by_full_name, p.collected_by_employee_code)!,
    collected_at: iso(p.collected_at)!,
    status: p.status,
    reversed_at: iso(p.reversed_at),
    reversed_by: ref(p.reversed_by, p.reversed_by_full_name, p.reversed_by_employee_code),
    reversal_reason: p.reversal_reason,
    cash_handover_id: p.cash_handover_id,
  };
}
