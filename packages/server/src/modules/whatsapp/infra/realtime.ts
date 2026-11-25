import { rooms } from '@point/shared';
import type { Tx } from '../../../core/db/tx.js';
import { newId } from '../../../core/crypto/ids.js';
import { publishRealtime } from '../../../core/realtime/realtime-publisher.js';

// `channel.status` is published by the notifications realtime planner from `wa.channel_health_changed`.

interface SummaryRow {
  id: string;
  org_id: string;
  display_number: number;
  event_id: string;
  event_name_ar: string;
  venue_id: string;
  venue_name_ar: string;
  dispatch_pool_id: string;
  status: string;
  channel: string;
  plate_country: string;
  plate_digits: string | null;
  plate_letters_ar: string | null;
  plate_letters_en: string | null;
  plate_raw: string | null;
  vehicle_make: string | null;
  vehicle_color: string | null;
  vehicle_type: string | null;
  wa_link_status: string;
  payment_status: string;
  created_at: Date;
  version: number;
  created_by: string;
  requested_at: Date | null;
  assignee_id: string | null;
}

/** TicketSummary of 07 (minimal projection: no phone, no key position). */
export function ticketSummaryView(t: SummaryRow) {
  const display =
    [t.plate_digits, t.plate_letters_ar].filter(Boolean).join(' ') || t.plate_raw || t.plate_letters_en || '';
  return {
    id: t.id,
    display_number: t.display_number,
    event_id: t.event_id,
    event_name_ar: t.event_name_ar,
    venue_id: t.venue_id,
    venue_name_ar: t.venue_name_ar,
    status: t.status,
    channel: t.channel,
    plate: {
      country: t.plate_country,
      digits: t.plate_digits,
      letters_ar: t.plate_letters_ar,
      letters_en: t.plate_letters_en,
      raw: t.plate_raw,
      display,
    },
    vehicle: { make: t.vehicle_make, color: t.vehicle_color, type: t.vehicle_type },
    wa_link_status: t.wa_link_status,
    payment_status: t.payment_status,
    requested_at: t.requested_at ? new Date(t.requested_at).toISOString() : null,
    created_at: new Date(t.created_at).toISOString(),
    version: t.version,
  };
}

export type TicketUpdatePublisher = (
  tx: Tx,
  ticketId: string,
  cause: string,
  extra?: Record<string, unknown>,
) => Promise<void>;

/**
 * Fallback `ticket.updated` (07 §4.3) when the adapter runs without the use-cases wiring: TicketSummary +
 * cause to the venue supervisors, the ticket's creator and the assignee of its open task. `@point/server`
 * wires {@link registerTicketUpdatePublisher} to the notifications coalescer built on the tickets-custody
 * TicketSummary (use-cases/realtime-projections.ts), so there is a single builder.
 */
export const defaultTicketUpdatePublisher: TicketUpdatePublisher = async (tx, ticketId, cause, extra) => {
  const t = await tx.maybeOne<SummaryRow>(
    `SELECT t.id, t.org_id, t.display_number, t.event_id, e.name_ar AS event_name_ar, t.venue_id, v.name_ar AS venue_name_ar,
            t.dispatch_pool_id, t.status, t.channel, t.plate_country, t.plate_digits, t.plate_letters_ar,
            t.plate_letters_en, t.plate_raw, t.vehicle_make, t.vehicle_color, t.vehicle_type, t.wa_link_status, t.payment_status,
            t.created_at, t.version, t.created_by,
            (SELECT c.requested_at FROM retrieval_cycles c WHERE c.id = t.active_cycle_id AND c.closed_at IS NULL) AS requested_at,
            (SELECT k.assignee_id FROM tasks k WHERE k.ticket_id = t.id AND k.status NOT IN ('completed','canceled')
              ORDER BY k.created_at DESC LIMIT 1) AS assignee_id
       FROM tickets t JOIN events e ON e.id = t.event_id JOIN venues v ON v.id = t.venue_id
      WHERE t.id = $1`,
    [ticketId],
  );
  if (!t) return;
  const target = [rooms.venueSupervisors(t.venue_id), rooms.user(t.created_by)];
  if (t.assignee_id && t.assignee_id !== t.created_by) target.push(rooms.user(t.assignee_id));
  await publishRealtime(tx, t.org_id, target, {
    event: 'ticket.updated',
    id: newId(),
    venue_id: t.venue_id,
    dispatch_pool_id: t.dispatch_pool_id,
    event_id: t.event_id,
    aggregate: { type: 'ticket', id: t.id, version: t.version },
    data: { cause, ...ticketSummaryView(t), ...(extra ?? {}) },
  });
};

let ticketUpdatePublisher: TicketUpdatePublisher = defaultTicketUpdatePublisher;

/** Seam for the tickets module: one TicketSummary projection for every `ticket.updated`. */
export function registerTicketUpdatePublisher(p: TicketUpdatePublisher): void {
  ticketUpdatePublisher = p;
}

export function publishTicketUpdated(
  tx: Tx,
  ticketId: string,
  cause: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  return ticketUpdatePublisher(tx, ticketId, cause, extra);
}
