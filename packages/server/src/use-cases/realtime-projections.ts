// Cross-module wiring of the realtime projections (04 §4.3: notifications does not import tickets-custody,
// the use-cases layer composes both). Runs when @point/server is imported (api and worker), like the
// DEC-32 release hook of dispatch.
import {
  registerTicketSummaryProjection,
  requestTicketUpdate,
  type TicketMessageRef,
} from '../modules/notifications/index.js';
import { loadTicketSummary, registerCustodyTicketUpdatePublisher } from '../modules/tickets-custody/index.js';
import { registerTicketUpdatePublisher } from '../modules/whatsapp/index.js';

/**
 * One TicketSummary builder for every `ticket.updated` (07 §4.3): the notifications realtime planner, the
 * WhatsApp adapter's direct updates (`publishTicketUpdated`: opt-out, W-01 outcome, delivery states) and
 * tickets-custody's (a code expiry) all go through the per-transaction coalescer, built from tickets-custody's
 * `loadTicketSummary`.
 */
export function wireTicketRealtime(): void {
  registerTicketSummaryProjection((q, ticketId) => loadTicketSummary(q, ticketId));
  registerTicketUpdatePublisher((tx, ticketId, cause, extra) =>
    requestTicketUpdate(tx, ticketId, {
      cause,
      ...(extra?.message ? { message: extra.message as TicketMessageRef } : {}),
    }),
  );
  // tickets-custody's own updates without a domain event (a handover code that expired, 14 §3.7)
  registerCustodyTicketUpdatePublisher((tx, ticketId, cause) => requestTicketUpdate(tx, ticketId, { cause }));
}

wireTicketRealtime();
