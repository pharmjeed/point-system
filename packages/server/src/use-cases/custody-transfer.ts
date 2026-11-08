import { Injectable } from '@nestjs/common';
import type { ActorContext } from '../core/actor-context/actor-context.js';
import { lockCycles, lockOpenDutyByUsers, lockPools, lockTasks, lockTickets } from '../core/db/locks.js';
import type { Tx } from '../core/db/tx.js';
import { AppError } from '../core/errors/app-error.js';
import {
  emitAvailability,
  emitTaskEvent,
  revokeDriverSingleOffers,
  runDispatchPass,
  settleDriverAfterTask,
  type DutyRow,
  type SettleOutcome,
  type TaskRow,
} from '../modules/dispatch/index.js';
import { scopeStillGranted, staffEligibleForVenue } from '../modules/incidents/index.js';
import {
  bumpTaskCardVersion,
  custodyTouchesTaskCard,
  isClosedTicket,
  moveCustody,
  type Holder,
  type TicketRow,
} from '../modules/tickets-custody/index.js';
import { auditCommand, eventActor, openTaskIdOf } from './shared.js';
import { loadCustodyEvent } from './supervisor-views.js';

const OPERATION = 'POST /v1/tickets/{ticketId}/custody-transfers';

export type CustodySubject = 'vehicle' | 'key';
export type TransferHolderType = 'driver' | 'spot' | 'key_slot' | 'supervisor' | 'unknown' | 'customer';

export interface CustodyTransferBody {
  subject: CustodySubject;
  to_holder_type: TransferHolderType;
  to_holder_id?: string | null;
  reason: string;
}

/** 06: `vehicle_holder_type` and `key_holder_type` — a vehicle is never in a key slot, a key never in a spot. */
const ALLOWED_HOLDERS: Record<CustodySubject, ReadonlySet<string>> = {
  vehicle: new Set(['driver', 'spot', 'supervisor', 'unknown']),
  key: new Set(['driver', 'key_slot', 'supervisor', 'unknown']),
};
const NEEDS_ID = new Set(['driver', 'spot', 'key_slot', 'supervisor']);
const MOVING_TASK = new Set(['accepted', 'in_progress']);

const fields = (field: string, issue: string) =>
  new AppError('VALIDATION_FAILED', { fields: [{ field, issue }] });

/**
 * `POST /v1/tickets/{ticketId}/custody-transfers` (PNT-079; 11 §2.4 and §2.7, 07 §2.3, DEC-32). Documents that the
 * vehicle or the key of an open ticket passed from its current holder (read from the ticket) to a new one:
 * `custody_events` with reason `official_transfer` (the reason is its note), the holder fields, and the spot or
 * slot allocations (released with `official_transfer`, a new one for a spot / slot target).
 *
 * When the ticket's task is `accepted` or `in_progress` and the item goes to another driver, the task follows
 * him in the same status (`task.reassigned`, `trigger = custody_transfer`) unless he already has an active
 * movement (MOVEMENT_IN_PROGRESS); the previous assignee is settled under the pool lock (TT-11 promotion or
 * available) and a dispatch pass runs. The new holder of a driver type must be on duty in the ticket's pool; a
 * supervisor holder must be staff of the venue. The customer is never a target: delivery is the handover (TT-18,
 * TT-19). A `parked` vehicle stays in a spot or unknown (ck_tickets_parked_holder). The key reaching the assignee
 * of an accepted retrieval — the current one, or the driver the transfer moves the task to — counts as picked up
 * (`key_picked_up_at` + `task.key_picked_up` with `key_slot_id: null`, DEC-187, DEC-251); a key leaving him before
 * the start resets the pickup (no event).
 *
 * Locks: L1 pool → L4 task → L5 ticket → L6 cycle → (L4/L7 offers, L8 duty sessions under the L1 exception).
 */
@Injectable()
export class CustodyTransferUseCase {
  async execute(tx: Tx, actor: ActorContext, ticketId: string, body: CustodyTransferBody, requestId: string) {
    const subject = body.subject;
    const toType = body.to_holder_type;
    const toId = body.to_holder_id ?? null;
    if (toType === 'customer') throw fields('to_holder_type', 'use_handover');
    if (!ALLOWED_HOLDERS[subject].has(toType)) throw fields('to_holder_type', 'not_allowed_for_subject');
    if (NEEDS_ID.has(toType) && !toId) throw fields('to_holder_id', 'required');
    if (!NEEDS_ID.has(toType) && toId) throw fields('to_holder_id', 'not_allowed');

    const pre = await tx.maybeOne<{ org_id: string; venue_id: string; dispatch_pool_id: string }>(
      `SELECT org_id, venue_id, dispatch_pool_id FROM tickets WHERE id = $1`,
      [ticketId],
    );
    if (!pre || pre.org_id !== actor.orgId || !actor.venueIds.has(pre.venue_id))
      throw new AppError('TICKET_NOT_FOUND');
    const taskId = await openTaskIdOf(tx, ticketId);
    await lockPools(tx, [pre.dispatch_pool_id]); // L1
    const [task] = taskId ? ((await lockTasks(tx, [taskId])) as TaskRow[]) : [null]; // L4
    const [t] = (await lockTickets(tx, [ticketId])) as TicketRow[]; // L5
    if (task?.cycle_id) await lockCycles(tx, [task.cycle_id]); // L6
    if (!(await scopeStillGranted(tx, actor, t!.venue_id))) throw new AppError('TICKET_NOT_FOUND');
    const ticket = t!;
    if (isClosedTicket(ticket.status)) throw new AppError('TICKET_CLOSED', { ticket_status: ticket.status });

    const from: Holder =
      subject === 'vehicle'
        ? { type: ticket.vehicle_holder_type, id: ticket.vehicle_holder_id }
        : { type: ticket.key_holder_type, id: ticket.key_holder_id };
    const to: Holder = { type: toType, id: toId };
    if (from.type === to.type && (from.id ?? null) === to.id)
      throw new AppError('CUSTODY_HOLDER_MISMATCH', { subject, current_holder_type: from.type });
    if (subject === 'vehicle' && ticket.status === 'parked' && toType !== 'spot' && toType !== 'unknown')
      throw fields('to_holder_type', 'parked_vehicle_spot_or_unknown');

    // the new holder (spot and slot read FOR SHARE after the canon locks, as complete-parking does, DEC-121)
    let targetDuty: DutyRow | null = null;
    if (toType === 'spot') await this.assertSpot(tx, ticket, toId!);
    if (toType === 'key_slot') await this.assertSlot(tx, ticket, toId!);
    if (toType === 'supervisor') {
      const staff = await staffEligibleForVenue(tx, actor.orgId, toId!, ticket.venue_id);
      if (!staff) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'user' });
      if (!staff.eligible) throw fields('to_holder_id', 'not_eligible');
    }
    if (toType === 'driver') {
      const u = await tx.maybeOne<{ role: string; status: string; can_drive: boolean }>(
        `SELECT role, status, can_drive FROM users WHERE id = $1 AND org_id = $2`,
        [toId, actor.orgId],
      );
      if (!u) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'user' });
      if (u.status !== 'active' || !(u.role === 'driver' || (u.role === 'supervisor' && u.can_drive)))
        throw fields('to_holder_id', 'not_a_driver');
      targetDuty = (await lockOpenDutyByUsers<DutyRow>(tx, [toId!]))[0] ?? null; // L8 (L1 held)
      if (
        !targetDuty ||
        targetDuty.dispatch_pool_id !== ticket.dispatch_pool_id ||
        targetDuty.status !== 'on_duty'
      )
        throw fields('to_holder_id', 'driver_not_on_duty');
    }

    // does the ticket's task follow the item (11 §2.4)?
    const moves = !!task && MOVING_TASK.has(task.status) && toType === 'driver' && task.assignee_id !== toId;
    if (moves) {
      const busy = await tx.maybeOne<{ id: string }>(
        `SELECT id FROM tasks WHERE assignee_id = $1 AND status IN ('accepted','in_progress')`,
        [toId],
      );
      if (busy) throw new AppError('MOVEMENT_IN_PROGRESS', { active_task_id: busy.id });
    }

    // allocations: the item leaves its spot / slot; a spot / slot target gets a fresh allocation (L9)
    if (from.type === 'spot' || from.type === 'key_slot') {
      const table = from.type === 'spot' ? 'spot_allocations' : 'key_slot_allocations';
      await tx.query(
        `UPDATE ${table} SET released_at = $2, released_by = $3, release_reason = 'official_transfer'
          WHERE ticket_id = $1 AND released_at IS NULL`,
        [ticket.id, tx.now, actor.userId],
      );
    }
    if (toType === 'spot')
      await tx.query(
        `INSERT INTO spot_allocations (org_id, ticket_id, parking_spot_id, allocated_at, allocated_by) VALUES ($1, $2, $3, $4, $5)`,
        [ticket.org_id, ticket.id, toId, tx.now, actor.userId],
      );
    if (toType === 'key_slot')
      await tx.query(
        `INSERT INTO key_slot_allocations (org_id, ticket_id, key_slot_id, allocated_at, allocated_by) VALUES ($1, $2, $3, $4, $5)`,
        [ticket.org_id, ticket.id, toId, tx.now, actor.userId],
      );

    const updated =
      subject === 'vehicle'
        ? await tx.one<TicketRow>(
            `UPDATE tickets SET vehicle_holder_type = $2, vehicle_holder_id = $3,
                    current_spot_id = CASE WHEN $2 = 'spot' THEN $3::uuid WHEN vehicle_holder_type = 'spot' THEN NULL ELSE current_spot_id END,
                    current_spot_note = CASE WHEN $2 = 'spot' OR vehicle_holder_type = 'spot' THEN NULL ELSE current_spot_note END,
                    version = version + 1
              WHERE id = $1 RETURNING *`,
            [ticket.id, toType, toId],
          )
        : await tx.one<TicketRow>(
            `UPDATE tickets SET key_holder_type = $2, key_holder_id = $3,
                    current_key_slot_id = CASE WHEN $2 = 'key_slot' THEN $3::uuid ELSE NULL END,
                    version = version + 1
              WHERE id = $1 RETURNING *`,
            [ticket.id, toType, toId],
          );
    const ea = eventActor(actor);
    const reason = body.reason.trim();
    const custodyEventId = await moveCustody(tx, updated, {
      subject,
      from,
      to,
      reason: 'official_transfer',
      taskId: task?.id ?? null,
      actorId: actor.userId,
      note: reason,
    });

    let settled: SettleOutcome | null = null;
    let taskBumped = false;
    if (moves && task) {
      const keyNow = subject === 'key' ? to : { type: updated.key_holder_type, id: updated.key_holder_id };
      const pickedUp =
        task.status === 'accepted' && task.type === 'retrieve'
          ? keyNow.type === 'driver' && keyNow.id === toId
            ? (task.key_picked_up_at ?? tx.now)
            : null
          : task.key_picked_up_at;
      const movedTask = await tx.one<TaskRow>(
        `UPDATE tasks SET assignee_id = $2, key_picked_up_at = $3, version = version + 1 WHERE id = $1 RETURNING *`,
        [task.id, toId, pickedUp],
      );
      if (task.cycle_id && task.status === 'accepted')
        await tx.query(`UPDATE retrieval_cycles SET accepted_by = $2 WHERE id = $1`, [task.cycle_id, toId]);
      if (task.cycle_id && task.status === 'in_progress')
        await tx.query(`UPDATE retrieval_cycles SET retrieved_by = $2 WHERE id = $1`, [task.cycle_id, toId]);
      await emitTaskEvent(
        tx,
        movedTask,
        'task.reassigned',
        ea,
        {
          task_id: task.id,
          ticket_id: ticket.id,
          from_assignee_id: task.assignee_id,
          to_assignee_id: toId,
          result_status: task.status,
          from_status: task.status,
          target: 'driver',
          reason,
          priority_override: false,
          trigger: 'custody_transfer',
        },
        updated,
      );
      // the key reaching the new assignee of an accepted retrieval is his pickup, as for the current assignee
      // below (DEC-187, DEC-251); a pickup made before the move keeps its time and emits nothing new
      if (task.type === 'retrieve' && task.status === 'accepted' && !task.key_picked_up_at && pickedUp)
        await emitTaskEvent(
          tx,
          movedTask,
          'task.key_picked_up',
          ea,
          { task_id: task.id, ticket_id: ticket.id, assignee_id: toId, key_slot_id: null },
          updated,
        );
      // the new assignee is busy now: no longer idle, his live single offers go back to the queue (10 §2.5)
      if (targetDuty!.available_since)
        await tx.query(
          `UPDATE duty_sessions SET available_since = NULL, version = version + 1 WHERE id = $1`,
          [targetDuty!.id],
        );
      await revokeDriverSingleOffers(tx, toId!, 'recipient_unavailable', ea);
      await emitAvailability(tx, toId!, ea);
      if (task.assignee_id) settled = await settleDriverAfterTask(tx, task.assignee_id, task.id, ea);
      await runDispatchPass(tx, ticket.dispatch_pool_id, 'driver_available');
    } else if (task && task.type === 'retrieve' && task.status === 'accepted' && subject === 'key') {
      // the assignee of an accepted retrieval: the key reaching him is a pickup, the key leaving him undoes it
      const reached = toType === 'driver' && toId === task.assignee_id;
      const left = from.type === 'driver' && from.id === task.assignee_id;
      if (reached && !task.key_picked_up_at) {
        taskBumped = true;
        const k = await tx.one<TaskRow>(
          `UPDATE tasks SET key_picked_up_at = $2, version = version + 1 WHERE id = $1 RETURNING *`,
          [task.id, tx.now],
        );
        await emitTaskEvent(
          tx,
          k,
          'task.key_picked_up',
          ea,
          { task_id: k.id, ticket_id: ticket.id, assignee_id: task.assignee_id, key_slot_id: null },
          updated,
        );
      } else if (left && task.key_picked_up_at) {
        taskBumped = true;
        await tx.query(`UPDATE tasks SET key_picked_up_at = NULL, version = version + 1 WHERE id = $1`, [
          task.id,
        ]);
      }
    }

    // RT-2: the task stays with its driver but his TaskCard shows another spot / slot → a newer card
    // (republished by the dispatch planner on custody.changed)
    if (
      task &&
      !moves &&
      !taskBumped &&
      task.assignee_id &&
      custodyTouchesTaskCard(subject, from.type, to.type)
    )
      await bumpTaskCardVersion(tx, task.id);

    await auditCommand(tx, actor, {
      action: 'ticket.custody_transfer',
      operation: OPERATION,
      entityType: 'ticket',
      entityId: ticket.id,
      venueId: ticket.venue_id,
      requestId,
      reason,
      before: { subject, holder_type: from.type, holder_id: from.id },
      after: { subject, holder_type: to.type, holder_id: to.id },
      metadata: {
        custody_event_id: custodyEventId,
        task_id: task?.id ?? null,
        task_moved: moves ? { from_assignee_id: task!.assignee_id, to_assignee_id: toId } : null,
        settled: settled?.outcome ?? null,
      },
    });
    return (await loadCustodyEvent(tx, custodyEventId))!;
  }

  private async assertSpot(tx: Tx, t: TicketRow, spotId: string) {
    const s = await tx.maybeOne<{ status: string; zone_status: string }>(
      `SELECT s.status, z.status AS zone_status FROM parking_spots s JOIN parking_zones z ON z.id = s.zone_id
        WHERE s.id = $1 AND s.venue_id = $2 FOR SHARE OF s, z`,
      [spotId, t.venue_id],
    );
    if (!s) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'parking_spot' });
    if (s.status !== 'active' || s.zone_status !== 'active')
      throw fields('to_holder_id', s.status !== 'active' ? 'inactive' : 'zone_inactive');
    const busy = await tx.maybeOne(
      `SELECT 1 FROM spot_allocations WHERE parking_spot_id = $1 AND released_at IS NULL AND ticket_id <> $2 LIMIT 1`,
      [spotId, t.id],
    );
    if (busy) throw new AppError('PARKING_SPOT_OCCUPIED', { parking_spot_id: spotId });
  }

  private async assertSlot(tx: Tx, t: TicketRow, slotId: string) {
    const s = await tx.maybeOne<{ status: string; board_status: string }>(
      `SELECT k.status, b.status AS board_status FROM key_slots k JOIN key_boards b ON b.id = k.key_board_id
        WHERE k.id = $1 AND k.venue_id = $2 FOR SHARE OF k, b`,
      [slotId, t.venue_id],
    );
    if (!s) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'key_slot' });
    if (s.status !== 'active' || s.board_status !== 'active')
      throw fields('to_holder_id', s.status !== 'active' ? 'inactive' : 'board_inactive');
    const busy = await tx.maybeOne(
      `SELECT 1 FROM key_slot_allocations WHERE key_slot_id = $1 AND released_at IS NULL AND ticket_id <> $2 LIMIT 1`,
      [slotId, t.id],
    );
    if (busy) throw new AppError('KEY_SLOT_OCCUPIED', { key_slot_id: slotId });
  }
}
