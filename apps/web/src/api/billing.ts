import { api, apiFetch } from './client';

/**
 * V5 — invoices and settlement (V2-040 … V2-042; docs/07_openapi.yaml: `SettlementStatement*`, `InvoiceDetail`,
 * `SystemSubscription*`): the platform's P-09 «التسوية» and P-10 «الفواتير», and the operator's O-05 «كشف التسوية» and
 * O-06 «اشتراك النظام». Amounts are integer halalas; a statement's net is positive when POINT pays the operator.
 */
export type SettlementStatus = 'draft' | 'issued' | 'disputed' | 'paid' | 'void';
export type SettlementLineKind =
  | 'subscriber_visit'
  | 'app_payment'
  | 'app_commission'
  | 'app_refund'
  | 'app_refund_commission'
  | 'saas_fee'
  | 'saas_vat'
  | 'adjustment';
export type InvoiceKind = 'customer_simplified' | 'operator_standard' | 'credit_note';
export type InvoiceSeries = 'simplified' | 'standard';
export type ZatcaStatus = 'pending' | 'reported' | 'cleared' | 'rejected';

export interface SettlementStatement {
  id: string;
  org_id: string;
  period: string;
  period_start: string;
  period_end: string;
  status: SettlementStatus;
  subscriber_visit_count: number;
  subscriber_payout_halalas: number;
  app_payment_count: number;
  app_gross_halalas: number;
  app_commission_halalas: number;
  app_refund_halalas: number;
  app_refund_commission_halalas: number;
  saas_fee_halalas: number;
  saas_vat_halalas: number;
  adjustments_halalas: number;
  net_payable_halalas: number;
  computed_at: string;
  issued_at: string | null;
  disputed_at: string | null;
  dispute_reason: string | null;
  dispute_resolved_at: string | null;
  dispute_resolution: string | null;
  paid_at: string | null;
  paid_on: string | null;
  paid_reference: string | null;
  voided_at: string | null;
  void_reason: string | null;
  saas_invoice_id: string | null;
  version: number;
  org?: { id: string; name_ar: string; operator_status?: string; legal_name?: string | null };
}

export interface SettlementLine {
  id: string;
  kind: SettlementLineKind;
  amount_halalas: number;
  base_halalas: number | null;
  rate_bp: number | null;
  quantity_days: number | null;
  occurred_on: string;
  venue: { id: string; name_ar: string | null } | null;
  ticket: { id: string; display_number: number | null } | null;
  online_payment_id: string | null;
  refund_id: string | null;
  note: string | null;
  created_at: string;
  released_at: string | null;
}

export interface InvoiceRef {
  id: string;
  number: string;
  kind: InvoiceKind;
  status: ZatcaStatus;
  total_halalas: number;
  issued_at: string;
}

export interface SettlementDetail extends SettlementStatement {
  lines: SettlementLine[];
  invoices: InvoiceRef[];
  history?: { action: string; occurred_at: string; actor: string | null; reason: string | null }[];
  disputed_by?: { full_name: string; role: string } | null;
}

export interface InvoiceLine {
  description_ar: string;
  description_en: string;
  quantity: number;
  net_halalas: number;
  vat_rate_bp: number;
  vat_halalas: number;
  total_halalas: number;
}

export interface InvoiceSummary {
  id: string;
  number: string;
  series: InvoiceSeries;
  kind: InvoiceKind;
  issued_at: string;
  total_halalas: number;
  vat_halalas: number;
  status: ZatcaStatus;
  provider: string;
  original_number: string | null;
  org: { id: string; name_ar: string | null } | null;
  account: { id: string; phone_masked: string | null } | null;
  pdf_ready: boolean;
}

export interface InvoiceDetail {
  id: string;
  number: string;
  series: InvoiceSeries;
  kind: InvoiceKind;
  type_code: 388 | 381;
  icv?: number;
  uuid: string;
  issued_at: string;
  supply_date: string;
  period_start: string | null;
  period_end: string | null;
  vat_rate_bp: number;
  subtotal_halalas: number;
  vat_halalas: number;
  total_halalas: number;
  seller: { legal_name_ar: string; vat_number: string; cr_number: string; address_ar: string };
  buyer: { kind: string; legal_name_ar?: string | null; vat_number?: string | null };
  lines: InvoiceLine[];
  original: { id: string; number: string | null } | null;
  credit_reason: string | null;
  status: ZatcaStatus;
  provider: string;
  provider_reference: string | null;
  provider_codes: { code: string; category: string }[];
  pdf_url: string | null;
  provider_events?: {
    id: number;
    kind: string;
    outcome: string;
    status: string | null;
    occurred_at: string;
  }[];
  credit_notes?: { id: string; number: string; total_halalas: number; issued_at: string }[];
  account?: { id: string; phone_masked: string | null } | null;
}

export interface SystemSubscription {
  operator: {
    name_ar: string;
    legal_name: string | null;
    vat_number: string | null;
    cr_number: string | null;
    operator_status: string;
  };
  contract: Contract | null;
  contracts: Contract[];
  active_venues: number;
  invoices: InvoiceDetail[];
}

export interface Contract {
  id: string;
  starts_on: string;
  ends_on: string | null;
  saas_fee_halalas_per_venue: number;
  saas_cycle: 'monthly' | 'yearly';
  subscriber_visit_payout_halalas: number;
  app_payment_commission_bp: number;
  state: 'upcoming' | 'current' | 'ended';
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface SettlementFilters {
  status?: SettlementStatus | undefined;
  period?: string | undefined;
  org_id?: string | undefined;
}

export interface InvoiceFilters {
  kind?: InvoiceKind | undefined;
  series?: InvoiceSeries | undefined;
  status?: ZatcaStatus | undefined;
  number?: string | undefined;
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

export const billingKeys = {
  settlements: (f: SettlementFilters) => ['platform', 'settlements', f] as const,
  settlement: (id: string) => ['platform', 'settlement', id] as const,
  invoices: (f: InvoiceFilters) => ['platform', 'invoices', f] as const,
  invoice: (id: string) => ['platform', 'invoice', id] as const,
  operatorStatements: ['billing', 'statements'] as const,
  operatorStatement: (id: string) => ['billing', 'statement', id] as const,
  subscription: ['billing', 'subscription'] as const,
  operatorInvoice: (id: string) => ['billing', 'invoice', id] as const,
};

export type SettlementCommandName = 'issue' | 'record-payment' | 'resolve-dispute' | 'void';

export const billingApi = {
  // P-09
  settlements: (f: SettlementFilters, cursor?: string, signal?: AbortSignal) =>
    page<SettlementStatement>('/v1/platform/settlements', f, cursor, signal),
  settlement: async (id: string, signal?: AbortSignal) =>
    (await api.get<SettlementDetail>(`/v1/platform/settlements/${enc(id)}`, { signal })).data,
  generate: (body: { period: string; org_id?: string }, key: string) =>
    send<{ period: string; results: unknown[] }>('/v1/platform/settlements/generate', body, key),
  adjust: (
    id: string,
    body: { expected_version: number; amount_halalas: number; reason: string },
    key: string,
  ) => send<{ statement: SettlementStatement }>(`/v1/platform/settlements/${enc(id)}/adjustments`, body, key),
  command: (id: string, command: SettlementCommandName, body: Record<string, unknown>, key: string) =>
    send<{ statement: SettlementStatement }>(`/v1/platform/settlements/${enc(id)}/${command}`, body, key),
  // P-10
  invoices: (f: InvoiceFilters, cursor?: string, signal?: AbortSignal) =>
    page<InvoiceSummary>('/v1/platform/invoices', f, cursor, signal),
  invoice: async (id: string, signal?: AbortSignal) =>
    (await api.get<InvoiceDetail>(`/v1/platform/invoices/${enc(id)}`, { signal })).data,
  // O-05 / O-06
  operatorStatements: (cursor?: string, signal?: AbortSignal) =>
    page<SettlementStatement>('/v1/settlement-statements', {}, cursor, signal, 24),
  operatorStatement: async (id: string, signal?: AbortSignal) =>
    (await api.get<SettlementDetail>(`/v1/settlement-statements/${enc(id)}`, { signal })).data,
  dispute: (id: string, body: { expected_version: number; reason: string }, key: string) =>
    send<SettlementStatement>(`/v1/settlement-statements/${enc(id)}/dispute`, body, key),
  subscription: async (signal?: AbortSignal) =>
    (await api.get<SystemSubscription>('/v1/system-subscription', { signal })).data,
  operatorInvoice: async (id: string, signal?: AbortSignal) =>
    (await api.get<InvoiceDetail>(`/v1/system-subscription/invoices/${enc(id)}`, { signal })).data,
};
