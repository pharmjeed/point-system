import { Inject, Injectable } from '@nestjs/common';
import type { ActorContext } from '../core/actor-context/actor-context.js';
import { lockPools, lockTasks, lockTickets } from '../core/db/locks.js';
import type { Tx } from '../core/db/tx.js';
import { AppError } from '../core/errors/app-error.js';
import type { Logger } from '../core/logging/logger.js';
import { LOGGER } from '../http/tokens.js';
import {
  emitTaskEvent,
  runDispatchPass,
  settleDriverAfterTask,
  type TaskRow,
} from '../modules/dispatch/index.js';
import {
  checkVersion,
  emitForTicket,
  invalidTransition,
  loadTaskView,
  loadTicketDetail,
  moveCustody,
  ticketRef,
  type TicketRow,
} from '../modules/tickets-custody/index.js';
import { venueSettingsFor } from '../modules/venues-events/index.js';
import { openRetrievalCycle } from './request-retrieval.js';
import { assertAssignee, auditCommand, eventActor, findTaskInScope } from './shared.js';
import { driverStateResult } from './views.js';

export interface CompleteParkingBody {
  parking_spot_id?: string | null;
  spot_note?: string | null;
  key_slot_id?: string | null;
  expected_version?: number;
}

const OPERATION = 'POST /v1/tasks/{taskId}/complete-parking';

/**
 * CompleteParking (PNT-030; 11 TT-05/TT-21, TT-08; DEC-13): spot or note per `parking.mode`, key slot per
 * `keys.require_slot`, allocations, custody to the spot (`parked` / `repark`) and the key slot
 * (`key_deposited`), task completed, ticket parked, driver settled (promotion or available), early request
 * converted with its original time, then the pass.
 */
@Injectable()
export class CompleteParkingUseCase {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  async execute(tx: Tx, actor: ActorContext, taskId: string, body: CompleteParkingBody, requestId: string) {
    const pre = await findTaskInScope(tx, actor, taskId);
    assertAssignee(actor, pre);
    await lockPools(tx, [pre.dispatch_pool_id]); // L1
    const [lockedTask] = (await lockTasks(tx, [taskId])) as TaskRow[]; // L4
    const task = lockedTask!;
    const [lockedTicket] = (await lockTickets(tx, [task.ticket_id])) as TicketRow[]; // L5
    const t = lockedTicket!;
    assertAssignee(actor, task);
    checkVersion('task', task, body.expected_version);
    const expectedTicket = task.type === 'park' ? 'parking' : 'reparking';
    if ((task.type !== 'park' && task.type !== 'repark') || task.status !== 'in_progress')
      throw invalidTransition('task', task, OPERATION, ['in_progress']);
    if (t.status !== expectedTicket)
      throw invalidTransition(
        'ticket',
        t,
        OPERATION,
        [expectedTicket],
        t.status === 'received' ? 'intake_not_submitted' : undefined,
      );

    const settings = await venueSettingsFor(tx, t.venue_id);
    const spotId = body.parking_spot_id ?? null;
    const note = body.spot_note?.trim() || null;
    const slotId = body.key_slot_id ?? null;
    const fields: { field: string; issue: string }[] = [];
    const mode = settings.parking.mode;
    if (mode === 'assigned_spots' && !spotId) fields.push({ field: 'parking_spot_id', issue: 'required' });
    if (mode === 'free_text' && !note) fields.push({ field: 'spot_note', issue: 'required' });
    if (mode === 'free_text' && spotId)
      fields.push({ field: 'parking_spot_id', issue: 'not_allowed_in_mode' });
    if (mode === 'mixed' && !spotId && !note)
      fields.push({ field: 'parking_spot_id', issue: 'spot_or_note_required' });
    if (settings.keys.require_slot && !slotId) fields.push({ field: 'key_slot_id', issue: 'required' });
    if (fields.length) throw new AppError('VALIDATION_FAILED', { fields });

    // venues-events contract: the spot with its zone and the slot with its board are read FOR SHARE after the
    // canon locks, so a deactivation (FOR NO KEY UPDATE in its own command) serializes with this allocation
    if (spotId) {
      const s = await tx.maybeOne<{ status: string; zone_status: string }>(
        `SELECT s.status, z.status AS zone_status
           FROM parking_spots s JOIN parking_zones z ON z.id = s.zone_id
          WHERE s.id = $1 AND s.venue_id = $2
            FOR SHARE OF s, z`,
        [spotId, t.venue_id],
      );
      if (!s) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'parking_spot' });
      if (s.status !== 'active' || s.zone_status !== 'active')
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ field: 'parking_spot_id', issue: s.status !== 'active' ? 'inactive' : 'zone_inactive' }],
        });
    }
    if (slotId) {
      const s = await tx.maybeOne<{ status: string; board_status: string }>(
        `SELECT k.status, b.status AS board_status
           FROM key_slots k JOIN key_boards b ON b.id = k.key_board_id
          WHERE k.id = $1 AND k.venue_id = $2
            FOR SHARE OF k, b`,
        [slotId, t.venue_id],
      );
      if (!s) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'key_slot' });
      if (s.status !== 'active' || s.board_status !== 'active')
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ field: 'key_slot_id', issue: s.status !== 'active' ? 'inactive' : 'board_inactive' }],
        });
    }
    if (t.vehicle_holder_type !== 'driver' || t.vehicle_holder_id !== actor.userId)
      throw new AppError('CUSTODY_HOLDER_MISMATCH', {
        subject: 'vehicle',
        current_holder_type: t.vehicle_holder_type,
      });
    if (t.key_holder_type !== 'driver' || t.key_holder_id !== actor.userId)
      throw new AppError('CUSTODY_HOLDER_MISMATCH', {
        subject: 'key',
        current_holder_type: t.key_holder_type,
      });

    // L9 allocations (uq_spot_alloc_spot_active / uq_key_alloc_slot_active back these checks)
    if (spotId) {
      const busy = await tx.maybeOne(
        `SELECT 1 FROM spot_allocations WHERE parking_spot_id = $1 AND released_at IS NULL LIMIT 1`,
        [spotId],
      );
      if (busy) throw new AppError('PARKING_SPOT_OCCUPIED', { parking_spot_id: spotId });
      await tx.query(
        `INSERT INTO spot_allocations (org_id, ticket_id, parking_spot_id, allocated_at, allocated_by) VALUES ($1, $2, $3, $4, $5)`,
        [t.org_id, t.id, spotId, tx.now, actor.userId],
      );
    }
    if (slotId) {
      const busy = await tx.maybeOne(
        `SELECT 1 FROM key_slot_allocations WHERE key_slot_id = $1 AND released_at IS NULL LIMIT 1`,
        [slotId],
      );
      if (busy) throw new AppError('KEY_SLOT_OCCUPIED', { key_slot_id: slotId });
      await tx.query(
        `INSERT INTO key_slot_allocations (org_id, ticket_id, key_slot_id, allocated_at, allocated_by) VALUES ($1, $2, $3, $4, $5)`,
        [t.org_id, t.id, slotId, tx.now, actor.userId],
      );
    }

    // close the current task before any promotion or new task (non-deferrable unique indexes, 11 §1.3)
    const done = await tx.one<TaskRow>(
      `UPDATE tasks SET status = 'completed', completed_at = $2, version = version + 1 WHERE id = $1 RETURNING *`,
      [task.id, tx.now],
    );
    const parked = await tx.one<TicketRow>(
      `UPDATE tickets SET status = 'parked', current_spot_id = $2, current_spot_note = $3, current_key_slot_id = $4,
              vehicle_holder_type = 'spot', vehicle_holder_id = $2,
              key_holder_type = $5, key_holder_id = $4, parked_by = $6, parked_at = $7, version = version + 1
        WHERE id = $1 RETURNING *`,
      [t.id, spotId, note, slotId, slotId ? 'key_slot' : 'unknown', actor.userId, tx.now],
    );
    const ea = eventActor(actor);
    const me = { type: 'driver' as const, id: actor.userId };
    await moveCustody(tx, parked, {
      subject: 'vehicle',
      from: me,
      to: { type: 'spot', id: spotId },
      reason: task.type === 'repark' ? 'repark' : 'parked',
      taskId: task.id,
      actorId: actor.userId,
      note,
    });
    await moveCustody(tx, parked, {
      subject: 'key',
      from: me,
      to: slotId ? { type: 'key_slot', id: slotId } : { type: 'unknown', id: null },
      reason: 'key_deposited',
      taskId: task.id,
      actorId: actor.userId,
    });
    await emitForTicket(tx, parked, {
      type: 'ticket.parked',
      actor: ea,
      payload: {
        ticket: ticketRef(parked),
        task_id: task.id,
        task_type: task.type,
        parking_spot_id: spotId,
        has_spot_note: !!note,
        key_slot_id: slotId,
        parked_by: actor.userId,
      },
    });
    await emitTaskEvent(
      tx,
      done,
      'task.completed',
      ea,
      {
        task_id: done.id,
        ticket_id: t.id,
        type: done.type,
        assignee_id: actor.userId,
        completed_at: tx.now.toISOString(),
      },
      parked,
    );

    // TT-08 order: close the parking task → promote his next task → open the early cycle → pass
    const settled = await settleDriverAfterTask(tx, actor.userId, task.id, ea);
    let converted: string | null = null;
    if (parked.pending_retrieval_at) {
      if (parked.customer_id) {
        const r = await openRetrievalCycle(tx, parked, {
          // the customer's channel of the early press: the WhatsApp button or the app (DEC-516)
          source: parked.pending_retrieval_source ?? 'whatsapp',
          requestedAt: new Date(parked.pending_retrieval_at),
          early: true,
          customerId: parked.customer_id,
          actor: { type: 'system', id: null },
        });
        converted = r.cycle.id;
      } else {
        // a pending request always comes from the customer (DEC-25, DEC-516), so a customer exists
        this.logger.warn({ ticket_id: t.id }, 'pending retrieval without customer left pending');
      }
    }
    await runDispatchPass(tx, t.dispatch_pool_id, converted ? 'request_created' : 'driver_available');
    await auditCommand(tx, actor, {
      action: 'task.execute',
      operation: OPERATION,
      entityType: 'task',
      entityId: task.id,
      venueId: t.venue_id,
      requestId,
      before: { task_status: 'in_progress', ticket_status: t.status },
      after: { task_status: 'completed', ticket_status: converted ? 'requested' : 'parked' },
      metadata: {
        ticket_id: t.id,
        parking_spot_id: spotId,
        key_slot_id: slotId,
        early_cycle_id: converted,
        settled: settled.outcome,
      },
    });
    const viewer = { userId: actor.userId, role: actor.role };
    return {
      ticket: await loadTicketDetail(tx, t.id, viewer),
      task: await loadTaskView(tx, task.id),
      driver: await driverStateResult(tx, actor.userId, settled, viewer, tx.now),
    };
  }
}
