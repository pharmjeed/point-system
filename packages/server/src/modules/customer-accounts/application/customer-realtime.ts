import { OPEN_TICKET_STATUSES, type TicketStatus } from '@point/shared';
import { customerRoom, type CustomerVisitUpdated } from '@point/shared/customer';
import { newId } from '../../../core/crypto/ids.js';
import type { Tx } from '../../../core/db/tx.js';
import { publishRealtime } from '../../../core/realtime/realtime-publisher.js';
import { registerTicketUpdateListener } from '../../notifications/index.js';

const OPEN = new Set<string>(OPEN_TICKET_STATUSES);

/**
 * `visit.updated` on the customer socket (V2-015, DEC-520): whenever a ticket's coalesced `ticket.updated` is
 * published for staff, the account the ticket's `customers` row is linked to (any channel: a WhatsApp visit of the
 * account shows in the app too, DEC-504) gets a minimal projection in its own room — the ticket id and its state, no
 * staff, venue, spot or code; the app reads the visit again. A voided ticket is no longer a visit, so the app learns
 * it is gone (it reads the visit and gets RESOURCE_NOT_FOUND). Published with pg_notify in the producing transaction
 * (DEC-48): nothing is delivered if it rolls back.
 */
export async function publishVisitUpdated(tx: Tx, ticketId: string): Promise<void> {
  const t = await tx.maybeOne<{ org_id: string; status: TicketStatus; account_id: string }>(
    `SELECT t.org_id, t.status, c.customer_account_id AS account_id
       FROM tickets t
       JOIN customers c ON c.id = t.customer_id AND c.org_id = t.org_id
       JOIN customer_accounts a ON a.id = c.customer_account_id
      WHERE t.id = $1 AND a.status = 'active'`,
    [ticketId],
  );
  if (!t) return;
  const data: CustomerVisitUpdated = { ticket_id: ticketId, status: t.status, open: OPEN.has(t.status) };
  await publishRealtime(tx, t.org_id, [customerRoom(t.account_id)], {
    event: 'visit.updated',
    id: newId(),
    data: { ...data },
  });
}

/** Registers the listener (idempotent; the api and the worker both publish from their transactions). */
export function startCustomerRealtime(): void {
  registerTicketUpdateListener('customer-visit', (tx, ticketId) => publishVisitUpdated(tx, ticketId));
}

export function stopCustomerRealtime(): void {
  registerTicketUpdateListener('customer-visit', null);
}
