import { Injectable } from '@nestjs/common';
import { requireDuty, type ActorContext } from '../core/actor-context/actor-context.js';
import { newId } from '../core/crypto/ids.js';
import { lockPools, lockTickets } from '../core/db/locks.js';
import type { Tx } from '../core/db/tx.js';
import { AppError } from '../core/errors/app-error.js';
import {
  emitTaskEvent,
  ensureDispatchSweep,
  insertRetrieveTask,
  runDispatchPass,
  type TaskRow,
} from '../modules/dispatch/index.js';
import {
  cycleView,
  emitForTicket,
  findTicketInScope,
  isClosedTicket,
  loadTaskView,
  loadTicketSummary,
  ticketRef,
  type CycleRow,
  type EventActor,
  type TicketRow,
} from '../modules/tickets-custody/index.js';
import { auditCommand, eventActor } from './shared.js';

/**
 * 10 §7.2 insert of a retrieval cycle and its retrieve task `queued` (`priority_at = requested_at`); the ticket
 * becomes `requested`. Used by the staff request (TT-06b) and by the early-request conversion (TT-08,
 * DEC-13: `requested_at` = the original press time). Caller holds L1 and the ticket (L5), ticket `parked`.
 * The escalation timer (`job.escalate_unaccepted`) is an S4 extension point (no handler yet).
 */
export async function openRetrievalCycle(
  tx: Tx,
  ticket: TicketRow,
  m: {
    source: 'whatsapp' | 'staff';
    requestedAt: Date;
    early: boolean;
    userId?: string | null;
    customerId?: string | null;
    reason?: string | null;
    actor: EventActor;
  },
): Promise<{ cycle: CycleRow; task: TaskRow; ticket: TicketRow }> {
  const cycle = await tx.one<CycleRow>(
    `INSERT INTO retrieval_cycles (id, org_id, venue_id, ticket_id, cycle_no, requested_at, request_source,
                                   requested_by_user_id, requested_by_customer_id, request_reason, requested_early, created_at)
     VALUES ($1, $2, $3, $4, COALESCE((SELECT max(cycle_no) FROM retrieval_cycles WHERE ticket_id = $4), 0) + 1,
             $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      newId(),
      ticket.org_id,
      ticket.venue_id,
      ticket.id,
      m.requestedAt,
      m.source,
      m.userId ?? null,
      m.customerId ?? null,
      m.reason ?? null,
      m.early,
      tx.now,
    ],
  );
  const task = await insertRetrieveTask(tx, ticket, cycle);
  const updated = await tx.one<TicketRow>(
    `UPDATE tickets SET status = 'requested', active_cycle_id = $2, last_requested_at = $3,
            pending_retrieval_at = NULL, pending_retrieval_source = NULL, version = version + 1
      WHERE id = $1 AND status = 'parked' RETURNING *`,
    [ticket.id, cycle.id, m.requestedAt],
  );
  await emitForTicket(tx, updated, {
    type: 'ticket.retrieval_requested',
    actor: m.actor,
    payload: {
      ticket: ticketRef(updated),
      cycle_id: cycle.id,
      cycle_no: cycle.cycle_no,
      task_id: task.id,
      requested_at: new Date(cycle.requested_at).toISOString(),
      request_source: cycle.request_source,
      requested_early: cycle.requested_early,
    },
  });
  await emitTaskEvent(
    tx,
    task,
    'task.created',
    m.actor,
    {
      task_id: task.id,
      ticket_id: ticket.id,
      type: 'retrieve',
      status: 'queued',
      cycle_id: cycle.id,
      assignee_id: null,
      priority_at: new Date(task.priority_at).toISOString(),
    },
    updated,
  );
  await ensureDispatchSweep(tx, ticket.org_id);
  return { cycle, task, ticket: updated };
}

const OPERATION = 'POST /v1/tickets/{ticketId}/retrievals';

/**
 * `POST /v1/tickets/{ticketId}/retrievals` (PNT-031; DEC-25): a driver on duty in the venue or a supervisor
 * asks for the car on behalf of the customer; the ticket must be `parked`. Immediate dispatch pass (DEC-08).
 */
@Injectable()
export class RequestRetrievalUseCase {
  async execute(tx: Tx, actor: ActorContext, ticketId: string, body: { reason: string }, requestId: string) {
    const pre = await findTicketInScope(tx, actor, ticketId); // 07 §1.10: scope before duty
    const duty = actor.role === 'driver' ? requireDuty(actor) : null;
    if (duty && duty.poolId !== pre.dispatch_pool_id) throw new AppError('DUTY_REQUIRED');
    await lockPools(tx, [pre.dispatch_pool_id]); // L1
    const [locked] = await lockTickets(tx, [ticketId]); // L5
    const t = locked as TicketRow;
    if (isClosedTicket(t.status)) throw new AppError('TICKET_CLOSED', { ticket_status: t.status });
    if (t.status === 'received' || t.status === 'parking' || t.status === 'reparking')
      throw new AppError('TICKET_NOT_PARKED', { ticket_status: t.status });
    if (t.status !== 'parked')
      throw new AppError('RETRIEVAL_ALREADY_ACTIVE', {
        cycle_id: t.active_cycle_id,
        ticket_status: t.status,
      });

    const reason = body.reason.trim();
    const r = await openRetrievalCycle(tx, t, {
      source: 'staff',
      requestedAt: tx.now,
      early: false,
      userId: actor.userId,
      reason,
      actor: eventActor(actor),
    });
    await runDispatchPass(tx, t.dispatch_pool_id, 'request_created');
    await auditCommand(tx, actor, {
      action: 'retrieval.request_on_behalf',
      operation: OPERATION,
      entityType: 'ticket',
      entityId: t.id,
      venueId: t.venue_id,
      requestId,
      reason,
      before: { status: 'parked' },
      after: { status: 'requested', cycle_id: r.cycle.id, task_id: r.task.id },
    });
    return {
      ticket: await loadTicketSummary(tx, t.id),
      cycle: cycleView(r.cycle),
      task: await loadTaskView(tx, r.task.id),
    };
  }
}
