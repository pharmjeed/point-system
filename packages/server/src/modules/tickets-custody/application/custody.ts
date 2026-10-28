import type { CustodyReason } from '@point/shared';
import { appendCustodyEvent, type HolderType } from '../../../core/audit/audit-writer.js';
import type { Tx } from '../../../core/db/tx.js';
import { emitForTicket, userActor, type TicketCtx } from './events.js';

export interface Holder {
  type: HolderType;
  id: string | null;
}

/**
 * One custody transition (11 §2.7): appends `custody_events` (L10), emits `custody.changed` and records it on
 * the ticket timeline. The caller has already updated `tickets.*_holder_*` in the same transaction.
 */
export async function moveCustody(
  tx: Tx,
  ticket: TicketCtx,
  m: {
    subject: 'vehicle' | 'key';
    from: Holder;
    to: Holder;
    reason: CustodyReason;
    taskId: string | null;
    actorId: string;
    note?: string | null;
  },
): Promise<string> {
  const id = await appendCustodyEvent(tx, {
    orgId: ticket.org_id,
    venueId: ticket.venue_id,
    ticketId: ticket.id,
    subject: m.subject,
    from: m.from,
    to: m.to,
    reason: m.reason,
    taskId: m.taskId,
    actorId: m.actorId,
    note: m.note ?? null,
  });
  await emitForTicket(tx, ticket, {
    type: 'custody.changed',
    actor: userActor(m.actorId),
    payload: {
      ticket_id: ticket.id,
      custody_event_id: id,
      subject: m.subject,
      from: m.from,
      to: m.to,
      reason: m.reason,
      task_id: m.taskId,
    },
  });
  return id;
}

/** Both subjects in the canonical order vehicle → key (used by intake, handover, void). */
export async function moveBoth(
  tx: Tx,
  ticket: TicketCtx,
  m: {
    vehicle: { from: Holder; to: Holder; reason: CustodyReason };
    key: { from: Holder; to: Holder; reason: CustodyReason };
    taskId: string | null;
    actorId: string;
  },
): Promise<void> {
  await moveCustody(tx, ticket, { subject: 'vehicle', ...m.vehicle, taskId: m.taskId, actorId: m.actorId });
  await moveCustody(tx, ticket, { subject: 'key', ...m.key, taskId: m.taskId, actorId: m.actorId });
}
