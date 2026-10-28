import {
  SUMMARY_SELECT,
  TASK_SELECT,
  taskView,
  ticketSummary,
  type TaskReadRow,
  type TicketQueryable,
  type TicketSummaryRow,
} from '../../tickets-custody/index.js';
import type { EventRow } from './scope.js';
import { computeSettlement, financeSummary, type Settlement } from './settlement.js';
import {
  WA_MESSAGE_COLUMNS,
  incidentView,
  iso,
  loadUserRefs,
  refOf,
  waMessageView,
  type IncidentRow,
  type WaMessageRow,
} from './views.js';

/**
 * The reconciliation of an event before its close (S-10, PNT-087; 07 `Reconciliation`, 11 §6.4, 13 §12). The
 * blockers are exactly `details.blockers` of EVENT_CLOSE_BLOCKED: open tickets, keys not on the board, open
 * requests, open tasks (drafts, accepted or running movements, reserved next tasks, reparks), and the financial
 * blockers of the settlement. The warnings never block (open incidents, failed messages, cash differences).
 */
export interface Reconciliation {
  event_id: string;
  can_close: boolean;
  blockers: {
    open_tickets: ReturnType<typeof ticketSummary>[];
    keys_not_in_slots: ReturnType<typeof ticketSummary>[];
    open_requests: QueueItem[];
    open_tasks: ReturnType<typeof taskView>[];
    unsettled_payments: Settlement['close_blockers']['unsettled_payments'];
    cash_outstanding: Settlement['close_blockers']['cash_outstanding'];
    payment_integrity: Settlement['close_blockers']['payment_integrity'];
  };
  warnings: {
    open_incidents: ReturnType<typeof incidentView>[];
    failed_messages: ReturnType<typeof waMessageView>[];
    cash_discrepancies: {
      cash_handover_id: string;
      driver: { id: string; full_name: string; employee_code?: string };
      difference_halalas: number;
    }[];
  };
}

export interface QueueItem {
  task_id: string;
  ticket: ReturnType<typeof ticketSummary>;
  status: string;
  requested_at: string;
  waiting_seconds: number;
  offer: {
    offer_id: string;
    mode: string;
    round_no: number;
    expires_at: string | null;
    recipients: number;
  } | null;
  escalated_at: string | null;
  assignee: { id: string; full_name: string; employee_code?: string } | null;
}

/** Statuses of a queued retrieval (07 `QueueItem`); the other open tasks are listed in `open_tasks`. */
const QUEUE_STATUSES = ['queued', 'offered', 'broadcast'];

export async function computeReconciliation(
  q: TicketQueryable,
  ev: EventRow,
  now: Date,
): Promise<{ reconciliation: Reconciliation; settlement: Settlement }> {
  const open = (
    await q.query<TicketSummaryRow>(
      `${SUMMARY_SELECT} WHERE t.event_id = $1 AND t.status NOT IN ('delivered','voided') ORDER BY t.display_number`,
      [ev.id],
    )
  ).rows;

  const queue = (
    await q.query<{
      task_id: string;
      ticket_id: string;
      status: string;
      priority_at: Date;
      requested_at: Date | null;
      escalated_at: Date | null;
      assignee_id: string | null;
      offer_id: string | null;
      mode: string | null;
      round_no: number | null;
      expires_at: Date | null;
      recipients: number | null;
    }>(
      `SELECT k.id AS task_id, k.ticket_id, k.status, k.priority_at, c.requested_at, k.escalated_at, k.assignee_id,
              o.id AS offer_id, o.mode, o.round_no, o.expires_at,
              (SELECT count(*)::int FROM offer_recipients r WHERE r.offer_id = o.id) AS recipients
         FROM tasks k
         LEFT JOIN retrieval_cycles c ON c.id = k.cycle_id
         LEFT JOIN task_offers o ON o.task_id = k.id AND o.status = 'active'
        WHERE k.event_id = $1 AND k.type = 'retrieve' AND k.status = ANY($2::text[])
        ORDER BY k.priority_at, k.seq`,
      [ev.id, QUEUE_STATUSES],
    )
  ).rows;

  const tasks = (
    await q.query<TaskReadRow>(
      `${TASK_SELECT} WHERE k.event_id = $1 AND k.status NOT IN ('completed','canceled')
         AND NOT (k.type = 'retrieve' AND k.status = ANY($2::text[]))
       ORDER BY k.priority_at, k.seq`,
      [ev.id, QUEUE_STATUSES],
    )
  ).rows;

  const incidents = (
    await q.query<IncidentRow>(
      `SELECT * FROM incidents WHERE event_id = $1 AND status IN ('open','in_review') ORDER BY created_at, id`,
      [ev.id],
    )
  ).rows;
  const failed = (
    await q.query<WaMessageRow>(
      `SELECT ${WA_MESSAGE_COLUMNS} FROM whatsapp_messages m
        WHERE m.event_id = $1 AND m.direction = 'outbound' AND m.status = 'failed'
        ORDER BY m.created_at DESC, m.id DESC LIMIT 200`,
      [ev.id],
    )
  ).rows;

  const settlement = await computeSettlement(q, ev);
  const users = await loadUserRefs(q, [
    ...queue.map((x) => x.assignee_id),
    ...incidents.flatMap((i) => [i.opened_by, i.owner_id, i.resolved_by]),
  ]);
  const summaries = new Map(open.map((t) => [t.id, ticketSummary(t)]));

  const reconciliation: Reconciliation = {
    event_id: ev.id,
    can_close: false,
    blockers: {
      open_tickets: open.map(ticketSummary),
      // the key with a person (driver, supervisor), unknown, or not yet deposited
      keys_not_in_slots: open.filter((t) => t.key_holder_type !== 'key_slot').map(ticketSummary),
      open_requests: queue.map((x) => ({
        task_id: x.task_id,
        ticket: summaries.get(x.ticket_id)!,
        status: x.status,
        requested_at: iso(x.requested_at ?? x.priority_at)!,
        waiting_seconds: Math.max(0, Math.round((now.getTime() - new Date(x.priority_at).getTime()) / 1000)),
        offer: x.offer_id
          ? {
              offer_id: x.offer_id,
              mode: x.mode!,
              round_no: x.round_no!,
              expires_at: iso(x.expires_at),
              recipients: Number(x.recipients ?? 0),
            }
          : null,
        escalated_at: iso(x.escalated_at),
        assignee: refOf(users, x.assignee_id),
      })),
      open_tasks: tasks.map((k) => taskView(k)),
      unsettled_payments: settlement.close_blockers.unsettled_payments,
      cash_outstanding: settlement.close_blockers.cash_outstanding,
      payment_integrity: settlement.close_blockers.payment_integrity,
    },
    warnings: {
      open_incidents: incidents.map((i) => incidentView(i, users)),
      failed_messages: failed.map(waMessageView),
      cash_discrepancies: settlement.cash_handovers
        .filter((h) => h.difference_halalas !== 0)
        .map((h) => ({ cash_handover_id: h.id, driver: h.driver, difference_halalas: h.difference_halalas })),
    },
  };
  reconciliation.can_close = Object.values(reconciliation.blockers).every((list) => list.length === 0);
  return { reconciliation, settlement };
}

/**
 * `events.close_summary` written by the close (13 §12, FR-SUP-05): the frozen finance part (`amounts`, `drivers`,
 * `discrepancies`), the ticket counts and the warnings that were accepted at close time.
 */
export function closeSummary(
  r: Reconciliation,
  s: Settlement,
  at: { closedAt: Date; closedBy: string; note: string | null },
) {
  return {
    closed_at: at.closedAt.toISOString(),
    closed_by: at.closedBy,
    note: at.note,
    tickets: s.tickets,
    finance: financeSummary(s),
    warnings: {
      open_incidents: r.warnings.open_incidents.map((i) => i.id),
      failed_messages: r.warnings.failed_messages.length,
      cash_discrepancies: r.warnings.cash_discrepancies,
    },
  };
}
