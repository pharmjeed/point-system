import { Injectable, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { requireDuty, type ActorContext } from '../../core/actor-context/actor-context.js';
import { lockTickets } from '../../core/db/locks.js';
import type { Tx } from '../../core/db/tx.js';
import { AppError } from '../../core/errors/app-error.js';
import { maskPhone } from '../../core/logging/redact.js';
import { normalizePhone } from '../../core/phone.js';
import { zodToFields } from '../../http/zod-pipe.js';
import {
  checkVersion,
  emitForTicket,
  findTicketInScope,
  invalidTransition,
  isClosedTicket,
  loadTicketDetail,
  ticketRef,
  type TicketRow,
} from '../../modules/tickets-custody/index.js';
import { recordWaLinkChange, revokeActionTokens, startDirectLink } from '../../modules/whatsapp/index.js';
import { registerCustomerLinkingHook, type CustomerLinkingHook } from '../hooks.js';
import { auditCommand, eventActor } from '../shared.js';

/**
 * SubmitIntake's direct WhatsApp link (PNT-043, 11 TT-03, 12 §7.1): the whatsapp LinkService moves the ticket
 * to `pending_send` (WA_TEMPLATE_NOT_APPROVED when the W-01 template is not approved) and emits
 * `ticket.wa_link_changed {method: direct}`; SubmitIntake then emits `ticket.intake_submitted` with
 * `pending_send` and the NotificationPlanner plans one W-01 (key `wa:W-01:{ticket}:lv{n}`).
 */
export const directLinkAtSubmit: CustomerLinkingHook = {
  async onIntakeSubmitted(tx, { ticket, actor }) {
    return startDirectLink(tx, ticket, { actor: eventActor(actor) });
  },
};

export function installCustomerLinking(): void {
  registerCustomerLinkingHook(directLinkAtSubmit);
}

export const ChangeCustomerPhoneBody = z.strictObject({
  expected_version: z.number().int().min(1),
  customer_phone: z.string().min(1).max(32),
  consent: z.strictObject({ method: z.literal('verbal_staff_confirmed'), confirmed: z.literal(true) }),
  reason: z.string().min(3).max(500),
});
export type ChangeCustomerPhoneBody = z.infer<typeof ChangeCustomerPhoneBody>;

/**
 * 08 §2 step 6 for `PATCH /customer-phone`: REASON_REQUIRED (reason missing or < 3), CONSENT_REQUIRED (the
 * «العميل أمامي» acknowledgement missing in the body, 08 §4.13), PHONE_INVALID, then VALIDATION_FAILED.
 */
@Injectable()
export class ChangeCustomerPhonePipe implements PipeTransform<unknown, ChangeCustomerPhoneBody> {
  transform(value: unknown): ChangeCustomerPhoneBody {
    const v = (value ?? {}) as Record<string, unknown>;
    if (typeof v.reason !== 'string' || v.reason.trim().length < 3)
      throw new AppError('REASON_REQUIRED', { field: 'reason', min_length: 3 });
    const consent = v.consent as Record<string, unknown> | undefined;
    if (!consent || consent.method !== 'verbal_staff_confirmed' || consent.confirmed !== true)
      throw new AppError('CONSENT_REQUIRED', { field: 'consent' });
    if (typeof v.customer_phone !== 'string' || !normalizePhone(v.customer_phone))
      throw new AppError('PHONE_INVALID', { field: 'customer_phone' });
    const r = ChangeCustomerPhoneBody.safeParse(v);
    if (!r.success) throw new AppError('VALIDATION_FAILED', { fields: zodToFields(r.error) });
    return r.data;
  }
}

const PHONE_OP = 'PATCH /v1/tickets/{ticketId}/customer-phone';
const AFTER_INTAKE = [
  'parking',
  'parked',
  'requested',
  'assigned',
  'assigned_waiting',
  'retrieving',
  'ready',
  'reparking',
];

/**
 * `PATCH /v1/tickets/{ticketId}/customer-phone` (PNT-049; 12 §7.4; 09 §4.2: a driver must be the creator or
 * the assignee of an open task, on duty in the venue). One transaction from L5: the new customer (created or
 * found by the normalized phone without locking it) with a new verbal consent, the old number's consent and
 * every action token of the ticket revoked, live link codes revoked, `link_version + 1` and `pending_send` —
 * W-01 goes to the new number (key `lv{n+1}`); the old number's buttons answer W-09 «غير نشطة» and its
 * pending notifications are skipped at send time (`stale`: the ticket's customer changed).
 */
@Injectable()
export class ChangeCustomerPhoneUseCase {
  async execute(
    tx: Tx,
    actor: ActorContext,
    ticketId: string,
    body: ChangeCustomerPhoneBody,
    requestId: string,
  ) {
    const pre = await findTicketInScope(tx, actor, ticketId);
    if (actor.role === 'driver') {
      const duty = requireDuty(actor);
      if (duty.venueId !== pre.venue_id) throw new AppError('DUTY_REQUIRED');
    }
    const [locked] = await lockTickets(tx, [ticketId]); // L5
    const t = locked as TicketRow;
    if (actor.role === 'driver' && t.created_by !== actor.userId) {
      const assignee = await tx.maybeOne(
        `SELECT 1 AS one FROM tasks WHERE ticket_id = $1 AND assignee_id = $2 AND status NOT IN ('completed','canceled')`,
        [t.id, actor.userId],
      );
      if (!assignee)
        throw new AppError('PERMISSION_DENIED', {
          permission: 'ticket.change_phone',
          reason: 'not_creator_or_assignee',
        });
    }
    if (isClosedTicket(t.status)) throw new AppError('TICKET_CLOSED', { ticket_status: t.status });
    checkVersion('ticket', t, body.expected_version);
    // the draft's number is edited with PATCH /intake; a paper ticket has no conversation to move
    if (t.status === 'received')
      throw invalidTransition('ticket', t, PHONE_OP, AFTER_INTAKE, 'draft_use_intake');
    if (t.channel !== 'whatsapp')
      throw invalidTransition('ticket', t, PHONE_OP, AFTER_INTAKE, 'paper_channel');

    const e164 = normalizePhone(body.customer_phone)!;
    const customer =
      (await tx.maybeOne<{ id: string; wa_opted_out_at: Date | null }>(
        `INSERT INTO customers (org_id, phone_e164, created_at, updated_at) VALUES ($1, $2, $3, $3)
         ON CONFLICT DO NOTHING RETURNING id, wa_opted_out_at`,
        [t.org_id, e164, tx.now],
      )) ??
      (await tx.one<{ id: string; wa_opted_out_at: Date | null }>(
        `SELECT id, wa_opted_out_at FROM customers WHERE org_id = $1 AND phone_e164 = $2`,
        [t.org_id, e164],
      ));
    if (customer.id === t.customer_id)
      throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'customer_phone', issue: 'unchanged' }] });
    // a customer who opted out comes back only on his own initiative (QR or his button, 12 §7.6)
    if (customer.wa_opted_out_at) throw new AppError('WA_CUSTOMER_OPTED_OUT');
    const previous = t.customer_id
      ? await tx.maybeOne<{ phone_e164: string | null }>(`SELECT phone_e164 FROM customers WHERE id = $1`, [
          t.customer_id,
        ])
      : null;

    await tx.query(
      `UPDATE customer_consents SET revoked_at = $2, revoke_source = 'staff' WHERE ticket_id = $1 AND revoked_at IS NULL`,
      [t.id, tx.now],
    );
    await tx.query(
      `INSERT INTO customer_consents (org_id, customer_id, ticket_id, channel, method, captured_by, captured_at)
       VALUES ($1, $2, $3, 'whatsapp', 'verbal_staff_confirmed', $4, $5)`,
      [t.org_id, customer.id, t.id, actor.userId, tx.now],
    );
    const revokedTokens = await revokeActionTokens(tx, t.id);
    await tx.query(
      `UPDATE link_codes SET status = 'revoked', revoke_reason = 'linked_direct'
        WHERE ticket_id = $1 AND status IN ('active','pending_confirmation')`,
      [t.id],
    );
    const after = await tx.one<TicketRow>(
      `UPDATE tickets SET customer_id = $2, link_version = link_version + 1, wa_link_status = 'pending_send',
              version = version + 1
        WHERE id = $1 RETURNING *`,
      [t.id, customer.id],
    );
    const ea = eventActor(actor);
    const reason = body.reason.trim();
    await emitForTicket(tx, after, {
      type: 'ticket.customer_phone_changed',
      actor: ea,
      payload: {
        ticket: ticketRef(after),
        changed_by: actor.userId,
        reason,
        link_version: after.link_version,
      },
    });
    await recordWaLinkChange(tx, t.wa_link_status, after, { method: 'phone_change', actor: ea });
    await auditCommand(tx, actor, {
      action: 'ticket.change_phone',
      operation: PHONE_OP,
      entityType: 'ticket',
      entityId: t.id,
      venueId: t.venue_id,
      requestId,
      reason,
      before: {
        phone_masked: maskPhone(previous?.phone_e164 ?? null),
        link_version: t.link_version,
        wa_link_status: t.wa_link_status,
      },
      after: {
        phone_masked: maskPhone(e164),
        link_version: after.link_version,
        wa_link_status: 'pending_send',
      },
      metadata: { customer_present_confirmed: true, revoked_action_tokens: revokedTokens },
    });
    return loadTicketDetail(tx, t.id, { userId: actor.userId, role: actor.role });
  }
}
