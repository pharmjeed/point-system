import { Injectable } from '@nestjs/common';
import { requireDuty, type ActorContext } from '../core/actor-context/actor-context.js';
import { newId } from '../core/crypto/ids.js';
import { lockEvents, lockOpenDutyByUsers, lockPools } from '../core/db/locks.js';
import type { Tx } from '../core/db/tx.js';
import { AppError } from '../core/errors/app-error.js';
import {
  driverStateOf,
  emitAvailability,
  emitTaskEvent,
  insertParkTask,
  revokeDriverSingleOffers,
  runDispatchPass,
  currentDriverState,
} from '../modules/dispatch/index.js';
import {
  emitForTicket,
  loadTicketDetail,
  moveBoth,
  taskView,
  ticketRef,
  type TicketRow,
} from '../modules/tickets-custody/index.js';
import { listVenueEventsByStatus } from '../modules/venues-events/index.js';
import { auditCommand, eventActor } from './shared.js';

export interface StartIntakeBody {
  event_id?: string | null;
  channel?: 'whatsapp' | 'paper';
}

const OPERATION = 'POST /v1/tickets';

/**
 * StartIntake (PNT-025; 10 §7.1; 11 TT-01): L1 pool → L2 event (number allocated with RETURNING) → his live
 * single offer withdrawn (L4 → L7) → ticket `received` with the fee snapshot (DEC-43) + park task
 * `in_progress` → L8 duty (`available_since = NULL`) → custody customer → driver (`intake`) → pass.
 * Competes atomically with an accept by the same driver on the pool lock.
 */
@Injectable()
export class StartIntakeUseCase {
  async execute(tx: Tx, actor: ActorContext, body: StartIntakeBody, requestId: string) {
    const duty = requireDuty(actor);

    // DEC-37: the event is chosen at intake and never changes; several open events need an explicit choice
    let eventId: string;
    if (body.event_id) {
      const ev = await tx.maybeOne<{ id: string; venue_id: string; status: string }>(
        `SELECT id, venue_id, status FROM events WHERE id = $1 AND org_id = $2`,
        [body.event_id, actor.orgId],
      );
      if (!ev || ev.venue_id !== duty.venueId)
        throw new AppError('RESOURCE_NOT_FOUND', { resource: 'event' });
      if (ev.status !== 'open')
        throw new AppError('EVENT_NOT_OPEN', { event_id: ev.id, event_status: ev.status });
      eventId = ev.id;
    } else {
      const open = await listVenueEventsByStatus(tx, duty.venueId, ['open']);
      if (open.length === 0) throw new AppError('EVENT_NOT_OPEN', { event_id: null, event_status: null });
      if (open.length > 1)
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ field: 'event_id', issue: 'required_multiple_open_events' }],
        });
      eventId = open[0]!.id;
    }

    await lockPools(tx, [duty.poolId]); // L1
    const [ev] = await lockEvents(tx, [eventId]); // L2
    if (!ev || ev.status !== 'open')
      throw new AppError('EVENT_NOT_OPEN', { event_id: eventId, event_status: ev?.status ?? null });
    if (ev.dispatch_pool_id !== duty.poolId) throw new AppError('DUTY_REQUIRED');

    // TOCTOU (09 §8.4): duty and assignment re-read under the pool lock (disable/transfer hold it too)
    const s = await driverStateOf(tx, actor.userId);
    if (!s || s.dispatch_pool_id !== duty.poolId) throw new AppError('DUTY_REQUIRED');
    if (actor.role === 'driver') {
      const a = await tx.maybeOne(
        `SELECT 1 FROM driver_assignments WHERE driver_id = $1 AND status = 'active' AND venue_id = $2`,
        [actor.userId, s.venue_id],
      );
      if (!a) throw new AppError('ASSIGNMENT_REQUIRED');
    }
    if (s.duty_status === 'on_break') throw new AppError('DRIVER_ON_BREAK');
    if (s.driver_state !== 'available')
      throw new AppError('MOVEMENT_IN_PROGRESS', { active_task_id: s.active_task_id ?? s.next_task_id });

    const ea = eventActor(actor);
    const revoked = await revokeDriverSingleOffers(tx, actor.userId, 'recipient_unavailable', ea); // L4 → L7

    // the number comes from the locked event row; the counter does not bump the event version (10 §2.7)
    const n = await tx.one<{ display_number: number; pricing_mode: string; fee_halalas: number }>(
      `UPDATE events SET next_display_number = next_display_number + 1
        WHERE id = $1 AND status = 'open'
        RETURNING next_display_number - 1 AS display_number, pricing_mode, fee_halalas`,
      [eventId],
    );
    const perVehicle = n.pricing_mode === 'per_vehicle';
    const ticket = await tx.one<TicketRow>(
      `INSERT INTO tickets (id, org_id, venue_id, event_id, dispatch_pool_id, display_number, status, channel,
                            vehicle_holder_type, vehicle_holder_id, key_holder_type, key_holder_id,
                            payment_status, fee_halalas, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'received', $7, 'driver', $8, 'driver', $8, $9, $10, $8, $11, $11)
       RETURNING *`,
      [
        newId(),
        actor.orgId,
        s.venue_id,
        eventId,
        duty.poolId,
        n.display_number,
        body.channel ?? 'whatsapp',
        actor.userId,
        perVehicle ? 'due' : 'not_required',
        perVehicle ? Number(n.fee_halalas) : 0,
        tx.now,
      ],
    );
    const task = await insertParkTask(tx, ticket, actor.userId);
    const [d] = await lockOpenDutyByUsers<{ id: string }>(tx, [actor.userId]); // L8
    await tx.query(`UPDATE duty_sessions SET available_since = NULL, version = version + 1 WHERE id = $1`, [
      d!.id,
    ]);

    await emitForTicket(tx, ticket, {
      type: 'ticket.created',
      actor: ea,
      payload: { ticket: ticketRef(ticket), created_by: actor.userId, park_task_id: task.id },
    });
    await emitTaskEvent(
      tx,
      task,
      'task.created',
      ea,
      {
        task_id: task.id,
        ticket_id: ticket.id,
        type: 'park',
        status: task.status,
        cycle_id: null,
        assignee_id: actor.userId,
        priority_at: new Date(task.priority_at).toISOString(),
      },
      ticket,
    );
    const driver = { type: 'driver' as const, id: actor.userId };
    const customer = { type: 'customer' as const, id: null };
    await moveBoth(tx, ticket, {
      vehicle: { from: customer, to: driver, reason: 'intake' },
      key: { from: customer, to: driver, reason: 'intake' },
      taskId: task.id,
      actorId: actor.userId,
    });
    await emitAvailability(tx, actor.userId, ea);
    await runDispatchPass(tx, duty.poolId, revoked.length ? 'recipient_unavailable' : 'requeued');
    await auditCommand(tx, actor, {
      action: 'ticket.intake',
      operation: OPERATION,
      entityType: 'ticket',
      entityId: ticket.id,
      venueId: ticket.venue_id,
      requestId,
      after: { status: 'received', display_number: ticket.display_number, event_id: eventId },
      metadata: {
        park_task_id: task.id,
        payment_status: ticket.payment_status,
        revoked_offer_ids: revoked.map((r) => r.offerId),
      },
    });
    return {
      ticket: await loadTicketDetail(tx, ticket.id, { userId: actor.userId, role: actor.role }),
      task: taskView({
        ...task,
        assignee_full_name: actor.fullName,
        assignee_employee_code: actor.employeeCode,
      }),
      driver_state: await currentDriverState(tx, actor.userId),
    };
  }
}
