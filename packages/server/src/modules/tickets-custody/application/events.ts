import { appendTicketEvent, type Actor } from '../../../core/audit/audit-writer.js';
import type { EventEnvelope, Tx } from '../../../core/db/tx.js';
import { emitEvent } from '../../../core/outbox/outbox-writer.js';

/** Minimal ticket identity carried by events (11 §8.1 TicketRef) and needed to place them. */
export interface TicketCtx {
  id: string;
  org_id: string;
  venue_id: string;
  event_id: string;
  dispatch_pool_id: string;
  display_number: number;
  version: number;
}

export interface EventActor {
  type: 'user' | 'customer' | 'system';
  id: string | null;
}

export const userActor = (id: string): EventActor => ({ type: 'user', id });
export const systemActor: EventActor = { type: 'system', id: null };

export function ticketRef(t: Pick<TicketCtx, 'id' | 'display_number' | 'version'>) {
  return { ticket_id: t.id, display_number: t.display_number, ticket_version: t.version };
}

/**
 * Emits a domain event (outbox, DEC-41) and, when it concerns a ticket, appends the same type to the ticket
 * timeline (`ticket_events`, 11 §1.6) with the ticket version after the change.
 */
export async function emitForTicket(
  tx: Tx,
  ticket: TicketCtx,
  ev: {
    type: string;
    actor: EventActor;
    aggregate?: { type: string; id: string; version: number | null };
    payload: Record<string, unknown>;
    /** skip the ticket_events row (events that are not part of the timeline) */
    timeline?: boolean;
  },
): Promise<EventEnvelope> {
  const envelope = await emitEvent(tx, {
    type: ev.type,
    orgId: ticket.org_id,
    venueId: ticket.venue_id,
    dispatchPoolId: ticket.dispatch_pool_id,
    eventId: ticket.event_id,
    aggregate: ev.aggregate ?? { type: 'ticket', id: ticket.id, version: ticket.version },
    actor: ev.actor,
    payload: ev.payload,
  });
  if (ev.timeline ?? true) {
    await appendTicketEvent(tx, {
      orgId: ticket.org_id,
      venueId: ticket.venue_id,
      ticketId: ticket.id,
      type: ev.type,
      actor: ev.actor as Actor,
      ticketVersion: ticket.version,
      data: ev.payload,
    });
  }
  return envelope as EventEnvelope;
}
