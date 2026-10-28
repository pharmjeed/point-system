import { Injectable } from '@nestjs/common';
import { autoResolveAlerts, raiseAlert } from '../core/alerts/alerts.js';
import type { ActorContext } from '../core/actor-context/actor-context.js';
import { lockCycles, lockPools, lockTasks, lockTickets } from '../core/db/locks.js';
import type { Tx } from '../core/db/tx.js';
import { AppError } from '../core/errors/app-error.js';
import {
  emitTaskEvent,
  runDispatchPass,
  settleDriverAfterTask,
  type TaskRow,
} from '../modules/dispatch/index.js';
import {
  checkVersion,
  cycleView,
  emitForTicket,
  findTicketInScope,
  isClosedTicket,
  loadTicketDetail,
  moveBoth,
  normalizeTag,
  ticketRef,
  type CycleRow,
  type TicketRow,
} from '../modules/tickets-custody/index.js';
import { venueSettingsFor } from '../modules/venues-events/index.js';
import { claimCodeHook, inlinePaymentHook } from './hooks.js';
import { assertAssignee, auditCommand, eventActor, openTaskIdOf } from './shared.js';
import { driverStateResult } from './views.js';

export interface HandoverBody {
  verification: { method: 'code'; code: string } | { method: 'paper_stub'; paper_serial: string };
  payment?: { method: 'cash' | 'pos'; amount_halalas: number; pos_reference?: string | null } | null;
  expected_version?: number;
}

const OPERATION = 'POST /v1/tickets/{ticketId}/handover';
const FAILED = 'handover.code_attempt_failed';

/**
 * Handover (PNT-034; 11 TT-18): L1 pool → L4 retrieve task → L5 ticket → L6 cycle. Paper tickets are
 * verified against the stub (`paper_serial`); a wrong stub counts toward `handover.max_attempts` like a wrong
 * code and is kept although the command fails (keepEffects, the error is the saved idempotent response).
 * The payment gate refuses a due ticket (PNT-080 collects inline through the InlinePaymentHook).
 */
@Injectable()
export class HandoverUseCase {
  async execute(tx: Tx, actor: ActorContext, ticketId: string, body: HandoverBody, requestId: string) {
    const pre = await findTicketInScope(tx, actor, ticketId);
    const taskId = await openTaskIdOf(tx, ticketId);
    await lockPools(tx, [pre.dispatch_pool_id]); // L1
    const [task] = taskId ? ((await lockTasks(tx, [taskId])) as TaskRow[]) : [null]; // L4
    const [locked] = (await lockTickets(tx, [ticketId])) as TicketRow[]; // L5
    const t = locked!;
    const [cycle] = t.active_cycle_id ? ((await lockCycles(tx, [t.active_cycle_id])) as CycleRow[]) : [null]; // L6

    // 11 §1.4: a second handover after success (new key) is TICKET_CLOSED; the closed check precedes the codes
    if (isClosedTicket(t.status)) throw new AppError('TICKET_CLOSED', { ticket_status: t.status });
    if (!task || task.type !== 'retrieve' || !cycle)
      throw new AppError('HANDOVER_NOT_READY', { ticket_status: t.status });
    assertAssignee(actor, task);
    checkVersion('ticket', t, body.expected_version);
    if (t.status !== 'ready') throw new AppError('HANDOVER_NOT_READY', { ticket_status: t.status });
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

    // payment gate before any attempt is counted (no side effect)
    let payment: Record<string, unknown> | null = null;
    const pay = inlinePaymentHook();
    if (t.payment_status === 'due' && !(body.payment && pay)) {
      const ev = await tx.one<{ allowed_payment_methods: string[] }>(
        `SELECT allowed_payment_methods FROM events WHERE id = $1`,
        [t.event_id],
      );
      throw new AppError('PAYMENT_PENDING', {
        amount_halalas: Number(t.fee_halalas),
        allowed_methods: ev.allowed_payment_methods,
      });
    }
    if (t.payment_status !== 'due' && body.payment)
      throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'payment', issue: 'not_applicable' }] });

    const settings = await venueSettingsFor(tx, t.venue_id);
    const max = settings.handover.max_attempts;
    const ea = eventActor(actor);
    const method = body.verification.method;
    let claimCodeId: string | null = null;
    if (method === 'paper_stub') {
      if (!t.paper_serial)
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ field: 'verification.method', issue: 'not_applicable' }],
        });
      const prior = await tx.one<{ n: number; last: Date | null }>(
        `SELECT count(*)::int AS n, max(occurred_at) AS last FROM ticket_events
          WHERE ticket_id = $1 AND type = $2 AND data->>'cycle_id' = $3`,
        [t.id, FAILED, cycle.id],
      );
      if (prior.n >= max) {
        const alert = await tx.maybeOne<{ id: string }>(
          `SELECT id FROM alerts WHERE venue_id = $1 AND dedupe_key = $2 AND status <> 'resolved'`,
          [t.venue_id, `handover_code_locked:${cycle.id}`],
        );
        throw new AppError('HANDOVER_CODE_LOCKED', {
          locked_at: prior.last ? new Date(prior.last).toISOString() : null,
          alert_id: alert?.id ?? null,
        });
      }
      if (normalizeTag(body.verification.paper_serial) !== normalizeTag(t.paper_serial)) {
        const attempts = prior.n + 1;
        const left = Math.max(0, max - attempts);
        await emitForTicket(tx, t, {
          type: FAILED,
          actor: ea,
          payload: {
            ticket_id: t.id,
            claim_code_id: null,
            cycle_id: cycle.id,
            method: 'paper_stub',
            attempts,
            attempts_left: left,
          },
        });
        if (left === 0) {
          await emitForTicket(tx, t, {
            type: 'handover.code_locked',
            actor: ea,
            payload: { ticket_id: t.id, claim_code_id: null, cycle_id: cycle.id, method: 'paper_stub' },
          });
          const { alert } = await raiseAlert(tx, {
            orgId: t.org_id,
            venueId: t.venue_id,
            type: 'handover_code_locked',
            dedupeKey: `handover_code_locked:${cycle.id}`,
            poolId: t.dispatch_pool_id,
            eventId: t.event_id,
            ticketId: t.id,
            taskId: task.id,
            userId: actor.userId,
            details: { display_number: t.display_number, attempts, method: 'paper_stub' },
          });
          throw new AppError(
            'HANDOVER_CODE_LOCKED',
            { locked_at: tx.now.toISOString(), alert_id: alert.id },
            { keepEffects: true },
          );
        }
        throw new AppError('PAPER_STUB_MISMATCH', { attempts_left: left }, { keepEffects: true });
      }
    } else {
      // PNT-047 verifies the live claim code (HANDOVER_CODE_INVALID / EXPIRED / LOCKED / CONSUMED)
      claimCodeId = (
        await claimCodeHook().verifyAtHandover(tx, { ticket: t, cycle, code: body.verification.code, actor })
      ).claim_code_id;
    }
    if (t.payment_status === 'due' && body.payment && pay)
      payment = await pay.collect(tx, { ticket: t, cycle, payment: body.payment, actor });

    const done = await tx.one<TaskRow>(
      `UPDATE tasks SET status = 'completed', completed_at = $2, version = version + 1 WHERE id = $1 RETURNING *`,
      [task.id, tx.now],
    );
    const closed = await tx.one<CycleRow>(
      `UPDATE retrieval_cycles SET delivered_at = $2, delivered_by = $3, handover_method = $4, outcome = 'delivered', closed_at = $2
        WHERE id = $1 RETURNING *`,
      [cycle.id, tx.now, actor.userId, method],
    );
    const delivered = await tx.one<TicketRow>(
      `UPDATE tickets SET status = 'delivered', delivered_at = $2, delivered_by = $3, active_cycle_id = NULL,
              vehicle_holder_type = 'customer', vehicle_holder_id = NULL, key_holder_type = 'customer', key_holder_id = NULL,
              version = version + 1
        WHERE id = $1 RETURNING *`,
      [t.id, tx.now, actor.userId],
    );
    const me = { type: 'driver' as const, id: actor.userId };
    const customer = { type: 'customer' as const, id: null };
    await moveBoth(tx, delivered, {
      vehicle: { from: me, to: customer, reason: 'handover' },
      key: { from: me, to: customer, reason: 'handover' },
      taskId: task.id,
      actorId: actor.userId,
    });
    await emitForTicket(tx, delivered, {
      type: 'handover.completed',
      actor: ea,
      payload: { ticket_id: t.id, cycle_id: cycle.id, method, delivered_by: actor.userId, approved_by: null },
    });
    await emitForTicket(tx, delivered, {
      type: 'ticket.delivered',
      actor: ea,
      payload: {
        ticket: ticketRef(delivered),
        cycle_id: cycle.id,
        delivered_by: actor.userId,
        method,
        payment_status: delivered.payment_status,
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
      delivered,
    );
    await autoResolveAlerts(tx, {
      orgId: t.org_id,
      venueId: t.venue_id,
      dedupeKeys: [`ready_not_collected:${cycle.id}`, `handover_code_locked:${cycle.id}`],
      note: 'delivered',
    });
    const settled = await settleDriverAfterTask(tx, actor.userId, task.id, ea);
    await runDispatchPass(tx, t.dispatch_pool_id, 'driver_available');
    await auditCommand(tx, actor, {
      action: 'handover.verify',
      operation: OPERATION,
      entityType: 'ticket',
      entityId: t.id,
      venueId: t.venue_id,
      requestId,
      before: { status: 'ready' },
      after: { status: 'delivered', method },
      metadata: {
        cycle_id: cycle.id,
        task_id: task.id,
        claim_code_id: claimCodeId,
        settled: settled.outcome,
      },
    });
    const viewer = { userId: actor.userId, role: actor.role };
    return {
      ticket: await loadTicketDetail(tx, t.id, viewer),
      cycle: cycleView(closed),
      payment,
      driver: await driverStateResult(tx, actor.userId, settled, viewer, tx.now),
    };
  }
}
