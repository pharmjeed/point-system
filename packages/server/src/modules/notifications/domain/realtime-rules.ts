import { TICKET_EVENT_TYPES } from '@point/shared';
import type { PlannerEvent } from './customer-rules.js';

/** A WhatsApp delivery state shown with the ticket (D-07 / S-03). */
export interface TicketMessageRef {
  id: string;
  purpose: string | null;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  status_rank: number;
}

/**
 * One `ticket.updated` asked for by a domain event (07 §4.3; 14 §3.1, §3.4, §3.5, §3.6; 11 §8.2, §8.6–§8.8,
 * §8.10). The flush adds the venue supervisors, the open task's assignee and the creator while the ticket
 * is in intake; the request names the drivers the event concerns beyond those.
 */
export interface TicketUpdateRequest {
  ticketId: string;
  cause: string;
  /** custody holders before/after (14 §3.4), the parking driver of an early request, the collector … */
  extraUserIds: string[];
  /** the creator is concerned whatever the ticket status (D-07 link state, late photos, void) */
  creator: boolean;
  /** an incident change: supervisors only */
  supervisorsOnly: boolean;
  message: TicketMessageRef | null;
}

const TICKET_EVENTS: ReadonlySet<string> = new Set(TICKET_EVENT_TYPES);

/** Ticket events whose creator hears about them in any ticket status. */
const CREATOR_EVENTS: ReadonlySet<string> = new Set([
  'ticket.created',
  'ticket.intake_submitted',
  'ticket.wa_link_changed',
  'ticket.customer_phone_changed',
  'ticket.inspection_completed',
  'ticket.voided',
]);

const OTHER_TICKET_CAUSES: ReadonlySet<string> = new Set([
  'custody.changed',
  'handover.code_issued',
  'handover.code_attempt_failed',
  'handover.code_locked',
  'handover.completed',
  'handover.exception_approved',
  'payment.recorded',
  'payment.reversed',
  'payment.waived',
]);

const INCIDENT_EVENTS: ReadonlySet<string> = new Set([
  'incident.opened',
  'incident.updated',
  'incident.resolved',
]);

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

const driverId = (h: unknown): string | null => {
  const x = h as { type?: unknown; id?: unknown } | null;
  return x && x.type === 'driver' ? str(x.id) : null;
};

/**
 * The «السائق» / «المشرف» `ticket.updated` cells of 14 §3 as a pure function of one event. `task.*`,
 * `offer.*` and `driver.*` are the dispatch realtime (`task.updated`, `offer.closed` …), `alert.*` core's.
 */
export function ticketUpdateRequests(ev: PlannerEvent): TicketUpdateRequest[] {
  const p = ev.payload ?? {};
  const req = (
    ticketId: string | null,
    o: Partial<Omit<TicketUpdateRequest, 'ticketId' | 'cause'>> = {},
  ): TicketUpdateRequest[] =>
    ticketId
      ? [
          {
            ticketId,
            cause: ev.type,
            extraUserIds: [...new Set((o.extraUserIds ?? []).filter((x): x is string => !!x))],
            creator: o.creator ?? false,
            supervisorsOnly: o.supervisorsOnly ?? false,
            message: o.message ?? null,
          },
        ]
      : [];

  if (TICKET_EVENTS.has(ev.type)) {
    const ticketId =
      str(p.ticket?.ticket_id) ??
      str(p.ticket_id) ??
      (ev.aggregate?.type === 'ticket' ? ev.aggregate.id : null);
    const extra: (string | null)[] = [];
    if (ev.type === 'ticket.retrieval_requested_early') extra.push(str(p.parking_task_assignee_id));
    if (ev.type === 'ticket.reparking') extra.push(str(p.assignee_id));
    return req(ticketId, { creator: CREATOR_EVENTS.has(ev.type), extraUserIds: extra as string[] });
  }
  if (OTHER_TICKET_CAUSES.has(ev.type)) {
    const extra =
      ev.type === 'custody.changed'
        ? [driverId(p.from), driverId(p.to)]
        : ev.type === 'payment.recorded'
          ? [str(p.collected_by)]
          : [];
    return req(str(p.ticket_id), { extraUserIds: extra as string[] });
  }
  if (INCIDENT_EVENTS.has(ev.type)) return req(str(p.ticket_id), { supervisorsOnly: true });
  if (ev.type === 'wa.message_status_changed') {
    const id = str(p.whatsapp_message_id);
    const status = p.status;
    const message: TicketMessageRef | null =
      id && (status === 'sent' || status === 'delivered' || status === 'read' || status === 'failed')
        ? {
            id,
            purpose: str(p.purpose),
            status,
            status_rank: typeof p.status_rank === 'number' ? p.status_rank : 0,
          }
        : null;
    return req(str(p.ticket_id), { creator: p.purpose === 'W-01', message });
  }
  return [];
}

/** Whether a cause is a ticket.* event (it then names the coalesced update over custody/payment causes). */
export const isTicketCause = (cause: string): boolean => TICKET_EVENTS.has(cause);
