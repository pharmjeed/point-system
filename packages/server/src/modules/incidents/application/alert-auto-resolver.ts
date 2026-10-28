import { publishStatus, type AlertRow } from '../../../core/alerts/alerts.js';
import type { EventEnvelope, Tx } from '../../../core/db/tx.js';
import type { EventProjector, OutboxRow } from '../../../core/outbox/dispatcher.js';

type Payload = Record<string, any>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const ticketIdOf = (p: Payload): string | null => str(p.ticket?.ticket_id) ?? str(p.ticket_id);
const keys = (...k: (string | false | null)[]) => k.filter((x): x is string => !!x);

/** The alerts a task leaves behind once it is claimed, started, promoted, reassigned, withdrawn or closed. */
const nextTaskKeys = (taskId: string | null) =>
  taskId ? [`next_task_waiting_long:${taskId}`, `idle_driver_while_next_waiting:${taskId}`] : [];
/** A closed or reparked cycle: nothing is waiting for the customer any more. */
const cycleKeys = (cycleId: string | null) =>
  cycleId ? [`ready_not_collected:${cycleId}`, `handover_code_locked:${cycleId}`] : [];

/**
 * 11 §6.10 / 14 §8 automatic resolution, by domain event: the dedupe keys an event clears. Producers that
 * already resolve inline (submit-intake, void, promotion, the supervisor commands) are repeated here on purpose —
 * resolving is idempotent, and the projector also covers the producers that do not (late photo completion,
 * delivery, repark, cancellations, claims).
 */
export const AUTO_RESOLVE_RULES: Readonly<Record<string, (p: Payload) => string[]>> = {
  'task.claimed': (p) => keys(str(p.task_id) && `request_unaccepted:${p.task_id}`),
  'task.started': (p) => nextTaskKeys(str(p.task_id)),
  'task.promoted': (p) => nextTaskKeys(str(p.task_id)),
  'task.reassigned': (p) => nextTaskKeys(str(p.task_id)),
  'task.withdrawn': (p) => nextTaskKeys(str(p.task_id)),
  'task.canceled': (p) => [
    ...keys(str(p.task_id) && `request_unaccepted:${p.task_id}`),
    ...nextTaskKeys(str(p.task_id)),
  ],
  'ticket.delivered': (p) => cycleKeys(str(p.cycle_id)),
  'ticket.reparking': (p) => cycleKeys(str(p.closed_cycle_id) ?? str(p.cycle_id)),
  'ticket.retrieval_canceled': (p) => cycleKeys(str(p.cycle_id)),
  'handover.code_issued': (p) => keys(str(p.cycle_id) && `handover_code_locked:${p.cycle_id}`),
  'handover.exception_approved': (p) => keys(str(p.cycle_id) && `handover_code_locked:${p.cycle_id}`),
  'ticket.inspection_completed': (p) => keys(ticketIdOf(p) && `inspection_incomplete:${ticketIdOf(p)}`),
  'ticket.inspection_exception_approved': (p) =>
    keys(ticketIdOf(p) && `inspection_incomplete:${ticketIdOf(p)}`),
  'ticket.intake_submitted': (p) => keys(ticketIdOf(p) && `draft_abandoned:${ticketIdOf(p)}`),
  'ticket.voided': (p) => {
    const id = ticketIdOf(p);
    return id ? [`draft_abandoned:${id}`, `inspection_incomplete:${id}`] : [];
  },
};

/** Ticket closures also clear the per-message failures of that ticket (`wa_send_failed:{ticket_id}:{purpose}`). */
const CLOSING_EVENTS = new Set(['ticket.delivered', 'ticket.voided', 'ticket.manually_reconciled']);

/**
 * AlertAutoResolver (04 §4.2 item 7, 11 §6.10): consumes domain events in the worker and resolves the live alerts
 * whose condition the event ended — `resolved_at` set, `resolved_by` left NULL, `alert.resolved` + realtime
 * `alert.updated` through the core `publishStatus`. Only alerts raised no later than the event are touched, so
 * a late delivery never resolves a condition that was raised again afterwards. Idempotent and order-independent.
 */
export function createAlertAutoResolver(): EventProjector {
  return {
    name: 'alert_auto_resolver',
    accepts: (type) => type in AUTO_RESOLVE_RULES || type === 'custody.changed' || CLOSING_EVENTS.has(type),
    async project(tx: Tx, row: OutboxRow) {
      const env = row.payload as EventEnvelope<Payload>;
      const p = (env?.payload ?? {}) as Payload;
      const at = new Date(env?.occurred_at ?? row.created_at);
      const orgId = env?.org_id ?? row.org_id;
      const venueId = env?.venue_id ?? row.venue_id ?? null;
      const dedupe = AUTO_RESOLVE_RULES[row.type]?.(p) ?? [];
      let prefix: string | null = null;
      if (CLOSING_EVENTS.has(row.type)) {
        const ticketId = ticketIdOf(p);
        const target = p.target_status;
        if (
          ticketId &&
          (row.type !== 'ticket.manually_reconciled' || target === 'delivered' || target === 'voided')
        )
          prefix = `wa_send_failed:${ticketId}:`;
      }
      if (row.type === 'custody.changed') dedupe.push(...(await custodyGoneKeys(tx, p)));
      if (!dedupe.length && !prefix) return;
      const resolved = await tx.rows<AlertRow>(
        `UPDATE alerts SET status = 'resolved', resolved_at = $3, resolved_by = NULL,
                resolution_note = COALESCE(resolution_note, $4)
          WHERE org_id = $1 AND status <> 'resolved' AND raised_at <= $5
            AND ($6::uuid IS NULL OR venue_id = $6)
            AND (dedupe_key = ANY($2::text[]) OR ($7::text IS NOT NULL AND starts_with(dedupe_key, $7)))
          RETURNING *`,
        [orgId, dedupe, tx.now, row.type, at, venueId, prefix],
      );
      for (const a of resolved) await publishStatus(tx, a, null, true);
    },
  };
}

/**
 * `driver_connection_lost_with_custody:{duty_session_id}` (14 §8) clears once the driver who handed something over
 * holds nothing any more: no vehicle or key of an open ticket and no active movement.
 */
async function custodyGoneKeys(tx: Tx, p: Payload): Promise<string[]> {
  const from = p.from as { type?: string; id?: string | null } | undefined;
  if (from?.type !== 'driver' || !str(from.id)) return [];
  const holds = await tx.maybeOne<{ holds: boolean }>(
    `SELECT (EXISTS (SELECT 1 FROM tickets
                      WHERE status NOT IN ('delivered','voided')
                        AND ((vehicle_holder_type = 'driver' AND vehicle_holder_id = $1)
                          OR (key_holder_type = 'driver' AND key_holder_id = $1)))
          OR EXISTS (SELECT 1 FROM tasks WHERE assignee_id = $1 AND status IN ('accepted','in_progress'))) AS holds`,
    [from.id],
  );
  if (holds?.holds) return [];
  const sessions = await tx.rows<{ id: string }>(`SELECT id FROM duty_sessions WHERE user_id = $1`, [
    from.id,
  ]);
  return sessions.map((s) => `driver_connection_lost_with_custody:${s.id}`);
}
