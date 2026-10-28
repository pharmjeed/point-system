import type { WaMessageId } from '@point/shared';

/** The parts of a canon §7.1 envelope the rules read. */
export interface PlannerEvent {
  id: string;
  type: string;
  org_id: string;
  venue_id: string | null;
  payload: Record<string, any>;
  /** the envelope's aggregate (staff push keys use the task version) */
  aggregate?: { type: string; id: string; version: number | null };
  dispatch_pool_id?: string | null;
  event_id?: string | null;
  occurred_at?: string;
  actor?: { type: 'user' | 'customer' | 'system'; id: string | null };
}

/** Refs carried by `job.wa_send` (WaSendJobPayloadSchema): ids and flags only, never phones or codes. */
export interface CustomerMessageRefs {
  cycle_id?: string;
  claim_code_id?: string;
  link_version?: number;
  variant?: string;
  inbound_message_id?: string;
  early?: boolean;
}

/**
 * What the database must confirm before the notification is created:
 * - `ticket_whatsapp`: a WhatsApp ticket with a customer whose link is pending_send, linked or opted_out
 *   (the sender re-checks «linked», consent and opt-out at send time, 12 §5.4–§5.5);
 * - `w01`: a WhatsApp ticket whose link is pending_send or linked; the key needs tickets.link_version;
 * - `cycle_informed`: `ticket_whatsapp` + a W-02 was created for the cycle or its early request (W-07);
 * - `status_reply_throttle`: W-09 once per wa.status_reply_throttle_s per ticket;
 * - `guidance_throttle`: W-10 once per wa.guidance_reply_throttle_min per sender.
 */
export type IntentCondition =
  'ticket_whatsapp' | 'w01' | 'cycle_informed' | 'status_reply_throttle' | 'guidance_throttle' | 'none';

export interface CustomerMessageIntent {
  purpose: WaMessageId;
  /** the ticket the message is about (null for W-10 / W-12 and an invalid link code) */
  ticketId: string | null;
  /** explicit recipient for replies; null = tickets.customer_id */
  customerId: string | null;
  /** 12 §5.2 key; null for W-01 from intake (the key needs tickets.link_version) */
  dedupeKey: string | null;
  taskId: string | null;
  refs: CustomerMessageRefs;
  condition: IntentCondition;
}

const epochSeconds = (iso: unknown): number | null => {
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

const INACTIVE_BUTTON = new Set(['stale_link_version', 'expired', 'revoked']);

/**
 * The «العميل» column of 14 §3.1 / 12 §5.2 as a pure function of one domain event. The NotificationPlanner
 * applies the database conditions and writes the notification + `job.wa_send` in the same transaction
 * (DEC-41). Paper tickets never reach a message: every ticket rule requires a WhatsApp ticket.
 */
export function customerMessageIntents(ev: PlannerEvent): CustomerMessageIntent[] {
  const p = ev.payload ?? {};
  const ticketId = str(p.ticket?.ticket_id) ?? str(p.ticket_id);
  const intent = (
    purpose: WaMessageId,
    dedupeKey: string | null,
    refs: CustomerMessageRefs,
    condition: IntentCondition,
    extra: Partial<Pick<CustomerMessageIntent, 'ticketId' | 'customerId' | 'taskId'>> = {},
  ): CustomerMessageIntent => ({
    purpose,
    ticketId: extra.ticketId !== undefined ? extra.ticketId : ticketId,
    customerId: extra.customerId ?? null,
    dedupeKey,
    taskId: extra.taskId ?? null,
    refs,
    condition,
  });
  const cycleId = str(p.cycle_id);

  switch (ev.type) {
    // W-01 — the ticket message with the single «طلب السيارة» button (once per link_version)
    case 'ticket.intake_submitted':
      if (!ticketId || p.channel !== 'whatsapp' || p.wa_link_status !== 'pending_send') return [];
      return [intent('W-01', null, {}, 'w01')];
    case 'ticket.wa_link_changed': {
      const lv = typeof p.link_version === 'number' ? p.link_version : null;
      if (!ticketId || lv === null) return [];
      if (p.to === 'pending_send' || (p.to === 'linked' && p.method === 'qr'))
        return [intent('W-01', `wa:W-01:${ticketId}:lv${lv}`, { link_version: lv }, 'w01')];
      return [];
    }

    // W-02 — request registered (early request while parking, DEC-13; or a new cycle that was not early)
    case 'ticket.retrieval_requested_early': {
      const epoch = epochSeconds(p.pending_retrieval_at);
      if (!ticketId || epoch === null) return [];
      return [intent('W-02', `wa:W-02:early:${ticketId}:${epoch}`, { early: true }, 'ticket_whatsapp')];
    }
    case 'ticket.retrieval_requested':
      if (!ticketId || !cycleId || p.requested_early === true) return [];
      return [intent('W-02', `wa:W-02:${cycleId}`, { cycle_id: cycleId }, 'ticket_whatsapp')];

    // W-03 … W-06 — one per cycle (W-05 one per code)
    case 'ticket.assigned_waiting':
      if (!ticketId || !cycleId) return [];
      return [
        intent('W-03', `wa:W-03:${cycleId}`, { cycle_id: cycleId }, 'ticket_whatsapp', {
          taskId: str(p.task_id),
        }),
      ];
    case 'ticket.retrieving':
      if (!ticketId || !cycleId) return [];
      return [intent('W-04', `wa:W-04:${cycleId}`, { cycle_id: cycleId }, 'ticket_whatsapp')];
    case 'handover.code_issued': {
      const claimCodeId = str(p.claim_code_id);
      if (!ticketId || !claimCodeId) return [];
      return [
        intent(
          'W-05',
          `wa:W-05:${claimCodeId}`,
          { claim_code_id: claimCodeId, ...(cycleId ? { cycle_id: cycleId } : {}) },
          'ticket_whatsapp',
        ),
      ];
    }
    case 'ticket.delivered':
      if (!ticketId || !cycleId) return [];
      return [intent('W-06', `wa:W-06:${ticketId}:${cycleId}`, { cycle_id: cycleId }, 'ticket_whatsapp')];

    // W-07 — canceled in the field, only if the customer was told about the request (DEC-30)
    case 'ticket.retrieval_canceled':
      if (!ticketId || !cycleId) return [];
      return [intent('W-07', `wa:W-07:${cycleId}`, { cycle_id: cycleId }, 'cycle_informed')];

    // W-08 — back to parking because the customer did not come (DEC-42); supervisor_cancel sends nothing
    case 'ticket.reparking': {
      const closed = str(p.closed_cycle_id);
      if (!ticketId || !closed || p.cause !== 'customer_absent') return [];
      return [intent('W-08', `wa:W-08:${closed}`, { cycle_id: closed }, 'ticket_whatsapp')];
    }

    // W-09 / W-10 — answers to «طلب السيارة» (14 §3.6)
    case 'wa.button_pressed': {
      const inbound = str(p.whatsapp_message_id);
      const customerId = str(p.customer_id);
      if (!inbound || !customerId) return [];
      if (p.outcome === 'status_reply')
        return [
          intent(
            'W-09',
            `wa:W-09:${inbound}`,
            { variant: 'status', inbound_message_id: inbound },
            'status_reply_throttle',
            {
              ticketId: str(p.ticket_id),
              customerId,
            },
          ),
        ];
      if (p.outcome !== 'rejected') return []; // request_created / early_request → W-02 from the ticket event
      if (INACTIVE_BUTTON.has(p.reject_reason))
        return [
          intent(
            'W-09',
            `wa:W-09:${inbound}`,
            { variant: 'inactive', inbound_message_id: inbound },
            'status_reply_throttle',
            {
              ticketId: str(p.ticket_id),
              customerId,
            },
          ),
        ];
      // unknown token or another sender: guidance without any ticket data
      return [
        intent('W-10', `wa:W-10:${inbound}`, { inbound_message_id: inbound }, 'guidance_throttle', {
          ticketId: null,
          customerId,
        }),
      ];
    }

    // W-10 / W-11 — free text, link code (the stop word is answered by W-12)
    case 'wa.inbound_received': {
      const inbound = str(p.whatsapp_message_id);
      const customerId = str(p.customer_id);
      if (!inbound || !customerId) return [];
      if (p.matched === 'link_code') {
        const received = p.link_result === 'received';
        return [
          intent(
            'W-11',
            `wa:W-11:${inbound}`,
            { variant: received ? 'received' : 'invalid', inbound_message_id: inbound },
            'none',
            { ticketId: received ? str(p.ticket_id) : null, customerId },
          ),
        ];
      }
      // other types (image, audio, location…) get the guidance too; reactions are never answered (12 §6.7)
      const guidance =
        p.kind === 'inbound_text' || (p.kind === 'inbound_other' && p.message_type !== 'reaction');
      if (p.matched === 'none' && guidance)
        return [
          intent('W-10', `wa:W-10:${inbound}`, { inbound_message_id: inbound }, 'guidance_throttle', {
            ticketId: null,
            customerId,
          }),
        ];
      return []; // buttons are answered from wa.button_pressed, the stop word from wa.customer_opted_out
    }

    // W-12 — opt-out confirmation, sent even after the opt-out
    case 'wa.customer_opted_out': {
      const customerId = str(p.customer_id);
      const epoch = epochSeconds(p.opted_out_at);
      if (!customerId || epoch === null) return [];
      const inbound = str(p.inbound_message_id);
      return [
        intent(
          'W-12',
          `wa:W-12:${customerId}:${epoch}`,
          inbound ? { inbound_message_id: inbound } : {},
          'none',
          {
            ticketId: null,
            customerId,
          },
        ),
      ];
    }
    default:
      return [];
  }
}
