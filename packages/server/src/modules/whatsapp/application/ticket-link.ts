import type { WaLinkStatus } from '@point/shared';
import { appendTicketEvent, audit } from '../../../core/audit/audit-writer.js';
import { lockTickets } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import { emitEvent } from '../../../core/outbox/outbox-writer.js';
import { publishTicketUpdated } from '../infra/realtime.js';
import type { W01OutcomeContext } from './seams.js';

interface LockedTicket {
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
 * Changes `tickets.wa_link_status` with its timeline row, event, audit and realtime update (11 §6.2,
 * §8.2 `ticket.wa_link_changed`). The ticket is locked (L5) first: callers take no lower level after it.
 */
export async function changeWaLinkStatus(
  tx: Tx,
  t: LockedTicket,
  to: WaLinkStatus,
  m: {
    method: 'opt_out' | 'provider_error' | 'provider_accepted';
    actor: { type: 'system' | 'customer'; id: string | null };
    action: string;
    notificationId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<number> {
  const u = await tx.one<{ version: number }>(
    `UPDATE tickets SET wa_link_status = $2, version = version + 1 WHERE id = $1 RETURNING version`,
    [t.id, to],
  );
  await appendTicketEvent(tx, {
    orgId: t.org_id,
    venueId: t.venue_id,
    ticketId: t.id,
    type: 'ticket.wa_link_changed',
    actor: m.actor,
    ticketVersion: u.version,
    data: { from: t.wa_link_status, to, method: m.method, notification_id: m.notificationId ?? null },
  });
  await emitEvent(tx, {
    type: 'ticket.wa_link_changed',
    orgId: t.org_id,
    venueId: t.venue_id,
    dispatchPoolId: t.dispatch_pool_id,
    eventId: t.event_id,
    aggregate: { type: 'ticket', id: t.id, version: u.version },
    actor: m.actor,
    payload: {
      ticket: { ticket_id: t.id, display_number: t.display_number, ticket_version: u.version },
      from: t.wa_link_status,
      to,
      method: m.method,
      link_version: t.link_version,
      notification_id: m.notificationId ?? null,
    },
  });
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
  await publishTicketUpdated(tx, t.id, 'ticket.wa_link_changed');
  return u.version;
}

/** Default W-01 outcome (seam for PNT-043): accepted → linked, permanent failure → failed (D-07 offers QR / paper). */
export async function applyW01Outcome(tx: Tx, ctx: W01OutcomeContext): Promise<void> {
  const [t] = await lockTickets(tx, [ctx.ticketId]);
  if (!t) return;
  const ticket = t as LockedTicket;
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
