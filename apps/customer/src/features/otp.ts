/**
 * C-03 logic (01 §2): six digits, «إعادة الإرسال بعد 60 ث», 5 attempts then a 15-minute stop; the code arrives
 * on WhatsApp only (DEC-460). Every number shown here comes from the server's answer (`resend_available_at`,
 * `attempts_left`, `locked_until`); the screen only counts down to them. Pure: the screen holds the state.
 */
import { CUSTOMER_OTP_LENGTH, type CustomerOtpChallenge } from '@point/shared/customer';
import { ApiError } from '../api/errors';
import { NetworkError } from '../api/transport';
import { toLatinDigits } from '../i18n/format';

export type OtpNotice =
  | { kind: 'invalid'; attemptsLeft: number | null }
  | { kind: 'expired' }
  | { kind: 'locked' }
  | { kind: 'resent' }
  | { kind: 'rateLimited' }
  | { kind: 'channelDown' }
  | { kind: 'network' }
  | { kind: 'server'; messageAr: string; message: string };

export interface OtpState {
  phoneE164: string;
  phoneMasked: string;
  /** Epoch ms. */
  resendAvailableAt: number;
  attemptsLeft: number;
  /** Epoch ms, or null when not locked. */
  lockedUntil: number | null;
  notice: OtpNotice | null;
}

export function fromChallenge(phoneE164: string, c: CustomerOtpChallenge): OtpState {
  return {
    phoneE164,
    phoneMasked: c.phone_masked,
    resendAvailableAt: Date.parse(c.resend_available_at),
    attemptsLeft: c.attempts_left,
    lockedUntil: null,
    notice: null,
  };
}

/** Keeps Latin digits only (any script typed or pasted, «123 456» included), at most six. */
export function sanitizeCode(raw: string): string {
  return toLatinDigits(raw).replace(/\D/g, '').slice(0, CUSTOMER_OTP_LENGTH);
}

export const isLocked = (s: OtpState, now: number): boolean => s.lockedUntil !== null && s.lockedUntil > now;

export const resendSecondsLeft = (s: OtpState, now: number): number =>
  Math.max(0, Math.ceil((s.resendAvailableAt - now) / 1000));

export const canResend = (s: OtpState, now: number): boolean =>
  !isLocked(s, now) && resendSecondsLeft(s, now) === 0;

/** No automatic submit on the sixth digit (03 §3.11): the button sends, and only a complete code. */
export const canSubmit = (s: OtpState, code: string, now: number): boolean =>
  !isLocked(s, now) && code.length === CUSTOMER_OTP_LENGTH;

function common(s: OtpState, e: unknown, now: number): OtpState {
  if (e instanceof NetworkError) return { ...s, notice: { kind: 'network' } };
  if (!(e instanceof ApiError)) return { ...s, notice: { kind: 'network' } };
  switch (e.code) {
    case 'CUSTOMER_OTP_LOCKED': {
      const until = Date.parse(e.detailString('locked_until') ?? '');
      return {
        ...s,
        lockedUntil: Number.isFinite(until) ? until : now + 15 * 60_000,
        notice: { kind: 'locked' },
      };
    }
    case 'CUSTOMER_OTP_EXPIRED':
      return { ...s, notice: { kind: 'expired' } };
    case 'RATE_LIMITED': {
      const wait = e.detailNumber('retry_after_s');
      return {
        ...s,
        resendAvailableAt: wait !== undefined ? now + wait * 1000 : s.resendAvailableAt,
        notice: { kind: 'rateLimited' },
      };
    }
    case 'WA_CHANNEL_UNAVAILABLE':
      return { ...s, notice: { kind: 'channelDown' } };
    default:
      return { ...s, notice: { kind: 'server', messageAr: e.messageAr, message: e.message } };
  }
}

/** After `POST /v1/customer/auth/verify` failed. */
export function applyVerifyError(s: OtpState, e: unknown, now: number): OtpState {
  if (e instanceof ApiError && e.code === 'CUSTOMER_OTP_INVALID') {
    const left = e.detailNumber('attempts_left');
    return {
      ...s,
      attemptsLeft: left ?? Math.max(0, s.attemptsLeft - 1),
      notice: { kind: 'invalid', attemptsLeft: left ?? null },
    };
  }
  return common(s, e, now);
}

/** After a successful resend: a new countdown from the server's time. */
export function applyResent(s: OtpState, c: CustomerOtpChallenge): OtpState {
  return {
    ...s,
    phoneMasked: c.phone_masked,
    resendAvailableAt: Date.parse(c.resend_available_at),
    attemptsLeft: c.attempts_left,
    notice: { kind: 'resent' },
  };
}

/** After a resend failed. */
export const applyResendError = (s: OtpState, e: unknown, now: number): OtpState => common(s, e, now);
