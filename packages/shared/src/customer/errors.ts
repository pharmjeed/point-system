/**
 * Error codes of the customer API `/v1/customer/*` (V2, docs/v2/05_API_Integrations.md §5). The envelope is the
 * one of 08 §1 (`{ error: { code, message, message_ar, request_id, retryable, details } }`). The new V2 codes are
 * catalogued here; the V1 codes the customer API reuses keep their 08 definition (`ERROR_CATALOG`).
 *
 * The client parses `code` as a plain string so that a code added later on the server never breaks an installed
 * app: unknown codes fall back to `message_ar`/`message` from the server (V2-011, DEC-482).
 */
import { z } from 'zod';
import { ERROR_CATALOG, type ErrorCode, type ErrorDef } from '../errors.js';

/** New codes introduced by the customer API (05 §5 plus V2-011, DEC-482). */
export const CUSTOMER_ERROR_CODES = [
  'CUSTOMER_OTP_INVALID',
  'CUSTOMER_OTP_EXPIRED',
  'CUSTOMER_OTP_LOCKED',
  'CUSTOMER_CONSENT_VERSION_STALE',
  'CUSTOMER_VEHICLE_LIMIT',
  'CUSTOMER_VEHICLE_DUPLICATE',
  'VENUE_NOT_LISTED',
  'ACCOUNT_DELETED',
  // V2-012 / V2-017 (DEC-505, DEC-507, DEC-508): C-15 remove a vehicle, C-20 delete the account
  'CUSTOMER_VEHICLE_IN_ACTIVE_VISIT',
  'CUSTOMER_ACCOUNT_VISIT_ACTIVE',
  'CUSTOMER_REAUTH_REQUIRED',
  // V2-015 (DEC-517, DEC-518): C-12's handover code, C-13's rating
  'HANDOVER_CODE_UNAVAILABLE',
  'CUSTOMER_VISIT_NOT_DELIVERED',
  'CUSTOMER_VISIT_ALREADY_RATED',
  // V2-022 / V2-023 (DEC-521, DEC-524): paying a visit in the app, saving a card
  'VISIT_NOT_PAYABLE',
  'PAYMENT_IN_PROGRESS',
  'CUSTOMER_CONSENT_REQUIRED',
  // V2-032 (DEC-534): the subscriptions (05 §5)
  'SUBSCRIPTION_ALREADY_EXISTS',
  'SUBSCRIPTION_NOT_ACTIVE',
  'SUBSCRIPTION_PLAN_UNAVAILABLE',
  'SUBSCRIPTION_VEHICLES_LOCKED',
  'SUBSCRIPTION_CARD_REQUIRED',
] as const;
export type CustomerErrorCode = (typeof CUSTOMER_ERROR_CODES)[number];
export const CustomerErrorCodeSchema = z.enum(CUSTOMER_ERROR_CODES);

/** V1 codes (08 §4) the customer API answers with, unchanged. */
export const CUSTOMER_REUSED_ERROR_CODES = [
  'AUTH_UNAUTHENTICATED',
  'AUTH_SESSION_EXPIRED',
  'AUTH_SESSION_REVOKED',
  // a suspended account (customer_accounts.status, P-06) cannot sign in or call the API (V2-010, DEC-497)
  'AUTH_ACCOUNT_DISABLED',
  'VALIDATION_FAILED',
  'PHONE_INVALID',
  'PLATE_INVALID',
  'RESOURCE_NOT_FOUND',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_IN_PROGRESS',
  'WA_CHANNEL_UNAVAILABLE',
  // V2-015 (DEC-516, DEC-517): the request from C-12 answers as the staff request does
  'TICKET_CLOSED',
  'RETRIEVAL_ALREADY_ACTIVE',
  'HANDOVER_NOT_READY',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  // V2-022 (DEC-521): the gateway declined, the ticket is paid already (online or cash/POS), the gateway is slow
  'PAYMENT_FAILED',
  'PAYMENT_ALREADY_RECORDED',
  'DEPENDENCY_TIMEOUT',
] as const satisfies readonly ErrorCode[];
export type CustomerReusedErrorCode = (typeof CUSTOMER_REUSED_ERROR_CODES)[number];

/** Every code the customer API documents. */
export type CustomerApiErrorCode = CustomerErrorCode | CustomerReusedErrorCode;

/**
 * The V2 catalog, in the shape of 08 (`ErrorDef`). Arabic text is customer-facing (V2-D01). `details`:
 * `CUSTOMER_OTP_INVALID` → `{ attempts_left }`; `CUSTOMER_OTP_LOCKED` → `{ locked_until }`;
 * `CUSTOMER_VEHICLE_LIMIT` → `{ max }`; `RATE_LIMITED` on `POST /v1/customer/auth/otp` → `{ retry_after_s }`;
 * `CUSTOMER_REAUTH_REQUIRED` → `{ reason: 'missing' | 'invalid' | 'expired' }`;
 * `HANDOVER_CODE_UNAVAILABLE` → `{ reason: 'whatsapp' | 'staff' | 'locked' | 'expired' | 'none' }` (V2-015);
 * `VISIT_NOT_PAYABLE` → `{ reason: 'delivered' | 'voided' | 'not_due' | 'entitlement' | 'below_minimum' }`;
 * `PAYMENT_IN_PROGRESS` → `{ online_payment_id, retry_after_s }`; `CUSTOMER_CONSENT_REQUIRED` → `{ kind:
 * 'card_on_file', current_version }` (V2-022 / V2-023); `SUBSCRIPTION_ALREADY_EXISTS` → `{ subscription_id, status }`;
 * `SUBSCRIPTION_NOT_ACTIVE` → `{ subscription_id, current_status, command }`; `SUBSCRIPTION_PLAN_UNAVAILABLE` →
 * `{ reason: 'retired' | 'cycle' | 'not_sold' }`; `SUBSCRIPTION_VEHICLES_LOCKED` → `{ available_at }`;
 * `SUBSCRIPTION_CARD_REQUIRED` → `{ source_type }` (V2-032).
 */
export const CUSTOMER_ERROR_CATALOG: Readonly<Record<CustomerErrorCode, Omit<ErrorDef, 'alert'>>> = {
  CUSTOMER_OTP_INVALID: {
    http: 422,
    retryable: false,
    log: 'info',
    message: 'The verification code is incorrect.',
    message_ar: 'رمز التحقق غير صحيح.',
  },
  CUSTOMER_OTP_EXPIRED: {
    http: 410,
    retryable: false,
    log: 'info',
    message: 'The verification code has expired. Request a new one.',
    message_ar: 'انتهت صلاحية الرمز. اطلب رمزًا جديدًا.',
  },
  CUSTOMER_OTP_LOCKED: {
    http: 423,
    retryable: false,
    log: 'warn',
    message: 'Too many wrong codes. Try again later.',
    message_ar: 'محاولات كثيرة خاطئة. حاول بعد 15 دقيقة.',
  },
  CUSTOMER_CONSENT_VERSION_STALE: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'The terms were updated. Review the new version.',
    message_ar: 'حُدّثت الشروط. راجع النسخة الجديدة ثم وافق.',
  },
  CUSTOMER_VEHICLE_LIMIT: {
    http: 422,
    retryable: false,
    log: 'info',
    message: 'The vehicle limit for the account is reached.',
    message_ar: 'وصلت إلى الحد الأقصى للسيارات في حسابك.',
  },
  CUSTOMER_VEHICLE_DUPLICATE: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'This vehicle is already in your account.',
    message_ar: 'هذه السيارة مضافة في حسابك.',
  },
  VENUE_NOT_LISTED: {
    http: 404,
    retryable: false,
    log: 'info',
    message: 'This location is not available in the app.',
    message_ar: 'هذا الموقع غير متاح في التطبيق.',
  },
  ACCOUNT_DELETED: {
    http: 410,
    retryable: false,
    log: 'info',
    message: 'This account was deleted.',
    message_ar: 'حُذف هذا الحساب.',
  },
  CUSTOMER_VEHICLE_IN_ACTIVE_VISIT: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'This vehicle is in a visit in progress. Remove it after the visit ends.',
    message_ar: 'هذه السيارة في زيارة جارية. احذفها بعد انتهاء الزيارة.',
  },
  CUSTOMER_ACCOUNT_VISIT_ACTIVE: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'You have a visit in progress. Delete the account after you collect your car.',
    message_ar: 'لديك زيارة جارية. احذف الحساب بعد استلام سيارتك.',
  },
  // 403, not 401: the app signs out on every 401 but AUTH_SESSION_EXPIRED, and the session itself is fine (DEC-507)
  CUSTOMER_REAUTH_REQUIRED: {
    http: 403,
    retryable: false,
    log: 'info',
    message: 'Confirm with a new verification code first.',
    message_ar: 'أكّد أولًا برمز تحقق جديد.',
  },
  // V2-015 (DEC-517): the car is ready but no code can be shown here — sent on WhatsApp, none for this visit, locked
  // after wrong attempts, or expired (the driver issues a new one)
  HANDOVER_CODE_UNAVAILABLE: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'The handover code cannot be shown here. Ask the driver or the supervisor at the gate.',
    message_ar: 'لا يمكن عرض رمز التسليم هنا. اطلب المساعدة من السائق أو المشرف عند البوابة.',
  },
  CUSTOMER_VISIT_NOT_DELIVERED: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'You can rate the visit after you collect your car.',
    message_ar: 'يمكنك تقييم الزيارة بعد استلام سيارتك.',
  },
  CUSTOMER_VISIT_ALREADY_RATED: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'You already rated this visit.',
    message_ar: 'قيّمت هذه الزيارة مسبقًا.',
  },
  // V2-022 (DEC-521): nothing to pay in the app for this visit (included, delivered, waived …)
  VISIT_NOT_PAYABLE: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'There is nothing to pay in the app for this visit.',
    message_ar: 'لا يوجد ما يُدفع في التطبيق لهذه الزيارة.',
  },
  // V2-022 (DEC-521): an earlier payment of this visit still waits for the bank (3-D Secure)
  PAYMENT_IN_PROGRESS: {
    http: 409,
    retryable: true,
    log: 'info',
    message: 'A payment for this visit is still in progress. Try again in a few minutes.',
    message_ar: 'هناك عملية دفع جارية لهذه الزيارة. حاول بعد دقائق.',
  },
  // V2-022 / V2-023 (DEC-524): a card is kept only with the explicit card_on_file consent
  CUSTOMER_CONSENT_REQUIRED: {
    http: 422,
    retryable: false,
    log: 'info',
    message: 'Agree to keep the card for later payments first.',
    message_ar: 'وافق أولًا على حفظ البطاقة للمدفوعات القادمة.',
  },
  // V2-032 (DEC-534): one live subscription per account and venue (uq_subscriptions_live)
  SUBSCRIPTION_ALREADY_EXISTS: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'You already have a subscription at this location.',
    message_ar: 'لديك اشتراك في هذا الموقع.',
  },
  // V2-032: the command does not apply to the subscription in its current status (04 §1)
  SUBSCRIPTION_NOT_ACTIVE: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'This subscription cannot be changed in its current status.',
    message_ar: 'لا يمكن تعديل هذا الاشتراك في حالته الحالية.',
  },
  // V2-032: the plan is retired, does not sell the cycle, or the location sells no subscriptions any more
  SUBSCRIPTION_PLAN_UNAVAILABLE: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'This plan is not available any more. Choose another one.',
    message_ar: 'هذه الباقة لم تعد متاحة. اختر باقة أخرى.',
  },
  // V2-032 (01 R6): the covered vehicles change once per period
  SUBSCRIPTION_VEHICLES_LOCKED: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'You already changed the covered vehicle this period.',
    message_ar: 'غيّرت السيارة المشمولة في هذه الفترة. يمكنك التغيير في الفترة القادمة.',
  },
  // V2-032 (DEC-534): the renewals charge a saved card, so the subscription is paid with one
  SUBSCRIPTION_CARD_REQUIRED: {
    http: 422,
    retryable: false,
    log: 'info',
    message: 'Pay with a card kept for the automatic renewal.',
    message_ar: 'ادفع ببطاقة تُحفظ للتجديد التلقائي.',
  },
};

const isCustomerErrorCode = (code: string): code is CustomerErrorCode =>
  (CUSTOMER_ERROR_CODES as readonly string[]).includes(code);

/** Definition of any code the customer API answers with: the V2 catalog first, then 08's (`ERROR_CATALOG`). */
export function customerErrorDef(code: CustomerApiErrorCode): Omit<ErrorDef, 'alert'> {
  return isCustomerErrorCode(code) ? CUSTOMER_ERROR_CATALOG[code] : ERROR_CATALOG[code];
}

/** The error body as the app reads it: `code` is any string (forward compatible, DEC-482). */
export const CustomerErrorBodySchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  message_ar: z.string(),
  request_id: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).default({}),
});
export type CustomerErrorBody = z.infer<typeof CustomerErrorBodySchema>;

export const CustomerErrorEnvelopeSchema = z.object({ error: CustomerErrorBodySchema });
export type CustomerErrorEnvelope = z.infer<typeof CustomerErrorEnvelopeSchema>;
