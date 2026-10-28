import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { requireDuty, type ActorContext } from '../../../core/actor-context/actor-context.js';
import { audit } from '../../../core/audit/audit-writer.js';
import type { Env } from '../../../core/config/env.js';
import { lockTickets } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { ENV } from '../../../http/tokens.js';
import {
  findTicketInScope,
  invalidTransition,
  isClosedTicket,
  loadTicketDetail,
  type TicketRow,
} from '../../tickets-custody/index.js';
import type { LinkCodeRow } from './link-codes.js';
import {
  assertChannelAvailable,
  confirmQrLink,
  issueQrLinkCode,
  startDirectLink,
  type LinkCodeQr,
} from './link-service.js';

export const WhatsappLinkBody = z.strictObject({ method: z.enum(['direct', 'qr']) });
export type WhatsappLinkBody = z.infer<typeof WhatsappLinkBody>;

export const WhatsappLinkConfirmBody = z.strictObject({
  link_code_id: z.uuid(),
  matches: z.boolean(),
});
export type WhatsappLinkConfirmBody = z.infer<typeof WhatsappLinkConfirmBody>;

const LINK_OP = 'POST /v1/tickets/{ticketId}/whatsapp-link';
const CONFIRM_OP = 'POST /v1/tickets/{ticketId}/whatsapp-link/confirm';
const OPEN_AFTER_INTAKE = [
  'parking',
  'parked',
  'requested',
  'assigned',
  'assigned_waiting',
  'retrieving',
  'ready',
  'reparking',
];
const QR_STATUSES = ['received', 'parking', 'parked'];
/** Link states a QR code may (re)start from (11 §6.2: none/failed → pending_confirmation; 12 §7.6 opted_out). */
const QR_FROM = new Set(['none', 'failed', 'opted_out', 'pending_send']);

/** `WaLinkResult` (07). */
export interface WaLinkResult {
  method: 'direct' | 'qr';
  wa_link_status: TicketRow['wa_link_status'];
  channel_health: string;
  qr: LinkCodeQr | null;
}

/**
 * `POST /v1/tickets/{ticketId}/whatsapp-link` and `/confirm` (PNT-043, PNT-044; 12 §7.1–§7.2). Both start at
 * L5 (canon §14ب: link codes need no pool lock) and take only L9 rows after it.
 */
@Injectable()
export class WhatsappLinkCommands {
  constructor(@Inject(ENV) private readonly env: Env) {}

  /**
   * direct: the W-01 retry of D-07 (the submit links directly by itself) — consent, opt-out, template and
   * channel checks, then `pending_send`. qr: a new link code and the wa.me panel.
   */
  async link(
    tx: Tx,
    actor: ActorContext,
    ticketId: string,
    body: WhatsappLinkBody,
    requestId: string,
  ): Promise<WaLinkResult> {
    const pre = await findTicketInScope(tx, actor, ticketId);
    if (actor.role === 'driver') {
      const duty = requireDuty(actor);
      if (duty.venueId !== pre.venue_id) throw new AppError('DUTY_REQUIRED');
    }
    const [locked] = await lockTickets(tx, [ticketId]); // L5
    const t = locked as TicketRow;
    if (isClosedTicket(t.status)) throw new AppError('TICKET_CLOSED', { ticket_status: t.status });
    if (t.channel !== 'whatsapp')
      throw invalidTransition('ticket', t, LINK_OP, [...OPEN_AFTER_INTAKE, 'received'], 'paper_channel');
    const channel = await assertChannelAvailable(tx, t.org_id);

    let after: TicketRow = t;
    let qr: LinkCodeQr | null = null;
    if (body.method === 'direct') {
      // the submit sends W-01 for a draft with a phone and consent (TT-03); retries come after it
      if (t.status === 'received')
        throw invalidTransition('ticket', t, LINK_OP, OPEN_AFTER_INTAKE, 'submit_intake_links_directly');
      if (t.wa_link_status === 'linked')
        throw invalidTransition('ticket', t, LINK_OP, OPEN_AFTER_INTAKE, 'already_linked');
      if (t.wa_link_status === 'pending_confirmation')
        throw invalidTransition('ticket', t, LINK_OP, OPEN_AFTER_INTAKE, 'qr_pending_confirmation');
      const customer = t.customer_id
        ? await tx.maybeOne<{ phone_e164: string | null; wa_opted_out_at: Date | null }>(
            `SELECT phone_e164, wa_opted_out_at FROM customers WHERE id = $1`,
            [t.customer_id],
          )
        : null;
      if (!customer?.phone_e164)
        throw new AppError('PHONE_INVALID', { field: 'customer_phone', issue: 'missing' });
      const consent = await tx.maybeOne(
        `SELECT 1 AS one FROM customer_consents WHERE ticket_id = $1 AND customer_id = $2 AND revoked_at IS NULL LIMIT 1`,
        [t.id, t.customer_id],
      );
      if (customer.wa_opted_out_at || t.wa_link_status === 'opted_out')
        throw new AppError('WA_CUSTOMER_OPTED_OUT');
      if (!consent) throw new AppError('WA_CONSENT_MISSING');
      after = await startDirectLink(tx, t, { actor: { type: 'user', id: actor.userId } });
    } else {
      if (!QR_STATUSES.includes(t.status)) throw invalidTransition('ticket', t, LINK_OP, QR_STATUSES);
      if (!QR_FROM.has(t.wa_link_status))
        throw invalidTransition(
          'ticket',
          t,
          LINK_OP,
          QR_STATUSES,
          t.wa_link_status === 'linked' ? 'already_linked' : 'qr_pending_confirmation',
        );
      const display = channel.phone_display || this.env.WA_DISPLAY_PHONE_E164;
      if (!display.replace(/\D/g, ''))
        throw new AppError('WA_CHANNEL_UNAVAILABLE', {
          health_status: channel.health_status,
          since: channel.health_changed_at ? new Date(channel.health_changed_at).toISOString() : null,
          reason: 'display_phone_not_configured',
        });
      qr = await issueQrLinkCode(tx, t, { actorId: actor.userId, displayPhoneE164: display });
    }
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'wa.link',
      entityType: 'ticket',
      entityId: t.id,
      venueId: t.venue_id,
      requestId,
      before: { wa_link_status: t.wa_link_status, link_version: t.link_version },
      after: { wa_link_status: after.wa_link_status, link_version: after.link_version },
      metadata: { operation: LINK_OP, method: body.method, link_code_id: qr?.link_code_id ?? null },
    });
    return {
      method: body.method,
      wa_link_status: after.wa_link_status,
      channel_health: channel.health_status,
      qr,
    };
  }

  /** «هل هذا العميل أمامك؟» — the link code's creator or a supervisor of the venue answers (09 §4.2). */
  async confirm(
    tx: Tx,
    actor: ActorContext,
    ticketId: string,
    body: WhatsappLinkConfirmBody,
    requestId: string,
  ) {
    await findTicketInScope(tx, actor, ticketId);
    const [locked] = await lockTickets(tx, [ticketId]); // L5
    const t = locked as TicketRow;
    const lc = await tx.maybeOne<LinkCodeRow>(
      `SELECT * FROM link_codes WHERE id = $1 AND ticket_id = $2 FOR NO KEY UPDATE`,
      [body.link_code_id, t.id],
    );
    if (!lc) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'link_code' });
    if (actor.role === 'driver' && lc.created_by !== actor.userId)
      throw new AppError('PERMISSION_DENIED', { permission: 'wa.link', reason: 'not_link_code_creator' });
    if (isClosedTicket(t.status))
      throw invalidTransition('ticket', t, CONFIRM_OP, QR_STATUSES, 'ticket_closed');
    const expired =
      lc.status === 'expired' ||
      ((lc.status === 'pending_confirmation' || lc.status === 'active') &&
        new Date(lc.expires_at).getTime() <= tx.now.getTime());
    if (expired)
      throw new AppError('WA_LINK_CODE_EXPIRED', { expired_at: new Date(lc.expires_at).toISOString() });
    if (lc.status !== 'pending_confirmation')
      throw invalidTransition('link_code', { id: lc.id, status: lc.status }, CONFIRM_OP, [
        'pending_confirmation',
      ]);
    const r = await confirmQrLink(tx, t, lc, { matches: body.matches, actorId: actor.userId });
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'wa.link',
      entityType: 'ticket',
      entityId: t.id,
      venueId: t.venue_id,
      requestId,
      before: { wa_link_status: t.wa_link_status, link_version: t.link_version },
      after: {
        wa_link_status: body.matches
          ? 'linked'
          : t.wa_link_status === 'pending_confirmation'
            ? 'none'
            : t.wa_link_status,
        link_version: r.linkVersion,
      },
      metadata: {
        operation: CONFIRM_OP,
        link_code_id: lc.id,
        matches: body.matches,
        customer_changed: body.matches && t.customer_id !== null && t.customer_id !== r.customerId,
        consent_method: body.matches ? 'customer_initiated' : null,
      },
    });
    return loadTicketDetail(tx, t.id, { userId: actor.userId, role: actor.role });
  }
}
