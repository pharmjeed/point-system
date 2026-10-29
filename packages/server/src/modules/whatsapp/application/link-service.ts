import { waTemplateById, type WaMessageId } from '@point/shared';
import { lockTickets } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import type { JobHandler } from '../../../core/outbox/dispatcher.js';
import { schedule } from '../../../core/outbox/outbox-writer.js';
import { isClosedTicket, type EventActor, type TicketRow } from '../../tickets-custody/index.js';
import { venueSettingsFor } from '../../venues-events/index.js';
import { sessionWindowOpen } from '../domain/send-rules.js';
import { activeChannel, type ChannelRow } from '../infra/channel.js';
import { publishTicketUpdated } from '../infra/realtime.js';
import { revokeActionTokens } from './action-tokens.js';
import { newLinkCode, waMeLink, type LinkCodeRow } from './link-codes.js';
import type { LinkCodeContext, LinkCodeResult } from './seams.js';
import { templateStatus } from './templates.js';
import { changeWaLinkStatus, recordWaLinkChange } from './ticket-link.js';

/**
 * LinkService (04 §4.2 whatsapp: `LinkService.issueQr / confirm`, `ConsentService`): the ticket ↔ customer
 * conversation link of 12 §7 — the direct link with verbal consent (PNT-043), the customer-initiated QR link
 * (PNT-044), the button press that resumes consent after an opt-out (12 §7.6). Every function runs inside the
 * caller's transaction with the ticket locked (L5); link codes are L9.
 */

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** `LinkCodeQr` (07): the D-07 panel. Scanning it alone sends nothing (12 §7.2 step 3). */
export interface LinkCodeQr {
  link_code_id: string;
  code: string;
  status: LinkCodeRow['status'];
  expires_at: string;
  wa_me_url: string;
  prefilled_text: string;
  qr_text: string;
}

/** WA_TEMPLATE_NOT_APPROVED — the early check of 08 §4.13 (submit-intake, whatsapp-link, handover-code/resend). */
export async function assertTemplateApproved(tx: Tx, orgId: string, purpose: WaMessageId): Promise<void> {
  const def = waTemplateById(purpose);
  if (def.kind !== 'template') return;
  const status = await templateStatus(tx, orgId, def.name);
  if (status !== 'approved')
    throw new AppError('WA_TEMPLATE_NOT_APPROVED', { template_name: def.name, template_status: status });
}

/**
 * W-05 has the session fallback of 12 §8.4: an unapproved template is refused early only when the
 * customer's service window is closed (TC-WA-06).
 */
export async function assertCodeMessageSendable(tx: Tx, orgId: string, customerId: string): Promise<void> {
  const def = waTemplateById('W-05');
  const status = await templateStatus(tx, orgId, def.name);
  if (status === 'approved') return;
  const c = await tx.maybeOne<{ last_inbound_at: Date | null }>(
    `SELECT last_inbound_at FROM customers WHERE id = $1`,
    [customerId],
  );
  if (sessionWindowOpen(c?.last_inbound_at ? new Date(c.last_inbound_at) : null, tx.now)) return;
  throw new AppError('WA_TEMPLATE_NOT_APPROVED', { template_name: def.name, template_status: status });
}

/** WA_CHANNEL_UNAVAILABLE when the single channel is missing or `down` (08 §4.13, 09 §4.2). */
export async function assertChannelAvailable(tx: Tx, orgId: string): Promise<ChannelRow> {
  const ch = await activeChannel(tx, orgId);
  if (!ch || ch.health_status === 'down')
    throw new AppError('WA_CHANNEL_UNAVAILABLE', {
      health_status: ch?.health_status ?? 'down',
      since: iso(ch?.health_changed_at),
    });
  return ch;
}

/** A W-01 was already planned for the ticket's current link_version (key `wa:W-01:{ticket}:lv{n}`, 12 §5.2). */
async function w01PlannedFor(tx: Tx, t: Pick<TicketRow, 'id' | 'link_version'>): Promise<boolean> {
  const r = await tx.maybeOne(`SELECT 1 AS one FROM notifications WHERE dedupe_key = $1`, [
    `wa:W-01:${t.id}:lv${t.link_version}`,
  ]);
  return !!r;
}

/**
 * Direct link (12 §7.1, 11 §6.2 `→ pending_send`): the W-01 template must be approved; a live QR code of the
 * ticket gives way (`linked_direct`); when a W-01 was already planned for this link_version (a retry) the
 * version moves on so the new W-01 has its own key and the buttons of the earlier one stop working. The
 * caller checked channel, customer, consent and opt-out. Returns the ticket after the change; the event
 * `ticket.wa_link_changed {method: direct}` makes the NotificationPlanner plan W-01 (the sender issues the
 * action token when it builds the message, 12 §5.11).
 */
export async function startDirectLink(tx: Tx, t: TicketRow, m: { actor: EventActor }): Promise<TicketRow> {
  await assertTemplateApproved(tx, t.org_id, 'W-01');
  await tx.query(
    `UPDATE link_codes SET status = 'revoked', revoke_reason = 'linked_direct' WHERE ticket_id = $1 AND status = 'active'`,
    [t.id],
  );
  const bump = (await w01PlannedFor(tx, t)) ? 1 : 0;
  const after = await tx.one<TicketRow>(
    `UPDATE tickets SET wa_link_status = 'pending_send', link_version = link_version + $2, version = version + 1
      WHERE id = $1 RETURNING *`,
    [t.id, bump],
  );
  await recordWaLinkChange(tx, t.wa_link_status, after, { method: 'direct', actor: m.actor });
  return after;
}

/**
 * QR link code (12 §7.2 step 1, 11 §5.2): one live code per ticket — the previous active one is revoked
 * (`regenerated`) — from the unambiguous alphabet, valid `link.qr_ttl_min`, with its expiry timer. The link
 * status does not change: nothing happens until the customer's message arrives.
 */
export async function issueQrLinkCode(
  tx: Tx,
  t: TicketRow,
  m: { actorId: string; displayPhoneE164: string },
): Promise<LinkCodeQr> {
  const ttl = (await venueSettingsFor(tx, t.venue_id)).link.qr_ttl_min;
  await tx.query(
    `UPDATE link_codes SET status = 'revoked', revoke_reason = 'regenerated' WHERE ticket_id = $1 AND status = 'active'`,
    [t.id],
  );
  let row: LinkCodeRow | null = null;
  for (let i = 0; i < 8 && !row; i++) {
    // uq_link_codes_live_code: a value already live elsewhere draws again (08 §5.2)
    row = await tx.maybeOne<LinkCodeRow>(
      `INSERT INTO link_codes (org_id, ticket_id, code, status, created_by, created_at, expires_at)
       VALUES ($1, $2, $3, 'active', $4, $5, $5::timestamptz + make_interval(mins => $6))
       ON CONFLICT (code) WHERE status IN ('active','pending_confirmation') DO NOTHING RETURNING *`,
      [t.org_id, t.id, newLinkCode(), m.actorId, tx.now, ttl],
    );
  }
  if (!row) throw new Error('could not draw a free link code');
  await schedule(tx, 'job.link_code_expire', new Date(row.expires_at), {
    orgId: t.org_id,
    venueId: t.venue_id,
    dedupeKey: `link_expire:${row.id}`,
    aggregate: { type: 'link_code', id: row.id, version: null },
    payload: { link_code_id: row.id },
  });
  return linkCodeQr(row, m.displayPhoneE164);
}

export function linkCodeQr(row: LinkCodeRow, displayPhoneE164: string): LinkCodeQr {
  const link = waMeLink(displayPhoneE164, row.code);
  return {
    link_code_id: row.id,
    code: row.code,
    status: row.status,
    expires_at: iso(row.expires_at)!,
    wa_me_url: link.url,
    prefilled_text: link.prefilled_text,
    qr_text: link.url,
  };
}

/**
 * A text message carrying a live link code (12 §7.2 `handleLinkCode`, 11 §5.2 step 3): the code waits for the
 * driver (`pending_confirmation` with the sender's identifiers), the ticket shows «هل هذا العميل أمامك؟»
 * (`wa_link_status = pending_confirmation`, ticket.updated) and the customer gets W-11 «received». A used,
 * expired or unknown code — or a second sender of the same code (qr_race) — gets W-11 «invalid» and changes
 * nothing. A ticket linked meanwhile (its W-01 was accepted) keeps its link and the code is revoked.
 * Runs in the inbound transaction (customer row first, then L5 → L9).
 */
export async function receiveLinkCode(tx: Tx, ctx: LinkCodeContext): Promise<LinkCodeResult> {
  const invalid: LinkCodeResult = { result: 'invalid', ticket_id: null };
  const peek = await tx.maybeOne<{ id: string; ticket_id: string }>(
    `SELECT id, ticket_id FROM link_codes WHERE org_id = $1 AND code = $2 AND status IN ('active','pending_confirmation')`,
    [ctx.orgId, ctx.code],
  );
  if (!peek) return invalid;
  const [locked] = await lockTickets(tx, [peek.ticket_id]);
  const t = locked as TicketRow | undefined;
  const lc = await tx.maybeOne<LinkCodeRow>(`SELECT * FROM link_codes WHERE id = $1 FOR NO KEY UPDATE`, [
    peek.id,
  ]);
  if (!t || !lc || lc.status !== 'active' || new Date(lc.expires_at).getTime() <= tx.now.getTime())
    return invalid;
  if (isClosedTicket(t.status) || t.channel !== 'whatsapp') return invalid;
  if (t.wa_link_status === 'linked' || t.wa_link_status === 'pending_confirmation') {
    if (t.wa_link_status === 'linked')
      await tx.query(
        `UPDATE link_codes SET status = 'revoked', revoke_reason = 'linked_direct' WHERE id = $1`,
        [lc.id],
      );
    return invalid;
  }
  await tx.query(
    `UPDATE link_codes SET status = 'pending_confirmation', inbound_message_id = $2, inbound_wa_id = $3,
            inbound_user_id = $4, inbound_phone_e164 = $5
      WHERE id = $1`,
    [lc.id, ctx.inbound.id, ctx.sender.waId, ctx.sender.userId, ctx.sender.phoneE164],
  );
  await changeWaLinkStatus(tx, t, 'pending_confirmation', {
    method: 'qr',
    actor: { type: 'customer', id: ctx.customer.id },
    action: 'job.wa_process_inbound',
    metadata: { link_code_id: lc.id, inbound_message_id: ctx.inbound.id },
  });
  return { result: 'received', ticket_id: t.id };
}

/**
 * The driver's answer to «هل هذا العميل أمامك؟» (12 §7.2 step 6, 11 §5.2 step 4). `matches = true`: the
 * sender becomes the ticket's customer with a `customer_initiated` consent whose evidence is his message
 * (an opt-out is lifted: his own message resumes consent), the link is `linked` (link_version + 1 when a W-01
 * was already planned for the ticket or the customer changes, so no older button or key is reused) and the
 * code is consumed; the event plans W-01. `matches = false`: the code is revoked (`driver_rejected_match`)
 * and the link goes back to `none`; nothing is sent. The caller locked the ticket (L5) and the code (L9)
 * and checked its state.
 */
export async function confirmQrLink(
  tx: Tx,
  t: TicketRow,
  lc: LinkCodeRow,
  m: { matches: boolean; actorId: string },
): Promise<{ customerId: string | null; linkVersion: number }> {
  const actor: EventActor = { type: 'user', id: m.actorId };
  if (!m.matches) {
    await tx.query(
      `UPDATE link_codes SET status = 'revoked', revoke_reason = 'driver_rejected_match' WHERE id = $1`,
      [lc.id],
    );
    if (t.wa_link_status === 'pending_confirmation')
      await changeWaLinkStatus(tx, t, 'none', {
        method: 'qr_rejected',
        actor,
        action: 'wa.link',
        audit: false,
      });
    return { customerId: t.customer_id, linkVersion: t.link_version };
  }
  const msg = lc.inbound_message_id
    ? await tx.maybeOne<{ customer_id: string | null }>(
        `SELECT customer_id FROM whatsapp_messages WHERE id = $1`,
        [lc.inbound_message_id],
      )
    : null;
  const customerId = msg?.customer_id ?? null;
  if (!customerId)
    throw new AppError('INVALID_STATE_TRANSITION', { entity_type: 'link_code', reason: 'no_sender' });
  await tx.query(
    `INSERT INTO customer_consents (org_id, customer_id, ticket_id, channel, method, captured_by, captured_at, evidence_message_id)
     VALUES ($1, $2, $3, 'whatsapp', 'customer_initiated', $4, $5, $6)`,
    [t.org_id, customerId, t.id, m.actorId, tx.now, lc.inbound_message_id],
  );
  await tx.query(
    `UPDATE customers SET wa_opted_out_at = NULL WHERE id = $1 AND wa_opted_out_at IS NOT NULL`,
    [customerId],
  );
  const customerChanged = t.customer_id !== null && t.customer_id !== customerId;
  if (customerChanged) {
    // the verbal consent and any button belonged to the previous number (12 §7.4)
    await tx.query(
      `UPDATE customer_consents SET revoked_at = $3, revoke_source = 'staff'
        WHERE ticket_id = $1 AND customer_id <> $2 AND revoked_at IS NULL`,
      [t.id, customerId, tx.now],
    );
    await revokeActionTokens(tx, t.id);
  }
  const bump = customerChanged || (await w01PlannedFor(tx, t)) ? 1 : 0;
  const after = await tx.one<TicketRow>(
    `UPDATE tickets SET customer_id = $2, wa_link_status = 'linked', link_version = link_version + $3, version = version + 1
      WHERE id = $1 RETURNING *`,
    [t.id, customerId, bump],
  );
  await tx.query(
    `UPDATE link_codes SET status = 'consumed', confirmed_by = $2, confirmed_at = $3 WHERE id = $1`,
    [lc.id, m.actorId, tx.now],
  );
  await recordWaLinkChange(tx, t.wa_link_status, after, { method: 'qr', actor });
  return { customerId, linkVersion: after.link_version };
}

/**
 * «طلب السيارة» after an opt-out (12 §7.6, 11 §6.2 `opted_out → linked`): the press itself is the customer's
 * request for the service — `wa_opted_out_at` is cleared, a `customer_initiated` consent for this ticket is
 * recorded with the button message as evidence, and the ticket is linked again (`button_resume`, audited).
 * The ticket is locked (L5) by the caller.
 */
export async function resumeConsentByButton(
  tx: Tx,
  t: TicketRow,
  m: { customerId: string; inboundMessageId: string },
): Promise<TicketRow> {
  await tx.query(
    `UPDATE customers SET wa_opted_out_at = NULL WHERE id = $1 AND wa_opted_out_at IS NOT NULL`,
    [m.customerId],
  );
  await tx.query(
    `INSERT INTO customer_consents (org_id, customer_id, ticket_id, channel, method, captured_at, evidence_message_id)
     VALUES ($1, $2, $3, 'whatsapp', 'customer_initiated', $4, $5)`,
    [t.org_id, m.customerId, t.id, tx.now, m.inboundMessageId],
  );
  if (t.wa_link_status === 'opted_out')
    await changeWaLinkStatus(tx, t, 'linked', {
      method: 'button_resume',
      actor: { type: 'customer', id: m.customerId },
      action: 'job.wa_process_inbound',
      metadata: { effect: 'wa_consent_resumed', inbound_message_id: m.inboundMessageId },
    });
  return tx.one<TicketRow>(`SELECT * FROM tickets WHERE id = $1`, [t.id]);
}

/**
 * `job.link_code_expire` (11 §8.11): at `expires_at` an active or pending code becomes `expired`; a pending
 * confirmation that nobody answered sends the link back to `none` (12 §7.3); D-07 shows «انتهى الرمز». A
 * code consumed or revoked before is a no-op; an early timer reschedules itself.
 */
export const linkCodeExpireHandler: JobHandler = {
  type: 'job.link_code_expire',
  mode: 'tx',
  async handle({ row, tx }) {
    const id = row.payload?.link_code_id;
    if (typeof id !== 'string' || !tx) return;
    const peek = await tx.maybeOne<{ ticket_id: string; status: string }>(
      `SELECT ticket_id, status FROM link_codes WHERE id = $1`,
      [id],
    );
    if (!peek || (peek.status !== 'active' && peek.status !== 'pending_confirmation')) return;
    const [locked] = await lockTickets(tx, [peek.ticket_id]);
    const t = locked as TicketRow;
    const lc = await tx.one<LinkCodeRow>(`SELECT * FROM link_codes WHERE id = $1 FOR NO KEY UPDATE`, [id]);
    if (lc.status !== 'active' && lc.status !== 'pending_confirmation') return;
    if (new Date(lc.expires_at).getTime() > tx.now.getTime()) {
      await schedule(tx, 'job.link_code_expire', new Date(lc.expires_at), {
        orgId: lc.org_id,
        venueId: t.venue_id,
        dedupeKey: `link_expire:${lc.id}`,
        aggregate: { type: 'link_code', id: lc.id, version: null },
        payload: { link_code_id: lc.id },
      });
      return;
    }
    await tx.query(`UPDATE link_codes SET status = 'expired' WHERE id = $1`, [lc.id]);
    if (lc.status === 'pending_confirmation' && t.wa_link_status === 'pending_confirmation')
      await changeWaLinkStatus(tx, t, 'none', {
        method: 'qr',
        actor: { type: 'system', id: null },
        action: 'job.link_code_expire',
        metadata: { link_code_id: lc.id, reason: 'link_code_expired' },
      });
    else await publishTicketUpdated(tx, t.id, 'wa.link_code_expired');
  },
};
