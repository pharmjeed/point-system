import type { OnlinePaymentStatus } from '@point/shared';
import type { GatewayPayment } from './gateway.js';

/** Where a status sits in the machine of docs/v2/04 §3 (paid and failed are the two ends of the charge). */
const RANK: Record<OnlinePaymentStatus, number> = {
  initiated: 0,
  authorized: 1,
  paid: 2,
  failed: 2,
  partially_refunded: 3,
  refunded: 4,
};

/** The moves the machine allows (DEC-512); everything else is ignored as stale or raised as a conflict. */
const NEXT: Record<OnlinePaymentStatus, readonly OnlinePaymentStatus[]> = {
  initiated: ['authorized', 'paid', 'failed', 'partially_refunded', 'refunded'],
  authorized: ['paid', 'failed', 'partially_refunded', 'refunded'],
  paid: ['partially_refunded', 'refunded'],
  partially_refunded: ['refunded'],
  failed: [],
  refunded: [],
};

export interface LocalPaymentState {
  status: OnlinePaymentStatus;
  amount_halalas: number;
  refunded_halalas: number;
  currency: string;
}

export type SyncDecision =
  | { kind: 'apply'; status: OnlinePaymentStatus; refunded: number }
  | { kind: 'unchanged' }
  | { kind: 'conflict'; reason: 'amount' | 'currency' | 'status'; gatewayStatus: string };

/**
 * What the gateway's record means for our row (DEC-512). The gateway is the source of truth about money, but the
 * machine only moves forward: an older read (out-of-order delivery, a stale page) changes nothing, and a record that
 * contradicts us — another amount, a failed payment the gateway calls paid — is a conflict for finance, never
 * applied silently. A partial refund keeps the gateway's payment `paid` with `refunded` > 0: it is our
 * `partially_refunded`. A void after the charge gives the money back: `refunded` of the whole amount; a void
 * before it is a payment that never happened: `failed`.
 */
export function decideSync(local: LocalPaymentState, gp: GatewayPayment): SyncDecision {
  if (gp.currency.toUpperCase() !== local.currency)
    return { kind: 'conflict', reason: 'currency', gatewayStatus: gp.status };
  if (gp.amount !== local.amount_halalas)
    return { kind: 'conflict', reason: 'amount', gatewayStatus: gp.status };
  const target = targetOf(local, gp);
  if (!target) return { kind: 'unchanged' };
  const refunded = Math.max(local.refunded_halalas, target.refunded);
  const status = refundedStatus(target.status, refunded, local.amount_halalas);
  if (status === local.status) {
    return refunded > local.refunded_halalas ? { kind: 'apply', status, refunded } : { kind: 'unchanged' };
  }
  if (NEXT[local.status].includes(status)) return { kind: 'apply', status, refunded };
  // a later read can never move back; a paid/failed contradiction is not "later", it is a conflict
  if (RANK[status] < RANK[local.status] || (local.status === 'paid' && status === 'authorized'))
    return { kind: 'unchanged' };
  return { kind: 'conflict', reason: 'status', gatewayStatus: gp.status };
}

function targetOf(
  local: LocalPaymentState,
  gp: GatewayPayment,
): { status: OnlinePaymentStatus; refunded: number } | null {
  const refunded = Math.max(0, Math.min(gp.refunded, local.amount_halalas));
  switch (gp.status) {
    case 'initiated':
      return { status: 'initiated', refunded: 0 };
    case 'authorized':
      return { status: 'authorized', refunded: 0 };
    case 'paid':
    case 'captured':
      return { status: 'paid', refunded };
    case 'refunded':
      return { status: 'refunded', refunded: refunded || local.amount_halalas };
    case 'voided':
      return RANK[local.status] >= RANK.paid && local.status !== 'failed'
        ? { status: 'refunded', refunded: local.amount_halalas }
        : { status: 'failed', refunded: 0 };
    case 'failed':
      return { status: 'failed', refunded: 0 };
    default:
      // verified (a card check), abandoned and unknown statuses say nothing about the money
      return null;
  }
}

function refundedStatus(status: OnlinePaymentStatus, refunded: number, amount: number): OnlinePaymentStatus {
  if (status !== 'paid' && status !== 'partially_refunded' && status !== 'refunded') return status;
  if (refunded <= 0) return 'paid';
  return refunded >= amount ? 'refunded' : 'partially_refunded';
}

/** Our status for a gateway record alone (reconciliation's comparison), or null when it says nothing. */
export function localStatusOf(gp: GatewayPayment, amount: number): OnlinePaymentStatus | null {
  const t = targetOf({ status: 'paid', amount_halalas: amount, refunded_halalas: 0, currency: 'SAR' }, gp);
  return t ? refundedStatus(t.status, t.refunded, amount) : null;
}
