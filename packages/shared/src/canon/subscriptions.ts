/**
 * V2 subscriptions (docs/v2/04 §1–§2, docs/v2/03 §4; V2-030 … V2-035, DEC-531 … DEC-539): the plans POINT sells per
 * venue (P-05), the customer's subscription and its state machine, the paid periods, and the rules of renewal, grace,
 * freezing and the entitlement at intake. Amounts are halalas, VAT included (04 §4). Times are instants (UTC); the
 * calendar of a period is the one of Asia/Riyadh (no daylight saving: UTC+3 all year).
 */
import { z } from 'zod';

/** `subscriptions.status` (03 §4, `ck_subscriptions_status`), in the order of 04 §1. */
export const SUBSCRIPTION_STATUSES = [
  'pending_payment',
  'active',
  'past_due',
  'canceled',
  'expired',
  'frozen',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
export const SubscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES);

/** The live statuses: one live subscription per account and venue (`uq_subscriptions_live`). */
export const SUBSCRIPTION_LIVE_STATUSES = [
  'pending_payment',
  'active',
  'past_due',
  'frozen',
] as const satisfies readonly SubscriptionStatus[];

/** `subscriptions.billing_cycle` and the prices of a plan (monthly / yearly, V2-D06). */
export const BILLING_CYCLES = ['monthly', 'yearly'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];
export const BillingCycleSchema = z.enum(BILLING_CYCLES);

/** `subscription_plans.status`: a price change is a new plan and the old one retired (03 §4). */
export const SUBSCRIPTION_PLAN_STATUSES = ['active', 'retired'] as const;
export type SubscriptionPlanStatus = (typeof SUBSCRIPTION_PLAN_STATUSES)[number];
export const SubscriptionPlanStatusSchema = z.enum(SUBSCRIPTION_PLAN_STATUSES);

/** `subscriptions.frozen_reason` (04 §1: «تعليق المشغل أو إغلاق الموقع», V2-034, DEC-536). */
export const SUBSCRIPTION_FROZEN_REASONS = ['operator_suspended', 'venue_inactive'] as const;
export type SubscriptionFrozenReason = (typeof SUBSCRIPTION_FROZEN_REASONS)[number];
export const SubscriptionFrozenReasonSchema = z.enum(SUBSCRIPTION_FROZEN_REASONS);

/** `subscriptions.ended_reason`: why a subscription is `canceled` or `expired` (DEC-532). */
export const SUBSCRIPTION_ENDED_REASONS = [
  /** pending_payment: 30 minutes without a successful payment */
  'pending_expired',
  /** pending_payment: the customer gave the checkout up (C-14 «إلغاء») */
  'abandoned',
  /** active with cancel_at_period_end: the period ended, no renewal */
  'period_end',
  /** past_due: the grace ended without a successful payment → expired */
  'grace_expired',
  /** past_due: the customer canceled after the period ended unpaid */
  'past_due_canceled',
  /** C-20: the account was deleted */
  'account_deleted',
  /** the operator was terminated: canceled with a prorated system refund (V2-034) */
  'operator_terminated',
  /** the platform refunded the whole current period (P-06 / P-08) */
  'refunded',
] as const;
export type SubscriptionEndedReason = (typeof SUBSCRIPTION_ENDED_REASONS)[number];
export const SubscriptionEndedReasonSchema = z.enum(SUBSCRIPTION_ENDED_REASONS);

/**
 * The fixed rules of 04 §1 (DEC-532, DEC-533): a pending subscription waits 30 minutes for its payment; the renewal
 * notice goes 3 days before the end; a failed renewal opens a 3-day grace with attempts on days 0, 1 and 3 after
 * the end (the third failure expires it at once; `job.subscription_grace_expire` is the safety net one hour after the
 * grace); a plan covers 1 to 5 vehicles.
 */
export const SUBSCRIPTION_RULES = {
  pending_payment_minutes: 30,
  renewal_notice_days: 3,
  grace_days: 3,
  retry_offsets_days: [0, 1, 3],
  grace_expire_margin_minutes: 60,
  vehicles_min: 1,
  vehicles_max: 5,
} as const;

/**
 * The transitions of 04 §1 as implemented (V2-031, DEC-532): `from` (null = no row yet) → `to` for each event of the
 * machine. A transition not listed is refused (SUBSCRIPTION_NOT_ACTIVE for the customer's commands, a no-op for a
 * timer whose subscription moved on).
 */
export const SUBSCRIPTION_TRANSITIONS = {
  subscribe: { from: [null], to: 'pending_payment' },
  first_payment_paid: { from: ['pending_payment'], to: 'active' },
  pending_expired: { from: ['pending_payment'], to: 'canceled' },
  abandon: { from: ['pending_payment'], to: 'canceled' },
  renewal_notice: { from: ['active'], to: 'active' },
  renewal_paid: { from: ['active'], to: 'active' },
  renewal_failed: { from: ['active', 'past_due'], to: 'past_due' },
  past_due_paid: { from: ['past_due'], to: 'active' },
  grace_expired: { from: ['past_due'], to: 'expired' },
  cancel_at_period_end: { from: ['active', 'frozen'], to: null },
  resume: { from: ['active', 'frozen'], to: null },
  period_end_canceled: { from: ['active'], to: 'canceled' },
  past_due_cancel: { from: ['past_due'], to: 'canceled' },
  freeze: { from: ['active'], to: 'frozen' },
  unfreeze: { from: ['frozen'], to: 'active' },
  operator_terminated: { from: ['pending_payment', 'active', 'past_due', 'frozen'], to: 'canceled' },
  account_deleted: { from: ['pending_payment', 'active', 'past_due', 'frozen'], to: 'canceled' },
  refunded: { from: ['active', 'frozen'], to: 'canceled' },
} as const satisfies Record<
  string,
  { from: readonly (SubscriptionStatus | null)[]; to: SubscriptionStatus | null }
>;
export type SubscriptionTransition = keyof typeof SUBSCRIPTION_TRANSITIONS;

export function canTransitionSubscription(from: SubscriptionStatus, event: SubscriptionTransition): boolean {
  return (SUBSCRIPTION_TRANSITIONS[event].from as readonly (SubscriptionStatus | null)[]).includes(from);
}

/** The tables of migration 0016_subscriptions.sql (outside canon §6, which lists the V1 tables). */
export const SUBSCRIPTION_TABLE_NAMES = [
  'subscription_plans',
  'subscriptions',
  'subscription_vehicles',
  'subscription_periods',
] as const;

/** Asia/Riyadh is UTC+3 all year (no daylight saving). */
const RIYADH_OFFSET_MS = 3 * 3_600_000;

/**
 * The end of `periods` billing periods from `anchor` (DEC-533): calendar months (12 for a year) on the Asia/Riyadh
 * calendar, at the same local time of day; a day the target month lacks is clamped to its last day (31 January +1
 * month = 28/29 February), always from the anchor so that the day never drifts.
 */
export function addBillingPeriods(anchor: Date, cycle: BillingCycle, periods: number): Date {
  if (!Number.isInteger(periods) || periods < 0) throw new RangeError('periods');
  const months = (cycle === 'yearly' ? 12 : 1) * periods;
  const local = new Date(anchor.getTime() + RIYADH_OFFSET_MS);
  const target = local.getUTCMonth() + months;
  const year = local.getUTCFullYear() + Math.floor(target / 12);
  const month = ((target % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const t = Date.UTC(
    year,
    month,
    Math.min(local.getUTCDate(), last),
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
    local.getUTCMilliseconds(),
  );
  return new Date(t - RIYADH_OFFSET_MS);
}

/**
 * The prorated refund of a period not used to its end (04 §1 «استرداد نسبي», V2-034, DEC-536): the share of the
 * period's price for the time from `unusedFrom` to the end, in whole halalas rounded down (never more than paid).
 */
export function proratedRefundHalalas(
  priceHalalas: number,
  periodStart: Date,
  periodEnd: Date,
  unusedFrom: Date,
): number {
  const total = periodEnd.getTime() - periodStart.getTime();
  if (total <= 0) return 0;
  const from = Math.max(unusedFrom.getTime(), periodStart.getTime());
  const unused = Math.max(0, periodEnd.getTime() - from);
  return Math.min(priceHalalas, Math.floor((priceHalalas * unused) / total));
}

/** The price of a plan for a cycle (`null` when the plan does not sell that cycle). */
export function planPrice(
  plan: { monthly_price_halalas: number | null; yearly_price_halalas: number | null },
  cycle: BillingCycle,
): number | null {
  return cycle === 'yearly' ? plan.yearly_price_halalas : plan.monthly_price_halalas;
}
