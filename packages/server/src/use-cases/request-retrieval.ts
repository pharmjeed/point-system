import { Injectable } from '@nestjs/common';
import type { TicketStatus } from '@point/shared';
import { requireDuty, type ActorContext } from '../core/actor-context/actor-context.js';
import { newId } from '../core/crypto/ids.js';
import { lockPools, lockTickets } from '../core/db/locks.js';
import type { Tx } from '../core/db/tx.js';
import { AppError } from '../core/errors/app-error.js';
import {
  dispatchSettings,
  emitTaskEvent,
  ensureDispatchSweep,
  insertRetrieveTask,
  runDispatchPass,
  scheduleEscalation,
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
 * becomes `requested`. Used by the staff request (TT-06b), the customer's button (TT-06a) and the early-request
 * conversion (TT-08, DEC-13: `requested_at` = the original press time). Caller holds L1 and the ticket (L5),
 * ticket `parked`. `job.escalate_unaccepted` is scheduled from `queued_at` (the escalation measures the time in
 * the queue, not since the original press).
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
  await scheduleEscalation(tx, task, await dispatchSettings(tx, ticket.venue_id));
  await ensureDispatchSweep(tx, ticket.org_id);
  return { cycle, task, ticket: updated };
}

export type CustomerRequestResult =
  | { kind: 'created'; ticketStatus: TicketStatus; cycleId: string; taskId: string }
  | { kind: 'pending_early'; ticketStatus: TicketStatus; pendingRetrievalAt: string }
  | { kind: 'already_pending'; ticketStatus: TicketStatus; pendingRetrievalAt: string }
  | { kind: 'already_active'; ticketStatus: TicketStatus; cycleId: string | null }
  | { kind: 'closed'; ticketStatus: TicketStatus };

/**
 * The customer's «طلب السيارة» (10 §7.2/§7.3, TT-06a/TT-07; DispatchService.requestRetrieval of 10 §13.2),
 * called by the WhatsApp button handler (PNT-045) inside the inbound message transaction once the action token
 * and the sender were verified. L1 pool → L5 ticket, then by ticket status: `parked` → a new cycle (`whatsapp`,
 * the customer) and its queued task + an immediate pass; `received`/`parking`/`reparking` → an early request
 * (DEC-13, PNT-060): `pending_retrieval_at` is set once (a repeated press keeps the original time) with
 * `ticket.retrieval_requested_early` (W-02 once, the parking driver's banner); an open cycle → `already_active`
 * and a closed ticket → `closed` (both answered with W-09 by the caller). No movement is ever created while the
 * vehicle is being parked (no two movements for one vehicle).
 */
export async function requestRetrievalForCustomer(
  tx: Tx,
  m: { ticketId: string; customerId: string | null; requestedAt?: Date },
): Promise<CustomerRequestResult> {
  const pre = await tx.maybeOne<{ dispatch_pool_id: string }>(
    `SELECT dispatch_pool_id FROM tickets WHERE id = $1`,
    [m.ticketId],
  );
  if (!pre) throw new AppError('TICKET_NOT_FOUND');
  await lockPools(tx, [pre.dispatch_pool_id]); // L1
  const [locked] = (await lockTickets(tx, [m.ticketId])) as TicketRow[]; // L5
  return applyCustomerRequest(tx, locked!, m);
}

/**
 * The state logic of {@link requestRetrievalForCustomer} for a caller that already holds L1 (the ticket's pool)
 * and L5 (the ticket) — the WhatsApp button handler, which locks first to check the action token (PNT-045).
 */
export async function applyCustomerRequest(
  tx: Tx,
  t: TicketRow,
  m: { customerId: string | null; requestedAt?: Date },
): Promise<CustomerRequestResult> {
  const actor: EventActor = m.customerId
    ? { type: 'customer', id: m.customerId }
    : { type: 'system', id: null };
  if (isClosedTicket(t.status)) return { kind: 'closed', ticketStatus: t.status };
  if (t.status === 'parked' && !t.active_cycle_id) {
    const r = await openRetrievalCycle(tx, t, {
      source: 'whatsapp',
      requestedAt: m.requestedAt ?? tx.now,
      early: false,
      customerId: m.customerId ?? t.customer_id,
      actor,
    });
    await runDispatchPass(tx, t.dispatch_pool_id, 'request_created');
    return { kind: 'created', ticketStatus: r.ticket.status, cycleId: r.cycle.id, taskId: r.task.id };
  }
  if ((t.status === 'received' || t.status === 'parking' || t.status === 'reparking') && !t.active_cycle_id) {
    if (t.pending_retrieval_at)
      return {
        kind: 'already_pending',
        ticketStatus: t.status,
        pendingRetrievalAt: new Date(t.pending_retrieval_at).toISOString(),
      };
    const at = m.requestedAt ?? tx.now;
    const updated = await tx.one<TicketRow>(
      `UPDATE tickets SET pending_retrieval_at = $2, pending_retrieval_source = 'whatsapp', version = version + 1
        WHERE id = $1 RETURNING *`,
      [t.id, at],
    );
    // the open park/repark task, started or not: its driver gets the early-request banner
    const parking = await tx.maybeOne<{ assignee_id: string | null }>(
      `SELECT assignee_id FROM tasks WHERE ticket_id = $1 AND type IN ('park','repark') AND status NOT IN ('completed','canceled')`,
      [t.id],
    );
    await emitForTicket(tx, updated, {
      type: 'ticket.retrieval_requested_early',
      actor,
      payload: {
        ticket: ticketRef(updated),
        pending_retrieval_at: at.toISOString(),
        request_source: 'whatsapp',
        requested_by_customer_id: m.customerId ?? t.customer_id,
        parking_task_assignee_id: parking?.assignee_id ?? null,
        status_at_request: t.status,
      },
    });
    return { kind: 'pending_early', ticketStatus: t.status, pendingRetrievalAt: at.toISOString() };
  }
  return { kind: 'already_active', ticketStatus: t.status, cycleId: t.active_cycle_id };
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
