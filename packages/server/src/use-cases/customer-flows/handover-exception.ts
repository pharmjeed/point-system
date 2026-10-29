import { Injectable, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { autoResolveAlerts } from '../../core/alerts/alerts.js';
import type { ActorContext } from '../../core/actor-context/actor-context.js';
import { lockCycles, lockEvents, lockPools, lockTasks, lockTickets } from '../../core/db/locks.js';
import type { Tx } from '../../core/db/tx.js';
import { AppError } from '../../core/errors/app-error.js';
import {
  emitTaskEvent,
  runDispatchPass,
  settleDriverAfterTask,
  type TaskRow,
} from '../../modules/dispatch/index.js';
import {
  checkVersion,
  cycleView,
  emitForTicket,
  findTicketInScope,
  isClosedTicket,
  loadTicketDetail,
  moveBoth,
  revokeClaimCodes,
  ticketRef,
  type CycleRow,
  type TicketRow,
} from '../../modules/tickets-custody/index.js';
import { zodToFields } from '../../http/zod-pipe.js';
import { inlinePaymentHook } from '../hooks.js';
import { auditCommand, eventActor, openTaskIdOf } from '../shared.js';

const uuid = z.uuid();

export const IdentityChecks = z.strictObject({
  phone_last4: z
    .string()
    .regex(/^[0-9]{4}$/)
    .optional(),
  plate_confirmed: z.boolean().optional(),
  vehicle_description_confirmed: z.boolean().optional(),
  document_note: z.string().max(200).optional(),
});
export type IdentityChecks = z.infer<typeof IdentityChecks>;

export const HandoverExceptionBody = z.strictObject({
  reason: z.string().min(3).max(500),
  identity_checks: IdentityChecks,
  payment: z
    .strictObject({
      method: z.enum(['cash', 'pos']),
      amount_halalas: z.number().int().min(0),
      pos_reference: z.string().max(40).nullable().optional(),
      collected_by: uuid,
    })
    .nullable()
    .optional(),
  expected_version: z.number().int().min(1).optional(),
});
export type HandoverExceptionBody = z.infer<typeof HandoverExceptionBody>;

export type IdentityMethod = 'phone_last4' | 'plate' | 'vehicle_description' | 'document';

/** How many checks the body claims (before the stored phone is compared). */
export function claimedChecks(c: IdentityChecks): number {
  return (
    (c.phone_last4 !== undefined ? 1 : 0) +
    (c.plate_confirmed ? 1 : 0) +
    (c.vehicle_description_confirmed ? 1 : 0) +
    (c.document_note && c.document_note.trim().length > 0 ? 1 : 0)
  );
}

const insufficient = () =>
  new AppError('VALIDATION_FAILED', {
    fields: [{ field: 'identity_checks', issue: 'insufficient_checks', min_checks: 2 }],
  });

/**
 * 08 §2 step 6: REASON_REQUIRED (reason missing or < 3), then the body shape, then fewer than two claimed
 * identity checks (the plate alone) as VALIDATION_FAILED — before any lock.
 */
@Injectable()
export class HandoverExceptionPipe implements PipeTransform<unknown, HandoverExceptionBody> {
  transform(value: unknown): HandoverExceptionBody {
    const v = (value ?? {}) as Record<string, unknown>;
    if (typeof v.reason !== 'string' || v.reason.trim().length < 3)
      throw new AppError('REASON_REQUIRED', { field: 'reason', min_length: 3 });
    const r = HandoverExceptionBody.safeParse(v);
    if (!r.success) throw new AppError('VALIDATION_FAILED', { fields: zodToFields(r.error) });
    if (claimedChecks(r.data.identity_checks) < 2) throw insufficient();
    return r.data;
  }
}

/**
 * The documented identity checks of 07 / 02 S-03 (TT-19): at least two independent ones; the plate alone
 * is never enough (00 §4ز). `phone_last4` counts only when it matches the last 4 digits stored for the
 * ticket's customer (a mismatch or a ticket without a phone is refused, not ignored). Pure: the caller
 * passes the stored phone.
 */
export function identityMethods(c: IdentityChecks, storedPhoneE164: string | null): IdentityMethod[] {
  const methods: IdentityMethod[] = [];
  if (c.phone_last4 !== undefined) {
    const digits = (storedPhoneE164 ?? '').replace(/\D/g, '');
    if (!digits)
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ field: 'identity_checks.phone_last4', issue: 'no_customer_phone' }],
      });
    if (!digits.endsWith(c.phone_last4))
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ field: 'identity_checks.phone_last4', issue: 'mismatch' }],
      });
    methods.push('phone_last4');
  }
  if (c.plate_confirmed) methods.push('plate');
  if (c.vehicle_description_confirmed) methods.push('vehicle_description');
  if (c.document_note && c.document_note.trim().length > 0) methods.push('document');
  if (methods.length < 2) throw insufficient();
  return methods;
}

const OPERATION = 'POST /v1/tickets/{ticketId}/handover-exception';

/**
 * Exceptional handover without the code (PNT-078; 11 TT-19; 13 §8.4): a supervisor of the venue approves the
 * handover after a documented identity verification and a reason — for a lost or locked code, a code that
 * never arrived, or a lost paper stub. Locks L1 pool → (L2 event FOR SHARE when money is due or sent, 13 §5.5)
 * → L4 task → L5 ticket → L6 cycle like TT-18. Effects as TT-18 with: the cycle's live code (locked too)
 * revoked `exception_handover`; `delivered_by` = the assignee who actually delivered and the supervisor as
 * approver (event + audit, `self_approved` when he is the assignee, 09 §10 rule 2); a documented
 * `manual_verification` incident (`lost_ticket` for a paper ticket) created `resolved` (`auto_created`);
 * `handover_code_locked` and `ready_not_collected` resolved; the driver settled and a dispatch pass.
 *
 * The payment gate is TT-18's (the PNT-080 InlinePaymentHook, before the code is revoked and without effect):
 * a due ticket needs `payment` (13 §5.2 rules on `payment.*`) or a prior waiver, a collected one refuses a second
 * payment (PAYMENT_ALREADY_RECORDED), `not_required` / `waived` refuse one (`not_applicable`). The collector
 * `collected_by` is the retrieval's assignee or the approving supervisor himself (13 §8.4; anyone else →
 * VALIDATION_FAILED `payment.collected_by` `not_eligible`): the cash stays in his custody until it is handed over
 * (13 §9), recorded with `source = exception` (PAY-TC-22).
 */
@Injectable()
export class HandoverExceptionUseCase {
  async execute(
    tx: Tx,
    actor: ActorContext,
    ticketId: string,
    body: HandoverExceptionBody,
    requestId: string,
  ) {
    const pre = await findTicketInScope(tx, actor, ticketId);
    const taskId = await openTaskIdOf(tx, ticketId);
    const money = await tx.one<{ event_id: string; payment_status: string }>(
      `SELECT event_id, payment_status FROM tickets WHERE id = $1`,
      [ticketId],
    );
    await lockPools(tx, [pre.dispatch_pool_id]); // L1
    // 13 §5.5: a handover that collects (or must collect) holds the event row FOR SHARE (L2), like the close
    if (money.payment_status === 'due' || body.payment) await lockEvents(tx, [money.event_id], 'FOR SHARE');
    const [task] = taskId ? ((await lockTasks(tx, [taskId])) as TaskRow[]) : [null]; // L4
    const [locked] = (await lockTickets(tx, [ticketId])) as TicketRow[]; // L5
    const t = locked!;
    const [cycle] = t.active_cycle_id ? ((await lockCycles(tx, [t.active_cycle_id])) as CycleRow[]) : [null]; // L6

    if (isClosedTicket(t.status)) throw new AppError('TICKET_CLOSED', { ticket_status: t.status });
    if (!task || task.type !== 'retrieve' || !cycle || !task.assignee_id)
      throw new AppError('HANDOVER_NOT_READY', { ticket_status: t.status });
    checkVersion('ticket', t, body.expected_version);
    if (t.status !== 'ready') throw new AppError('HANDOVER_NOT_READY', { ticket_status: t.status });

    const stored = t.customer_id
      ? await tx.maybeOne<{ phone_e164: string | null }>(`SELECT phone_e164 FROM customers WHERE id = $1`, [
          t.customer_id,
        ])
      : null;
    const methods = identityMethods(body.identity_checks, stored?.phone_e164 ?? null);

    // payment gate (TT-18 rules, 13 §8.4) before any effect: the code is revoked only after it passed
    const assignee = task.assignee_id;
    const input = body.payment ?? null;
    const pay = inlinePaymentHook();
    if (pay?.check) {
      await pay.check(tx, { ticket: t, payment: input, actor, operation: OPERATION });
    } else {
      if (t.payment_status === 'due' && !(input && pay)) {
        const ev = await tx.one<{ allowed_payment_methods: string[] }>(
          `SELECT allowed_payment_methods FROM events WHERE id = $1`,
          [t.event_id],
        );
        throw new AppError('PAYMENT_PENDING', {
          amount_halalas: Number(t.fee_halalas),
          allowed_methods: ev.allowed_payment_methods,
        });
      }
      if (t.payment_status !== 'due' && input)
        throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'payment', issue: 'not_applicable' }] });
    }
    // 13 §8.4: the money is with the assignee who handed the car over, or with the approving supervisor
    if (input && input.collected_by !== assignee && input.collected_by !== actor.userId)
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ field: 'payment.collected_by', issue: 'not_eligible' }],
      });

    const ea = eventActor(actor);
    const revokedCodes = await revokeClaimCodes(tx, cycle.id, 'exception_handover');
    let payment: Record<string, unknown> | null = null;
    if (t.payment_status === 'due' && input && pay) {
      payment = await pay.collect(tx, {
        ticket: t,
        cycle,
        payment: input,
        actor,
        requestId,
        collectedBy: input.collected_by,
        source: 'exception',
        operation: OPERATION,
      });
    }

    // the documented incident, resolved at once (TT-19)
    const reason = body.reason.trim();
    const incidentType = t.channel === 'paper' ? 'lost_ticket' : 'manual_verification';
    const incident = await tx.one<{ id: string; severity: string }>(
      `INSERT INTO incidents (org_id, venue_id, event_id, ticket_id, type, status, severity, description, opened_by,
              owner_id, resolution, resolved_by, resolved_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'resolved', 'medium', $6, $7, $7, $8, $7, $9, $9, $9) RETURNING id, severity`,
      [
        t.org_id,
        t.venue_id,
        t.event_id,
        t.id,
        incidentType,
        reason,
        actor.userId,
        `handover_exception: ${methods.join(', ')}`,
        tx.now,
      ],
    );
    for (const [type, status] of [
      ['incident.opened', 'open'],
      ['incident.resolved', 'resolved'],
    ] as const) {
      await emitForTicket(tx, t, {
        type,
        actor: ea,
        aggregate: { type: 'incident', id: incident.id, version: 1 },
        payload: {
          incident_id: incident.id,
          type: incidentType,
          status,
          severity: incident.severity,
          ticket_id: t.id,
          auto_created: true, // opened by the command itself, as TT-20 and the payment discrepancies (DEC-240)
        },
      });
    }

    const done = await tx.one<TaskRow>(
      `UPDATE tasks SET status = 'completed', completed_at = $2, version = version + 1 WHERE id = $1 RETURNING *`,
      [task.id, tx.now],
    );
    const closed = await tx.one<CycleRow>(
      `UPDATE retrieval_cycles SET delivered_at = $2, delivered_by = $3, handover_method = 'supervisor_exception',
              outcome = 'delivered', closed_at = $2
        WHERE id = $1 RETURNING *`,
      [cycle.id, tx.now, assignee],
    );
    const delivered = await tx.one<TicketRow>(
      `UPDATE tickets SET status = 'delivered', delivered_at = $2, delivered_by = $3, active_cycle_id = NULL,
              vehicle_holder_type = 'customer', vehicle_holder_id = NULL, key_holder_type = 'customer', key_holder_id = NULL,
              version = version + 1
        WHERE id = $1 RETURNING *`,
      [t.id, tx.now, assignee],
    );
    const customer = { type: 'customer' as const, id: null };
    await moveBoth(tx, delivered, {
      vehicle: {
        from: { type: t.vehicle_holder_type, id: t.vehicle_holder_id },
        to: customer,
        reason: 'handover',
      },
      key: { from: { type: t.key_holder_type, id: t.key_holder_id }, to: customer, reason: 'handover' },
      taskId: task.id,
      actorId: actor.userId,
    });
    await emitForTicket(tx, delivered, {
      type: 'handover.exception_approved',
      actor: ea,
      payload: {
        ticket_id: t.id,
        cycle_id: cycle.id,
        approved_by: actor.userId,
        reason,
        incident_id: incident.id,
      },
    });
    await emitForTicket(tx, delivered, {
      type: 'handover.completed',
      actor: ea,
      payload: {
        ticket_id: t.id,
        cycle_id: cycle.id,
        method: 'supervisor_exception',
        delivered_by: assignee,
        approved_by: actor.userId,
      },
    });
    await emitForTicket(tx, delivered, {
      type: 'ticket.delivered',
      actor: ea,
      payload: {
        ticket: ticketRef(delivered),
        cycle_id: cycle.id,
        delivered_by: assignee,
        method: 'supervisor_exception',
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
        assignee_id: assignee,
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
    const settled = await settleDriverAfterTask(tx, assignee, task.id, ea);
    await runDispatchPass(tx, t.dispatch_pool_id, 'driver_available');
    await auditCommand(tx, actor, {
      action: 'handover.exception',
      operation: OPERATION,
      entityType: 'ticket',
      entityId: t.id,
      venueId: t.venue_id,
      requestId,
      reason,
      before: { status: 'ready' },
      after: { status: 'delivered', method: 'supervisor_exception', delivered_by: assignee },
      metadata: {
        cycle_id: cycle.id,
        task_id: task.id,
        identity_methods: methods,
        document_note: body.identity_checks.document_note?.trim() || null,
        self_approved: assignee === actor.userId,
        incident_id: incident.id,
        revoked_claim_code_ids: revokedCodes,
        settled: settled.outcome,
      },
    });
    return {
      ticket: await loadTicketDetail(tx, t.id, { userId: actor.userId, role: actor.role }),
      cycle: cycleView(closed),
      payment,
    };
  }
}
