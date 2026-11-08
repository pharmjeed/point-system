import { api, apiFetch } from './client';

/**
 * V2-024 — the platform console's P-06 «العملاء» and P-08 «المدفوعات والاسترداد» (docs/07_openapi.yaml tag Platform:
 * `PlatformCustomer*`, `PlatformPayment*`, `PlatformReconciliationRun*`, `PlatformAlert*`). Phones arrive masked;
 * amounts are integer halalas, VAT included (`vat_halalas` is the VAT inside). Field names follow the contract.
 */
export type CustomerStatus = 'active' | 'suspended' | 'deleted';
export type CustomerCommand = 'suspend' | 'reactivate' | 'revoke_sessions';
export type OnlinePaymentStatus =
  'initiated' | 'authorized' | 'paid' | 'failed' | 'partially_refunded' | 'refunded';
export type RefundStatus = 'requested' | 'succeeded' | 'failed';
export type PlatformAlertType =
  'payment_unknown' | 'payment_mismatch' | 'payment_refund_failed' | 'payment_reconcile_failed';
export type ReconciliationStatus = 'running' | 'matched' | 'mismatched' | 'failed';

export interface NamedRef {
  id: string;
  name_ar: string | null;
}

export interface PlatformCustomer {
  id: string;
  display_name: string | null;
  phone_masked: string | null;
  status: CustomerStatus;
  locale: 'ar' | 'en';
  vehicles_count: number;
  live_sessions: number;
  created_at: string;
  deleted_at: string | null;
}

export interface CustomerPaymentRow {
  id: string;
  purpose: 'visit' | 'subscription';
  status: OnlinePaymentStatus;
  amount_halalas: number;
  vat_halalas: number;
  refunded_halalas: number;
  card_brand: string | null;
  card_last4: string | null;
  org: NamedRef | null;
  venue: NamedRef | null;
  ticket_id: string | null;
  created_at: string;
  paid_at: string | null;
}

export interface PlatformCustomerDetail extends PlatformCustomer {
  updated_at: string;
  consents: {
    current: {
      kind: 'terms' | 'privacy' | 'marketing';
      current_version: string;
      answered_version: string | null;
      granted: boolean | null;
      up_to_date: boolean;
      answered_at: string | null;
    }[];
    history: { kind: string; version: string; granted: boolean; created_at: string }[];
  };
  vehicles: {
    id: string;
    plate_display: string | null;
    make: string | null;
    model: string | null;
    color: string | null;
    type: string | null;
    created_at: string;
    removed_at: string | null;
  }[];
  visits: {
    ticket_id: string;
    org: NamedRef;
    venue: NamedRef;
    status: string;
    open: boolean;
    channel: 'whatsapp' | 'paper' | 'app';
    plate_display: string | null;
    entitlement: string;
    received_at: string;
    delivered_at: string | null;
  }[];
  sessions: {
    live: number;
    total: number;
    devices: number;
    items: {
      id: string;
      platform: 'ios' | 'android';
      device_hint: string;
      live: boolean;
      push_enabled: boolean;
      created_at: string;
      last_seen_at: string | null;
      revoked_at: string | null;
      revoked_reason: string | null;
    }[];
  };
  payment_methods: {
    id: string;
    brand: string | null;
    last4: string | null;
    expires_month: number | null;
    expires_year: number | null;
    is_default: boolean;
    created_at: string;
    removed_at: string | null;
  }[];
  payments: CustomerPaymentRow[];
  history: {
    action: 'customer.suspend' | 'customer.reactivate' | 'customer.sessions_revoke';
    reason: string | null;
    from_status: string | null;
    to_status: string | null;
    revoked_sessions: number | null;
    occurred_at: string;
    actor: { id: string; full_name: string | null } | null;
  }[];
}

export interface PlatformPayment {
  id: string;
  purpose: 'visit' | 'subscription';
  status: OnlinePaymentStatus;
  amount_halalas: number;
  vat_halalas: number;
  refunded_halalas: number;
  currency: 'SAR';
  gateway: string;
  gateway_payment_id: string | null;
  source_type: string | null;
  card_brand: string | null;
  card_last4: string | null;
  failure_code: string | null;
  account: { id: string; phone_masked: string | null; status: CustomerStatus };
  org: NamedRef | null;
  venue: NamedRef | null;
  ticket_id: string | null;
  subscription_id: string | null;
  created_at: string;
  paid_at: string | null;
}

export interface PlatformAlert {
  id: string;
  type: PlatformAlertType;
  severity: 'info' | 'warning' | 'critical';
  status: 'open' | 'acknowledged' | 'resolved';
  dedupe_key: string;
  online_payment_id: string | null;
  details: Record<string, unknown>;
  occurrences: number;
  raised_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  resolved_by: { id: string; full_name: string | null } | null;
  resolution_note: string | null;
}

export interface PlatformRefund {
  id: string;
  amount_halalas: number;
  reason: string;
  status: RefundStatus;
  failure_code: string | null;
  /** V2-022 (DEC-523): `system` = refunded by the platform itself (a double payment), with no platform user */
  kind?: 'manual' | 'system';
  issued_by: { id: string | null; full_name: string | null };
  created_at: string;
  sent_at: string | null;
  completed_at: string | null;
}

export interface PlatformPaymentDetail extends PlatformPayment {
  authorized_at: string | null;
  failed_at: string | null;
  refunded_at: string | null;
  gateway_updated_at: string | null;
  updated_at: string;
  version: number;
  refundable_halalas: number;
  refund_pending_halalas: number;
  refunds: PlatformRefund[];
  status_history: {
    action: string;
    from_status: string | null;
    to_status: string | null;
    cause: string | null;
    failure_code: string | null;
    occurred_at: string;
  }[];
  webhook_events: {
    id: number;
    event_type: string;
    live: boolean | null;
    received_at: string;
    processed_at: string | null;
    outcome: string | null;
    claimed: { status: string | null; amount_halalas: number | null; refunded_halalas: number | null };
  }[];
  alerts: PlatformAlert[];
}

export interface ReconciliationRun {
  id: string;
  gateway: string;
  run_date: string;
  status: ReconciliationStatus;
  started_at: string;
  finished_at: string | null;
  gateway_count: number | null;
  local_count: number | null;
  matched_count: number | null;
  mismatch_count: number | null;
  gateway_paid_halalas: number | null;
  local_paid_halalas: number | null;
  failure_reason: string | null;
}

export interface ReconciliationMismatch {
  kind: 'unknown_at_point' | 'missing_at_gateway' | 'status' | 'amount' | 'refunded' | null;
  gateway_payment_id: string | null;
  online_payment_id: string | null;
  point_status: string | null;
  gateway_status: string | null;
  point_amount_halalas: number | null;
  gateway_amount_halalas: number | null;
  point_refunded_halalas: number | null;
  gateway_refunded_halalas: number | null;
  synced: boolean;
}

export interface ReconciliationRunDetail extends ReconciliationRun {
  mismatches: ReconciliationMismatch[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CustomerFilters {
  phone?: string | undefined;
  status?: CustomerStatus | undefined;
}

export interface PaymentFilters {
  status?: OnlinePaymentStatus | undefined;
  purpose?: 'visit' | 'subscription' | undefined;
  org_id?: string | undefined;
  venue_id?: string | undefined;
  account_id?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export interface AlertFilters {
  status: 'open' | 'resolved' | 'all';
  type?: PlatformAlertType | undefined;
}

async function page<T>(path: string, filters: object, cursor?: string, signal?: AbortSignal, limit = 50) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v !== undefined && v !== '') params.set(k, String(v));
  if (cursor) params.set('cursor', cursor);
  params.set('limit', String(limit));
  const r = await apiFetch<T[]>('GET', `${path}?${params.toString()}`, { signal });
  return { items: r.data ?? [], nextCursor: r.meta.next_cursor ?? null } satisfies Page<T>;
}

const enc = encodeURIComponent;
const send = async <T>(path: string, body: unknown, key: string): Promise<T> =>
  (await api.post<T>(path, { body, idempotencyKey: key })).data;

export const consoleKeys = {
  customers: (f: CustomerFilters) => ['platform', 'customers', f] as const,
  customer: (id: string) => ['platform', 'customer', id] as const,
  payments: (f: PaymentFilters) => ['platform', 'payments', f] as const,
  payment: (id: string) => ['platform', 'payment', id] as const,
  runs: (f: object) => ['platform', 'reconciliation', f] as const,
  run: (id: string) => ['platform', 'reconciliation-run', id] as const,
  alerts: (f: AlertFilters) => ['platform', 'alerts', f] as const,
};

const COMMAND_PATH: Record<CustomerCommand, string> = {
  suspend: 'suspend',
  reactivate: 'reactivate',
  revoke_sessions: 'sessions/revoke',
};

export const consoleApi = {
  customers: (f: CustomerFilters, cursor?: string, signal?: AbortSignal) =>
    page<PlatformCustomer>('/v1/platform/customers', f, cursor, signal),
  customer: async (id: string, signal?: AbortSignal) =>
    (await api.get<PlatformCustomerDetail>(`/v1/platform/customers/${enc(id)}`, { signal })).data,
  customerCommand: (id: string, command: CustomerCommand, reason: string, key: string) =>
    send<{ account: PlatformCustomer; revoked_sessions: number }>(
      `/v1/platform/customers/${enc(id)}/${COMMAND_PATH[command]}`,
      { reason },
      key,
    ),
  payments: (f: PaymentFilters, cursor?: string, signal?: AbortSignal) =>
    page<PlatformPayment>('/v1/platform/payments', f, cursor, signal),
  payment: async (id: string, signal?: AbortSignal) =>
    (await api.get<PlatformPaymentDetail>(`/v1/platform/payments/${enc(id)}`, { signal })).data,
  refund: (id: string, body: { amount_halalas?: number; reason: string }, key: string) =>
    send<{ refund: unknown; payment: unknown }>(`/v1/platform/payments/${enc(id)}/refunds`, body, key),
  runs: (f: { status?: ReconciliationStatus | undefined }, cursor?: string, signal?: AbortSignal) =>
    page<ReconciliationRun>('/v1/platform/reconciliation-runs', f, cursor, signal, 30),
  run: async (id: string, signal?: AbortSignal) =>
    (await api.get<ReconciliationRunDetail>(`/v1/platform/reconciliation-runs/${enc(id)}`, { signal })).data,
  alerts: (f: AlertFilters, cursor?: string, signal?: AbortSignal) =>
    page<PlatformAlert>('/v1/platform/alerts', f, cursor, signal),
  resolveAlert: (id: string, note: string, key: string) =>
    send<PlatformAlert>(`/v1/platform/alerts/${enc(id)}/resolve`, { note }, key),
};
