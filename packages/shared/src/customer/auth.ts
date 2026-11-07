/**
 * Customer sign-in (V2-D11 as amended by DEC-460): Saudi mobile + a 6-digit code delivered **over WhatsApp only**
 * (an authentication template on the platform number; no SMS, no password). A short access token and a rotating
 * refresh token per device, sent as `Authorization: Bearer` — no cookie (05 §1). Shapes chosen in V2-011
 * (DEC-482); the server (V2-010) implements them.
 */
import { z } from 'zod';
import { CustomerLocaleSchema, CustomerMeSchema, SaudiMobileE164Schema } from './account.js';

/** C-03: six digits. */
export const CUSTOMER_OTP_LENGTH = 6;
/** C-03: «إعادة الإرسال بعد 60 ث». */
export const CUSTOMER_OTP_RESEND_AFTER_S = 60;
/** C-03: five wrong codes, then a 15-minute lock. */
export const CUSTOMER_OTP_MAX_ATTEMPTS = 5;
export const CUSTOMER_OTP_LOCK_MINUTES = 15;
/** Lifetime of one code (DEC-482). */
export const CUSTOMER_OTP_TTL_S = 300;
/** Access token lifetime (DEC-482); the refresh token lives 60 days and rotates on every refresh. */
export const CUSTOMER_ACCESS_TTL_S = 900;
export const CUSTOMER_REFRESH_TTL_DAYS = 60;

/** WhatsApp is the only delivery channel (DEC-460). */
export const CUSTOMER_OTP_CHANNELS = ['whatsapp'] as const;
export const CustomerOtpChannelSchema = z.enum(CUSTOMER_OTP_CHANNELS);

/** `customer_account_sessions.platform` (03 §3). */
export const CUSTOMER_DEVICE_PLATFORMS = ['ios', 'android'] as const;
export type CustomerDevicePlatform = (typeof CUSTOMER_DEVICE_PLATFORMS)[number];
export const CustomerDevicePlatformSchema = z.enum(CUSTOMER_DEVICE_PLATFORMS);

/** A random id the app creates once per install and keeps in secure storage (rate limits per device, C-02). */
export const CustomerDeviceIdSchema = z.string().min(8).max(128);

export const CustomerOtpCodeSchema = z.string().regex(/^[0-9]{6}$/);

const iso = z.iso.datetime({ offset: true });

/** `POST /v1/customer/auth/otp` body. Calling it again (C-03 «إعادة الإرسال») issues a new code. */
export const CustomerOtpRequestBodySchema = z.strictObject({
  phone_e164: SaudiMobileE164Schema,
  device_id: CustomerDeviceIdSchema,
  platform: CustomerDevicePlatformSchema,
  /** Language of the WhatsApp authentication template. */
  locale: CustomerLocaleSchema.default('ar'),
});
export type CustomerOtpRequestBody = z.input<typeof CustomerOtpRequestBodySchema>;

/**
 * `POST /v1/customer/auth/otp` → `data`. Times are server times: the app counts down against them (C-03) and
 * never decides on its own that a resend is allowed. A resend before `resend_available_at` → `RATE_LIMITED`
 * with `details.retry_after_s`; during a lock → `CUSTOMER_OTP_LOCKED` with `details.locked_until`.
 */
export const CustomerOtpChallengeSchema = z.object({
  channel: CustomerOtpChannelSchema,
  phone_masked: z.string(),
  expires_at: iso,
  resend_available_at: iso,
  attempts_left: z.int().min(0).max(CUSTOMER_OTP_MAX_ATTEMPTS),
});
export type CustomerOtpChallenge = z.infer<typeof CustomerOtpChallengeSchema>;

/** `POST /v1/customer/auth/verify` body. A wrong code → `CUSTOMER_OTP_INVALID` with `details.attempts_left`. */
export const CustomerOtpVerifyBodySchema = z.strictObject({
  phone_e164: SaudiMobileE164Schema,
  code: CustomerOtpCodeSchema,
  device_id: CustomerDeviceIdSchema,
  platform: CustomerDevicePlatformSchema,
});
export type CustomerOtpVerifyBody = z.infer<typeof CustomerOtpVerifyBodySchema>;

export const CustomerTokensSchema = z.object({
  token_type: z.literal('Bearer'),
  access_token: z.string().min(16),
  access_expires_at: iso,
  refresh_token: z.string().min(16),
  refresh_expires_at: iso,
});
export type CustomerTokens = z.infer<typeof CustomerTokensSchema>;

/** `POST /v1/customer/auth/verify` → `data`: the account is created on the first verified sign-in. */
export const CustomerAuthResultSchema = CustomerTokensSchema.extend({
  account: CustomerMeSchema,
  is_new_account: z.boolean(),
});
export type CustomerAuthResult = z.infer<typeof CustomerAuthResultSchema>;

/**
 * `POST /v1/customer/auth/refresh` body → `data` = `CustomerTokens` (a new pair; the old refresh token stops
 * working). An expired, revoked or reused refresh token → `401 AUTH_SESSION_REVOKED` (the app signs out). An
 * expired access token on any other route → `401 AUTH_SESSION_EXPIRED` (the app refreshes once and retries).
 */
export const CustomerRefreshBodySchema = z.strictObject({
  refresh_token: z.string().min(16),
  device_id: CustomerDeviceIdSchema,
});
export type CustomerRefreshBody = z.infer<typeof CustomerRefreshBodySchema>;

/** `POST /v1/customer/auth/logout` (Bearer) body → `data` = `{ logged_out: true }`; revokes this device's session. */
export const CustomerLogoutBodySchema = z.strictObject({ refresh_token: z.string().min(16) });
export type CustomerLogoutBody = z.infer<typeof CustomerLogoutBodySchema>;
export const CustomerLogoutResultSchema = z.object({ logged_out: z.literal(true) });
