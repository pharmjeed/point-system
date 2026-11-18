import { api, apiFetch } from './client';

/**
 * V2-030 / V2-035 — the platform console's P-05 «باقات الاشتراك» and P-07 «الاشتراكات» (docs/07_openapi.yaml tag
 * Platform: `PlatformPlan*`, `PlatformSubscription*`). Amounts are integer halalas, VAT included; phones arrive
 * masked. Field names follow the contract.
 */
export type SubscriptionStatus =
  'pending_eligibility' | 'pending_payment' | 'active' | 'past_due' | 'canceled' | 'expired' | 'frozen';

/** V2-036 (docs/v2/04 §7, DEC-590): a plan's policies, the V4 behaviour by default. */
export interface PlanPolicies {
  term_kind: 'calendar' | 'service_days';
  service_days: number | null;
  service_weekdays: number[] | null;
  renewal_mode: 'auto' | 'manual';
  daily_visit_limit: number | null;
  refund_policy: 'prorated_on_termination' | 'non_refundable';
  closure_policy: 'freeze' | 'continue';
  freeze_max_times: number;
  freeze_max_days: number | null;
  eligibility: 'none' | 'student_id_review';
  capacity: number | null;
  audience_ar: string | null;
  vehicle_change: 'once_per_period' | 'any_time';
}
export type BillingCycle = 'monthly' | 'yearly';

export interface PlatformPlan extends PlanPolicies {
  seats_taken: number;
  plan_id: string;
  venue_id: string;
  name_ar: string;
  name_en: string | null;
  vehicles_included: number;
  monthly_price_halalas: number | null;
  yearly_price_halalas: number | null;
  status: 'active' | 'retired';
  replaces_plan_id: string | null;
  replaced_by_plan_id: string | null;
  live_subscriptions: number;
  created_at: string;
  retired_at: string | null;
}

export interface PlanVenue {
  venue_id: string;
  org_id: string;
  name_ar: string;
  name_en: string | null;
  operator_name_ar: string;
  category: string;
  profile_status: string;
  profile_version: number;
  subscriptions_enabled: boolean;
  subscriptions_allowed: boolean;
  pay_per_visit_halalas: number | null;
  plans: PlatformPlan[];
}

export interface PlanInput {
  venue_id: string;
  name_ar: string;
  vehicles_included: number;
  monthly_price_halalas: number | null;
  yearly_price_halalas: number | null;
  replaces_plan_id?: string;
  reason?: string;
  policies?: Partial<PlanPolicies>;
}

export interface PlatformSubscription {
  subscription_id: string;
  account_id: string;
  phone_masked: string | null;
  account_status: string;
  org_id: string;
  operator_name_ar: string;
  venue_id: string;
  venue_name_ar: string;
  plan_id: string;
  plan_name_ar: string;
  billing_cycle: BillingCycle;
  status: SubscriptionStatus;
  price_halalas: number;
  next_price_halalas: number | null;
  vehicles_included: number;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  grace_ends_at: string | null;
  renewal_attempts: number;
  frozen_at: string | null;
  frozen_reason: 'operator_suspended' | 'venue_inactive' | 'customer_freeze' | null;
  frozen_days_total: number;
  periods_paid: number;
  visits: number;
  activated_at: string | null;
  ended_at: string | null;
  ended_reason: string | null;
  created_at: string;
  // V2-036
  policy?: Omit<PlanPolicies, 'capacity' | 'audience_ar'>;
  service_start_on?: string | null;
  service_end_on?: string | null;
  remaining_days?: number | null;
  eligibility_status?: 'pending' | 'approved' | 'rejected' | null;
  student_number_masked?: string | null;
  refund_due_at?: string | null;
}

export interface PlatformSubscriptionDetail extends PlatformSubscription {
  covered_vehicles: number;
  eligibility?: {
    status: 'pending' | 'approved' | 'rejected';
    source: 'review' | 'list' | 'reuse' | null;
    student_number: string;
    student_name: string;
    decided_at: string | null;
    decision_reason: string | null;
    created_at: string;
  } | null;
  freezes?: {
    freeze_id: string;
    period_seq: number;
    status: string;
    starts_on: string;
    returns_on: string;
    days: number;
    used_days: number | null;
    ended_on: string | null;
    end_reason: string | null;
  }[];
  purchase_consents?: {
    period_seq: number;
    terms_version: string;
    privacy_version: string;
    price_halalas: number;
    net_halalas: number;
    vat_halalas: number;
    non_refundable: boolean;
    valuables_notice: boolean;
    created_at: string;
  }[];
  refunds?: {
    refund_id: string;
    amount_halalas: number;
    status: string;
    kind: string;
    created_at: string;
    completed_at: string | null;
  }[];
  periods: {
    seq: number;
    starts_at: string;
    ends_at: string;
    price_halalas: number;
    plan_id: string;
    online_payment_id: string;
    extended_days: number;
  }[];
  payments: {
    payment_id: string;
    status: string;
    amount_halalas: number;
    refunded_halalas: number;
    seq: number | null;
    card_brand: string | null;
    card_last4: string | null;
    failure_code: string | null;
    paid_at: string | null;
    created_at: string;
  }[];
  timeline: {
    action: string;
    occurred_at: string;
    actor_type: string;
    from_status: string | null;
    to_status: string | null;
  }[];
}

export interface SubscriptionsReport {
  generated_at: string;
  days: number;
  counts: Partial<Record<SubscriptionStatus, number>>;
  active_subscribers: number;
  mrr_halalas: number;
  renewals_due: { count: number; amount_halalas: number; until: string };
  churn: { count: number; rate_bp: number; by_reason: Record<string, number>; since: string };
  new_subscriptions: number;
  venues: {
    venue_id: string;
    venue_name_ar: string;
    org_id: string;
    operator_name_ar: string;
    active: number;
    frozen: number;
    past_due: number;
    mrr_halalas: number;
  }[];
}

export interface SubscriptionFilters {
  status?: SubscriptionStatus | undefined;
  billing_cycle?: BillingCycle | undefined;
  venue_id?: string | undefined;
  renews_before?: string | undefined;
}

async function page<T>(path: string, filters: object, cursor?: string, signal?: AbortSignal, limit = 50) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v !== undefined && v !== '') params.set(k, String(v));
  if (cursor) params.set('cursor', cursor);
  params.set('limit', String(limit));
  const r = await apiFetch<T[]>('GET', `${path}?${params.toString()}`, { signal });
  return { items: r.data ?? [], nextCursor: r.meta.next_cursor ?? null };
}

const enc = encodeURIComponent;

/** V2-036 (DEC-599): an announced holiday or closure of a venue. */
export interface VenueClosure {
  closure_id: string;
  venue_id: string;
  kind: 'holiday' | 'closure';
  starts_on: string;
  ends_on: string;
  reason_ar: string;
  created_at: string;
  canceled_at: string | null;
  cancel_reason: string | null;
}

export const subscriptionKeys = {
  closures: (venueId: string) => ['platform', 'venue-closures', venueId] as const,
  eligible: (venueId: string) => ['platform', 'eligible-students', venueId] as const,
  plans: (q: string) => ['platform', 'plans', q] as const,
  list: (f: SubscriptionFilters) => ['platform', 'subscriptions', f] as const,
  one: (id: string) => ['platform', 'subscription', id] as const,
  report: (days: number) => ['platform', 'subscriptions-report', days] as const,
};

export const subscriptionsApi = {
  plans: (q: string, cursor?: string, signal?: AbortSignal) =>
    page<PlanVenue>('/v1/platform/plans', q ? { q } : {}, cursor, signal),
  createPlan: async ({ policies, ...body }: PlanInput, key: string) =>
    (
      await api.post<PlatformPlan>('/v1/platform/plans', {
        body: { ...body, ...policies },
        idempotencyKey: key,
      })
    ).data,
  retirePlan: async (planId: string, reason: string, key: string) =>
    (
      await api.post<PlatformPlan>(`/v1/platform/plans/${enc(planId)}/retire`, {
        body: { reason },
        idempotencyKey: key,
      })
    ).data,
  list: (f: SubscriptionFilters, cursor?: string, signal?: AbortSignal) =>
    page<PlatformSubscription>('/v1/platform/subscriptions', f, cursor, signal),
  one: async (id: string, signal?: AbortSignal) =>
    (await api.get<PlatformSubscriptionDetail>(`/v1/platform/subscriptions/${enc(id)}`, { signal })).data,
  // V2-036 (DEC-596 … DEC-600)
  decideEligibility: async (
    id: string,
    body: { decision: 'approve' | 'reject'; reason?: string },
    key: string,
  ) =>
    (
      await api.post<PlatformSubscriptionDetail>(`/v1/platform/subscriptions/${enc(id)}/eligibility`, {
        body,
        idempotencyKey: key,
      })
    ).data,
  exceptionalRefund: async (id: string, reason: string, key: string) =>
    (
      await api.post<{ amount_halalas: number; remaining_days: number | null }>(
        `/v1/platform/subscriptions/${enc(id)}/exceptional-refund`,
        { body: { reason }, idempotencyKey: key },
      )
    ).data,
  eligibleSummary: async (venueId: string, signal?: AbortSignal) =>
    (
      await api.get<{ venue_id: string; listed: number; pending_applications: number }>(
        `/v1/platform/venues/${enc(venueId)}/eligible-students`,
        { signal },
      )
    ).data,
  importEligible: async (
    venueId: string,
    body: { mode: 'add' | 'remove'; student_numbers: string[] },
    key: string,
  ) =>
    (
      await api.post<{ changed: number; approved: number; listed: number }>(
        `/v1/platform/venues/${enc(venueId)}/eligible-students`,
        { body, idempotencyKey: key },
      )
    ).data,
  closures: async (venueId: string, signal?: AbortSignal) =>
    (
      await api.get<{ items: VenueClosure[] }>(`/v1/platform/venue-closures?venue_id=${enc(venueId)}`, {
        signal,
      })
    ).data.items,
  createClosure: async (
    body: {
      venue_id: string;
      kind: 'holiday' | 'closure';
      starts_on: string;
      ends_on: string;
      reason_ar: string;
    },
    key: string,
  ) => (await api.post<VenueClosure>('/v1/platform/venue-closures', { body, idempotencyKey: key })).data,
  cancelClosure: async (closureId: string, reason: string, key: string) =>
    (
      await api.post<VenueClosure>(`/v1/platform/venue-closures/${enc(closureId)}/cancel`, {
        body: { reason },
        idempotencyKey: key,
      })
    ).data,
  report: async (days: number, signal?: AbortSignal) =>
    (await api.get<SubscriptionsReport>(`/v1/platform/subscriptions/report?days=${days}`, { signal })).data,
};
