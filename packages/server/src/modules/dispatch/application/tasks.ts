import { autoResolveAlerts } from '../../../core/alerts/alerts.js';
import { newId } from '../../../core/crypto/ids.js';
import { lockCycles, lockOpenDutyByUsers, lockTasks, lockTickets } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import { InvariantViolation } from '../../../core/errors/app-error.js';
import {
  emitForTicket,
  ticketRef,
  type CycleRow,
  type EventActor,
  type TicketCtx,
  type TicketRow,
} from '../../tickets-custody/index.js';
import type { DutyRow, TaskRow } from '../infra/rows.js';
import { emitAvailability, emitTaskEvent } from './events.js';
import { scheduleEscalation } from './offers.js';
import { dispatchSettings } from './settings.js';

/** TT-01: the park task of a new ticket, `in_progress` for the driver who started the intake. */
export async function insertParkTask(tx: Tx, ticket: TicketRow, assigneeId: string): Promise<TaskRow> {
  return tx.one<TaskRow>(
    `INSERT INTO tasks (id, org_id, venue_id, dispatch_pool_id, event_id, ticket_id, type, status, priority_at,
                        assignee_id, accepted_at, started_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'park', 'in_progress', $7, $8, $7, $7, $7, $7) RETURNING *`,
    [
      newId(),
      ticket.org_id,
      ticket.venue_id,
      ticket.dispatch_pool_id,
      ticket.event_id,
      ticket.id,
      tx.now,
      assigneeId,
    ],
  );
}

/** TT-06/TT-08: a retrieve task `queued` with `priority_at = requested_at` (DEC-13 keeps the original time). */
export async function insertRetrieveTask(
  tx: Tx,
  ticket: Pick<TicketRow, 'id' | 'org_id' | 'venue_id' | 'dispatch_pool_id' | 'event_id'>,
  cycle: Pick<CycleRow, 'id' | 'requested_at'>,
): Promise<TaskRow> {
  return tx.one<TaskRow>(
    `INSERT INTO tasks (id, org_id, venue_id, dispatch_pool_id, event_id, ticket_id, cycle_id, type, status,
                        priority_at, queued_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'retrieve', 'queued', $8, $9, $9, $9) RETURNING *`,
    [
      newId(),
      ticket.org_id,
      ticket.venue_id,
      ticket.dispatch_pool_id,
      ticket.event_id,
      ticket.id,
      cycle.id,
      cycle.requested_at,
      tx.now,
    ],
  );
}

/**
 * TT-20 / TT-20b: the `repark` task of the driver who holds the vehicle, created directly `in_progress` (canon §5.2:
 * park and repark tasks are never offered). The caller canceled the retrieve task first (uq_tasks_open_per_ticket,
 * uq_tasks_active_movement_driver are not deferrable).
 */
export async function insertReparkTask(
  tx: Tx,
  ticket: Pick<TicketRow, 'id' | 'org_id' | 'venue_id' | 'dispatch_pool_id' | 'event_id'>,
  assigneeId: string,
): Promise<TaskRow> {
  return tx.one<TaskRow>(
    `INSERT INTO tasks (id, org_id, venue_id, dispatch_pool_id, event_id, ticket_id, type, status, priority_at,
                        assignee_id, accepted_at, started_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'repark', 'in_progress', $7, $8, $7, $7, $7, $7) RETURNING *`,
    [
      newId(),
      ticket.org_id,
      ticket.venue_id,
      ticket.dispatch_pool_id,
      ticket.event_id,
      ticket.id,
      tx.now,
      assigneeId,
    ],
  );
}

export type TaskCancelReason =
  | 'customer_field_cancel'
  | 'supervisor_cancel'
  | 'repark_customer_absent'
  | 'manual_reconcile'
  | 'draft_discarded'
  | 'ticket_voided';

/**
 * Cancels an open task (`task.canceled`, 11 §8.3) — no silent delete. The caller holds the task row (L4) and
 * revoked its live round before (offer.revoked → offer.closed); releasing the driver is the caller's business.
 */
export async function cancelTask(
  tx: Tx,
  task: TaskRow,
  m: { cancelReason: TaskCancelReason; canceledBy: string | null; actor: EventActor; ticket?: TicketCtx },
): Promise<TaskRow> {
  const canceled = await tx.one<TaskRow>(
    `UPDATE tasks SET status = 'canceled', canceled_at = $2, canceled_by = $3, cancel_reason = $4, version = version + 1
      WHERE id = $1 AND status NOT IN ('completed','canceled') RETURNING *`,
    [task.id, tx.now, m.canceledBy, m.cancelReason],
  );
  await emitTaskEvent(
    tx,
    canceled,
    'task.canceled',
    m.actor,
    {
      task_id: canceled.id,
      ticket_id: canceled.ticket_id,
      type: canceled.type,
      previous_status: task.status,
      assignee_id: task.assignee_id,
      cancel_reason: m.cancelReason,
      canceled_by: m.canceledBy,
    },
    m.ticket,
  );
  return canceled;
}

export type SettleOutcome =
  | { outcome: 'promoted'; task: TaskRow; ticket: TicketRow }
  | { outcome: 'available'; duty: DutyRow }
  | { outcome: 'off' };

/**
 * 10 §6.1 / §6.2: called with the pool lock held AFTER the driver's current task was completed or canceled.
 * His reserved next task is promoted in the same transaction (he never passes through `available`);
 * otherwise `available_since = now`. The caller then runs the dispatch pass.
 */
export async function settleDriverAfterTask(
  tx: Tx,
  driverId: string,
  afterTaskId: string,
  actor: EventActor,
): Promise<SettleOutcome> {
  const nextId = await tx.maybeOne<{ id: string }>(
    `SELECT id FROM tasks WHERE assignee_id = $1 AND status = 'assigned_waiting'`,
    [driverId],
  );
  if (nextId) {
    const [next] = await lockTasks(tx, [nextId.id]); // L4 (same pool, canon §14ب exception)
    const n = next as TaskRow;
    await lockTickets(tx, [n.ticket_id]); // L5
    if (n.cycle_id) await lockCycles(tx, [n.cycle_id]); // L6
    const task = await tx.one<TaskRow>(
      `UPDATE tasks SET status = 'accepted', accepted_at = $2, version = version + 1
        WHERE id = $1 AND status = 'assigned_waiting' RETURNING *`,
      [n.id, tx.now],
    );
    const ticket = await tx.maybeOne<TicketRow>(
      `UPDATE tickets SET status = 'assigned', version = version + 1
        WHERE id = $1 AND status = 'assigned_waiting' RETURNING *`,
      [n.ticket_id],
    );
    if (!ticket) throw new InvariantViolation(`ticket of next task ${n.id} is not assigned_waiting`);
    if (n.cycle_id)
      await tx.query(`UPDATE retrieval_cycles SET assigned_at = $2 WHERE id = $1`, [n.cycle_id, tx.now]);
    await emitTaskEvent(
      tx,
      task,
      'task.promoted',
      actor,
      { task_id: task.id, ticket_id: task.ticket_id, assignee_id: driverId, after_task_id: afterTaskId },
      ticket,
    );
    await emitForTicket(tx, ticket, {
      type: 'ticket.assigned',
      actor,
      payload: {
        ticket: ticketRef(ticket),
        cycle_id: task.cycle_id,
        task_id: task.id,
        assignee_id: driverId,
        via: 'promotion',
      },
    });
    await autoResolveAlerts(tx, {
      orgId: task.org_id,
      venueId: task.venue_id,
      dedupeKeys: [`next_task_waiting_long:${task.id}`, `idle_driver_while_next_waiting:${task.id}`],
      note: 'promoted',
    });
    return { outcome: 'promoted', task, ticket };
  }
  const [duty] = await lockOpenDutyByUsers<DutyRow>(tx, [driverId]); // L8
  if (duty && duty.status === 'on_duty') {
    const d = await tx.one<DutyRow>(
      `UPDATE duty_sessions SET available_since = $2, version = version + 1 WHERE id = $1 RETURNING *`,
      [duty.id, tx.now],
    );
    await emitAvailability(tx, driverId, actor);
    return { outcome: 'available', duty: d };
  }
  return { outcome: 'off' };
}

/**
 * Back to the queue with the original priority (TT-12/TT-13, DEC-32): a new episode (`queued_at = now`, a new
 * `job.escalate_unaccepted` from it), the ticket `requested`, the cycle unassigned, `task.withdrawn`; the
 * waiting alerts of the reserved task are resolved (10 §8.4). Caller holds L1 and the task/ticket/cycle rows.
 */
export async function withdrawTask(
  tx: Tx,
  task: TaskRow,
  m: { trigger: 'supervisor' | 'transfer' | 'disabled'; reason: string; actor: EventActor },
): Promise<{ task: TaskRow; ticket: TicketRow }> {
  const previous = task.status;
  if (previous !== 'accepted' && previous !== 'assigned_waiting')
    throw new InvariantViolation(`task ${task.id} cannot be withdrawn from ${previous}`);
  const updated = await tx.one<TaskRow>(
    `UPDATE tasks SET status = 'queued', assignee_id = NULL, claimed_at = NULL, accepted_at = NULL,
            assigned_waiting_at = NULL, queued_at = $2, escalated_at = NULL, version = version + 1
      WHERE id = $1 AND version = $3 RETURNING *`,
    [task.id, tx.now, task.version],
  );
  const ticket = await tx.one<TicketRow>(
    `UPDATE tickets SET status = 'requested', version = version + 1 WHERE id = $1 RETURNING *`,
    [task.ticket_id],
  );
  if (task.cycle_id)
    await tx.query(
      `UPDATE retrieval_cycles SET accepted_by = NULL, assigned_at = NULL, assigned_waiting_at = NULL WHERE id = $1`,
      [task.cycle_id],
    );
  await emitTaskEvent(
    tx,
    updated,
    'task.withdrawn',
    m.actor,
    {
      task_id: task.id,
      ticket_id: task.ticket_id,
      from_assignee_id: task.assignee_id,
      previous_status: previous,
      reason: m.reason,
      trigger: m.trigger,
      key_was_picked_up: task.key_picked_up_at != null,
    },
    ticket,
  );
  await scheduleEscalation(tx, updated, await dispatchSettings(tx, updated.venue_id));
  await autoResolveAlerts(tx, {
    orgId: updated.org_id,
    venueId: updated.venue_id,
    dedupeKeys: [`next_task_waiting_long:${task.id}`, `idle_driver_while_next_waiting:${task.id}`],
    note: 'withdrawn',
  });
  return { task: updated, ticket };
}
