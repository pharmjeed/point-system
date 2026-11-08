/**
 * Account deletion (C-20, an App Store and Google Play requirement; docs/v2/01 R6) and the fresh WhatsApp
 * verification it needs (V2-017, DEC-507, DEC-508).
 *
 * 1. The app asks for a code for the account's own number with the sign-in call `POST /v1/customer/auth/otp`
 *    (same limits, same WhatsApp template, DEC-496).
 * 2. `POST /v1/customer/auth/reauth/verify` (Bearer) checks it like the sign-in verify (attempts, lock, expiry) and
 *    answers a short-lived, single-use `reauth_token` bound to the caller's session.
 * 3. `DELETE /v1/customer/me` (Bearer + Idempotency-Key) with `{ reauth_token }` deletes the account: personal data
 *    scrubbed, the phone kept as an irreversible keyed hash only, vehicles removed, sessions revoked, push tokens
 *    dropped, audit rows kept. Refused while a visit is in progress (`CUSTOMER_ACCOUNT_VISIT_ACTIVE`).
 */
import { z } from 'zod';
import { CustomerOtpCodeSchema } from './auth.js';

const iso = z.iso.datetime({ offset: true });

/** Lifetime of a re-verification proof: long enough to read C-20's last confirmation, short enough to be fresh. */
export const CUSTOMER_REAUTH_TTL_S = 300;

/** `POST /v1/customer/auth/reauth/verify` body: the code just sent to the account's own number. */
export const CustomerReauthVerifyBodySchema = z.strictObject({ code: CustomerOtpCodeSchema });
export type CustomerReauthVerifyBody = z.infer<typeof CustomerReauthVerifyBodySchema>;

/** `POST /v1/customer/auth/reauth/verify` → `data`: one proof per session, the last one replaces the previous. */
export const CustomerReauthSchema = z.object({
  reauth_token: z.string().min(16).max(200),
  expires_at: iso,
});
export type CustomerReauth = z.infer<typeof CustomerReauthSchema>;

/**
 * `DELETE /v1/customer/me` body. Without `reauth_token`, or with one that is not the live proof of this session →
 * `CUSTOMER_REAUTH_REQUIRED` (403) with `details.reason` `missing` / `invalid` / `expired`.
 */
export const CustomerAccountDeleteBodySchema = z.strictObject({
  reauth_token: z.string().min(16).max(200),
});
export type CustomerAccountDeleteBody = z.infer<typeof CustomerAccountDeleteBodySchema>;

/** `DELETE /v1/customer/me` → `data`. Every token of the account stops working in the same transaction. */
export const CustomerAccountDeletedSchema = z.object({
  deleted: z.literal(true),
  deleted_at: iso,
});
export type CustomerAccountDeleted = z.infer<typeof CustomerAccountDeletedSchema>;

/** `CUSTOMER_REAUTH_REQUIRED.details.reason`. */
export const CUSTOMER_REAUTH_REASONS = ['missing', 'invalid', 'expired'] as const;
export type CustomerReauthReason = (typeof CUSTOMER_REAUTH_REASONS)[number];
