import { Injectable } from '@nestjs/common';
import { autoResolveAlerts, raiseAlert } from '../core/alerts/alerts.js';
import type { ActorContext } from '../core/actor-context/actor-context.js';
import { lockPools, lockTasks, lockTickets } from '../core/db/locks.js';
import type { Tx } from '../core/db/tx.js';
import { AppError } from '../core/errors/app-error.js';
import {
  emitTaskEvent,
  runDispatchPass,
  settleDriverAfterTask,
  type SettleOutcome,
  type TaskRow,
} from '../modules/dispatch/index.js';
import {
  assertCreator,
  checkVersion,
  draftFieldsPresent,
  emitForTicket,
  findTicketInScope,
  invalidTransition,
  loadTicketDetail,
  moveBoth,
  revokeLiveLinkCodes,
  ticketRef,
  type EventActor,
  type TicketRow,
} from '../modules/tickets-custody/index.js';
import { revokeActionTokens } from '../modules/whatsapp/index.js';
import { auditCommand, eventActor, openTaskIdOf } from './shared.js';
import { driverStateResult } from './views.js';

/**
 * TT-04 effects shared by discard-draft and void: park task canceled, ticket voided with the custody back to
 * the customer (`correction`, DEC-45), live link codes and action tokens revoked, the driver settled
 * (promotion or available) and the alerts of the draft resolved. Caller holds L1, L4, L5.
 */
async function voidTicket(
  tx: Tx,
  t: TicketRow,
  task: TaskRow | null,
  m: {
    actorId: string;
    actor: EventActor;
    reason: string;
    cancelReason: 'draft_discarded' | 'ticket_voided';
    via: 'discard_draft' | 'void';
  },
): Promise<{ ticket: TicketRow; settled: SettleOutcome | null }> {
  let canceled: TaskRow | null = null;
  if (task) {
    canceled = await tx.one<TaskRow>(
      `UPDATE tasks SET status = 'canceled', canceled_at = $2, canceled_by = $3, cancel_reason = $4, version = version + 1
        WHERE id = $1 RETURNING *`,
      [task.id, tx.now, m.actorId, m.cancelReason],
    );
  }
  const ticket = await tx.one<TicketRow>(
    `UPDATE tickets SET status = 'voided', voided_at = $2, voided_by = $3, void_reason = $4,
            vehicle_holder_type = 'customer', vehicle_holder_id = NULL, key_holder_type = 'customer', key_holder_id = NULL,
            pending_retrieval_at = NULL, pending_retrieval_source = NULL, version = version + 1
      WHERE id = $1 RETURNING *`,
    [t.id, tx.now, m.actorId, m.reason],
  );
  await revokeLiveLinkCodes(tx, t.id, 'ticket_voided');
  await revokeActionTokens(tx, t.id); // 11 §5.3: every «طلب السيارة» button of the ticket stops working
  await emitForTicket(tx, ticket, {
    type: 'ticket.voided',
    actor: m.actor,
    payload: { ticket: ticketRef(ticket), voided_by: m.actorId, reason: m.reason, via: m.via },
  });
  if (canceled) {
    await emitTaskEvent(
      tx,
      canceled,
      'task.canceled',
      m.actor,
      {
        task_id: canceled.id,
        ticket_id: t.id,
        type: canceled.type,
        previous_status: task!.status,
        assignee_id: canceled.assignee_id,
        cancel_reason: m.cancelReason,
        canceled_by: m.actorId,
      },
      ticket,
    );
  }
  await moveBoth(tx, ticket, {
    vehicle: {
      from: { type: t.vehicle_holder_type, id: t.vehicle_holder_id },
      to: { type: 'customer', id: null },
      reason: 'correction',
    },
    key: {
      from: { type: t.key_holder_type, id: t.key_holder_id },
      to: { type: 'customer', id: null },
      reason: 'correction',
    },
    taskId: canceled?.id ?? null,
    actorId: m.actorId,
  });
  await autoResolveAlerts(tx, {
    orgId: t.org_id,
    venueId: t.venue_id,
    dedupeKeys: [`draft_abandoned:${t.id}`, `inspection_incomplete:${t.id}`],
    note: 'ticket_voided',
  });
  const settled = canceled?.assignee_id
    ? await settleDriverAfterTask(tx, canceled.assignee_id, canceled.id, m.actor)
    : null;
  await runDispatchPass(tx, t.dispatch_pool_id, 'driver_available');
  return { ticket, settled };
}

async function lockDraft(tx: Tx, poolId: string, ticketId: string) {
  const taskId = await openTaskIdOf(tx, ticketId);
  await lockPools(tx, [poolId]); // L1
  const [task] = taskId ? ((await lockTasks(tx, [taskId])) as TaskRow[]) : [null]; // L4
  const [t] = (await lockTickets(tx, [ticketId])) as TicketRow[]; // L5
  return { task: task ?? null, ticket: t! };
}

/** `POST /v1/tickets/{ticketId}/discard-draft` (PNT-029, DEC-20): the driver's own empty draft only. */
@Injectable()
export class DiscardDraftUseCase {
  async execute(
    tx: Tx,
    actor: ActorContext,
    ticketId: string,
    body: { expected_version?: number },
    requestId: string,
  ) {
    const op = 'POST /v1/tickets/{ticketId}/discard-draft';
    const pre = await findTicketInScope(tx, actor, ticketId);
    assertCreator(actor, pre);
    const { task, ticket: t } = await lockDraft(tx, pre.dispatch_pool_id, ticketId);
    checkVersion('ticket', t, body.expected_version);
    if (t.status !== 'received') throw invalidTransition('ticket', t, op, ['received']);
    const photos = await tx.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM media_assets WHERE ticket_id = $1 AND upload_status = 'uploaded'`,
      [t.id],
    );
    const marks = await tx.maybeOne<{ n: number }>(
      `SELECT jsonb_array_length(damage_marks)::int AS n FROM vehicle_inspections
        WHERE ticket_id = $1 AND kind = 'intake' ORDER BY created_at DESC, id DESC LIMIT 1`,
      [t.id],
    );
    const present = draftFieldsPresent(t, { uploadedPhotos: photos.n, damageMarks: marks?.n ?? 0 });
    if (present.length) {
      // 08: draft_abandoned is raised at once on this refusal and kept although the command fails
      await raiseAlert(tx, {
        orgId: t.org_id,
        venueId: t.venue_id,
        type: 'draft_abandoned',
        dedupeKey: `draft_abandoned:${t.id}`,
        poolId: t.dispatch_pool_id,
        eventId: t.event_id,
        ticketId: t.id,
        taskId: task?.id ?? null,
        userId: actor.userId,
        details: { display_number: t.display_number, fields_present: present, cause: 'discard_refused' },
      });
      throw new AppError('DRAFT_HAS_DATA', { fields_present: present }, { keepEffects: true });
    }
    const ea = eventActor(actor);
    const r = await voidTicket(tx, t, task, {
      actorId: actor.userId,
      actor: ea,
      reason: 'empty_draft',
      cancelReason: 'draft_discarded',
      via: 'discard_draft',
    });
    await auditCommand(tx, actor, {
      action: 'ticket.discard_empty_draft',
      operation: op,
      entityType: 'ticket',
      entityId: t.id,
      venueId: t.venue_id,
      requestId,
      before: { status: 'received' },
      after: { status: 'voided', void_reason: 'empty_draft' },
      metadata: { settled: r.settled?.outcome ?? null },
    });
    return driverStateResult(tx, actor.userId, r.settled, { userId: actor.userId, role: actor.role }, tx.now);
  }
}

/**
 * `POST /v1/tickets/{ticketId}/void` (PNT-029, DEC-20, DEC-45): a supervisor voids a `received` or
 * `parking` ticket after confirming the vehicle and key went back to the customer.
 */
@Injectable()
export class VoidTicketUseCase {
  async execute(
    tx: Tx,
    actor: ActorContext,
    ticketId: string,
    body: { reason: string; custody_returned_to_customer: boolean; expected_version?: number },
    requestId: string,
  ) {
    const op = 'POST /v1/tickets/{ticketId}/void';
    const pre = await findTicketInScope(tx, actor, ticketId);
    const { task, ticket: t } = await lockDraft(tx, pre.dispatch_pool_id, ticketId);
    checkVersion('ticket', t, body.expected_version);
    if (t.status !== 'received' && t.status !== 'parking')
      throw invalidTransition('ticket', t, op, ['received', 'parking']);
    if (body.custody_returned_to_customer !== true) {
      const items = [
        { type: 'vehicle', holder_type: t.vehicle_holder_type },
        { type: 'key', holder_type: t.key_holder_type },
      ]
        .filter((i) => i.holder_type !== 'customer')
        .map((i) => ({ ...i, ticket_id: t.id, display_number: t.display_number }));
      throw new AppError('CUSTODY_OPEN', { items });
    }
    const reason = body.reason.trim();
    const r = await voidTicket(tx, t, task, {
      actorId: actor.userId,
      actor: eventActor(actor),
      reason,
      cancelReason: 'ticket_voided',
      via: 'void',
    });
    await auditCommand(tx, actor, {
      action: 'ticket.void',
      operation: op,
      entityType: 'ticket',
      entityId: t.id,
      venueId: t.venue_id,
      requestId,
      reason,
      before: { status: t.status },
      after: { status: 'voided' },
      metadata: { released_driver_id: task?.assignee_id ?? null, settled: r.settled?.outcome ?? null },
    });
    return loadTicketDetail(tx, t.id, { userId: actor.userId, role: actor.role });
  }
}
