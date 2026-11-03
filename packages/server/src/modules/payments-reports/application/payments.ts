import { Injectable } from '@nestjs/common';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import { audit } from '../../../core/audit/audit-writer.js';
import { newId } from '../../../core/crypto/ids.js';
import { lockEvents, lockTasks, lockTickets, TxRestartError } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import {
  bumpTaskCardVersion,
  emitForTicket,
  invalidTransition,
  loadTicketDetail,
  loadTicketSummary,
  type TicketRow,
} from '../../tickets-custody/index.js';
import {
  assertPaymentMatches,
  assertPaymentShape,
  deliveredDueDescription,
  paymentStatusBlocker,
  storedPosReference,
  type PaymentInput,
} from '../domain/payment-rules.js';
import { openPaymentDiscrepancyIncident } from './incidents.js';
import { EVENT_SELECT, isUuid, notFound, recheckStaffScope, type EventRow } from './scope.js';
import { loadPaymentViews, type PaymentRow } from './views.js';

/** Where a collection comes from (13 §14 `payment.recorded.source`). */
export type PaymentSource = 'separate' | 'handover' | 'exception' | 'reconcile' | 'replacement';

const OP_RECORD = 'POST /v1/tickets/{ticketId}/payments';
const OP_WAIVE = 'POST /v1/tickets/{ticketId}/payment-waiver';
const OP_REVERSE = 'POST /v1/payments/{paymentId}/reverse';

const userActor = (a: ActorContext) => ({ type: 'user' as const, id: a.userId, role: a.role });

interface TaskHead {
  id: string;
  ticket_id: string;
  assignee_id: string | null;
  cycle_id: string | null;
  status: string;
}

/** The event row (the caller locked it FOR SHARE at L2). */
export async function loadEventRow(tx: Pick<Tx, 'one'>, eventId: string): Promise<EventRow> {
  return tx.one<EventRow>(`${EVENT_SELECT} WHERE e.id = $1`, [eventId]);
}

/** The single `recorded` payment of a ticket (`uq_payments_ticket_recorded`), if any. */
export async function recordedPaymentOf(
  tx: Pick<Tx, 'maybeOne'>,
  ticketId: string,
): Promise<PaymentRow | null> {
  return tx.maybeOne<PaymentRow>(`SELECT * FROM payments WHERE ticket_id = $1 AND status = 'recorded'`, [
    ticketId,
  ]);
}

/** PAYMENT_ALREADY_RECORDED with the details of 13 §16. */
export async function alreadyRecorded(tx: Pick<Tx, 'maybeOne'>, ticketId: string): Promise<AppError> {
  const p = await recordedPaymentOf(tx, ticketId);
  return new AppError(
    'PAYMENT_ALREADY_RECORDED',
    p ? { payment_id: p.id, method: p.method, collected_by: p.collected_by } : {},
  );
}

/**
 * INVALID_STATE_TRANSITION on the ticket's money state (08 §4.10 note): `current_status` is the `payment_status`
 * the command found, `allowed_from` the money states it accepts, `reason` the refusal (`payment_not_required`…).
 */
export function moneyStateError(
  t: Pick<TicketRow, 'id' | 'payment_status' | 'version'>,
  command: string,
  allowedFrom: readonly string[],
  reason: string,
): AppError {
  return invalidTransition(
    'ticket',
    { id: t.id, status: t.payment_status, version: t.version },
    command,
    allowedFrom,
    reason,
  );
}

/** Closed or canceled events take no financial command (13 §12, PAY-TC-20). */
export function assertEventAcceptsMoney(ev: Pick<EventRow, 'id' | 'status'>): void {
  if (ev.status === 'closed' || ev.status === 'canceled')
    throw new AppError('EVENT_ALREADY_CLOSED', { event_id: ev.id, current_status: ev.status });
}

/**
 * The money checks of a collection, without any effect (13 §5.2, §5.3 step 5): the event still takes money,
 * the ticket's money state (`due` only: `collected` → PAYMENT_ALREADY_RECORDED, `not_required` / `waived` →
 * INVALID_STATE_TRANSITION with `reason`), then the reference shape, the event's method and the exact fee
 * snapshot. `prefix` is the dotted path of the payment object in the body (`payment.` in the handover).
 */
export async function assertCollectable(
  tx: Pick<Tx, 'maybeOne'>,
  args: { ticket: TicketRow; event: EventRow; input: PaymentInput; command: string; prefix?: string },
): Promise<void> {
  const { ticket: t, event: ev, input } = args;
  assertEventAcceptsMoney(ev);
  const blocker = paymentStatusBlocker(t.payment_status);
  if (blocker === 'collected') throw await alreadyRecorded(tx, t.id);
  if (blocker) throw moneyStateError(t, args.command, ['due'], blocker);
  assertPaymentShape(input, args.prefix ?? '');
  assertPaymentMatches(input, ev, t);
}

export interface RecordCollectionArgs {
  ticket: TicketRow;
  cycleId: string | null;
  input: PaymentInput;
  /** who holds the money (13 §8.3: the cash stays with `collected_by` until it is handed over) */
  collectedBy: string;
  /** the original collection time (a replacement keeps it, 13 §7.2) */
  collectedAt?: Date;
  actor: ActorContext;
  requestId: string;
  source: PaymentSource;
  operation: string;
  /** the id of the new row when the caller needs it before the insert (a replacement, 13 §7.2) */
  paymentId?: string;
  replacesPaymentId?: string;
  /**
   * 13 §8.4: the exceptional handover writes its own `handover.exception` row first and the `payment.record` row
   * after it. With `deferAudit` the row is not written here: `writeAudit` writes it (same transaction and request).
   */
  deferAudit?: boolean;
}

/**
 * The atomic collection of 13 §5.5. The caller holds L2 (event FOR SHARE) → L4 (task) → L5 (ticket) and ran
 * `assertCollectable`. Writes the `payments` row (L9; `uq_payments_ticket_recorded` is the last line of defence
 * → PAYMENT_ALREADY_RECORDED), the ticket `collected` with `version + 1` (a replacement leaves it to the
 * reversal), `payment.recorded` (timeline + outbox) and the `payment.record` audit row (or, with `deferAudit`,
 * returns its writer as `writeAudit` for the caller to run after its own row).
 */
export async function recordCollection(
  tx: Tx,
  a: RecordCollectionArgs,
): Promise<{ payment: PaymentRow; ticket: TicketRow; writeAudit: (() => Promise<void>) | null }> {
  const p = await tx.one<PaymentRow>(
    `INSERT INTO payments (id, org_id, venue_id, event_id, ticket_id, cycle_id, method, amount_halalas, currency,
                           pos_reference, collected_by, collected_at, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'SAR', $9, $10, $11, 'recorded', $12)
     RETURNING *`,
    [
      a.paymentId ?? newId(),
      a.ticket.org_id,
      a.ticket.venue_id,
      a.ticket.event_id,
      a.ticket.id,
      a.cycleId,
      a.input.method,
      a.input.amount_halalas,
      storedPosReference(a.input),
      a.collectedBy,
      a.collectedAt ?? tx.now,
      tx.now,
    ],
  );
  let ticket = a.ticket;
  if (a.source !== 'replacement') {
    const r = await tx.maybeOne<TicketRow>(
      `UPDATE tickets SET payment_status = 'collected', version = version + 1
        WHERE id = $1 AND version = $2 RETURNING *`,
      [a.ticket.id, a.ticket.version],
    );
    if (!r) throw new AppError('VERSION_CONFLICT', { entity: 'ticket', id: a.ticket.id });
    ticket = r;
  }
  await emitForTicket(tx, ticket, {
    type: 'payment.recorded',
    actor: { type: 'user', id: a.actor.userId },
    payload: {
      ticket_id: ticket.id,
      payment_id: p.id,
      cycle_id: a.cycleId,
      method: p.method,
      amount_halalas: Number(p.amount_halalas),
      collected_by: a.collectedBy,
      source: a.source,
      ...(a.replacesPaymentId ? { replaces_payment_id: a.replacesPaymentId } : {}),
    },
  });
  const entry = {
    orgId: a.actor.orgId,
    actor: userActor(a.actor),
    action: 'payment.record',
    entityType: 'payment',
    entityId: p.id,
    venueId: ticket.venue_id,
    requestId: a.requestId,
    // 13 §5.5: the payment's values and the ticket's money state after the command
    before: a.source === 'replacement' ? null : { ticket_payment_status: 'due' },
    after: {
      method: p.method,
      amount_halalas: Number(p.amount_halalas),
      status: 'recorded',
      ticket_payment_status: 'collected',
    },
    metadata: {
      operation: a.operation,
      ticket_id: ticket.id,
      cycle_id: a.cycleId,
      source: a.source,
      ...(a.collectedBy !== a.actor.userId ? { collected_by: a.collectedBy } : {}),
      ...(a.replacesPaymentId ? { replaces_payment_id: a.replacesPaymentId } : {}),
    },
  };
  if (a.deferAudit) return { payment: p, ticket, writeAudit: () => audit(tx, entry) };
  await audit(tx, entry);
  return { payment: p, ticket, writeAudit: null };
}

export interface ReverseBody {
  reason: string;
  replacement?: PaymentInput | null;
}

/**
 * PNT-080 / PNT-081: the separate collection (13 §5.4), the waiver (§6) and the reversal (§7). Each command
 * takes the event row FOR SHARE (L2, serialized with the event close, which locks it FOR NO KEY UPDATE) and then
 * only the rows it reads or changes, in canon §14ب order; the staff scope is re-read after the locks.
 */
@Injectable()
export class PaymentsService {
  /**
   * `POST /v1/tickets/{ticketId}/payments` — the assignee of the open retrieval collects while the car waits at
   * the handover point (`ready`), before the code (13 §5.4). L2 event FOR SHARE → L4 task → L5 ticket, no pool
   * lock (13 §5.5). Task and ticket keep their status; only `payment_status` and `version` change.
   */
  async record(tx: Tx, actor: ActorContext, ticketId: string, input: PaymentInput, requestId: string) {
    const head = await ticketHead(tx, actor, ticketId);
    await lockEvents(tx, [head.event_id], 'FOR SHARE'); // L2
    const taskId = await openRetrieveTaskId(tx, ticketId);
    const [task] = taskId ? ((await lockTasks(tx, [taskId])) as TaskHead[]) : [null]; // L4
    const [locked] = (await lockTickets(tx, [ticketId])) as TicketRow[]; // L5
    const ticket = locked!;
    const ev = await loadEventRow(tx, ticket.event_id);

    // 11 §1.2: the assignee (step 5) before the state (step 7). Only the assignee of the live retrieval may
    // collect, so this check on the locked task is the TOCTOU re-check of the scope (09 §8.4), as in the handover
    const live =
      task && task.ticket_id === ticketId && (task.status === 'accepted' || task.status === 'in_progress')
        ? task
        : null;
    if (live && live.assignee_id !== actor.userId)
      throw new AppError('NOT_TASK_ASSIGNEE', { task_id: live.id });
    if (ticket.status !== 'ready' || !live) throw invalidTransition('ticket', ticket, OP_RECORD, ['ready']);
    await assertCollectable(tx, { ticket, event: ev, input, command: OP_RECORD });

    const { payment, ticket: after } = await recordCollection(tx, {
      ticket,
      cycleId: live.cycle_id,
      input,
      collectedBy: actor.userId,
      actor,
      requestId,
      source: 'separate',
      operation: OP_RECORD,
    });
    const [view] = await loadPaymentViews(tx, [payment]);
    return { payment: view!, ticket: (await loadTicketSummary(tx, after.id))! };
  }

  /**
   * `POST /v1/tickets/{ticketId}/payment-waiver` — a supervisor waives a `due` fee with a reason (13 §6): full and
   * final, on an open ticket or on a delivered one that became `due` after a reversal. L2 FOR SHARE → L4 open
   * assigned task → L5 ticket.
   */
  async waive(tx: Tx, actor: ActorContext, ticketId: string, body: { reason: string }, requestId: string) {
    const reason = body.reason.trim();
    const head = await ticketHead(tx, actor, ticketId);
    await lockEvents(tx, [head.event_id], 'FOR SHARE'); // L2
    const task = await lockAssignedOpenTask(tx, ticketId); // L4 (the assignee's TaskCard shows payment_due)
    const [locked] = (await lockTickets(tx, [ticketId])) as TicketRow[]; // L5
    const ticket = locked!;
    await assertAssignedOpenTaskUnchanged(tx, ticketId, task);
    await recheckStaffScope(tx, actor, ticket.venue_id, { notFound: 'TICKET_NOT_FOUND' });
    const ev = await loadEventRow(tx, ticket.event_id);
    assertEventAcceptsMoney(ev);
    if (ticket.status === 'voided') throw new AppError('TICKET_CLOSED', { ticket_status: ticket.status });
    const blocker = paymentStatusBlocker(ticket.payment_status);
    if (blocker === 'collected') throw await alreadyRecorded(tx, ticket.id);
    if (blocker) throw moneyStateError(ticket, OP_WAIVE, ['due'], blocker);

    const after = await tx.one<TicketRow>(
      `UPDATE tickets SET payment_status = 'waived', payment_waived_at = $3, payment_waived_by = $4,
              payment_waiver_reason = $5, version = version + 1
        WHERE id = $1 AND version = $2 RETURNING *`,
      [ticket.id, ticket.version, tx.now, actor.userId, reason],
    );
    if (task) await bumpTaskCardVersion(tx, task.id); // RT-2: payment_due leaves the card
    const amount = Number(ticket.fee_halalas);
    const selfApproved = await handsOverTicket(tx, actor.userId, ticket);
    await emitForTicket(tx, after, {
      type: 'payment.waived',
      actor: { type: 'user', id: actor.userId },
      payload: { ticket_id: ticket.id, amount_halalas: amount, waived_by: actor.userId, reason },
    });
    await audit(tx, {
      orgId: actor.orgId,
      actor: userActor(actor),
      action: 'payment.waive',
      entityType: 'ticket',
      entityId: ticket.id,
      venueId: ticket.venue_id,
      requestId,
      reason,
      before: { payment_status: 'due' },
      after: { payment_status: 'waived' },
      metadata: {
        operation: OP_WAIVE,
        ticket_id: ticket.id,
        amount_halalas: amount,
        ...(selfApproved ? { self_approved: true } : {}),
      },
    });
    return loadTicketDetail(tx, ticket.id, { userId: actor.userId, role: actor.role });
  }

  /**
   * `POST /v1/payments/{paymentId}/reverse` (13 §7): the record becomes `reversed`, never deleted. Without a
   * replacement the ticket is `due` again — on a delivered ticket an unsettled payment with a
   * `payment_discrepancy` incident (§7.1); with one, a new `recorded` row keeps `collected_by`, `cycle_id` and
   * `collected_at` and the ticket stays `collected` (§7.2). L2 FOR SHARE → L4 open assigned task → L5 ticket →
   * L9 payment.
   */
  async reverse(tx: Tx, actor: ActorContext, paymentId: string, body: ReverseBody, requestId: string) {
    const reason = body.reason.trim();
    if (!isUuid(paymentId)) throw notFound('payment');
    const head = await tx.maybeOne<{ org_id: string; venue_id: string; event_id: string; ticket_id: string }>(
      `SELECT org_id, venue_id, event_id, ticket_id FROM payments WHERE id = $1`,
      [paymentId],
    );
    if (!head || head.org_id !== actor.orgId || !actor.venueIds.has(head.venue_id)) throw notFound('payment');
    await lockEvents(tx, [head.event_id], 'FOR SHARE'); // L2
    const task = await lockAssignedOpenTask(tx, head.ticket_id); // L4 (payment_due may come back on the card)
    const [locked] = (await lockTickets(tx, [head.ticket_id])) as TicketRow[]; // L5
    const ticket = locked!;
    await assertAssignedOpenTaskUnchanged(tx, head.ticket_id, task);
    const original = await tx.one<PaymentRow>(`SELECT * FROM payments WHERE id = $1 FOR NO KEY UPDATE`, [
      paymentId,
    ]); // L9
    await recheckStaffScope(tx, actor, original.venue_id, { resource: 'payment' });
    const ev = await loadEventRow(tx, ticket.event_id);
    assertEventAcceptsMoney(ev);
    if (original.status === 'reversed')
      throw new AppError('PAYMENT_ALREADY_REVERSED', {
        payment_id: original.id,
        reversed_at: new Date(original.reversed_at!).toISOString(),
      });
    // a recorded payment always belongs to a `collected` ticket (13 §11.3 b); anything else is for an administrator
    if (ticket.payment_status !== 'collected')
      throw moneyStateError(ticket, OP_REVERSE, ['collected'], 'payment_integrity');
    const replacement = body.replacement ?? null;
    if (replacement) {
      assertPaymentShape(replacement, 'replacement.');
      // a replacement corrects the method or the reference (13 §7.2); the same method and reference change nothing
      if (
        replacement.method === original.method &&
        storedPosReference(replacement) === (original.pos_reference ?? null)
      )
        throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'replacement', issue: 'no_change' }] });
      assertPaymentMatches(replacement, ev, ticket);
    }

    const reversed = await tx.one<PaymentRow>(
      `UPDATE payments SET status = 'reversed', reversed_at = $2, reversed_by = $3, reversal_reason = $4
        WHERE id = $1 AND status = 'recorded' RETURNING *`,
      [original.id, tx.now, actor.userId, reason],
    );
    const nextStatus = replacement ? 'collected' : 'due';
    const afterReverse = await tx.one<TicketRow>(
      `UPDATE tickets SET payment_status = $3, version = version + 1 WHERE id = $1 AND version = $2 RETURNING *`,
      [ticket.id, ticket.version, nextStatus],
    );
    if (task && nextStatus === 'due') await bumpTaskCardVersion(tx, task.id); // RT-2: payment_due is back
    const delivered = ticket.status === 'delivered';
    const afterHandover = original.cash_handover_id !== null;
    const replacementId = replacement ? newId() : null;

    let incidentId: string | null = null;
    if (!replacement && delivered) {
      incidentId = await openPaymentDiscrepancyIncident(tx, {
        orgId: ticket.org_id,
        venueId: ticket.venue_id,
        eventId: ticket.event_id,
        dispatchPoolId: ticket.dispatch_pool_id,
        ticketId: ticket.id,
        description: deliveredDueDescription(ticket.display_number, Number(original.amount_halalas)),
        openedBy: actor.userId,
      });
    }
    // 13 §7.2: payment.reversed (with replacement_payment_id) and then the replacement's payment.recorded
    await emitForTicket(tx, afterReverse, {
      type: 'payment.reversed',
      actor: { type: 'user', id: actor.userId },
      payload: {
        payment_id: original.id,
        ticket_id: ticket.id,
        method: original.method,
        amount_halalas: Number(original.amount_halalas),
        reversed_by: actor.userId,
        reason,
        with_replacement: !!replacement,
        replacement_payment_id: replacementId,
        after_cash_handover: afterHandover,
        ticket_delivered: delivered,
        incident_id: incidentId,
      },
    });
    const selfApproved = original.collected_by === actor.userId;
    await audit(tx, {
      orgId: actor.orgId,
      actor: userActor(actor),
      action: 'payment.reverse',
      entityType: 'payment',
      entityId: original.id,
      venueId: original.venue_id,
      requestId,
      reason,
      before: { status: 'recorded', ticket_payment_status: 'collected' },
      after: { status: 'reversed', ticket_payment_status: nextStatus },
      metadata: {
        operation: OP_REVERSE,
        payment_id: original.id,
        ticket_id: ticket.id,
        amount_halalas: Number(original.amount_halalas),
        method: original.method,
        with_replacement: !!replacement,
        replacement_payment_id: replacementId,
        after_cash_handover: afterHandover,
        incident_id: incidentId,
        ...(selfApproved ? { self_approved: true } : {}),
      },
    });
    let replacementRow: PaymentRow | null = null;
    if (replacement) {
      // inserted after the original is reversed: uq_payments_ticket_recorded is not deferrable (11 §1.3)
      replacementRow = (
        await recordCollection(tx, {
          ticket: afterReverse,
          cycleId: original.cycle_id,
          input: replacement,
          collectedBy: original.collected_by,
          collectedAt: original.collected_at,
          actor,
          requestId,
          source: 'replacement',
          operation: OP_REVERSE,
          paymentId: replacementId!,
          replacesPaymentId: original.id,
        })
      ).payment;
    }
    const views = await loadPaymentViews(tx, replacementRow ? [reversed, replacementRow] : [reversed]);
    return { reversed: views[0]!, replacement: views[1] ?? null };
  }
}

/** The ticket's identity for the scope check (08 §1.3 rule 4: outside the venues → TICKET_NOT_FOUND). */
async function ticketHead(tx: Pick<Tx, 'maybeOne'>, actor: ActorContext, ticketId: string) {
  const t = await tx.maybeOne<{ id: string; org_id: string; venue_id: string; event_id: string }>(
    `SELECT id, org_id, venue_id, event_id FROM tickets WHERE id = $1`,
    [ticketId],
  );
  if (!t || t.org_id !== actor.orgId || !actor.venueIds.has(t.venue_id))
    throw new AppError('TICKET_NOT_FOUND');
  return t;
}

const ASSIGNED_OPEN_TASK = `SELECT id FROM tasks
  WHERE ticket_id = $1 AND status NOT IN ('completed','canceled') AND assignee_id IS NOT NULL`;

/**
 * The ticket's open task with an assignee, locked (L4), or null: its TaskCard shows `payment_due` (RT-2). Read
 * without a lock first, then re-checked under the lock (the task may have closed in between).
 */
async function lockAssignedOpenTask(tx: Tx, ticketId: string): Promise<TaskHead | null> {
  const r = await tx.maybeOne<{ id: string }>(ASSIGNED_OPEN_TASK, [ticketId]);
  if (!r) return null;
  const [task] = (await lockTasks(tx, [r.id])) as TaskHead[];
  return task && task.assignee_id && task.status !== 'completed' && task.status !== 'canceled' ? task : null;
}

/**
 * Under L5 (every assignment of a ticket's task holds the ticket lock: accept, promotion, reassignment), the open
 * assigned task is the one locked at L4. One assigned between the unlocked read and L5 (an accept that committed
 * meanwhile) would keep a same-version TaskCard with the old `payment_due`, which the client ignores; L4 cannot be
 * taken after L5 (canon §14ب), so the transaction restarts and the next attempt locks that task.
 */
async function assertAssignedOpenTaskUnchanged(
  tx: Tx,
  ticketId: string,
  locked: TaskHead | null,
): Promise<void> {
  const r = await tx.maybeOne<{ id: string }>(ASSIGNED_OPEN_TASK, [ticketId]);
  if ((r?.id ?? null) !== (locked?.id ?? null))
    throw new TxRestartError('the open task of the ticket was assigned before the ticket lock');
}

/** The open retrieve task with an assignee (accepted / in_progress), read without a lock. */
async function openRetrieveTaskId(tx: Pick<Tx, 'maybeOne'>, ticketId: string): Promise<string | null> {
  const r = await tx.maybeOne<{ id: string }>(
    `SELECT id FROM tasks WHERE ticket_id = $1 AND type = 'retrieve' AND status IN ('accepted','in_progress')`,
    [ticketId],
  );
  return r?.id ?? null;
}

/** 09 §10 rule 2: a driving supervisor waiving the fee of a ticket he hands over approves his own work. */
async function handsOverTicket(tx: Pick<Tx, 'maybeOne'>, userId: string, t: TicketRow): Promise<boolean> {
  if (t.delivered_by === userId) return true;
  const r = await tx.maybeOne<{ id: string }>(
    `SELECT id FROM tasks WHERE ticket_id = $1 AND type = 'retrieve' AND status NOT IN ('completed','canceled')
        AND assignee_id = $2`,
    [t.id, userId],
  );
  return !!r;
}
