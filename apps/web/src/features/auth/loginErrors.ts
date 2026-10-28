import { ApiError, NetworkError } from '@/api/errors';
import { d01 } from '@/i18n/ar';
import { errorMessagesAr } from '@/i18n/errors';

/**
 * How each sign-in error is shown (02 D-01/S-01, 08 §4.1). The text is the server's `message_ar`
 * (08 text); the 08 map is the fallback. Pure, so it is unit-tested.
 */
export type LoginErrorAction =
  | {
      kind: 'field';
      field: 'phone' | 'secret' | 'code' | 'current' | 'next';
      message: string;
      clearField: boolean;
    }
  | { kind: 'form'; message: string; requestId: string | null }
  | { kind: 'locked'; message: string; until: number | null }
  | { kind: 'rate'; message: string; until: number }
  | { kind: 'dialog'; message: string }
  | { kind: 'secretChange' }
  | { kind: 'mfaSetup' }
  | { kind: 'restart'; message: string }
  | { kind: 'offline'; message: string };

const FIELD_MAP: Record<string, 'phone' | 'secret' | 'code' | 'current' | 'next'> = {
  phone: 'phone',
  secret: 'secret',
  code: 'code',
  current_secret: 'current',
  new_secret: 'next',
};

export function classifyLoginError(
  error: unknown,
  context: 'login' | 'mfa' | 'secret' = 'login',
  now: number = Date.now(),
): LoginErrorAction {
  if (error instanceof NetworkError) return { kind: 'offline', message: d01.offline };
  if (!(error instanceof ApiError))
    return { kind: 'form', message: errorMessagesAr.INTERNAL_ERROR, requestId: null };
  const message = error.message_ar;
  switch (error.code) {
    case 'AUTH_INVALID_CREDENTIALS':
      // 08: inline, only the secret field is cleared. On D-02/S-01 step 3 it is the *current* secret.
      return { kind: 'field', field: context === 'secret' ? 'current' : 'secret', message, clearField: true };
    case 'AUTH_ACCOUNT_LOCKED': {
      const until =
        typeof error.details.locked_until === 'string' ? Date.parse(error.details.locked_until) : NaN;
      return { kind: 'locked', message, until: Number.isNaN(until) ? null : until };
    }
    case 'AUTH_ACCOUNT_DISABLED':
      return { kind: 'dialog', message };
    case 'AUTH_SECRET_CHANGE_REQUIRED':
      return { kind: 'secretChange' };
    case 'AUTH_MFA_SETUP_REQUIRED':
      return { kind: 'mfaSetup' };
    case 'AUTH_MFA_INVALID':
      return { kind: 'field', field: 'code', message, clearField: true };
    case 'AUTH_MFA_REQUIRED':
    case 'AUTH_SESSION_EXPIRED':
      // The 5-minute single-use mfa_token is gone: start again from the password (07 §1.2, 08 §4.1).
      return { kind: 'restart', message };
    case 'PHONE_INVALID':
      return { kind: 'field', field: 'phone', message, clearField: false };
    case 'VALIDATION_FAILED': {
      const first = error.fields.find((f) => FIELD_MAP[f.field]);
      if (first) {
        const field = FIELD_MAP[first.field] ?? 'secret';
        return { kind: 'field', field, message: first.message_ar || message, clearField: false };
      }
      return { kind: 'form', message, requestId: error.requestId };
    }
    case 'RATE_LIMITED':
      return { kind: 'rate', message, until: now + (error.retryAfterS ?? 30) * 1000 };
    default:
      return { kind: 'form', message, requestId: error.requestId };
  }
}
