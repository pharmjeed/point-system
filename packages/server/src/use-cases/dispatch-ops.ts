import { Injectable } from '@nestjs/common';
import { autoResolveAlerts } from '../core/alerts/alerts.js';
import type { ActorContext } from '../core/actor-context/actor-context.js';
import {
  lockCycles,
  lockOffers,
  lockOpenDutyByUsers,
  lockPools,
  lockTasks,
  lockTickets,
} from '../core/db/locks.js';
import type { Tx } from '../core/db/tx.js';
import { AppError } from '../core/errors/app-error.js';
import {
  cancelTask,
  dispatchSettings,
  driverStateOf,
  emitAvailability,
  emitTaskEvent,
  findOlderActionable,
  insertReparkTask,
  revokeDriverSingleOffers,
  revokeRound,
  runDispatchPass,
  scheduleNextTaskWaitCheck,
  settleDriverAfterTask,
  withdrawTask,
  type DutyRow,
  type OfferRow,
  type SettleOutcome,
  type TaskRow,
} from '../modules/dispatch/index.js';
import {
  checkVersion,
  cycleView,
  emitForTicket,
  findTicketInScope,
  invalidTransition,
  loadTaskView,
  loadTicketDetail,
  loadTicketSummary,
  moveCustody,
  revokeLiveClaimCode,
  ticketRef,
  type CycleRow,
  type EventActor,
  type TicketRow,
} from '../modules/tickets-custody/index.js';
import { incidentRecorder } from './hooks.js';
import { assertAssignee, auditCommand, eventActor, findTaskInScope } from './shared.js';

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** Alerts of a task that end with it leaving the queue or its reservation (10 §8.4). */
const taskAlertKeys = (taskId: string) => [
  `request_unaccepted:${taskId}`,
  `next_task_waiting_long:${taskId}`,
  `idle_driver_while_next_waiting:${taskId}`,
];

/** The previous assignee after his task was taken away (10 §6.1 for his current task; a next task just leaves). */
async function releasePrevious(tx: Tx, task: TaskRow, actor: EventActor): Promise<SettleOutcome | null> {
  if (!task.assignee_id) return null;
  if (task.status === 'accepted') return settleDriverAfterTask(tx, task.assignee_id, task.id, actor);
  await emitAvailability(tx, task.assignee_id, actor); // busy_with_next → his current movement only
  return null;
}

/**
 * TT-20 / TT-20b: the repark goes to the driver of the running retrieval, who must hold both the vehicle and the
 * key (a formal custody transfer moves the task with them, 10 §6.3) — otherwise `CUSTODY_HOLDER_MISMATCH` and
 * nothing changes: the supervisor reconciles the custody first. Returns that driver.
 */
function assertMovementCustody(k: TicketRow, driverId: string | null): string {
  if (!driverId || k.vehicle_holder_type !== 'driver' || k.vehicle_holder_id !== driverId)
    throw new AppError('CUSTODY_HOLDER_MISMATCH', {
      subject: 'vehicle',
      current_holder_type: k.vehicle_holder_type,
    });
  if (k.key_holder_type !== 'driver' || k.key_holder_id !== driverId)
    throw new AppError('CUSTODY_HOLDER_MISMATCH', {
      subject: 'key',
      current_holder_type: k.key_holder_type,
    });
  return driverId;
}

export interface ReassignBody {
  reason: string;
  target_driver_id?: string | null;
  override_priority?: boolean;
  expected_version?: number;
}

const REASSIGNABLE = ['queued', 'offered', 'broadcast', 'accepted', 'assigned_waiting'] as const;

/**
 * `POST /v1/tasks/{taskId}/reassign` (PNT-058; 10 §9.1, TT-09b/TT-10b/TT-12/TT-13): before the movement only.
 * To the queue (`target_driver_id = null`, task accepted or reserved): `task.withdrawn`, a new episode with the
 * original priority and its escalation, the previous driver settled (promotion or available), a pass. To a driver
 * on duty in the same pool: like an atomic accept in his name — `accepted` if available, `assigned_waiting` if busy
 * with one movement (W-03 once per cycle) — with the priority guard for him unless `override_priority`
 * (extra audit `dispatch.priority_override`); a live round is revoked (`reassigned`). Locks: L1 → L4 → L5 → L6 →
 * L7 → L8 (previous and target duties), then the settle rows under the L1 exception.
 */
@Injectable()
export class ReassignTaskUseCase {
  async execute(tx: Tx, actor: ActorContext, taskId: string, body: ReassignBody, requestId: string) {
    const op = 'POST /v1/tasks/{taskId}/reassign';
    const pre = await findTaskInScope(tx, actor, taskId);
    const targetId = body.target_driver_id ?? null;
    await lockPools(tx, [pre.dispatch_pool_id]); // L1
    const [task] = (await lockTasks(tx, [taskId])) as TaskRow[]; // L4
    const [ticket] = (await lockTickets(tx, [task!.ticket_id])) as TicketRow[]; // L5
    const [cycle] = task!.cycle_id ? ((await lockCycles(tx, [task!.cycle_id])) as CycleRow[]) : [null]; // L6
    const liveId = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM task_offers WHERE task_id = $1 AND status = 'active'`,
      [taskId],
    );
    const [live] = liveId ? ((await lockOffers(tx, [liveId.id])) as OfferRow[]) : [null]; // L7

    const t = task!;
    checkVersion('task', t, body.expected_version);
    if (t.status === 'in_progress')
      throw new AppError('REASSIGN_BLOCKED_MOVEMENT', { task_id: t.id, started_at: iso(t.started_at) });
    if (t.type !== 'retrieve' || !(REASSIGNABLE as readonly string[]).includes(t.status))
      throw invalidTransition('task', t, op, REASSIGNABLE);
    if (t.status === 'accepted' && t.key_picked_up_at)
      throw new AppError('CUSTODY_RELEASE_REQUIRED', {
        task_id: t.id,
        key_holder_id: ticket!.key_holder_type === 'driver' ? ticket!.key_holder_id : null,
      });
    const inQueue = t.status === 'queued' || t.status === 'offered' || t.status === 'broadcast';
    if (!targetId && inQueue)
      throw invalidTransition('task', t, op, ['accepted', 'assigned_waiting'], 'already_in_queue');
    if (targetId && targetId === t.assignee_id)
      throw invalidTransition('task', t, op, REASSIGNABLE, 'same_assignee');

    const prev = t.assignee_id;
    const duties = await lockOpenDutyByUsers<DutyRow>(
      tx,
      [prev, targetId].filter((x): x is string => !!x),
    ); // L8
    const cfg = await dispatchSettings(tx, t.venue_id);
    let outcome: 'accepted' | 'assigned_waiting' | null = null;
    let override: { older_task_id: string; older_offer_id: string } | null = null;
    if (targetId) {
      const duty = duties.find((d) => d.user_id === targetId);
      const user = await tx.maybeOne<{ status: string }>(
        `SELECT status FROM users WHERE id = $1 AND org_id = $2`,
        [targetId, actor.orgId],
      );
      if (!duty || duty.dispatch_pool_id !== t.dispatch_pool_id || !user || user.status !== 'active')
        throw new AppError('DUTY_REQUIRED', { target_driver_id: targetId });
      const s = await driverStateOf(tx, targetId);
      if (!s) throw new AppError('DUTY_REQUIRED', { target_driver_id: targetId });
      if (s.driver_state === 'busy_with_next')
        throw new AppError('NEXT_TASK_ALREADY_RESERVED', { next_task_id: s.next_task_id });
      if (
        s.driver_state !== 'available' &&
        s.driver_state !== 'intake_parking' &&
        s.driver_state !== 'retrieving'
      )
        throw new AppError('DRIVER_NOT_AVAILABLE', {
          active_task_id: s.active_task_id,
          next_task_id: s.next_task_id,
        });
      outcome = s.driver_state === 'available' ? 'accepted' : 'assigned_waiting';
      const older = await findOlderActionable(tx, {
        poolId: t.dispatch_pool_id,
        userId: targetId,
        taskId: t.id,
        priorityAt: t.priority_at,
        seq: t.seq,
        now: tx.now,
        graceMs: cfg.acceptGraceMs,
      });
      if (older && !body.override_priority) throw new AppError('OLDER_REQUEST_PENDING', older);
      override = older;
    }

    const reason = body.reason.trim();
    const ea = eventActor(actor);
    if (live) await revokeRound(tx, live.id, t.venue_id, 'reassigned', ea);

    let finalTask: TaskRow;
    let finalTicket: TicketRow;
    if (!targetId) {
      // TT-12 / TT-13 to the queue: new episode, original priority (DEC-32)
      const r = await withdrawTask(tx, t, { trigger: 'supervisor', reason, actor: ea });
      finalTask = r.task;
      finalTicket = r.ticket;
    } else {
      // TT-09b / TT-10b: claimed in the target's name (an atomic accept by the supervisor)
      finalTask = await tx.one<TaskRow>(
        `UPDATE tasks SET status = $2, assignee_id = $3, claimed_at = $4,
                accepted_at = CASE WHEN $2 = 'accepted' THEN $4::timestamptz END,
                assigned_waiting_at = CASE WHEN $2 = 'assigned_waiting' THEN $4::timestamptz END,
                version = version + 1
          WHERE id = $1 AND version = $5 RETURNING *`,
        [t.id, outcome, targetId, tx.now, t.version],
      );
      if (cycle)
        await tx.query(
          `UPDATE retrieval_cycles SET accepted_by = $2,
                  assigned_at = CASE WHEN $3 = 'accepted' THEN $4::timestamptz END,
                  assigned_waiting_at = CASE WHEN $3 = 'assigned_waiting' THEN $4::timestamptz END
            WHERE id = $1`,
          [cycle.id, targetId, outcome, tx.now],
        );
      finalTicket = await tx.one<TicketRow>(
        `UPDATE tickets SET status = $2, version = version + 1 WHERE id = $1 RETURNING *`,
        [ticket!.id, outcome === 'accepted' ? 'assigned' : 'assigned_waiting'],
      );
      const duty = duties.find((d) => d.user_id === targetId)!;
      if (outcome === 'accepted')
        await tx.query(
          `UPDATE duty_sessions SET available_since = NULL, version = version + 1 WHERE id = $1`,
          [duty.id],
        );
      // a live single offer of the target goes back to the queue before the pass (I-D, 10 §5.3)
      await revokeDriverSingleOffers(tx, targetId, 'recipient_unavailable', ea);
      await emitTaskEvent(
        tx,
        finalTask,
        'task.reassigned',
        ea,
        {
          task_id: t.id,
          ticket_id: t.ticket_id,
          from_assignee_id: prev,
          to_assignee_id: targetId,
          result_status: outcome,
          reason,
          priority_override: !!override,
          trigger: 'reassign',
          from_status: t.status,
          target: 'driver',
        },
        finalTicket,
      );
      await emitForTicket(tx, finalTicket, {
        type: outcome === 'accepted' ? 'ticket.assigned' : 'ticket.assigned_waiting',
        actor: ea,
        payload: {
          ticket: ticketRef(finalTicket),
          cycle_id: t.cycle_id,
          task_id: t.id,
          assignee_id: targetId,
          via: 'supervisor',
        },
      });
      await emitAvailability(tx, targetId, ea);
      if (outcome === 'assigned_waiting') await scheduleNextTaskWaitCheck(tx, finalTask, cfg);
      await autoResolveAlerts(tx, {
        orgId: t.org_id,
        venueId: t.venue_id,
        dedupeKeys: taskAlertKeys(t.id),
        note: 'reassigned',
      });
    }
    const settled = await releasePrevious(tx, t, ea);
    // the previous driver is not offered the task he just lost in this pass (he stays a broadcast recipient)
    await runDispatchPass(tx, t.dispatch_pool_id, targetId ? 'offer_accepted' : 'requeued', {
      excludeUserIds: prev && !targetId ? [prev] : [],
    });
    await auditCommand(tx, actor, {
      action: 'task.reassign',
      operation: op,
      entityType: 'task',
      entityId: t.id,
      venueId: t.venue_id,
      requestId,
      reason,
      before: { task_status: t.status, assignee_id: prev, ticket_status: ticket!.status },
      after: {
        task_status: finalTask.status,
        assignee_id: finalTask.assignee_id,
        ticket_status: finalTicket.status,
      },
      metadata: {
        target: targetId ? 'driver' : 'queue',
        previous_assignee_id: prev,
        key_picked_up: false,
        revoked_offer_id: live?.id ?? null,
        settled: settled?.outcome ?? null,
        override_priority: !!override,
      },
    });
    if (override)
      await auditCommand(tx, actor, {
        action: 'dispatch.priority_override',
        operation: op,
        entityType: 'task',
        entityId: t.id,
        venueId: t.venue_id,
        requestId,
        reason,
        metadata: { target_driver_id: targetId, ...override },
      });
    return { task: await loadTaskView(tx, t.id), ticket: await loadTicketSummary(tx, t.ticket_id) };
  }
}

/**
 * `POST /v1/tasks/{taskId}/release-custody` (PNT-058; 10 §9.2): the assignee (or a supervisor of the venue)
 * confirms the key is back in a slot before a withdrawal: key custody driver → key_slot (`withdrawal_release`),
 * a new slot allocation (the same slot when it is free), `key_picked_up_at = NULL`. The task stays `accepted` in
 * his name and his availability does not change (no pass). Starts at L4 like the movement commands.
 */
@Injectable()
export class ReleaseCustodyUseCase {
  async execute(
    tx: Tx,
    actor: ActorContext,
    taskId: string,
    body: { key_slot_id: string; reason: string },
    requestId: string,
  ) {
    const op = 'POST /v1/tasks/{taskId}/release-custody';
    const pre = await findTaskInScope(tx, actor, taskId);
    if (actor.role === 'driver') assertAssignee(actor, pre);
    const [task] = (await lockTasks(tx, [taskId])) as TaskRow[]; // L4
    const [ticket] = (await lockTickets(tx, [task!.ticket_id])) as TicketRow[]; // L5
    const t = task!;
    const k = ticket!;
    if (actor.role === 'driver') assertAssignee(actor, t);
    if (t.type !== 'retrieve' || t.status !== 'accepted')
      throw invalidTransition('task', t, op, ['accepted']);
    if (!t.key_picked_up_at) throw invalidTransition('task', t, op, ['accepted'], 'key_not_picked_up');
    if (k.key_holder_type !== 'driver' || k.key_holder_id !== t.assignee_id)
      throw new AppError('CUSTODY_HOLDER_MISMATCH', {
        subject: 'key',
        current_holder_type: k.key_holder_type,
      });
    const slotId = body.key_slot_id;
    const s = await tx.maybeOne<{ status: string; board_status: string }>(
      `SELECT ks.status, b.status AS board_status
         FROM key_slots ks JOIN key_boards b ON b.id = ks.key_board_id
        WHERE ks.id = $1 AND ks.venue_id = $2
          FOR SHARE OF ks, b`,
      [slotId, k.venue_id],
    );
    if (!s) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'key_slot' });
    if (s.status !== 'active' || s.board_status !== 'active')
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ field: 'key_slot_id', issue: s.status !== 'active' ? 'inactive' : 'board_inactive' }],
      });
    const busy = await tx.maybeOne(
      `SELECT 1 FROM key_slot_allocations WHERE key_slot_id = $1 AND released_at IS NULL LIMIT 1`,
      [slotId],
    );
    if (busy) throw new AppError('KEY_SLOT_OCCUPIED', { key_slot_id: slotId });
    await tx.query(
      `INSERT INTO key_slot_allocations (org_id, ticket_id, key_slot_id, allocated_at, allocated_by) VALUES ($1, $2, $3, $4, $5)`,
      [k.org_id, k.id, slotId, tx.now, actor.userId],
    );
    const tk = await tx.one<TicketRow>(
      `UPDATE tickets SET key_holder_type = 'key_slot', key_holder_id = $2, current_key_slot_id = $2, version = version + 1
        WHERE id = $1 RETURNING *`,
      [k.id, slotId],
    );
    await tx.query(`UPDATE tasks SET key_picked_up_at = NULL, version = version + 1 WHERE id = $1`, [t.id]);
    await moveCustody(tx, tk, {
      subject: 'key',
      from: { type: 'driver', id: t.assignee_id },
      to: { type: 'key_slot', id: slotId },
      reason: 'withdrawal_release',
      taskId: t.id,
      actorId: actor.userId,
    });
    const reason = body.reason.trim();
    await auditCommand(tx, actor, {
      action: 'task.release_custody',
      operation: op,
      entityType: 'task',
      entityId: t.id,
      venueId: t.venue_id,
      requestId,
      reason,
      before: { key_holder_type: 'driver', key_holder_id: t.assignee_id },
      after: { key_holder_type: 'key_slot', key_slot_id: slotId },
      metadata: { ticket_id: k.id, subject: 'key' },
    });
    return loadTaskView(tx, t.id);
  }
}

/**
 * `POST /v1/retrieval-cycles/{cycleId}/cancel` (PNT-059; 10 §9.3; TT-14, TT-15, TT-20b). Before the movement:
 * a driver on duty in the venue while the request is `requested`, a supervisor also when `assigned` or
 * `assigned_waiting` (a picked-up key must be released first) — round revoked (`task_canceled`), task canceled
 * (`customer_field_cancel` / `supervisor_cancel`), cycle `canceled`, ticket `parked`, the assignee settled, a pass.
 * After the movement started (`retrieving`/`ready`), supervisors only (DEC-30, AC-11): the retrieve task is
 * canceled (`supervisor_cancel`), the live handover code revoked (`canceled`), a `repark` task `in_progress` for
 * the same driver who keeps the vehicle and the key (no custody event), ticket `reparking` with
 * `ticket.reparking` (`supervisor_cancel`): the driver stays busy until complete-parking. W-07 is planned from
 * `ticket.retrieval_canceled` only when the customer was told about the request (DEC-30, DEC-42).
 */
@Injectable()
export class CancelCycleUseCase {
  async execute(tx: Tx, actor: ActorContext, cycleId: string, body: { reason: string }, requestId: string) {
    const op = 'POST /v1/retrieval-cycles/{cycleId}/cancel';
    const pre = await tx.maybeOne<{ ticket_id: string; venue_id: string; dispatch_pool_id: string }>(
      `SELECT c.ticket_id, t.venue_id, t.dispatch_pool_id
         FROM retrieval_cycles c JOIN tickets t ON t.id = c.ticket_id
        WHERE c.id = $1 AND c.org_id = $2`,
      [cycleId, actor.orgId],
    );
    if (!pre || !actor.venueIds.has(pre.venue_id))
      throw new AppError('RESOURCE_NOT_FOUND', { resource: 'retrieval_cycle' });
    const isDriver = actor.role === 'driver';
    if (isDriver && (!actor.duty || actor.duty.poolId !== pre.dispatch_pool_id))
      throw new AppError('DUTY_REQUIRED');
    const open = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM tasks WHERE cycle_id = $1 AND type = 'retrieve' AND status NOT IN ('completed','canceled')`,
      [cycleId],
    );
    await lockPools(tx, [pre.dispatch_pool_id]); // L1
    const [task] = open ? ((await lockTasks(tx, [open.id])) as TaskRow[]) : [null]; // L4
    const [ticket] = (await lockTickets(tx, [pre.ticket_id])) as TicketRow[]; // L5
    const [cycle] = (await lockCycles(tx, [cycleId])) as CycleRow[]; // L6
    const liveId = task
      ? await tx.maybeOne<{ id: string }>(
          `SELECT id FROM task_offers WHERE task_id = $1 AND status = 'active'`,
          [task.id],
        )
      : null;
    const [live] = liveId ? ((await lockOffers(tx, [liveId.id])) as OfferRow[]) : [null]; // L7

    const c = cycle!;
    const k = ticket!;
    if (c.closed_at || k.active_cycle_id !== c.id || !task)
      throw invalidTransition(
        'retrieval_cycle',
        { id: c.id, status: c.outcome ?? 'closed', version: null },
        op,
        ['open'],
      );
    const before = k.status;
    if (isDriver && before !== 'requested')
      throw invalidTransition('ticket', k, op, ['requested'], 'driver_cancel_after_assignment');
    if (task.status === 'accepted' && task.key_picked_up_at)
      throw new AppError('CUSTODY_RELEASE_REQUIRED', {
        task_id: task.id,
        key_holder_id: k.key_holder_type === 'driver' ? k.key_holder_id : null,
      });
    const reason = body.reason.trim();
    const ea = eventActor(actor);
    const afterStart = before === 'retrieving' || before === 'ready';
    const holder = afterStart ? assertMovementCustody(k, task.assignee_id) : null;
    let reparkTask: TaskRow | null = null;
    let finalTicket: TicketRow;
    let settled: SettleOutcome | null = null;

    const closed = await tx.one<CycleRow>(
      `UPDATE retrieval_cycles SET outcome = 'canceled', canceled_at = $2, canceled_by = $3, cancel_reason = $4, closed_at = $2
        WHERE id = $1 RETURNING *`,
      [c.id, tx.now, actor.userId, reason],
    );
    if (!afterStart) {
      // TT-14 / TT-15
      if (live) await revokeRound(tx, live.id, k.venue_id, 'task_canceled', ea);
      finalTicket = await tx.one<TicketRow>(
        `UPDATE tickets SET status = 'parked', active_cycle_id = NULL, version = version + 1 WHERE id = $1 RETURNING *`,
        [k.id],
      );
      await cancelTask(tx, task, {
        cancelReason: isDriver ? 'customer_field_cancel' : 'supervisor_cancel',
        canceledBy: actor.userId,
        actor: ea,
        ticket: finalTicket,
      });
      await emitForTicket(tx, finalTicket, {
        type: 'ticket.retrieval_canceled',
        actor: ea,
        payload: {
          ticket: ticketRef(finalTicket),
          cycle_id: c.id,
          previous_status: before,
          canceled_by: actor.userId,
          reason,
        },
      });
      settled = await releasePrevious(tx, task, ea);
    } else {
      // TT-20b (DEC-30): the driver keeps the vehicle and the key and parks it again
      const driverId = holder!;
      await revokeLiveClaimCode(tx, c.id, 'canceled');
      finalTicket = await tx.one<TicketRow>(
        `UPDATE tickets SET status = 'reparking', active_cycle_id = NULL, version = version + 1 WHERE id = $1 RETURNING *`,
        [k.id],
      );
      await cancelTask(tx, task, {
        cancelReason: 'supervisor_cancel',
        canceledBy: actor.userId,
        actor: ea,
        ticket: finalTicket,
      });
      reparkTask = await insertReparkTask(tx, finalTicket, driverId);
      await emitForTicket(tx, finalTicket, {
        type: 'ticket.retrieval_canceled',
        actor: ea,
        payload: {
          ticket: ticketRef(finalTicket),
          cycle_id: c.id,
          previous_status: before,
          canceled_by: actor.userId,
          reason,
        },
      });
      await emitForTicket(tx, finalTicket, {
        type: 'ticket.reparking',
        actor: ea,
        payload: {
          ticket: ticketRef(finalTicket),
          closed_cycle_id: c.id,
          repark_task_id: reparkTask.id,
          assignee_id: driverId,
          cause: 'supervisor_cancel',
          reason,
        },
      });
      await emitTaskEvent(
        tx,
        reparkTask,
        'task.created',
        ea,
        {
          task_id: reparkTask.id,
          ticket_id: k.id,
          type: 'repark',
          status: 'in_progress',
          cycle_id: null,
          assignee_id: driverId,
          priority_at: new Date(reparkTask.priority_at).toISOString(),
        },
        finalTicket,
      );
      await emitAvailability(tx, driverId, ea); // retrieving → intake_parking; available_since stays NULL
    }
    await autoResolveAlerts(tx, {
      orgId: k.org_id,
      venueId: k.venue_id,
      dedupeKeys: [...taskAlertKeys(task.id), `ready_not_collected:${c.id}`, `handover_code_locked:${c.id}`],
      note: 'canceled',
    });
    await runDispatchPass(tx, k.dispatch_pool_id, 'task_canceled');
    await auditCommand(tx, actor, {
      action: 'retrieval.cancel',
      operation: op,
      entityType: 'retrieval_cycle',
      entityId: c.id,
      venueId: k.venue_id,
      requestId,
      reason,
      before: { ticket_status: before, task_status: task.status, assignee_id: task.assignee_id },
      after: { ticket_status: finalTicket.status, cycle_outcome: 'canceled' },
      metadata: {
        ticket_id: k.id,
        task_id: task.id,
        stage: afterStart ? 'after_start' : before === 'requested' ? 'requested' : 'assigned',
        repark_task_id: reparkTask?.id ?? null,
        settled: settled?.outcome ?? null,
      },
    });
    return {
      ticket: await loadTicketSummary(tx, k.id),
      cycle: cycleView(closed),
      repark_task: reparkTask ? await loadTaskView(tx, reparkTask.id) : null,
    };
  }
}

/**
 * `POST /v1/tickets/{ticketId}/repark` (PNT-061; 10 §9.4, TT-20): the customer did not come for a `ready`
 * vehicle. The retrieve task is canceled (`repark_customer_absent`), the live handover code revoked (`reparked`),
 * the cycle closed `reparked` with its times kept, a `repark` task `in_progress` for the driver who holds the
 * vehicle and the key, ticket `reparking` (`ticket.reparking`, `customer_absent` → W-08, the only place it is sent,
 * DEC-42), a documented `customer_absent` incident and `ready_not_collected` resolved. The driver stays busy and
 * his next task stays reserved; the customer's next request opens cycle_no + 1.
 */
@Injectable()
export class ReparkUseCase {
  async execute(
    tx: Tx,
    actor: ActorContext,
    ticketId: string,
    body: { reason: string; expected_version?: number },
    requestId: string,
  ) {
    const op = 'POST /v1/tickets/{ticketId}/repark';
    const pre = await findTicketInScope(tx, actor, ticketId);
    const open = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM tasks WHERE ticket_id = $1 AND type = 'retrieve' AND status NOT IN ('completed','canceled')`,
      [ticketId],
    );
    await lockPools(tx, [pre.dispatch_pool_id]); // L1
    const [task] = open ? ((await lockTasks(tx, [open.id])) as TaskRow[]) : [null]; // L4
    const [ticket] = (await lockTickets(tx, [ticketId])) as TicketRow[]; // L5
    const k = ticket!;
    const [cycle] = k.active_cycle_id ? ((await lockCycles(tx, [k.active_cycle_id])) as CycleRow[]) : [null]; // L6
    checkVersion('ticket', k, body.expected_version);
    if (k.status !== 'ready' || !task || !cycle || task.status !== 'in_progress')
      throw invalidTransition('ticket', k, op, ['ready']);
    const holder = assertMovementCustody(k, task.assignee_id);
    const reason = body.reason.trim();
    const ea = eventActor(actor);

    await revokeLiveClaimCode(tx, cycle.id, 'reparked');
    const closed = await tx.one<CycleRow>(
      `UPDATE retrieval_cycles SET outcome = 'reparked', reparked_at = $2, closed_at = $2 WHERE id = $1 RETURNING *`,
      [cycle.id, tx.now],
    );
    const reparking = await tx.one<TicketRow>(
      `UPDATE tickets SET status = 'reparking', active_cycle_id = NULL, version = version + 1 WHERE id = $1 RETURNING *`,
      [k.id],
    );
    await cancelTask(tx, task, {
      cancelReason: 'repark_customer_absent',
      canceledBy: actor.userId,
      actor: ea,
      ticket: reparking,
    });
    const repark = await insertReparkTask(tx, reparking, holder);
    const incident = await incidentRecorder().recordDocumented(tx, {
      orgId: k.org_id,
      venueId: k.venue_id,
      eventId: k.event_id,
      ticketId: k.id,
      type: 'customer_absent',
      description: reason,
      resolution: 'repark',
      actorId: actor.userId,
    });
    await emitForTicket(tx, reparking, {
      type: 'ticket.reparking',
      actor: ea,
      payload: {
        ticket: ticketRef(reparking),
        closed_cycle_id: cycle.id,
        repark_task_id: repark.id,
        assignee_id: holder,
        cause: 'customer_absent',
        reason,
      },
    });
    await emitTaskEvent(
      tx,
      repark,
      'task.created',
      ea,
      {
        task_id: repark.id,
        ticket_id: k.id,
        type: 'repark',
        status: 'in_progress',
        cycle_id: null,
        assignee_id: holder,
        priority_at: new Date(repark.priority_at).toISOString(),
      },
      reparking,
    );
    await emitAvailability(tx, holder, ea); // retrieving → intake_parking
    await autoResolveAlerts(tx, {
      orgId: k.org_id,
      venueId: k.venue_id,
      dedupeKeys: [`ready_not_collected:${cycle.id}`, `handover_code_locked:${cycle.id}`],
      note: 'reparked',
    });
    await auditCommand(tx, actor, {
      action: 'ticket.repark',
      operation: op,
      entityType: 'ticket',
      entityId: k.id,
      venueId: k.venue_id,
      requestId,
      reason,
      before: { status: 'ready', cycle_id: cycle.id },
      after: { status: 'reparking', repark_task_id: repark.id },
      metadata: {
        cycle_id: closed.id,
        retrieve_task_id: task.id,
        holder_id: holder,
        incident_id: incident.incident_id,
      },
    });
    const viewer = { userId: actor.userId, role: actor.role };
    return { ticket: await loadTicketDetail(tx, k.id, viewer), task: await loadTaskView(tx, repark.id) };
  }
}
