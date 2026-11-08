import type { OperatorStatus } from '@point/shared';
import type { Tx } from '../db/tx.js';

/**
 * Seam between the modules whose commands change what a subscription may count on — the platform's operator
 * lifecycle (V2-005, `operators-service`), the operator's own venue status (`venues.service`, PATCH /v1/venues/{id})
 * and the customer's account deletion (C-20) — and the subscriptions module, which owns the subscription machine
 * (docs/v2/04 §1, V2-034; DEC-536). Lower modules never import the subscriptions module (04 §4.3): it fills this
 * seam when it loads (the DriverReleaseHook pattern), and every call runs in the caller's transaction after the
 * caller locked its own row (the organization, the venue, the account), so the change and its effect on the
 * subscriptions commit together. Without a registered module the calls do nothing (no subscription can exist).
 */
export interface SubscriptionLifecycleHook {
  /** organizations.operator_status moved from → to (suspend / reactivate / terminate / activate). */
  onOperatorStatusChanged(
    tx: Tx,
    args: { orgId: string; from: OperatorStatus; to: OperatorStatus; requestId: string | null },
  ): Promise<void>;
  /** venues.status moved from → to ('active' / 'inactive'). */
  onVenueStatusChanged(
    tx: Tx,
    args: { orgId: string; venueId: string; from: string; to: string; requestId: string | null },
  ): Promise<void>;
  /** The account is being deleted (C-20): its live subscriptions end with it, without a refund (04 §1). */
  onAccountDeleted(tx: Tx, args: { accountId: string; requestId: string | null }): Promise<number>;
}

let hook: SubscriptionLifecycleHook | null = null;

export function registerSubscriptionLifecycleHook(h: SubscriptionLifecycleHook | null): void {
  hook = h;
}

export const subscriptionLifecycle = {
  onOperatorStatusChanged: (
    tx: Tx,
    args: Parameters<SubscriptionLifecycleHook['onOperatorStatusChanged']>[1],
  ) => (hook ? hook.onOperatorStatusChanged(tx, args) : Promise.resolve()),
  onVenueStatusChanged: (tx: Tx, args: Parameters<SubscriptionLifecycleHook['onVenueStatusChanged']>[1]) =>
    hook ? hook.onVenueStatusChanged(tx, args) : Promise.resolve(),
  onAccountDeleted: (tx: Tx, args: Parameters<SubscriptionLifecycleHook['onAccountDeleted']>[1]) =>
    hook ? hook.onAccountDeleted(tx, args) : Promise.resolve(0),
};
