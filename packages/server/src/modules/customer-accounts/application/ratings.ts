import type { CustomerVisitRating } from '@point/shared/customer';
import type { CustomerActorContext } from '../../../core/actor-context/customer-actor.js';
import { customerAudit } from '../../../core/audit/customer-audit.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { lockCustomerAccount } from './account-service.js';
import { findAccountVisit } from './visits.js';

/**
 * `POST /v1/customer/visits/{ticketId}/rating` (C-13, V2-015, DEC-518): once per visit, after the delivery, 1–5 stars
 * and an optional note. The row carries the operator's ticket (its org and venue) and the account; a second rating is
 * refused (`uq_customer_visit_ratings_ticket` the backstop). The account's trail records the stars, never the note.
 */
export async function rateCustomerVisit(
  tx: Tx,
  actor: CustomerActorContext,
  ticketId: string,
  body: { stars: number; note?: string | null | undefined },
  client: ClientInfo,
): Promise<CustomerVisitRating> {
  await lockCustomerAccount(tx, actor.accountId);
  const visit = await findAccountVisit(tx, actor.accountId, ticketId);
  if (visit.status !== 'delivered')
    throw new AppError('CUSTOMER_VISIT_NOT_DELIVERED', { ticket_status: visit.status });
  const row = await tx.maybeOne<{ created_at: Date; note: string | null; stars: number }>(
    `INSERT INTO customer_visit_ratings (org_id, venue_id, ticket_id, account_id, stars, note, request_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (ticket_id) DO NOTHING RETURNING created_at, note, stars`,
    [
      visit.org_id,
      visit.venue_id,
      visit.ticket_id,
      actor.accountId,
      body.stars,
      body.note ?? null,
      client.requestId,
      tx.now,
    ],
  );
  if (!row) throw new AppError('CUSTOMER_VISIT_ALREADY_RATED');
  await customerAudit(tx, {
    actor: { type: 'customer', accountId: actor.accountId },
    action: 'customer.visit.rated',
    entityType: 'ticket',
    entityId: visit.ticket_id,
    requestId: client.requestId,
    ip: client.ip ?? null,
    userAgent: client.userAgent ?? null,
    metadata: {
      org_id: visit.org_id,
      venue_id: visit.venue_id,
      stars: row.stars,
      with_note: row.note !== null,
    },
  });
  return {
    ticket_id: visit.ticket_id,
    stars: row.stars,
    note: row.note,
    rated_at: new Date(row.created_at).toISOString(),
  };
}
