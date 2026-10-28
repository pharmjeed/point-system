import { Injectable } from '@nestjs/common';
import { autoResolveAlerts } from '../core/alerts/alerts.js';
import type { ActorContext } from '../core/actor-context/actor-context.js';
import { lockTickets } from '../core/db/locks.js';
import type { Tx } from '../core/db/tx.js';
import { AppError } from '../core/errors/app-error.js';
import { scopeStillGranted } from '../modules/incidents/index.js';
import { listUploadedPhotoKinds } from '../modules/media/index.js';
import {
  emitForTicket,
  findTicketInScope,
  invalidTransition,
  isClosedTicket,
  loadTicketDetail,
  OPEN_TICKET_STATUSES,
  ticketRef,
  type TicketRow,
} from '../modules/tickets-custody/index.js';
import { venueSettingsFor } from '../modules/venues-events/index.js';
import { auditCommand, eventActor } from './shared.js';

const OPERATION = 'POST /v1/tickets/{ticketId}/inspection-exception';

/**
 * `POST /v1/tickets/{ticketId}/inspection-exception` (PNT-079; 11 §2.4, 07 §2.2, 09 §10 rule 2 and §11): the
 * supervisor approves an incomplete intake inspection on an open ticket — `inspection_status = exception_approved`,
 * `ticket.inspection_exception_approved`, the `inspection_incomplete` alert resolved. The audit row carries the
 * reason, the missing photos and `self_approved` when the supervisor created the ticket himself. L5 only.
 */
@Injectable()
export class InspectionExceptionUseCase {
  async execute(tx: Tx, actor: ActorContext, ticketId: string, body: { reason: string }, requestId: string) {
    await findTicketInScope(tx, actor, ticketId); // TICKET_NOT_FOUND outside the scope (08 §1.3 rule 4)
    const [locked] = (await lockTickets(tx, [ticketId])) as TicketRow[]; // L5
    const t = locked!;
    if (!(await scopeStillGranted(tx, actor, t.venue_id))) throw new AppError('TICKET_NOT_FOUND');
    if (isClosedTicket(t.status))
      throw invalidTransition('ticket', t, OPERATION, OPEN_TICKET_STATUSES, 'ticket_closed');
    if (t.inspection_status !== 'incomplete')
      throw invalidTransition('ticket', t, OPERATION, OPEN_TICKET_STATUSES, 'inspection_not_incomplete');

    const required = (await venueSettingsFor(tx, t.venue_id)).inspection.required_photos;
    const uploaded = new Set<string>(await listUploadedPhotoKinds(tx, t.id));
    const missing = required.filter((k) => !uploaded.has(k));
    const reason = body.reason.trim();
    const updated = await tx.one<TicketRow>(
      `UPDATE tickets SET inspection_status = 'exception_approved', version = version + 1 WHERE id = $1 RETURNING *`,
      [t.id],
    );
    await emitForTicket(tx, updated, {
      type: 'ticket.inspection_exception_approved',
      actor: eventActor(actor),
      payload: {
        ticket: ticketRef(updated),
        approved_by: actor.userId,
        reason,
        missing_photos_count: missing.length,
      },
    });
    await autoResolveAlerts(tx, {
      orgId: t.org_id,
      venueId: t.venue_id,
      dedupeKeys: [`inspection_incomplete:${t.id}`],
      note: 'exception_approved',
    });
    await auditCommand(tx, actor, {
      action: 'ticket.inspection_exception',
      operation: OPERATION,
      entityType: 'ticket',
      entityId: t.id,
      venueId: t.venue_id,
      requestId,
      reason,
      before: { inspection_status: 'incomplete' },
      after: { inspection_status: 'exception_approved' },
      metadata: { missing_photos: missing, self_approved: t.created_by === actor.userId },
    });
    return loadTicketDetail(tx, t.id, { userId: actor.userId, role: actor.role });
  }
}
