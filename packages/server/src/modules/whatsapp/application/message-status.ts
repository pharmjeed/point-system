import { appendTicketEvent } from '../../../core/audit/audit-writer.js';
import type { Tx } from '../../../core/db/tx.js';
import { emitEvent } from '../../../core/outbox/outbox-writer.js';
import { publishTicketUpdated } from '../infra/realtime.js';

/** The outbound whatsapp_messages columns a status change is published with. */
export interface OutboundMessageRef {
  id: string;
  org_id: string;
  notification_id: string | null;
  ticket_id: string | null;
  venue_id: string | null;
  event_id: string | null;
  purpose: string | null;
}

export type OutboundStatus = 'sent' | 'delivered' | 'read' | 'failed';

/**
 * `wa.message_status_changed` (11 §8.10) for an outbound message: the domain event, the ticket timeline
 * row and `ticket.updated` for the staff screens (D-07 / S-03 show sent · delivered · read · failed, 14
 * §3.3). Used by the status webhook and by the sender when the provider refuses a message for good.
 */
export async function recordMessageStatusChange(
  tx: Tx,
  row: OutboundMessageRef,
  status: OutboundStatus,
  rank: number,
  errorCode: string | null,
): Promise<void> {
  const payload = {
    whatsapp_message_id: row.id,
    notification_id: row.notification_id,
    ticket_id: row.ticket_id,
    purpose: row.purpose,
    status,
    status_rank: rank,
    error_code: errorCode,
  };
  await emitEvent(tx, {
    type: 'wa.message_status_changed',
    orgId: row.org_id,
    venueId: row.venue_id,
    eventId: row.event_id,
    aggregate: { type: 'whatsapp_message', id: row.id, version: rank },
    actor: { type: 'system', id: null },
    payload,
  });
  if (!row.ticket_id || !row.venue_id) return;
  const t = await tx.maybeOne<{ version: number }>(`SELECT version FROM tickets WHERE id = $1`, [
    row.ticket_id,
  ]);
  if (!t) return;
  await appendTicketEvent(tx, {
    orgId: row.org_id,
    venueId: row.venue_id,
    ticketId: row.ticket_id,
    type: 'wa.message_status_changed',
    actor: { type: 'system', id: null },
    ticketVersion: t.version,
    data: payload,
  });
  await publishTicketUpdated(tx, row.ticket_id, 'wa.message_status_changed', {
    message: { id: row.id, purpose: row.purpose, status, status_rank: rank },
  });
}
