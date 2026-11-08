import type { Tx } from '../../../core/db/tx.js';
import type { OnlinePaymentRow } from './payment-sync.js';

/**
 * What a subscription payment's moves mean for its subscription (V2-031, docs/v2/04 §1; DEC-532, DEC-533). The
 * subscription is the subscriptions module's: this module never touches one itself; that module registers the hook
 * when it loads (the VisitPaymentHook pattern), and the payment's own transaction calls it — the payment row locked by
 * the caller, then the subscription row (FOR NO KEY UPDATE) in the hook.
 */
export interface SubscriptionPaymentHook {
  /** The payment counts for the first time (`paid`, or `partially_refunded` read at once). */
  afterPaid(tx: Tx, payment: OnlinePaymentRow): Promise<void>;
  /** The payment ended `failed` (declined, 3-D Secure failed, refused by the gateway). */
  afterFailed(tx: Tx, payment: OnlinePaymentRow): Promise<void>;
  /** A counting payment was refunded in full. */
  afterRefunded(tx: Tx, payment: OnlinePaymentRow): Promise<void>;
}

let hook: SubscriptionPaymentHook | null = null;

export function registerSubscriptionPaymentHook(h: SubscriptionPaymentHook | null): void {
  hook = h;
}

export function subscriptionPaymentHook(): SubscriptionPaymentHook | null {
  return hook;
}
