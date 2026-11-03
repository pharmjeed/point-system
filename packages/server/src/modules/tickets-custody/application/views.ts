import type pg from 'pg';
import type { Role } from '@point/shared';
import { maskPhone } from '../../../core/logging/redact.js';
import { listTicketMedia } from '../../media/index.js';
import { plateView } from '../domain/plate.js';
import type { CycleRow, TicketRow } from '../infra/rows.js';
import { loadClaimCodeState } from './claim-codes.js';

/** Anything that can run a query: a Tx, the Database pool, a pg client. */
export interface Queryable {
  query<R extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<pg.QueryResult<R>>;
}

export const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : new Date(d).toISOString();

export interface UserRefRow {
  id: string;
  full_name: string;
  employee_code: string | null;
}

export const userRef = (u: UserRefRow | null | undefined) =>
  u ? { id: u.id, full_name: u.full_name, employee_code: u.employee_code ?? undefined } : null;

/** `tasks` row as read by projections (owned by dispatch; read-only here). */
export interface TaskReadRow {
  id: string;
  org_id: string;
  venue_id: string;
  dispatch_pool_id: string;
  event_id: string;
  ticket_id: string;
  cycle_id: string | null;
  type: 'park' | 'retrieve' | 'repark';
  status: string;
  priority_at: Date;
  seq: number;
  assignee_id: string | null;
  queued_at: Date | null;
  first_offered_at: Date | null;
  broadcast_at: Date | null;
  claimed_at: Date | null;
  assigned_waiting_at: Date | null;
  accepted_at: Date | null;
  key_picked_up_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  canceled_at: Date | null;
  cancel_reason: string | null;
  escalated_at: Date | null;
  version: number;
  assignee_full_name?: string | null;
  assignee_employee_code?: string | null;
}

/** Task schema (07). `showAssignee = false` hides the assignee (09 §5.1: name visible to staff and to himself). */
export function taskView(k: TaskReadRow, opts: { showAssignee?: boolean } = {}) {
  const show = opts.showAssignee ?? true;
  return {
    id: k.id,
    ticket_id: k.ticket_id,
    cycle_id: k.cycle_id,
    event_id: k.event_id,
    venue_id: k.venue_id,
    dispatch_pool_id: k.dispatch_pool_id,
    type: k.type,
    status: k.status,
    priority_at: iso(k.priority_at)!,
    seq: Number(k.seq),
    assignee:
      show && k.assignee_id
        ? {
            id: k.assignee_id,
            full_name: k.assignee_full_name ?? '',
            employee_code: k.assignee_employee_code ?? undefined,
          }
        : null,
    queued_at: iso(k.queued_at),
    first_offered_at: iso(k.first_offered_at),
    broadcast_at: iso(k.broadcast_at),
    claimed_at: iso(k.claimed_at),
    assigned_waiting_at: iso(k.assigned_waiting_at),
    accepted_at: iso(k.accepted_at),
    key_picked_up_at: iso(k.key_picked_up_at),
    started_at: iso(k.started_at),
    completed_at: iso(k.completed_at),
    canceled_at: iso(k.canceled_at),
    cancel_reason: k.cancel_reason,
    escalated_at: iso(k.escalated_at),
    version: k.version,
  };
}

export const TASK_SELECT = `SELECT k.*, u.full_name AS assignee_full_name, u.employee_code AS assignee_employee_code
  FROM tasks k LEFT JOIN users u ON u.id = k.assignee_id`;

export async function loadTaskView(q: Queryable, taskId: string) {
  const r = await q.query<TaskReadRow>(`${TASK_SELECT} WHERE k.id = $1`, [taskId]);
  return r.rows[0] ? taskView(r.rows[0]) : null;
}

/** RetrievalCycle schema (07). */
export function cycleView(c: CycleRow) {
  return {
    id: c.id,
    ticket_id: c.ticket_id,
    cycle_no: c.cycle_no,
    requested_at: iso(c.requested_at)!,
    request_source: c.request_source,
    requested_early: c.requested_early,
    request_reason: c.request_reason,
    assigned_at: iso(c.assigned_at),
    assigned_waiting_at: iso(c.assigned_waiting_at),
    accepted_by: c.accepted_by,
    started_at: iso(c.started_at),
    ready_at: iso(c.ready_at),
    delivered_at: iso(c.delivered_at),
    canceled_at: iso(c.canceled_at),
    cancel_reason: c.cancel_reason,
    reparked_at: iso(c.reparked_at),
    retrieved_by: c.retrieved_by,
    delivered_by: c.delivered_by,
    outcome: c.outcome,
    closed_at: iso(c.closed_at),
  };
}

export type TicketSummaryRow = TicketRow & {
  event_name_ar: string;
  venue_name_ar: string;
  cycle_requested_at: Date | null;
};

export const SUMMARY_SELECT = `SELECT t.*, e.name_ar AS event_name_ar, v.name_ar AS venue_name_ar, c.requested_at AS cycle_requested_at
  FROM tickets t
  JOIN events e ON e.id = t.event_id
  JOIN venues v ON v.id = t.venue_id
  LEFT JOIN retrieval_cycles c ON c.id = t.active_cycle_id`;

/** TicketSummary (07; 09 §5.1 minimal projection). */
export function ticketSummary(t: TicketSummaryRow) {
  return {
    id: t.id,
    display_number: t.display_number,
    event_id: t.event_id,
    event_name_ar: t.event_name_ar,
    venue_id: t.venue_id,
    venue_name_ar: t.venue_name_ar,
    status: t.status,
    channel: t.channel,
    plate: plateView(t),
    vehicle: { make: t.vehicle_make, color: t.vehicle_color },
    wa_link_status: t.wa_link_status,
    payment_status: t.payment_status,
    requested_at: iso(t.cycle_requested_at),
    // DEC-13 early request while received/parking/reparking: the driver reads it from the state, whatever the
    // coalesced cause of the update (DEC-265, 14 §5.1 «طلب مبكر أثناء الصف»)
    pending_retrieval_at: iso(t.pending_retrieval_at),
    created_at: iso(t.created_at)!,
    version: t.version,
  };
}

export async function loadTicketSummary(q: Queryable, ticketId: string) {
  const r = await q.query<TicketSummaryRow>(`${SUMMARY_SELECT} WHERE t.id = $1`, [ticketId]);
  return r.rows[0] ? ticketSummary(r.rows[0]) : null;
}

export interface Viewer {
  userId: string;
  role: Role;
}

const STAFF: ReadonlySet<Role> = new Set<Role>(['supervisor', 'admin', 'owner']);

/**
 * TicketDetail (07) built from an allow-list per viewer (09 §5.1): `full` for staff in scope, the assignee of
 * an open task on the ticket, and its creator during intake (received/parking); `minimal` otherwise.
 */
export async function loadTicketDetail(q: Queryable, ticketId: string, viewer: Viewer) {
  const tr = await q.query<TicketSummaryRow>(`${SUMMARY_SELECT} WHERE t.id = $1`, [ticketId]);
  const t = tr.rows[0];
  if (!t) return null;
  const taskRes = await q.query<TaskReadRow>(
    `${TASK_SELECT} WHERE k.ticket_id = $1 AND k.status NOT IN ('completed','canceled')`,
    [ticketId],
  );
  const openTask = taskRes.rows[0] ?? null;
  const isStaff = STAFF.has(viewer.role);
  const isAssignee = !!openTask && openTask.assignee_id === viewer.userId;
  const isCreatorIntake =
    t.created_by === viewer.userId && (t.status === 'received' || t.status === 'parking');
  const full = isStaff || isAssignee || isCreatorIntake;

  const base = {
    ...ticketSummary(t),
    projection: full ? ('full' as const) : ('minimal' as const),
    vehicle_detail: {
      make: t.vehicle_make,
      model: t.vehicle_model,
      color: t.vehicle_color,
      type: t.vehicle_type,
    },
    parked_at: iso(t.parked_at),
    open_task: openTask ? taskView(openTask, { showAssignee: isStaff || isAssignee }) : null,
  };
  if (!full) return base;

  const spot = t.current_spot_id
    ? (
        await q.query<{ id: string; label: string; zone_name: string }>(
          `SELECT s.id, s.label, z.name AS zone_name FROM parking_spots s JOIN parking_zones z ON z.id = s.zone_id WHERE s.id = $1`,
          [t.current_spot_id],
        )
      ).rows[0]
    : undefined;
  const slot = t.current_key_slot_id
    ? (
        await q.query<{ id: string; label: string; board_name: string }>(
          `SELECT k.id, k.label, b.name AS board_name FROM key_slots k JOIN key_boards b ON b.id = k.key_board_id WHERE k.id = $1`,
          [t.current_key_slot_id],
        )
      ).rows[0]
    : undefined;
  const customer = t.customer_id
    ? (
        await q.query<{ phone_e164: string | null; wa_opted_out_at: Date | null }>(
          `SELECT phone_e164, wa_opted_out_at FROM customers WHERE id = $1`,
          [t.customer_id],
        )
      ).rows[0]
    : undefined;
  const consent = t.customer_id
    ? (
        await q.query<{ method: string; captured_at: Date; revoked_at: Date | null }>(
          `SELECT method, captured_at, revoked_at FROM customer_consents
            WHERE ticket_id = $1 AND customer_id = $2 ORDER BY captured_at DESC, id DESC LIMIT 1`,
          [t.id, t.customer_id],
        )
      ).rows[0]
    : undefined;
  const media = await listTicketMedia(q, t.id);
  const inspection = (
    await q.query<{ damage_marks: { area: string; note?: string }[] }>(
      `SELECT damage_marks FROM vehicle_inspections WHERE ticket_id = $1 AND kind = 'intake' ORDER BY created_at DESC, id DESC LIMIT 1`,
      [t.id],
    )
  ).rows[0];
  const cycle = t.active_cycle_id
    ? (await q.query<CycleRow>(`SELECT * FROM retrieval_cycles WHERE id = $1`, [t.active_cycle_id])).rows[0]
    : undefined;
  const payment = (
    await q.query<{
      id: string;
      ticket_id: string;
      cycle_id: string | null;
      event_id: string;
      method: string;
      amount_halalas: number;
      currency: string;
      pos_reference: string | null;
      collected_by: string;
      collected_at: Date;
      status: string;
      reversed_at: Date | null;
      reversed_by: string | null;
      reversal_reason: string | null;
      cash_handover_id: string | null;
    }>(`SELECT * FROM payments WHERE ticket_id = $1 ORDER BY collected_at DESC, id DESC LIMIT 1`, [t.id])
  ).rows[0];
  const pendingLink = (
    await q.query<{ id: string; inbound_phone_e164: string | null; received_at: Date }>(
      `SELECT l.id, l.inbound_phone_e164, COALESCE(m.received_at, m.created_at, l.created_at) AS received_at
         FROM link_codes l LEFT JOIN whatsapp_messages m ON m.id = l.inbound_message_id
        WHERE l.ticket_id = $1 AND l.status = 'pending_confirmation' LIMIT 1`,
      [t.id],
    )
  ).rows[0];
  const actorIds = [
    t.created_by,
    t.parked_by,
    t.retrieved_by,
    t.delivered_by,
    payment?.collected_by,
    payment?.reversed_by,
  ].filter((x): x is string => !!x);
  const users = new Map(
    (
      await q.query<UserRefRow>(`SELECT id, full_name, employee_code FROM users WHERE id = ANY($1::uuid[])`, [
        [...new Set(actorIds)],
      ])
    ).rows.map((u) => [u.id, u]),
  );

  const holderLabel = (type: string, id: string | null) => {
    if (type === 'driver' && id) return users.get(id)?.full_name ?? null;
    if (type === 'spot') return spot?.label ?? t.current_spot_note ?? null;
    if (type === 'key_slot') return slot ? `${slot.board_name} / ${slot.label}` : null;
    return null;
  };
  const ownsVehicle = t.vehicle_holder_type === 'driver' && t.vehicle_holder_id === viewer.userId;
  const ownsKey = t.key_holder_type === 'driver' && t.key_holder_id === viewer.userId;
  const retrieveAssignee = isAssignee && openTask?.type === 'retrieve';
  const ownPayment = !!payment && payment.collected_by === viewer.userId;

  const detail: Record<string, unknown> = {
    ...base,
    customer: t.customer_id
      ? {
          phone_masked: maskPhone(customer?.phone_e164 ?? null),
          ...(isStaff
            ? {
                consent: consent
                  ? {
                      method: consent.method,
                      captured_at: iso(consent.captured_at)!,
                      revoked_at: iso(consent.revoked_at),
                    }
                  : null,
              }
            : {}),
          opted_out: !!customer?.wa_opted_out_at,
        }
      : null,
    wa_link_pending:
      pendingLink && (isStaff || isCreatorIntake || isAssignee)
        ? {
            link_code_id: pendingLink.id,
            inbound_phone_masked: maskPhone(pendingLink.inbound_phone_e164) ?? '',
            received_at: iso(pendingLink.received_at)!,
          }
        : null,
    key_tag: t.key_tag,
    inspection_status: t.inspection_status,
    damage_marks: inspection?.damage_marks ?? [],
    notes: t.notes,
    current_spot: spot ? { id: spot.id, label: spot.label, zone_name: spot.zone_name } : null,
    current_spot_note: t.current_spot_note,
    current_key_slot: slot ? { id: slot.id, label: slot.label, board_name: slot.board_name } : null,
    active_cycle: cycle ? cycleView(cycle) : null,
    media,
    claim_code: await loadClaimCodeState(q, t.venue_id, t.active_cycle_id), // PNT-047: state only, never the code
    submitted_at: iso(t.submitted_at),
    delivered_at: iso(t.delivered_at),
    voided_at: iso(t.voided_at),
    void_reason: t.void_reason,
  };
  if (isStaff || ownsVehicle)
    detail.vehicle_holder = {
      type: t.vehicle_holder_type,
      id: t.vehicle_holder_id,
      label: holderLabel(t.vehicle_holder_type, t.vehicle_holder_id),
    };
  if (isStaff || ownsKey)
    detail.key_holder = {
      type: t.key_holder_type,
      id: t.key_holder_id,
      label: holderLabel(t.key_holder_type, t.key_holder_id),
    };
  // the retrieval assignee never sees the paper serial: the server matches the stub at handover (09 §5.1)
  if (isStaff || isCreatorIntake) detail.paper_serial = t.paper_serial;
  if (isStaff || retrieveAssignee) detail.fee_halalas = t.fee_halalas;
  if (payment && (isStaff || ownPayment))
    detail.payment = {
      id: payment.id,
      ticket_id: payment.ticket_id,
      cycle_id: payment.cycle_id,
      event_id: payment.event_id,
      method: payment.method,
      amount_halalas: payment.amount_halalas,
      currency: payment.currency,
      pos_reference: payment.pos_reference,
      collected_by: userRef(users.get(payment.collected_by)),
      collected_at: iso(payment.collected_at)!,
      status: payment.status,
      reversed_at: iso(payment.reversed_at),
      reversed_by: payment.reversed_by ? userRef(users.get(payment.reversed_by)) : null,
      reversal_reason: payment.reversal_reason,
      cash_handover_id: payment.cash_handover_id,
    };
  else if (isStaff) detail.payment = null;
  if (isStaff) {
    detail.payment_waiver_reason = t.payment_waiver_reason;
    detail.created_by = userRef(users.get(t.created_by));
    detail.parked_by = t.parked_by ? userRef(users.get(t.parked_by)) : null;
    detail.retrieved_by = t.retrieved_by ? userRef(users.get(t.retrieved_by)) : null;
    detail.delivered_by = t.delivered_by ? userRef(users.get(t.delivered_by)) : null;
  }
  return detail;
}
