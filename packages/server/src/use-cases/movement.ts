import { Injectable } from '@nestjs/common';
import type { ActorContext } from '../core/actor-context/actor-context.js';
import { lockCycles, lockTasks, lockTickets } from '../core/db/locks.js';
import type { Tx } from '../core/db/tx.js';
import { AppError } from '../core/errors/app-error.js';
import { emitTaskEvent, type TaskRow } from '../modules/dispatch/index.js';
import {
  checkVersion,
  emitForTicket,
  invalidTransition,
  moveCustody,
  scheduleReadyUncollectedCheck,
  ticketRef,
  type CycleRow,
  type TicketRow,
} from '../modules/tickets-custody/index.js';
import { claimCodeHook } from './hooks.js';
import { assertAssignee, auditCommand, eventActor, findTaskInScope } from './shared.js';
import { loadTaskCardOrThrow } from './views.js';

/**
 * Movement commands (PNT-033; 11 §2.4, TT-16, TT-17). They do not change dispatch inputs, so they start at
 * L4 (task) → L5 (ticket) → L6 (cycle) and never take the pool lock (canon §14ب; 10 §2.1).
 */
@Injectable()
export class MovementUseCase {
  private async lock(tx: Tx, actor: ActorContext, taskId: string) {
    const pre = await findTaskInScope(tx, actor, taskId);
    assertAssignee(actor, pre);
    const [task] = (await lockTasks(tx, [taskId])) as TaskRow[]; // L4
    const [ticket] = (await lockTickets(tx, [task!.ticket_id])) as TicketRow[]; // L5
    const [cycle] = task!.cycle_id ? ((await lockCycles(tx, [task!.cycle_id])) as CycleRow[]) : [null]; // L6
    assertAssignee(actor, task!);
    return { task: task!, ticket: ticket!, cycle: cycle ?? null };
  }

  private startable(task: TaskRow, op: string): void {
    if (task.type !== 'retrieve')
      throw invalidTransition('task', task, op, ['accepted'], 'not_a_retrieve_task');
    if (task.status === 'assigned_waiting')
      throw new AppError('TASK_NOT_STARTABLE', {
        task_status: task.status,
        reason: 'next_task_not_promoted',
      });
    if (task.status !== 'accepted') throw invalidTransition('task', task, op, ['accepted']);
  }

  /** `POST /v1/tasks/{taskId}/key-pickup`: key slot → driver (`key_pickup`), slot allocation released. */
  async keyPickup(
    tx: Tx,
    actor: ActorContext,
    taskId: string,
    body: { key_slot_id: string; expected_version?: number },
    requestId: string,
  ) {
    const op = 'POST /v1/tasks/{taskId}/key-pickup';
    const { task, ticket } = await this.lock(tx, actor, taskId);
    checkVersion('task', task, body.expected_version);
    this.startable(task, op);
    if (task.key_picked_up_at)
      throw invalidTransition('task', task, op, ['accepted'], 'key_already_picked_up');
    if (ticket.key_holder_type !== 'key_slot' || ticket.key_holder_id !== body.key_slot_id)
      throw new AppError('CUSTODY_HOLDER_MISMATCH', {
        subject: 'key',
        current_holder_type: ticket.key_holder_type,
      });
    await tx.query(
      `UPDATE key_slot_allocations SET released_at = $2, released_by = $3, release_reason = 'key_pickup'
        WHERE ticket_id = $1 AND released_at IS NULL`,
      [ticket.id, tx.now, actor.userId],
    );
    const t2 = await tx.one<TaskRow>(
      `UPDATE tasks SET key_picked_up_at = $2, version = version + 1 WHERE id = $1 RETURNING *`,
      [task.id, tx.now],
    );
    const tk = await tx.one<TicketRow>(
      `UPDATE tickets SET key_holder_type = 'driver', key_holder_id = $2, current_key_slot_id = NULL, version = version + 1
        WHERE id = $1 RETURNING *`,
      [ticket.id, actor.userId],
    );
    const ea = eventActor(actor);
    await moveCustody(tx, tk, {
      subject: 'key',
      from: { type: 'key_slot', id: body.key_slot_id },
      to: { type: 'driver', id: actor.userId },
      reason: 'key_pickup',
      taskId: task.id,
      actorId: actor.userId,
    });
    await emitTaskEvent(
      tx,
      t2,
      'task.key_picked_up',
      ea,
      { task_id: t2.id, ticket_id: tk.id, assignee_id: actor.userId, key_slot_id: body.key_slot_id },
      tk,
    );
    await auditCommand(tx, actor, {
      action: 'task.execute',
      operation: op,
      entityType: 'task',
      entityId: task.id,
      venueId: task.venue_id,
      requestId,
      after: { key_picked_up: true },
      metadata: { ticket_id: tk.id },
    });
    return loadTaskCardOrThrow(tx, task.id, { userId: actor.userId, role: actor.role }, tx.now);
  }

  /** `POST /v1/tasks/{taskId}/start-retrieval` (TT-16): spot → driver (`retrieval_start`); W-04 via the planner. */
  async startRetrieval(
    tx: Tx,
    actor: ActorContext,
    taskId: string,
    body: { expected_version?: number },
    requestId: string,
  ) {
    const op = 'POST /v1/tasks/{taskId}/start-retrieval';
    const { task, ticket, cycle } = await this.lock(tx, actor, taskId);
    checkVersion('task', task, body.expected_version);
    this.startable(task, op);
    if (!task.key_picked_up_at) throw new AppError('KEY_NOT_PICKED_UP', { task_id: task.id });
    if (ticket.status !== 'assigned') throw invalidTransition('ticket', ticket, op, ['assigned']);
    await tx.query(
      `UPDATE spot_allocations SET released_at = $2, released_by = $3, release_reason = 'retrieval_start'
        WHERE ticket_id = $1 AND released_at IS NULL`,
      [ticket.id, tx.now, actor.userId],
    );
    const t2 = await tx.one<TaskRow>(
      `UPDATE tasks SET status = 'in_progress', started_at = $2, version = version + 1 WHERE id = $1 RETURNING *`,
      [task.id, tx.now],
    );
    if (cycle)
      await tx.query(`UPDATE retrieval_cycles SET started_at = $2, retrieved_by = $3 WHERE id = $1`, [
        cycle.id,
        tx.now,
        actor.userId,
      ]);
    const tk = await tx.one<TicketRow>(
      `UPDATE tickets SET status = 'retrieving', retrieved_by = $2, current_spot_id = NULL, current_spot_note = NULL,
              vehicle_holder_type = 'driver', vehicle_holder_id = $2, version = version + 1
        WHERE id = $1 RETURNING *`,
      [ticket.id, actor.userId],
    );
    const ea = eventActor(actor);
    await moveCustody(tx, tk, {
      subject: 'vehicle',
      from: { type: ticket.vehicle_holder_type, id: ticket.vehicle_holder_id },
      to: { type: 'driver', id: actor.userId },
      reason: 'retrieval_start',
      taskId: task.id,
      actorId: actor.userId,
    });
    await emitTaskEvent(
      tx,
      t2,
      'task.started',
      ea,
      {
        task_id: t2.id,
        ticket_id: tk.id,
        type: t2.type,
        assignee_id: actor.userId,
        started_at: tx.now.toISOString(),
      },
      tk,
    );
    await emitForTicket(tx, tk, {
      type: 'ticket.retrieving',
      actor: ea,
      payload: {
        ticket: ticketRef(tk),
        cycle_id: task.cycle_id,
        task_id: task.id,
        retrieved_by: actor.userId,
      },
    });
    await auditCommand(tx, actor, {
      action: 'task.execute',
      operation: op,
      entityType: 'task',
      entityId: task.id,
      venueId: task.venue_id,
      requestId,
      before: { task_status: 'accepted', ticket_status: 'assigned' },
      after: { task_status: 'in_progress', ticket_status: 'retrieving' },
      metadata: { ticket_id: tk.id },
    });
    return loadTaskCardOrThrow(tx, task.id, { userId: actor.userId, role: actor.role }, tx.now);
  }

  /** `POST /v1/tasks/{taskId}/ready` (TT-17): the driver stays busy until the handover. */
  async markReady(
    tx: Tx,
    actor: ActorContext,
    taskId: string,
    body: { expected_version?: number },
    requestId: string,
  ) {
    const op = 'POST /v1/tasks/{taskId}/ready';
    const { task, ticket, cycle } = await this.lock(tx, actor, taskId);
    checkVersion('task', task, body.expected_version);
    if (task.type !== 'retrieve' || task.status !== 'in_progress')
      throw invalidTransition('task', task, op, ['in_progress']);
    if (ticket.status !== 'retrieving') throw invalidTransition('ticket', ticket, op, ['retrieving']);
    if (cycle) await tx.query(`UPDATE retrieval_cycles SET ready_at = $2 WHERE id = $1`, [cycle.id, tx.now]);
    const tk = await tx.one<TicketRow>(
      `UPDATE tickets SET status = 'ready', version = version + 1 WHERE id = $1 RETURNING *`,
      [ticket.id],
    );
    // PNT-047: claim code (hash + the only encrypted copy for W-05) and its expiry timer; none in S2
    const code =
      cycle && tk.channel === 'whatsapp' && tk.wa_link_status === 'linked'
        ? await claimCodeHook().issueAtReady(tx, { ticket: tk, cycle: { ...cycle, ready_at: tx.now }, actor })
        : null;
    const expected = code ? 'code' : tk.paper_serial ? 'paper_stub' : 'supervisor_exception';
    // `code_expires_at` of 11 §8.2 is left out: outbox payload keys containing "code" are rejected (DEC-38 guard)
    await emitForTicket(tx, tk, {
      type: 'ticket.ready',
      actor: eventActor(actor),
      payload: {
        ticket: ticketRef(tk),
        cycle_id: task.cycle_id,
        task_id: task.id,
        expected_method: expected,
        claim_code_id: code?.claim_code_id ?? null,
      },
    });
    // TT-17 timer: job.ready_uncollected_check at ready_at + ready.uncollected_alert_min (ready_not_collected)
    if (cycle) await scheduleReadyUncollectedCheck(tx, tk, cycle.id, tx.now);
    await auditCommand(tx, actor, {
      action: 'task.execute',
      operation: op,
      entityType: 'task',
      entityId: task.id,
      venueId: task.venue_id,
      requestId,
      before: { ticket_status: 'retrieving' },
      after: { ticket_status: 'ready', expected_method: expected },
      metadata: { ticket_id: tk.id },
    });
    return loadTaskCardOrThrow(tx, task.id, { userId: actor.userId, role: actor.role }, tx.now);
  }
}
