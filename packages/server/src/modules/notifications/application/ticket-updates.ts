import { rooms } from '@point/shared';
import type { Tx } from '../../../core/db/tx.js';
import { newId } from '../../../core/crypto/ids.js';
import { maskPhone } from '../../../core/logging/redact.js';
import { publishRealtime } from '../../../core/realtime/realtime-publisher.js';
import { isTicketCause, type TicketMessageRef } from '../domain/realtime-rules.js';

/** Something that runs a query (a Tx). */
interface Queryable {
  query: Tx['query'];
}

/** `TicketSummary` (07) as built by its owner module; `version` is the ticket version. */
export type TicketSummaryView = Record<string, unknown> & { id: string; version: number };

/**
 * The single TicketSummary builder (tickets-custody `loadTicketSummary`), wired by the use-cases layer
 * (04 §4.3: notifications does not import tickets-custody). Without it no `ticket.updated` is published.
 */
export type TicketSummaryProjection = (q: Queryable, ticketId: string) => Promise<TicketSummaryView | null>;

let projection: TicketSummaryProjection | null = null;

export function registerTicketSummaryProjection(p: TicketSummaryProjection | null): void {
  projection = p;
}

/**
 * Another audience of a ticket's coalesced update (V2-015, DEC-520: the customer's own socket), told once per ticket
 * and transaction, right before COMMIT, after the staff publications. Registered by its owner module (the
 * customer-accounts module publishes `visit.updated` to the account's room); it only writes rows and NOTIFYs.
 */
export type TicketUpdateListener = (tx: Tx, ticketId: string, cause: string) => Promise<void>;
const listeners = new Map<string, TicketUpdateListener>();

export function registerTicketUpdateListener(name: string, fn: TicketUpdateListener | null): void {
  if (fn) listeners.set(name, fn);
  else listeners.delete(name);
}

export interface TicketUpdateOptions {
  cause: string;
  actor?: { type: 'user' | 'customer' | 'system'; id: string | null };
  extraUserIds?: readonly string[];
  creator?: boolean;
  supervisorsOnly?: boolean;
  message?: TicketMessageRef | null;
}

interface Pending {
  ticketId: string;
  cause: string;
  actor: { type: 'user' | 'customer' | 'system'; id: string | null };
  extraUserIds: Set<string>;
  creator: boolean;
  supervisorsOnly: boolean;
  message: TicketMessageRef | null;
}

interface TxState {
  byTicket: Map<string, Pending>;
  scheduled: boolean;
}

const states = new WeakMap<Tx, TxState>();

/**
 * Asks for one `ticket.updated` of the ticket in this transaction (07 §4.3). Requests are coalesced per
 * ticket and published right before COMMIT from the final state (one projection, DEC-48), so a command that
 * emits several events for a ticket publishes it once: `cause` is the first `ticket.*` event (else the first
 * cause), the concerned drivers are the union.
 */
export function requestTicketUpdate(tx: Tx, ticketId: string, o: TicketUpdateOptions): Promise<void> {
  let s = states.get(tx);
  if (!s) {
    s = { byTicket: new Map(), scheduled: false };
    states.set(tx, s);
  }
  const cur = s.byTicket.get(ticketId);
  if (!cur) {
    s.byTicket.set(ticketId, {
      ticketId,
      cause: o.cause,
      actor: o.actor ?? { type: 'system', id: null },
      extraUserIds: new Set(o.extraUserIds ?? []),
      creator: o.creator ?? false,
      supervisorsOnly: o.supervisorsOnly ?? false,
      message: o.message ?? null,
    });
  } else {
    if (!isTicketCause(cur.cause) && isTicketCause(o.cause)) {
      cur.cause = o.cause;
      if (o.actor) cur.actor = o.actor;
    }
    for (const u of o.extraUserIds ?? []) cur.extraUserIds.add(u);
    cur.creator ||= o.creator ?? false;
    cur.supervisorsOnly &&= o.supervisorsOnly ?? false;
    if (o.message) cur.message = o.message;
  }
  if (!s.scheduled) {
    s.scheduled = true;
    const state = s;
    // a hook, not the planner round: updates asked during the command and by later planners all flush here
    tx.onBeforeCommit(async () => {
      state.scheduled = false;
      await flushTicketUpdates(tx, state);
    });
  }
  return Promise.resolve();
}

interface TicketTargets {
  org_id: string;
  venue_id: string;
  event_id: string;
  dispatch_pool_id: string;
  status: string;
  created_by: string;
  assignee_id: string | null;
}

/** W-01 and W-05 are the only message states a driver sees (09 §5.1). */
const DRIVER_MESSAGES = new Set(['W-01', 'W-05']);

async function flushTicketUpdates(tx: Tx, s: TxState): Promise<void> {
  const items = [...s.byTicket.values()];
  s.byTicket.clear();
  if (!projection) {
    for (const it of items) for (const fn of listeners.values()) await fn(tx, it.ticketId, it.cause);
    return;
  }
  for (const it of items) {
    for (const fn of listeners.values()) await fn(tx, it.ticketId, it.cause);
    const summary = await projection(tx, it.ticketId);
    if (!summary) continue;
    const t = await tx.maybeOne<TicketTargets>(
      `SELECT t.org_id, t.venue_id, t.event_id, t.dispatch_pool_id, t.status, t.created_by,
              (SELECT k.assignee_id FROM tasks k
                WHERE k.ticket_id = t.id AND k.status NOT IN ('completed','canceled') AND k.assignee_id IS NOT NULL
                ORDER BY k.created_at DESC LIMIT 1) AS assignee_id
         FROM tickets t WHERE t.id = $1`,
      [it.ticketId],
    );
    if (!t) continue;
    const link = await tx.maybeOne<{ id: string; inbound_phone_e164: string | null; received_at: Date }>(
      `SELECT l.id, l.inbound_phone_e164, COALESCE(m.received_at, m.created_at, l.created_at) AS received_at
         FROM link_codes l LEFT JOIN whatsapp_messages m ON m.id = l.inbound_message_id
        WHERE l.ticket_id = $1 AND l.status = 'pending_confirmation' LIMIT 1`,
      [it.ticketId],
    );
    const waLinkPending = link
      ? {
          link_code_id: link.id,
          inbound_phone_masked: maskPhone(link.inbound_phone_e164) ?? '',
          received_at: new Date(link.received_at).toISOString(),
        }
      : null;

    // drivers concerned: the creator during intake (or for creator events), the open task's assignee
    // (both may see the pending QR link, 09 §5.1), and the drivers the event names (summary only)
    const privileged = new Set<string>();
    if (it.creator || t.status === 'received' || t.status === 'parking') privileged.add(t.created_by);
    if (t.assignee_id) privileged.add(t.assignee_id);
    const others = new Set([...it.extraUserIds].filter((u) => !privileged.has(u)));
    const userIds = it.supervisorsOnly ? [] : [...privileged, ...others];
    // staff in scope read the supervisors variant from the venue room
    const staff = new Set(
      userIds.length
        ? (
            await tx.rows<{ id: string }>(
              `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND role <> 'driver'`,
              [userIds],
            )
          ).map((r) => r.id)
        : [],
    );

    const base = {
      venue_id: t.venue_id,
      dispatch_pool_id: t.dispatch_pool_id,
      event_id: t.event_id,
      aggregate: { type: 'ticket', id: it.ticketId, version: summary.version },
      actor: it.actor,
    };
    const publish = async (target: string[], data: Record<string, unknown>) => {
      if (!target.length) return;
      await publishRealtime(tx, t.org_id, target, { ...base, event: 'ticket.updated', id: newId(), data });
    };
    await publish([rooms.venueSupervisors(t.venue_id)], {
      ...summary,
      cause: it.cause,
      ...(waLinkPending ? { wa_link_pending: waLinkPending } : {}),
      ...(it.message ? { message: it.message } : {}),
    });
    const driverMessage = it.message && DRIVER_MESSAGES.has(it.message.purpose ?? '') ? it.message : null;
    await publish(
      [...privileged].filter((u) => !staff.has(u) && !it.supervisorsOnly).map((u) => rooms.user(u)),
      {
        ...summary,
        cause: it.cause,
        ...(waLinkPending ? { wa_link_pending: waLinkPending } : {}),
        ...(driverMessage ? { message: driverMessage } : {}),
      },
    );
    await publish(
      [...others].filter((u) => !staff.has(u) && !it.supervisorsOnly).map((u) => rooms.user(u)),
      { ...summary, cause: it.cause },
    );
  }
}
