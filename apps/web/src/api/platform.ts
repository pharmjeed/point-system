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
