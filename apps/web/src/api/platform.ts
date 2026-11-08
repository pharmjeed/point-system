import { api } from './client';
import type { MfaSetup } from './types';

/**
 * V2 platform console endpoints (`/v1/platform/*`, docs/07_openapi.yaml tag Platform, DEC-462). The platform session
 * lives in its own httpOnly cookie (`__Host-point_psid`); none of these calls touches the staff session.
 */
export type PlatformRole = 'platform_owner' | 'platform_admin' | 'platform_finance' | 'platform_support';

export interface PlatformMe {
  user: {
    id: string;
    full_name: string;
    phone_e164?: string;
    phone_masked: string;
    role: PlatformRole;
    status: 'active' | 'disabled';
    mfa_enabled: boolean;
    must_change_secret: boolean;
    last_login_at?: string | null;
  };
  permissions: string[];
  session: {
    expires_at: string;
    mfa_verified: boolean;
    restricted: boolean;
    pending: Array<'secret_change' | 'mfa_setup'>;
  };
  brand: { staff_name_ar: string; staff_name_en: string };
}

export interface PlatformLoginResult {
  mfa_required: boolean;
  mfa_token: string | null;
  mfa_setup_required: boolean;
  must_change_secret: boolean;
  me: PlatformMe | null;
}

export async function platformLogin(body: { phone: string; secret: string }): Promise<PlatformLoginResult> {
  return (await api.post<PlatformLoginResult>('/v1/platform/auth/login', { body })).data;
}

export async function platformVerifyMfa(body: { mfa_token: string; code: string }): Promise<PlatformMe> {
  return (await api.post<PlatformMe>('/v1/platform/auth/mfa/verify', { body })).data;
}

export async function platformSetupMfa(): Promise<MfaSetup> {
  return (await api.post<MfaSetup>('/v1/platform/auth/mfa/setup')).data;
}

export async function platformConfirmMfa(body: { code: string }): Promise<PlatformMe> {
  return (await api.post<PlatformMe>('/v1/platform/auth/mfa/confirm', { body })).data;
}

export async function platformChangeSecret(body: {
  current_secret: string;
  new_secret: string;
}): Promise<PlatformMe> {
  return (await api.post<PlatformMe>('/v1/platform/auth/secret/change', { body })).data;
}

export async function platformLogout(): Promise<void> {
  await api.post<void>('/v1/platform/auth/logout');
}

export async function getPlatformMe(signal?: AbortSignal): Promise<PlatformMe> {
  return (await api.get<PlatformMe>('/v1/platform/me', { signal })).data;
}

/** The step a restricted platform session must finish: the password first, then the TOTP set-up. */
export function platformPendingStep(me: PlatformMe): 'password' | 'mfa-setup' | null {
  const first = me.session.pending[0];
  return first === 'secret_change' ? 'password' : first === 'mfa_setup' ? 'mfa-setup' : null;
}

/** Codes that mean «no usable platform session»: back to /platform/login. */
export const PLATFORM_SIGNED_OUT_CODES: readonly string[] = [
  'PLATFORM_AUTH_REQUIRED',
  'AUTH_SESSION_EXPIRED',
  'AUTH_SESSION_REVOKED',
  'AUTH_ACCOUNT_DISABLED',
];

// ------------------------------------------------------------------------- P-01 … P-03 (V2-003) and V2-005

/** `organizations.operator_status` (docs/v2/02 §4). */
export type OperatorStatus = 'invited' | 'trial' | 'active' | 'suspended' | 'terminated';
export type OperatorCommand = 'activate' | 'suspend' | 'reactivate' | 'terminate';

export interface PlatformOverview {
  operators: { total: number; by_status: Record<OperatorStatus, number> };
  venues: { total: number; active: number };
  drivers_on_duty: number;
  tickets_today: number;
  /** V2-035: active subscribers and MRR (older servers omit it) */
  subscriptions?: { active: number; mrr_halalas: number };
  day: string;
  generated_at: string;
}

export interface OperatorContract {
  id: string;
  org_id: string;
  saas_fee_halalas_per_venue: number;
  saas_cycle: 'monthly' | 'yearly';
  subscriber_visit_payout_halalas: number;
  app_payment_commission_bp: number;
  starts_on: string;
  ends_on: string | null;
  state: 'upcoming' | 'current' | 'ended';
  created_by: { id: string; full_name?: string | null };
  created_at: string;
}

export interface PlatformOperator {
  id: string;
  name_ar: string;
  name_en?: string | null;
  legal_name?: string | null;
  cr_number?: string | null;
  vat_number?: string | null;
  operator_status: OperatorStatus;
  is_platform_operated: boolean;
  venues_count: number;
  active_venues_count: number;
  staff_count: number;
  current_contract: OperatorContract | null;
  created_at: string;
}

export interface PlatformOperatorDetail extends PlatformOperator {
  venues: {
    id: string;
    code: string;
    name_ar: string;
    city?: string | null;
    status: 'active' | 'inactive';
  }[];
  owner: {
    id: string;
    full_name: string;
    employee_code: string;
    phone_masked: string;
    status: string;
    must_change_secret?: boolean;
    mfa_enabled?: boolean;
    last_login_at?: string | null;
    temporary_password_reissuable: boolean;
  } | null;
  status_history: {
    action: string;
    from_status?: OperatorStatus | null;
    to_status?: OperatorStatus | null;
    reason?: string | null;
    occurred_at: string;
    actor?: { id: string; full_name?: string | null } | null;
  }[];
}

export interface PlatformOperatorUser {
  id: string;
  employee_code: string;
  full_name: string;
  phone_masked: string;
  role: 'owner' | 'admin' | 'supervisor' | 'driver';
  can_drive: boolean;
  status: 'active' | 'disabled';
  mfa_enabled: boolean;
  last_login_at?: string | null;
  created_at?: string;
}

export interface CreateOperatorInput {
  name_ar: string;
  name_en?: string | null;
  legal_name: string;
  cr_number?: string | null;
  vat_number?: string | null;
  operator_status: 'trial' | 'active';
  owner: { full_name: string; phone: string };
}

export interface CreatedOperator {
  operator: PlatformOperator;
  owner: { id: string; full_name: string; employee_code: string; phone_masked: string };
  /** shown once; `null` when the server replays the answer (DEC-485) */
  temporary_password: string | null;
}

export interface CreateContractInput {
  saas_fee_halalas_per_venue: number;
  saas_cycle: 'monthly' | 'yearly';
  subscriber_visit_payout_halalas: number;
  app_payment_commission_bp: number;
  starts_on: string;
  ends_on?: string | null;
}

const op = (orgId: string) => `/v1/platform/operators/${encodeURIComponent(orgId)}`;
const send = async <T>(path: string, body: unknown, key: string): Promise<T> =>
  (await api.post<T>(path, { body, idempotencyKey: key })).data;

export const platformKeys = {
  overview: ['platform', 'overview'] as const,
  operators: ['platform', 'operators'] as const,
  operator: (orgId: string) => ['platform', 'operators', orgId] as const,
  users: (orgId: string) => ['platform', 'operators', orgId, 'users'] as const,
  contracts: (orgId: string) => ['platform', 'operators', orgId, 'contracts'] as const,
};

export const platformApi = {
  overview: async (signal?: AbortSignal) =>
    (await api.get<PlatformOverview>('/v1/platform/overview', { signal })).data,
  operators: async (signal?: AbortSignal) =>
    (await api.get<{ items: PlatformOperator[] }>('/v1/platform/operators', { signal })).data.items,
  operator: async (orgId: string, signal?: AbortSignal) =>
    (await api.get<PlatformOperatorDetail>(op(orgId), { signal })).data,
  users: async (orgId: string, signal?: AbortSignal) =>
    (await api.get<{ items: PlatformOperatorUser[] }>(`${op(orgId)}/users`, { signal })).data.items,
  contracts: async (orgId: string, signal?: AbortSignal) =>
    (await api.get<{ items: OperatorContract[] }>(`${op(orgId)}/contracts`, { signal })).data.items,
  createOperator: (body: CreateOperatorInput, key: string) =>
    send<CreatedOperator>('/v1/platform/operators', body, key),
  reissueOwnerPassword: (orgId: string, key: string) =>
    send<{ user_id: string; temporary_password: string | null }>(
      `${op(orgId)}/owner/temporary-password`,
      {},
      key,
    ),
  createContract: (orgId: string, body: CreateContractInput, key: string) =>
    send<OperatorContract>(`${op(orgId)}/contracts`, body, key),
  endContract: (
    orgId: string,
    contractId: string,
    body: { ends_on: string; reason?: string | null },
    key: string,
  ) => send<OperatorContract>(`${op(orgId)}/contracts/${encodeURIComponent(contractId)}/end`, body, key),
  transition: (orgId: string, command: OperatorCommand, reason: string | null, key: string) =>
    send<PlatformOperator>(`${op(orgId)}/${command}`, reason ? { reason } : {}, key),
};
