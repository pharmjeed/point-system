import type { Tx } from '../../../core/db/tx.js';
import { openIncidentViaHook } from '../../../core/hooks/incident-writer.js';

/**
 * The system-opened `payment_discrepancy` incident of 13 §7.1 (reversal without replacement on a delivered
 * ticket) and §10.2 (non-zero cash handover difference), `open`, in the producing command's transaction. The
 * incidents module owns the table; this module may not import it (04 §4.3), so the row is written by its
 * `openIncident` through the core seam: `incident.opened` (11 §8.8 `IncidentChanged` + `auto_created`, 15 §7.5),
 * placed on the event's dispatch pool and caused by the commanding user.
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
  const incident = await openIncidentViaHook(tx, {
    orgId: a.orgId,
    venueId: a.venueId,
    eventId: a.eventId,
    ticketId: a.ticketId,
    dispatchPoolId: a.dispatchPoolId,
    type: 'payment_discrepancy',
    severity: a.severity ?? 'medium',
    description: a.description,
    openedBy: a.openedBy,
    actor: { type: 'user', id: a.openedBy },
    autoCreated: true,
  });
  return incident.id;
}
