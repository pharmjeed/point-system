/**
 * V2 subscriptions (docs/v2/04 §1–§2, docs/v2/03 §4; V2-030 … V2-035, DEC-531 … DEC-539): the plans POINT sells per
 * venue (P-05), the customer's subscription and its state machine, the paid periods, and the rules of renewal, grace,
 * freezing and the entitlement at intake. Amounts are halalas, VAT included (04 §4). Times are instants (UTC); the
 * calendar of a period is the one of Asia/Riyadh (no daylight saving: UTC+3 all year).
 */
import { z } from 'zod';
import { weekdaysOfMask } from './service-days.js';

/** `subscriptions.status` (03 §4, `ck_subscriptions_status`), in the order of 04 §1. */
export const SUBSCRIPTION_STATUSES = [
  /** a plan with an eligibility check: the application waits for the platform's decision (DEC-596) */
  'pending_eligibility',
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
  'pending_eligibility',
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

/**
 * The per-plan policies of 04 §7 (DEC-590): what was fixed for every plan in V4 became a column of the plan, its
 * default the V4 behaviour, so that the existing plans run unchanged and a contract's plan (the student plan of the
 * subscriptions annex) is data.
 * - `term_kind`: `calendar` = calendar months (12 for a year) from the anchor (DEC-533); `service_days` = N counted
 *   days on the plan's service weekdays (`service_days`, `service_weekdays_mask`; DEC-591).
 * - `renewal_mode`: `auto` = the saved card is charged at the end (DEC-533); `manual` = nothing is charged, the term
 *   ends (`expired`, `term_completed`) and the customer renews on request with a new paid subscription (DEC-595).
 * - `refund_policy`: `prorated_on_termination` (DEC-536); `non_refundable` = no refund when the customer changes
 *   their mind, shown and consented before payment; exceptional refunds stay a platform action (DEC-600).
 * - `closure_policy`: `freeze` = the venue's closure freezes the term (DEC-536); `continue` = it keeps counting and
 *   the subscriber is notified (DEC-599).
 * - `eligibility`: `none`, or `student_id_review` = an application with the student number reviewed by the platform
 *   (or matched to the venue's eligible list) before any payment (DEC-596).
 */
export const SUBSCRIPTION_TERM_KINDS = ['calendar', 'service_days'] as const;
export type SubscriptionTermKind = (typeof SUBSCRIPTION_TERM_KINDS)[number];
export const SubscriptionTermKindSchema = z.enum(SUBSCRIPTION_TERM_KINDS);

export const SUBSCRIPTION_RENEWAL_MODES = ['auto', 'manual'] as const;
export type SubscriptionRenewalMode = (typeof SUBSCRIPTION_RENEWAL_MODES)[number];
export const SubscriptionRenewalModeSchema = z.enum(SUBSCRIPTION_RENEWAL_MODES);

export const SUBSCRIPTION_REFUND_POLICIES = ['prorated_on_termination', 'non_refundable'] as const;
export type SubscriptionRefundPolicy = (typeof SUBSCRIPTION_REFUND_POLICIES)[number];
export const SubscriptionRefundPolicySchema = z.enum(SUBSCRIPTION_REFUND_POLICIES);

export const SUBSCRIPTION_CLOSURE_POLICIES = ['freeze', 'continue'] as const;
export type SubscriptionClosurePolicy = (typeof SUBSCRIPTION_CLOSURE_POLICIES)[number];
export const SubscriptionClosurePolicySchema = z.enum(SUBSCRIPTION_CLOSURE_POLICIES);

export const SUBSCRIPTION_ELIGIBILITY_KINDS = ['none', 'student_id_review'] as const;
export type SubscriptionEligibilityKind = (typeof SUBSCRIPTION_ELIGIBILITY_KINDS)[number];
export const SubscriptionEligibilityKindSchema = z.enum(SUBSCRIPTION_ELIGIBILITY_KINDS);

/**
 * `subscription_plans.vehicle_change` (DEC-602, annex clause 1 «يمكن تحديث المركبة المسجلة قبل الاستلام»): the V4
 * rule of once per period (01 R6), or any time no visit of the subscription is open.
 */
export const SUBSCRIPTION_VEHICLE_CHANGE_POLICIES = ['once_per_period', 'any_time'] as const;
export type SubscriptionVehicleChangePolicy = (typeof SUBSCRIPTION_VEHICLE_CHANGE_POLICIES)[number];
export const SubscriptionVehicleChangePolicySchema = z.enum(SUBSCRIPTION_VEHICLE_CHANGE_POLICIES);

/** `subscription_eligibility.status` and how the decision was reached (DEC-596). */
export const SUBSCRIPTION_ELIGIBILITY_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type SubscriptionEligibilityStatus = (typeof SUBSCRIPTION_ELIGIBILITY_STATUSES)[number];
export const SubscriptionEligibilityStatusSchema = z.enum(SUBSCRIPTION_ELIGIBILITY_STATUSES);
export const SUBSCRIPTION_ELIGIBILITY_SOURCES = ['review', 'list', 'reuse'] as const;
export type SubscriptionEligibilitySource = (typeof SUBSCRIPTION_ELIGIBILITY_SOURCES)[number];
export const SubscriptionEligibilitySourceSchema = z.enum(SUBSCRIPTION_ELIGIBILITY_SOURCES);

/** `subscription_freezes.status` (DEC-594): one live (scheduled or active) freeze at a time. */
export const SUBSCRIPTION_FREEZE_STATUSES = [
  'scheduled',
  'active',
  'completed',
  'withdrawn',
  'canceled',
] as const;
export type SubscriptionFreezeStatus = (typeof SUBSCRIPTION_FREEZE_STATUSES)[number];
export const SubscriptionFreezeStatusSchema = z.enum(SUBSCRIPTION_FREEZE_STATUSES);

/** `venue_closures.kind` (DEC-599): a scheduled holiday or a closure announced by the site. */
export const VENUE_CLOSURE_KINDS = ['holiday', 'closure'] as const;
export type VenueClosureKind = (typeof VENUE_CLOSURE_KINDS)[number];
export const VenueClosureKindSchema = z.enum(VENUE_CLOSURE_KINDS);

/**
 * The plan policies' bounds (`ck_subscription_plans_*` of 0019): counted days 1 … 60, a daily visit limit 1 … 10, a
 * customer freeze at most 3 times per term and 30 counted days, a capacity of 1 … 100000 live subscriptions.
 */
export const SUBSCRIPTION_POLICY_LIMITS = {
  service_days_max: 60,
  daily_visit_limit_max: 10,
  freeze_max_times: 3,
  freeze_max_days: 30,
  capacity_max: 100_000,
  audience_max: 120,
} as const;

/**
 * `subscriptions.frozen_reason` (04 §1: «تعليق المشغل أو إغلاق الموقع», V2-034, DEC-536; and the customer's own
 * freeze of a counted-day plan, 04 §7, DEC-594).
 */
export const SUBSCRIPTION_FROZEN_REASONS = [
  'operator_suspended',
  'venue_inactive',
  'customer_freeze',
] as const;
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
  /** pending_eligibility: the platform found the applicant not eligible (DEC-596) */
  'eligibility_rejected',
  /** a plan renewed by hand (`renewal_mode = manual`): its term ended → expired (DEC-595) */
  'term_completed',
  /** the platform refunded the remaining counted days in an exceptional case (annex clause 5, DEC-600) */
  'exceptional_refund',
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
  apply: { from: [null], to: 'pending_eligibility' },
  eligibility_approved: { from: ['pending_eligibility'], to: 'pending_payment' },
  eligibility_rejected: { from: ['pending_eligibility'], to: 'canceled' },
  first_payment_paid: { from: ['pending_payment'], to: 'active' },
  pending_expired: { from: ['pending_payment'], to: 'canceled' },
  abandon: { from: ['pending_eligibility', 'pending_payment'], to: 'canceled' },
  renewal_notice: { from: ['active'], to: 'active' },
  renewal_paid: { from: ['active'], to: 'active' },
  renewal_failed: { from: ['active', 'past_due'], to: 'past_due' },
  past_due_paid: { from: ['past_due'], to: 'active' },
  grace_expired: { from: ['past_due'], to: 'expired' },
  term_completed: { from: ['active'], to: 'expired' },
  cancel_at_period_end: { from: ['active', 'frozen'], to: null },
  resume: { from: ['active', 'frozen'], to: null },
  period_end_canceled: { from: ['active'], to: 'canceled' },
  past_due_cancel: { from: ['past_due'], to: 'canceled' },
  freeze: { from: ['active'], to: 'frozen' },
  unfreeze: { from: ['frozen'], to: 'active' },
  operator_terminated: {
    from: ['pending_eligibility', 'pending_payment', 'active', 'past_due', 'frozen'],
    to: 'canceled',
  },
  account_deleted: {
    from: ['pending_eligibility', 'pending_payment', 'active', 'past_due', 'frozen'],
    to: 'canceled',
  },
  refunded: { from: ['active', 'frozen'], to: 'canceled' },
  exceptional_refund: { from: ['active', 'frozen'], to: 'canceled' },
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

/** The tables of migration 0019_subscription_policies.sql (04 §7, DEC-590 … DEC-609). */
export const SUBSCRIPTION_POLICY_TABLE_NAMES = [
  'subscription_eligibility',
  'subscription_eligible_students',
  'subscription_freezes',
  'subscription_purchase_consents',
  'venue_closures',
  'customer_complaints',
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

/** The policy columns of `subscription_plans` (0019, DEC-590). */
export interface PlanPolicyColumns {
  term_kind: SubscriptionTermKind;
  service_days: number | null;
  service_weekdays_mask: number | null;
  renewal_mode: SubscriptionRenewalMode;
  daily_visit_limit: number | null;
  refund_policy: SubscriptionRefundPolicy;
  closure_policy: SubscriptionClosurePolicy;
  freeze_max_times: number;
  freeze_max_days: number | null;
  eligibility: SubscriptionEligibilityKind;
  vehicle_change: SubscriptionVehicleChangePolicy;
}

/** A plan's policies as the app and the console show them (the weekday mask as a list of weekdays). */
export function planPolicyView(p: PlanPolicyColumns) {
  return {
    term_kind: p.term_kind,
    service_days: p.service_days,
    service_weekdays: p.service_weekdays_mask === null ? null : weekdaysOfMask(p.service_weekdays_mask),
    renewal_mode: p.renewal_mode,
    refund_policy: p.refund_policy,
    closure_policy: p.closure_policy,
    daily_visit_limit: p.daily_visit_limit,
    freeze_max_times: p.freeze_max_times,
    freeze_max_days: p.freeze_max_days,
    eligibility: p.eligibility,
    vehicle_change: p.vehicle_change,
  };
}

/**
 * The purchase consent is required before paying a plan that is non-refundable, renewed by hand or checked for
 * eligibility (DEC-601): its conditions differ from V4's and the annex asks them shown and accepted before payment.
 */
export function purchaseConsentRequired(
  p: Pick<PlanPolicyColumns, 'refund_policy' | 'renewal_mode' | 'eligibility'>,
): boolean {
  return p.refund_policy === 'non_refundable' || p.renewal_mode === 'manual' || p.eligibility !== 'none';
}
