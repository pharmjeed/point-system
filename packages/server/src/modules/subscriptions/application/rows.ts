import {
  weekdaysOfMask,
  type BillingCycle,
  type SubscriptionClosurePolicy,
  type SubscriptionEligibilityKind,
  type SubscriptionEndedReason,
  type SubscriptionFrozenReason,
  type SubscriptionPlanStatus,
  type SubscriptionRefundPolicy,
  type SubscriptionRenewalMode,
  type SubscriptionStatus,
  type SubscriptionTermKind,
} from '@point/shared';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';

export type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SubscriptionRow {
  id: string;
  account_id: string;
  plan_id: string;
  org_id: string;
  venue_id: string;
  billing_cycle: BillingCycle;
  status: SubscriptionStatus;
  price_halalas: number;
  vehicles_included: number;
  cycle_anchor_at: Date | null;
  periods_paid: number;
  current_period_start: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  cancel_requested_at: Date | null;
  payment_method_id: string | null;
  pending_expires_at: Date | null;
  grace_ends_at: Date | null;
  renewal_attempts: number;
  next_plan_id: string | null;
  next_price_halalas: number | null;
  renewal_notice_for: Date | null;
  vehicles_changed_at: Date | null;
  frozen_at: Date | null;
  frozen_reason: SubscriptionFrozenReason | null;
  frozen_seconds_total: number;
  activated_at: Date | null;
  ended_at: Date | null;
  ended_reason: SubscriptionEndedReason | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  // 0019 (DEC-591, DEC-593, DEC-600): `YYYY-MM-DD` strings (read as text, never as a local Date)
  service_start_on: string | null;
  service_end_on: string | null;
  frozen_remaining_days: number | null;
  refund_due_at: Date | null;
}

/** Every column of `subscriptions`, amounts as numbers (bigint halalas stay far below 2^53). */
export const SUBSCRIPTION_COLUMNS = `s.id, s.account_id, s.plan_id, s.org_id, s.venue_id, s.billing_cycle, s.status,
  s.price_halalas::float8 AS price_halalas, s.vehicles_included, s.cycle_anchor_at, s.periods_paid,
  s.current_period_start, s.current_period_end, s.cancel_at_period_end, s.cancel_requested_at, s.payment_method_id,
  s.pending_expires_at, s.grace_ends_at, s.renewal_attempts, s.next_plan_id,
  s.next_price_halalas::float8 AS next_price_halalas, s.renewal_notice_for, s.vehicles_changed_at, s.frozen_at,
  s.frozen_reason, s.frozen_seconds_total::float8 AS frozen_seconds_total, s.activated_at, s.ended_at, s.ended_reason,
  s.version, s.created_at, s.updated_at, s.service_start_on::text AS service_start_on,
  s.service_end_on::text AS service_end_on, s.frozen_remaining_days, s.refund_due_at`;

export async function subscriptionById(q: Q, id: string, lock = false): Promise<SubscriptionRow | null> {
  if (!UUID.test(id)) return null;
  const r = await q.query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions s WHERE s.id = $1${lock ? ' FOR NO KEY UPDATE' : ''}`,
    [id],
  );
  return r.rows[0] ?? null;
}

/** The policies of a plan (0019, 04 §7, DEC-590): the V4 behaviour by default. */
export interface PlanPolicyRow {
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
  capacity: number | null;
  audience_ar: string | null;
  vehicle_change: 'once_per_period' | 'any_time';
}

export interface PlanRow extends PlanPolicyRow {
  id: string;
  org_id: string;
  venue_id: string;
  name_ar: string;
  name_en: string | null;
  vehicles_included: number;
  monthly_price_halalas: number | null;
  yearly_price_halalas: number | null;
  status: SubscriptionPlanStatus;
  replaces_plan_id: string | null;
  replaced_by_plan_id: string | null;
  created_by: string;
  retired_at: Date | null;
  retired_by: string | null;
  retire_reason: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export const POLICY_COLUMNS = (a: string) => `${a}.term_kind, ${a}.service_days, ${a}.service_weekdays_mask,
  ${a}.renewal_mode, ${a}.daily_visit_limit, ${a}.refund_policy, ${a}.closure_policy, ${a}.freeze_max_times,
  ${a}.freeze_max_days, ${a}.eligibility, ${a}.capacity, ${a}.audience_ar, ${a}.vehicle_change`;

export const PLAN_COLUMNS = `p.id, p.org_id, p.venue_id, p.name_ar, p.name_en, p.vehicles_included,
  p.monthly_price_halalas::float8 AS monthly_price_halalas, p.yearly_price_halalas::float8 AS yearly_price_halalas,
  p.status, p.replaces_plan_id, p.replaced_by_plan_id, p.created_by, p.retired_at, p.retired_by, p.retire_reason,
  p.version, p.created_at, p.updated_at, ${POLICY_COLUMNS('p')}`;

/** The policies of the plan a subscription is on (plans are never edited, DEC-531: read, not locked). */
export async function policyOf(
  q: Q,
  sub: Pick<SubscriptionRow, 'plan_id' | 'org_id'>,
): Promise<PlanPolicyRow> {
  const r = await q.query<PlanPolicyRow>(
    `SELECT ${POLICY_COLUMNS('p')} FROM subscription_plans p WHERE p.id = $1 AND p.org_id = $2`,
    [sub.plan_id, sub.org_id],
  );
  const p = r.rows[0];
  if (!p) throw new Error(`plan ${sub.plan_id} of a subscription is missing`);
  return p;
}

/** The weekdays of a counted-day plan (0 = Sunday … 6 = Saturday), or null for a calendar term. */
export const weekdaysOf = (p: Pick<PlanPolicyRow, 'service_weekdays_mask'>) =>
  p.service_weekdays_mask === null ? null : weekdaysOfMask(p.service_weekdays_mask);

export async function planById(q: Q, id: string, lock = false): Promise<PlanRow | null> {
  if (!UUID.test(id)) return null;
  const r = await q.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM subscription_plans p WHERE p.id = $1${lock ? ' FOR NO KEY UPDATE' : ''}`,
    [id],
  );
  return r.rows[0] ?? null;
}

export interface PeriodRow {
  id: string;
  subscription_id: string;
  seq: number;
  plan_id: string;
  billing_cycle: BillingCycle;
  starts_at: Date;
  ends_at: Date;
  price_halalas: number;
  online_payment_id: string;
  extended_seconds: number;
  created_at: Date;
}

export const PERIOD_COLUMNS = `sp.id, sp.subscription_id, sp.seq, sp.plan_id, sp.billing_cycle, sp.starts_at, sp.ends_at,
  sp.price_halalas::float8 AS price_halalas, sp.online_payment_id, sp.extended_seconds::float8 AS extended_seconds,
  sp.created_at`;

export const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** The statuses that hold a seat of a plan's capacity (DEC-598): an application waiting for review does not. */
export const SEAT_STATUSES = `('pending_payment','active','past_due','frozen')`;

/**
 * The live subscriptions holding a seat of a plan's capacity (DEC-598): on the plan and on every plan of its
 * replacement family (a price change keeps the seats taken), an SQL scalar of the plan id expression given.
 */
export const seatsTakenSql = (planId: string) => `(WITH RECURSIVE fam(id) AS (
    SELECT ${planId}
    UNION
    SELECT p2.id FROM subscription_plans p2 JOIN fam ON p2.replaces_plan_id = fam.id OR p2.replaced_by_plan_id = fam.id
  )
  SELECT count(*)::int FROM subscriptions s2 JOIN subscription_plans pf ON pf.id = s2.plan_id AND pf.org_id = s2.org_id
   WHERE s2.plan_id IN (SELECT id FROM fam) AND s2.status IN ${SEAT_STATUSES})`;
