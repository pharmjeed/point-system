import type { WaLinkStatus } from '@point/shared';
import { audit } from '../../../core/audit/audit-writer.js';
import { lockTickets } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import { emitForTicket, type EventActor } from '../../tickets-custody/index.js';
import { publishTicketUpdated } from '../infra/realtime.js';
import type { W01OutcomeContext } from './seams.js';

/** `ticket.wa_link_changed.method` (11 §8.2). */
export type WaLinkMethod =
  | 'direct'
  | 'qr'
  | 'phone_change'
  | 'opt_out'
  | 'button_resume'
  | 'provider_error'
  | 'provider_accepted'
  | 'qr_rejected'
  | 'channel_paper';

/** The ticket columns a link change reads (a locked `tickets` row, L5). */
export interface WaLinkTicket {
  id: string;
  org_id: string;
  venue_id: string;
  event_id: string;
  dispatch_pool_id: string;
  display_number: number;
  wa_link_status: WaLinkStatus;
  link_version: number;
  version: number;
}

/**
 * The trace of a link status change the caller has already written to `tickets` (11 §6.2): the timeline row
 * and `ticket.wa_link_changed` (11 §8.2, with the ticket after the change: version, link_version), then
 * `ticket.updated` for the creator, the assignee and the supervisors (D-07, S-03). The NotificationPlanner
 * plans W-01 from the event when it moves to `pending_send`, or to `linked` through QR.
 */
export async function recordWaLinkChange(
  tx: Tx,
  from: WaLinkStatus,
  after: WaLinkTicket,
  m: { method: WaLinkMethod; actor: EventActor; notificationId?: string | null },
): Promise<void> {
  await emitForTicket(tx, after, {
    type: 'ticket.wa_link_changed',
    actor: m.actor,
    payload: {
      ticket: { ticket_id: after.id, display_number: after.display_number, ticket_version: after.version },
      from,
      to: after.wa_link_status,
      method: m.method,
      link_version: after.link_version,
      notification_id: m.notificationId ?? null,
    },
  });
  await publishTicketUpdated(tx, after.id, 'ticket.wa_link_changed');
}

/**
 * Changes `tickets.wa_link_status` with its timeline row, event, audit and realtime update (11 §6.2,
 * §8.2 `ticket.wa_link_changed`). The ticket is locked (L5) first: callers take no lower level after it.
 * Commands that write their own audit row pass `audit: false`.
 */
export async function changeWaLinkStatus(
  tx: Tx,
  t: WaLinkTicket,
  to: WaLinkStatus,
  m: {
    method: WaLinkMethod;
    actor: EventActor;
    action: string;
    notificationId?: string | null;
    metadata?: Record<string, unknown>;
    audit?: boolean;
  },
): Promise<WaLinkTicket> {
  const after = await tx.one<WaLinkTicket>(
    `UPDATE tickets SET wa_link_status = $2, version = version + 1 WHERE id = $1
     RETURNING id, org_id, venue_id, event_id, dispatch_pool_id, display_number, wa_link_status, link_version, version`,
    [t.id, to],
  );
  await recordWaLinkChange(tx, t.wa_link_status, after, m);
  if (m.audit ?? true)
    await audit(tx, {
      orgId: t.org_id,
      actor: m.actor,
      action: m.action,
      entityType: 'ticket',
      entityId: t.id,
      venueId: t.venue_id,
      before: { wa_link_status: t.wa_link_status },
      after: { wa_link_status: to },
      metadata: { method: m.method, ...(m.metadata ?? {}) },
    });
  return after;
}

/** Default W-01 outcome (seam for PNT-043): accepted → linked, permanent failure → failed (D-07 offers QR / paper). */
export async function applyW01Outcome(tx: Tx, ctx: W01OutcomeContext): Promise<void> {
  const [t] = await lockTickets(tx, [ctx.ticketId]);
  if (!t) return;
  const ticket = t as WaLinkTicket;
  if (ctx.linkVersion !== null && ticket.link_version !== ctx.linkVersion) return; // an older W-01
  const from = ticket.wa_link_status;
  const to: WaLinkStatus | null =
    ctx.outcome === 'accepted'
      ? from === 'pending_send'
        ? 'linked'
        : null
      : from === 'pending_send' || from === 'linked'
        ? 'failed'
        : null;
  if (!to) return;
  await changeWaLinkStatus(tx, ticket, to, {
    method: ctx.outcome === 'accepted' ? 'provider_accepted' : 'provider_error',
    actor: { type: 'system', id: null },
    action: ctx.action,
    notificationId: ctx.notificationId,
    metadata: ctx.errorCode ? { error_code: ctx.errorCode } : {},
  });
}
