import type { Tx } from '../../../core/db/tx.js';
import { newId } from '../../../core/crypto/ids.js';
import { emitEvent } from '../../../core/outbox/outbox-writer.js';

/**
 * The system-opened `payment_discrepancy` incident of 13 §7.1 (reversal without replacement on a delivered
 * ticket) and §10.2 (non-zero cash handover difference). The incidents module (PNT-083) owns the incident
 * routes; until it exposes a writer, the row is inserted here with the `incident.opened` payload of 11 §8.8
 * (`IncidentChanged`) plus `auto_created` (15 §7.5), in the producing command's transaction.
 */
export interface OpenIncidentArgs {
  orgId: string;
  venueId: string;
  eventId: string;
  dispatchPoolId: string | null;
  ticketId: string | null;
  description: string;
  openedBy: string;
  severity?: 'low' | 'medium' | 'high';
}

export async function openPaymentDiscrepancyIncident(tx: Tx, a: OpenIncidentArgs): Promise<string> {
  const id = newId();
  const severity = a.severity ?? 'medium';
  await tx.query(
    `INSERT INTO incidents (id, org_id, venue_id, event_id, ticket_id, type, status, severity, description, opened_by,
                            version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'payment_discrepancy', 'open', $6, $7, $8, 1, $9, $9)`,
    [id, a.orgId, a.venueId, a.eventId, a.ticketId, severity, a.description, a.openedBy, tx.now],
  );
  await emitEvent(tx, {
    type: 'incident.opened',
    orgId: a.orgId,
    venueId: a.venueId,
    dispatchPoolId: a.dispatchPoolId,
    eventId: a.eventId,
    aggregate: { type: 'incident', id, version: 1 },
    actor: { type: 'user', id: a.openedBy },
    payload: {
      incident_id: id,
      type: 'payment_discrepancy',
      status: 'open',
      severity,
      ticket_id: a.ticketId,
      auto_created: true,
    },
  });
  return id;
}
