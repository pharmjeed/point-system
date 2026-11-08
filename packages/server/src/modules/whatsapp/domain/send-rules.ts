import type {
  NotificationSkippedReason,
  TicketChannel,
  TicketStatus,
  W09Variant,
  WaLinkStatus,
  WaMessageId,
} from '@point/shared';

/** The 24 h customer service window (12 F-04), anchored on customers.last_inbound_at. */
export const SESSION_WINDOW_MS = 24 * 3600 * 1000;

export function sessionWindowOpen(lastInboundAt: Date | null, now: Date): boolean {
  return lastInboundAt !== null && now.getTime() - lastInboundAt.getTime() < SESSION_WINDOW_MS;
}

export interface SendFacts {
  now: Date;
  purpose: WaMessageId;
  kind: 'template' | 'session';
  customer: { id: string; optedOut: boolean; hasConsent: boolean; lastInboundAt: Date | null };
  ticket: {
    status: TicketStatus;
    channel: TicketChannel;
    /** tickets.customer_id: a message of the ticket never goes to a previous customer (phone change, 12 §7.4) */
    customerId: string | null;
    waLinkStatus: WaLinkStatus;
    linkVersion: number;
    activeCycleId: string | null;
    pendingRetrievalAt: Date | null;
  } | null;
  refs: {
    linkVersion?: number | null;
    cycleId?: string | null;
    claimCodeId?: string | null;
    variant?: string | null;
    early?: boolean | null;
  };
  /** the cycle named by the notification (refs.cycle_id) */
  cycle: {
    closedAt: Date | null;
    outcome: string | null;
    requestedEarly: boolean;
    newerExists: boolean;
  } | null;
  /** the ticket's active cycle (early W-02 converted to a cycle at `parked`, DEC-13) */
  activeCycle: { closedAt: Date | null; requestedEarly: boolean } | null;
  /** the task named by the notification (W-03) */
  task: { status: string } | null;
  claimCode: {
    consumedAt: Date | null;
    revokedAt: Date | null;
    expiresAt: Date;
    hasCiphertext: boolean;
  } | null;
}

const ADVANCED: ReadonlySet<TicketStatus> = new Set(['retrieving', 'ready', 'delivered']);
const isOpen = (s: TicketStatus) => s !== 'delivered' && s !== 'voided';

/** W-09 text for the ticket state at the press (14 §4); null = no status reply makes sense now. */
export function w09VariantFor(t: {
  status: TicketStatus;
  pendingRetrievalAt: Date | null;
}): W09Variant | null {
  if (t.status === 'voided') return 'inactive';
  if (t.pendingRetrievalAt && (t.status === 'received' || t.status === 'parking' || t.status === 'reparking'))
    return 'pending_early';
  switch (t.status) {
    case 'requested':
    case 'assigned':
    case 'assigned_waiting':
    case 'retrieving':
    case 'ready':
    case 'delivered':
      return t.status;
    default:
      return null;
  }
}

function ticketMessage(f: SendFacts): NotificationSkippedReason | null {
  const t = f.ticket!;
  switch (f.purpose) {
    case 'W-02': {
      if (ADVANCED.has(t.status)) return 'superseded';
      if (f.refs.early) {
        const stillPending =
          t.pendingRetrievalAt !== null || (f.activeCycle?.closedAt === null && f.activeCycle.requestedEarly);
        return stillPending ? null : 'superseded';
      }
      return f.cycle && f.cycle.closedAt === null ? null : 'superseded';
    }
    case 'W-03':
      return f.task?.status === 'assigned_waiting' ? null : 'superseded';
    case 'W-04':
      if (t.status === 'retrieving' && (!f.refs.cycleId || t.activeCycleId === f.refs.cycleId)) return null;
      return t.status === 'ready' || t.status === 'delivered' ? 'superseded' : 'stale';
    case 'W-05': {
      // never skipped while the ticket is ready and the code is live (12 §5.5)
      const c = f.claimCode;
      if (!c) return 'stale';
      if (c.consumedAt || c.revokedAt) return 'superseded';
      if (c.expiresAt.getTime() <= f.now.getTime() || !c.hasCiphertext) return 'stale';
      if (t.status !== 'ready') return t.status === 'delivered' ? 'superseded' : 'stale';
      return null;
    }
    case 'W-06':
      return t.status === 'delivered' ? null : 'stale';
    case 'W-07':
      return f.cycle?.closedAt && f.cycle.outcome === 'canceled' && !f.cycle.newerExists
        ? null
        : 'superseded';
    case 'W-08':
      return (t.status === 'reparking' || t.status === 'parked') && !f.cycle?.newerExists
        ? null
        : 'superseded';
    default:
      return null;
  }
}

/**
 * Send-time checks (12 §5.4–§5.5, 11 §6.9): the state is read fresh right before each attempt; a
 * message that no longer reflects reality is skipped. W-12 is the only message sent after an opt-out;
 * W-09 … W-12 need no consent (they answer the customer) but need the service window.
 */
export function sendTimeSkipReason(f: SendFacts): NotificationSkippedReason | null {
  if (f.customer.optedOut && f.purpose !== 'W-12') return 'opted_out';
  if (f.kind === 'template' && !f.customer.hasConsent) return 'no_consent';
  if (f.kind === 'session' && !sessionWindowOpen(f.customer.lastInboundAt, f.now)) return 'stale';
  const t = f.ticket;
  switch (f.purpose) {
    case 'W-01':
      if (!t || t.channel !== 'whatsapp' || !isOpen(t.status)) return 'stale';
      if (t.customerId !== f.customer.id) return 'stale';
      if (f.refs.linkVersion != null && f.refs.linkVersion !== t.linkVersion) return 'stale';
      if (t.waLinkStatus === 'opted_out') return 'opted_out';
      return t.waLinkStatus === 'pending_send' || t.waLinkStatus === 'linked' ? null : 'stale';
    case 'W-02':
    case 'W-03':
    case 'W-04':
    case 'W-05':
    case 'W-06':
    case 'W-07':
    case 'W-08':
      if (!t || t.channel !== 'whatsapp' || t.customerId !== f.customer.id) return 'stale';
      if (t.waLinkStatus === 'opted_out') return 'opted_out';
      if (t.waLinkStatus !== 'linked') return 'stale';
      return ticketMessage(f);
    case 'W-09':
      if (f.refs.variant === 'inactive') return null;
      return t && w09VariantFor(t) ? null : 'stale';
    default:
      return null;
  }
}
