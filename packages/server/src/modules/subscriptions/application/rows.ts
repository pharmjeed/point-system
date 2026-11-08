import type {
  BillingCycle,
  SubscriptionEndedReason,
  SubscriptionFrozenReason,
  SubscriptionPlanStatus,
  SubscriptionStatus,
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
}

/** Every column of `subscriptions`, amounts as numbers (bigint halalas stay far below 2^53). */
export const SUBSCRIPTION_COLUMNS = `s.id, s.account_id, s.plan_id, s.org_id, s.venue_id, s.billing_cycle, s.status,
  s.price_halalas::float8 AS price_halalas, s.vehicles_included, s.cycle_anchor_at, s.periods_paid,
  s.current_period_start, s.current_period_end, s.cancel_at_period_end, s.cancel_requested_at, s.payment_method_id,
  s.pending_expires_at, s.grace_ends_at, s.renewal_attempts, s.next_plan_id,
  s.next_price_halalas::float8 AS next_price_halalas, s.renewal_notice_for, s.vehicles_changed_at, s.frozen_at,
  s.frozen_reason, s.frozen_seconds_total::float8 AS frozen_seconds_total, s.activated_at, s.ended_at, s.ended_reason,
  s.version, s.created_at, s.updated_at`;

export async function subscriptionById(q: Q, id: string, lock = false): Promise<SubscriptionRow | null> {
  if (!UUID.test(id)) return null;
  const r = await q.query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions s WHERE s.id = $1${lock ? ' FOR NO KEY UPDATE' : ''}`,
    [id],
  );
  return r.rows[0] ?? null;
}

export interface PlanRow {
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

export const PLAN_COLUMNS = `p.id, p.org_id, p.venue_id, p.name_ar, p.name_en, p.vehicles_included,
  p.monthly_price_halalas::float8 AS monthly_price_halalas, p.yearly_price_halalas::float8 AS yearly_price_halalas,
  p.status, p.replaces_plan_id, p.replaced_by_plan_id, p.created_by, p.retired_at, p.retired_by, p.retire_reason,
  p.version, p.created_at, p.updated_at`;

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
