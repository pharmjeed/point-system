import { CUSTOMER_ACCOUNT_TRANSITIONS } from '@shared/platform-console';
import type { PlatformMe } from '@/api/platform';
import type {
  CustomerCommand,
  CustomerStatus,
  OnlinePaymentStatus,
  PaymentFilters,
  PlatformPaymentDetail,
} from '@/api/platformConsole';
import { normalizeSaudiMobile } from '@/lib/phone';
import { isCalendarDate, platformCan, sarToHalalas, type ChipTone } from './platformModel';

/**
 * Pure rules of P-06 and P-08 (V2-024): what to offer and how to read a form before it is sent. The server decides
 * (permissions, transitions, the refundable amount) and these only mirror it.
 */

const COMMANDS: CustomerCommand[] = ['suspend', 'reactivate', 'revoke_sessions'];

/** The account commands offered on P-06: `platform.customer_manage` and a status that allows them (DEC-527). */
export function customerCommands(me: PlatformMe, status: CustomerStatus): CustomerCommand[] {
  if (!platformCan(me, 'platform.customer_manage')) return [];
  return COMMANDS.filter((c) => (CUSTOMER_ACCOUNT_TRANSITIONS[c].from as readonly string[]).includes(status));
}

export const customerCommandIsDestructive = (c: CustomerCommand) => c !== 'reactivate';

export const CUSTOMER_TONE: Record<CustomerStatus, ChipTone> = {
  active: 'success',
  suspended: 'warning',
  deleted: 'neutral',
};

export const PAYMENT_TONE: Record<OnlinePaymentStatus, ChipTone> = {
  initiated: 'info',
  authorized: 'info',
  paid: 'success',
  failed: 'danger',
  partially_refunded: 'warning',
  refunded: 'neutral',
};

/**
 * The phone search of P-06: an exact Saudi mobile only (the server normalizes again, PHONE_INVALID); a blank field
 * lists the newest accounts.
 */
export function phoneQuery(input: string): { ok: true; phone: string | null } | { ok: false } {
  if (!input.trim()) return { ok: true, phone: null };
  const phone = normalizeSaudiMobile(input);
  return phone ? { ok: true, phone } : { ok: false };
}

/** The refund of P-08 is offered with `platform.refund_issue` while something is left to refund (DEC-513). */
export const canRefund = (me: PlatformMe, p: Pick<PlatformPaymentDetail, 'refundable_halalas'>) =>
  platformCan(me, 'platform.refund_issue') && p.refundable_halalas > 0;

/**
 * The refund amount field (riyals, two decimals): blank = everything still refundable (the server's default),
 * otherwise 0.01 … the refundable amount.
 */
export function refundAmount(
  input: string,
  refundable: number,
): { ok: true; halalas: number | undefined } | { ok: false } {
  if (!input.trim()) return { ok: true, halalas: undefined };
  const h = sarToHalalas(input);
  if (h === null || h <= 0 || h > refundable) return { ok: false };
  return { ok: true, halalas: h };
}

export interface PaymentFilterForm {
  status: OnlinePaymentStatus | '';
  purpose: 'visit' | 'subscription' | '';
  from: string;
  to: string;
}

export const BLANK_PAYMENT_FILTERS: PaymentFilterForm = { status: '', purpose: '', from: '', to: '' };

/** The P-08 filter form → the query (Riyadh days, inclusive); a backwards range is refused before it is sent. */
export function paymentFilters(
  f: PaymentFilterForm,
  extra: Pick<PaymentFilters, 'org_id' | 'venue_id' | 'account_id'> = {},
): { ok: true; filters: PaymentFilters } | { ok: false; issue: 'date' | 'range' } {
  const from = f.from.trim();
  const to = f.to.trim();
  if ((from && !isCalendarDate(from)) || (to && !isCalendarDate(to))) return { ok: false, issue: 'date' };
  if (from && to && from > to) return { ok: false, issue: 'range' };
  return {
    ok: true,
    filters: {
      ...(f.status ? { status: f.status } : {}),
      ...(f.purpose ? { purpose: f.purpose } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...extra,
    },
  };
}

/** One merged, oldest-first timeline of a payment: status changes, gateway deliveries and refunds. */
export type TimelineEntry =
  | { kind: 'status'; at: string; action: string; to: string | null }
  | {
      kind: 'webhook';
      at: string;
      type: string;
      outcome: string | null;
      claimed: PlatformPaymentDetail['webhook_events'][number]['claimed'];
    }
  | { kind: 'refund'; at: string; refund: PlatformPaymentDetail['refunds'][number] };

export function paymentTimeline(p: PlatformPaymentDetail): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...p.status_history.map((h) => ({
      kind: 'status' as const,
      at: h.occurred_at,
      action: h.action,
      to: h.to_status,
    })),
    ...p.webhook_events.map((e) => ({
      kind: 'webhook' as const,
      at: e.received_at,
      type: e.event_type,
      outcome: e.processed_at ? e.outcome : null,
      claimed: e.claimed,
    })),
    ...p.refunds.map((r) => ({ kind: 'refund' as const, at: r.created_at, refund: r })),
  ];
  return entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
