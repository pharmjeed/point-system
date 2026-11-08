import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from '@/api/errors';
import { classifyLoginError } from '@/features/auth/loginErrors';
import { errorMessagesAr } from '@/i18n/errors';

/** PNT-022 acceptance 1: each sign-in error is shown with its 08 text (server message_ar first). */
const err = (
  code: keyof typeof errorMessagesAr,
  extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {},
) => new ApiError({ code, status: 400, message_ar: errorMessagesAr[code], requestId: 'req_x', ...extra });

describe('classifyLoginError (02 D-01/S-01, 08 §4.1)', () => {
  it('AUTH_INVALID_CREDENTIALS → inline under the secret, which is cleared', () => {
    expect(classifyLoginError(err('AUTH_INVALID_CREDENTIALS'))).toEqual({
      kind: 'field',
      field: 'secret',
      message: 'بيانات الدخول غير صحيحة.',
      clearField: true,
    });
    expect(classifyLoginError(err('AUTH_INVALID_CREDENTIALS'), 'secret')).toMatchObject({ field: 'current' });
  });

  it('AUTH_ACCOUNT_LOCKED → inline with the lock end from details.locked_until', () => {
    const until = '2026-10-29T19:00:00Z';
    expect(classifyLoginError(err('AUTH_ACCOUNT_LOCKED', { details: { locked_until: until } }))).toEqual({
      kind: 'locked',
      message: 'أُوقف الدخول مؤقتًا لكثرة المحاولات. حاول لاحقًا.',
      until: Date.parse(until),
    });
  });

  it('AUTH_ACCOUNT_DISABLED → dialog', () => {
    expect(classifyLoginError(err('AUTH_ACCOUNT_DISABLED'))).toEqual({
      kind: 'dialog',
      message: 'هذا الحساب معطّل. راجع الإدارة.',
    });
  });

  it('AUTH_SECRET_CHANGE_REQUIRED → D-02 / S-01 step 3; AUTH_MFA_SETUP_REQUIRED → S-01 step 4', () => {
    expect(classifyLoginError(err('AUTH_SECRET_CHANGE_REQUIRED')).kind).toBe('secretChange');
    expect(classifyLoginError(err('AUTH_MFA_SETUP_REQUIRED')).kind).toBe('mfaSetup');
  });

  it('AUTH_MFA_INVALID → inline on the code; AUTH_MFA_REQUIRED → restart from the password', () => {
    expect(classifyLoginError(err('AUTH_MFA_INVALID'), 'mfa')).toMatchObject({
      kind: 'field',
      field: 'code',
      message: 'رمز التحقق غير صحيح.',
    });
    expect(classifyLoginError(err('AUTH_MFA_REQUIRED'), 'mfa')).toEqual({
      kind: 'restart',
      message: 'انتهت خطوة التحقق. سجّل الدخول مجددًا.',
    });
  });

  it('PHONE_INVALID → under the phone; VALIDATION_FAILED → the named field', () => {
    expect(classifyLoginError(err('PHONE_INVALID'))).toMatchObject({ kind: 'field', field: 'phone' });
    const validation = err('VALIDATION_FAILED', {
      details: { fields: [{ field: 'new_secret', issue: 'weak', message_ar: 'اختر رقمًا سريًا أقوى.' }] },
    });
    expect(classifyLoginError(validation, 'secret')).toMatchObject({
      kind: 'field',
      field: 'next',
      message: 'اختر رقمًا سريًا أقوى.',
    });
  });

  it('RATE_LIMITED → blocked until Retry-After', () => {
    expect(classifyLoginError(err('RATE_LIMITED', { retryAfterS: 20 }), 'login', 1000)).toEqual({
      kind: 'rate',
      message: 'طلبات كثيرة. انتظر قليلًا ثم حاول.',
      until: 21_000,
    });
  });

  it('other errors → form message with the request id; no reply → offline text', () => {
    expect(classifyLoginError(err('INTERNAL_ERROR'))).toEqual({
      kind: 'form',
      message: 'حدث خطأ غير متوقع. أعد المحاولة.',
      requestId: 'req_x',
    });
    expect(classifyLoginError(new NetworkError('offline'))).toEqual({
      kind: 'offline',
      message: 'لا يوجد اتصال بالإنترنت.',
    });
  });

  it('shows the server text when it differs from the local map', () => {
    const custom = new ApiError({
      code: 'AUTH_INVALID_CREDENTIALS',
      status: 401,
      message_ar: 'نص من الخادم',
    });
    expect(classifyLoginError(custom)).toMatchObject({ message: 'نص من الخادم' });
  });
});
