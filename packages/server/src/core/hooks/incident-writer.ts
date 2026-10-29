import type { IncidentSeverity, IncidentType } from '@point/shared';
import type { Tx } from '../db/tx.js';

/**
 * One incident writer for every flow that opens an incident inside its own command (11 §6.11): the documented
 * exception handover (TT-19), the repark for an absent customer (TT-20), a reversal after delivery and a cash
 * handover with a difference (13 §7.1, §10.2), and `POST /v1/incidents`. The incidents module owns the table
 * (04 §4.2 item 7) and implements it as `openIncident`; the use-cases import it directly (04 §4.3), the modules
 * below the incidents module (payments-reports) reach it through this seam, which the incidents module fills when
 * it loads (the DriverReleaseHook pattern). The row and its events are written in the caller's transaction.
 */
export interface OpenIncidentInput {
  orgId: string;
  venueId: string;
  eventId?: string | null;
  ticketId?: string | null;
  type: IncidentType;
  severity?: IncidentSeverity;
  description: string;
  /** the user recorded as `opened_by` (06: NOT NULL), also for incidents opened by a system flow */
  openedBy: string;
  /** who caused it: the user of the command (default), or the system for an automatic incident */
  actor?: { type: 'user' | 'system'; id: string | null };
  /** created already resolved (TT-19, TT-20 document what happened): `incident.resolved` follows */
  resolution?: string | null;
  /** the incident's owner: the supervisor who documented it (TT-19, TT-20); default none */
  ownerId?: string | null;
  /** envelope `dispatch_pool_id` of the events: the producing command's pool (default none) */
  dispatchPoolId?: string | null;
  /**
   * `auto_created` of the event payloads (15 §7.5): default = the actor is the system; `true` for an incident a
   * command opens as a side effect; `null` leaves the key out (the analytics projector then reads the actor).
   */
  autoCreated?: boolean | null;
  /** the `status` that `incident.opened` reports: `open` (11 §8.8, default) or the stored row's own status */
  openedStatus?: 'open' | 'stored';
  /** also appends the events to the ticket timeline (`ticket_events`) at this ticket version (11 §1.6) */
  timeline?: { ticketVersion: number } | null;
}

/** What the writer returns: enough for the callers' payloads, audit rows and answers. */
export interface OpenedIncident {
  id: string;
  status: string;
  severity: string;
  version: number;
}

export type IncidentOpener = (tx: Tx, input: OpenIncidentInput) => Promise<OpenedIncident>;

let opener: IncidentOpener | null = null;

/** The incidents module registers its writer when it loads; `null` unregisters it (tests). */
export function registerIncidentOpener(fn: IncidentOpener | null): void {
  opener = fn;
}

export const hasIncidentOpener = (): boolean => opener !== null;

/**
 * Opens an incident through the registered writer. Never silently skipped: without the incidents module loaded
 * the command fails (and rolls back) instead of committing a change whose incident 13 §7.1 / §10.2 require.
 */
export async function openIncidentViaHook(tx: Tx, input: OpenIncidentInput): Promise<OpenedIncident> {
  if (!opener) throw new Error('no incident writer is registered: the incidents module is not loaded');
  return opener(tx, input);
}
