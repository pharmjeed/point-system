import type { WaLinkStatus } from '@point/shared';
import type { EventEnvelope, Tx } from '../../../core/db/tx.js';
import { orgSettings } from '../../../core/settings/settings-service.js';
import { customerMessageIntents, type CustomerMessageIntent } from '../domain/customer-rules.js';
import type { NotificationRule, PlannedNotification } from './planner.js';

/**
 * Outbox attempts of a `job.wa_send` row. Waiting (ordering gate, recipient bucket, channel down) gives
 * its attempt back; provider attempts are bounded by `wa.send_max_attempts` on the notification, so this
 * only stops a job that keeps crashing.
 */
export const WA_SEND_JOB_MAX_ATTEMPTS = 50;

/** 12 §5.2 «مربوطة» is re-checked at send time; planning also keeps opted-out tickets (a `skipped` trace). */
const PLANNABLE_LINKS: ReadonlySet<WaLinkStatus> = new Set(['pending_send', 'linked', 'opted_out']);

interface TicketLink {
  id: string;
  org_id: string;
  venue_id: string;
  channel: string;
  customer_id: string | null;
  wa_link_status: WaLinkStatus;
  link_version: number;
}

const plannable = (t: TicketLink | null): t is TicketLink =>
  !!t && t.channel === 'whatsapp' && !!t.customer_id && PLANNABLE_LINKS.has(t.wa_link_status);

/** A W-02 was created for the cycle or for its early request (DEC-13, DEC-30): only then W-07. */
async function customerInformedOfCycle(tx: Tx, ticketId: string, cycleId: string): Promise<boolean> {
  const c = await tx.maybeOne<{ requested_at: Date; requested_early: boolean }>(
    `SELECT requested_at, requested_early FROM retrieval_cycles WHERE id = $1 AND ticket_id = $2`,
    [cycleId, ticketId],
  );
  if (!c) return false;
  const keys = [`wa:W-02:${cycleId}`];
  if (c.requested_early)
    keys.push(`wa:W-02:early:${ticketId}:${Math.floor(new Date(c.requested_at).getTime() / 1000)}`);
  const r = await tx.maybeOne(
    `SELECT 1 AS one FROM notifications WHERE dedupe_key = ANY($1::text[]) LIMIT 1`,
    [keys],
  );
  return !!r;
}

/**
 * Throttled replies (14 §10): a reply of `purpose` was already created for an earlier inbound message of
 * the same ticket (W-09) or sender (W-10) inside the window. Inbound rows are found through their
 * ticket/customer indexes, the replies through their unique dedupe keys (`wa:W-0x:{inbound_message_id}`).
 */
async function recentlyAnswered(
  tx: Tx,
  purpose: 'W-09' | 'W-10',
  by: { ticketId: string } | { customerId: string },
  currentInboundId: string,
  windowMs: number,
): Promise<boolean> {
  const since = new Date(tx.now.getTime() - windowMs);
  const column = 'ticketId' in by ? 'ticket_id' : 'customer_id';
  const value = 'ticketId' in by ? by.ticketId : by.customerId;
  const r = await tx.maybeOne(
    `SELECT 1 AS one FROM whatsapp_messages m
       JOIN notifications n ON n.dedupe_key = $2 || m.id::text
      WHERE m.${column} = $1 AND m.direction = 'inbound' AND m.created_at > $3 AND m.id <> $4
        AND n.created_at > $3
      LIMIT 1`,
    [value, `wa:${purpose}:`, since, currentInboundId],
  );
  return !!r;
}

async function resolve(
  tx: Tx,
  ev: EventEnvelope,
  i: CustomerMessageIntent,
): Promise<PlannedNotification | null> {
  const ticket = i.ticketId
    ? await tx.maybeOne<TicketLink>(
        `SELECT id, org_id, venue_id, channel, customer_id, wa_link_status, link_version FROM tickets WHERE id = $1`,
        [i.ticketId],
      )
    : null;
  if (i.ticketId && !ticket) return null;
  const refs = { ...i.refs };
  let dedupeKey = i.dedupeKey;
  switch (i.condition) {
    case 'w01': {
      if (!ticket || ticket.channel !== 'whatsapp' || !ticket.customer_id) return null;
      if (ticket.wa_link_status !== 'pending_send' && ticket.wa_link_status !== 'linked') return null;
      const lv = refs.link_version ?? ticket.link_version;
      refs.link_version = lv;
      dedupeKey ??= `wa:W-01:${ticket.id}:lv${lv}`;
      break;
    }
    case 'ticket_whatsapp':
      if (!plannable(ticket)) return null;
      break;
    case 'cycle_informed':
      if (!plannable(ticket) || !refs.cycle_id) return null;
      if (!(await customerInformedOfCycle(tx, ticket.id, refs.cycle_id))) return null;
      break;
    case 'status_reply_throttle':
    case 'guidance_throttle': {
      const s = (await orgSettings(tx, ev.org_id)).wa;
      const purpose = i.condition === 'status_reply_throttle' ? 'W-09' : 'W-10';
      const windowMs =
        purpose === 'W-09' ? s.status_reply_throttle_s * 1000 : s.guidance_reply_throttle_min * 60_000;
      const by = purpose === 'W-09' && ticket ? { ticketId: ticket.id } : { customerId: i.customerId! };
      if (await recentlyAnswered(tx, purpose, by, refs.inbound_message_id!, windowMs)) return null;
      break;
    }
    case 'none':
      break;
  }
  const recipient = i.customerId ?? ticket?.customer_id ?? null;
  if (!recipient || !dedupeKey) return null;
  return {
    channel: 'whatsapp',
    purpose: i.purpose,
    orgId: ev.org_id,
    venueId: ticket?.venue_id ?? null,
    ticketId: ticket?.id ?? null,
    taskId: i.taskId,
    recipientCustomerId: recipient,
    recipientUserId: null,
    recipientDeviceId: null,
    dedupeKey,
    sourceEventId: ev.id,
    job: {
      type: 'job.wa_send',
      // DEC-41: one ordering key per ticket; replies without a ticket are not ordered
      orderingKey: ticket ? `wa:${ticket.id}` : null,
      payload: refs as Record<string, unknown>,
      maxAttempts: WA_SEND_JOB_MAX_ATTEMPTS,
    },
  };
}

/** The customer column of 14 §3.1 (12 §5.2): notifications + `job.wa_send` for the customer channel. */
export const whatsappCustomerRule: NotificationRule = {
  name: 'whatsapp-customer',
  async plan(tx, ev) {
    const intents = customerMessageIntents(ev);
    const out: PlannedNotification[] = [];
    for (const i of intents) {
      const planned = await resolve(tx, ev, i);
      if (planned) out.push(planned);
    }
    return out;
  },
};
