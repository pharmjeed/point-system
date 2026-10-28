import { api } from './client';
import type { LoginRequest, LoginResult, Me, MfaSetup } from './types';

/**
 * Auth and session endpoints (07 §2.1). None of them takes an `Idempotency-Key` (`x-idempotency: none`);
 * all unsafe ones carry the CSRF header (client.ts). Secrets go in the request body only and are never
 * kept by the app after the call (PNT-022 acceptance 2).
 */
export async function login(body: LoginRequest): Promise<LoginResult> {
  return (await api.post<LoginResult>('/v1/auth/login', { body })).data;
}

export async function verifyMfa(body: { mfa_token: string; code: string }): Promise<Me> {
  return (await api.post<Me>('/v1/auth/mfa/verify', { body })).data;
}

export async function setupMfa(): Promise<MfaSetup> {
  return (await api.post<MfaSetup>('/v1/auth/mfa/setup')).data;
}

export async function confirmMfa(body: { code: string }): Promise<Me> {
  return (await api.post<Me>('/v1/auth/mfa/confirm', { body })).data;
}

export async function changeSecret(body: { current_secret: string; new_secret: string }): Promise<Me> {
  return (await api.post<Me>('/v1/auth/secret/change', { body })).data;
}

export async function logout(): Promise<void> {
  await api.post<void>('/v1/auth/logout');
}

export async function getMe(signal?: AbortSignal): Promise<Me> {
  return (await api.get<Me>('/v1/me', { signal })).data;
}
