/**
 * The customer's subscriptions (V2-032; docs/v2/01 R2, C-08, C-09, C-10, C-14; docs/v2/04 §1; DEC-532, DEC-534):
 * subscribing to a venue's plan (C-09 → C-10, paid by the pay flow of C-10 with a card kept for the renewals), the list
 * of C-14, cancel at the end of the period, resume, and the covered vehicles (changed once per period). Amounts in
 * halalas, VAT included (C-09); the server decides every amount and every period boundary.
 */
import { z } from 'zod';
import {
  BillingCycleSchema,
  SubscriptionClosurePolicySchema,
  SubscriptionEligibilityKindSchema,
  SubscriptionEligibilitySourceSchema,
  SubscriptionEligibilityStatusSchema,
  SubscriptionEndedReasonSchema,
  SubscriptionFreezeStatusSchema,
  SubscriptionFrozenReasonSchema,
  SubscriptionRefundPolicySchema,
  SubscriptionRenewalModeSchema,
  SubscriptionStatusSchema,
  SubscriptionTermKindSchema,
  SubscriptionVehicleChangePolicySchema,
} from '../canon/subscriptions.js';
import { isIsoDate } from '../canon/service-days.js';
import { OnlinePaymentStatusSchema } from '../canon/payments-online.js';
import { CustomerPaymentSourceSchema, CustomerReceiptSchema } from './payments.js';

const iso = z.iso.datetime({ offset: true });
const isoDate = z.string().refine(isIsoDate, { message: 'a YYYY-MM-DD date' });

/**
 * The purchase consent recorded with the payment that starts a term (04 §7, DEC-601; annex clauses 3, 5, 6): the
 * subscription terms and the privacy policy at their versions in force, the price shown (net, VAT, total), the
 * non-refund condition when the plan is `non_refundable`, and the notice to take valuables out of the car. Required
 * for a plan that is non-refundable, renewed by hand or checked for eligibility; recorded whenever it is sent.
 */
export const CustomerPurchaseConsentSchema = z.strictObject({
  terms_version: z.string().min(1).max(40),
  privacy_version: z.string().min(1).max(40),
  /** the non-refund condition was shown and accepted (`refund_policy = non_refundable`) */
  non_refundable: z.boolean(),
  /** the valuables notice was shown before payment (annex clause 6) */
  valuables_notice: z.boolean(),
});
export type CustomerPurchaseConsent = z.infer<typeof CustomerPurchaseConsentSchema>;

/** A plan's policies as the app shows them before payment and on C-14 (04 §7, DEC-590). */
export const CustomerPlanPolicySchema = z.object({
  term_kind: SubscriptionTermKindSchema,
  /** a counted-day term: its counted days (22) and the weekdays that count (0 = Sunday … 6 = Saturday) */
  service_days: z.number().int().nullable(),
  service_weekdays: z.array(z.number().int().min(0).max(6)).nullable(),
  renewal_mode: SubscriptionRenewalModeSchema,
  refund_policy: SubscriptionRefundPolicySchema,
  closure_policy: SubscriptionClosurePolicySchema,
  /** visits a subscription covers per Riyadh day (null: no limit) */
  daily_visit_limit: z.number().int().nullable(),
  freeze_max_times: z.number().int(),
  freeze_max_days: z.number().int().nullable(),
  eligibility: SubscriptionEligibilityKindSchema,
  /** the covered car changes once per period, or any time before an intake (annex clause 1) */
  vehicle_change: SubscriptionVehicleChangePolicySchema,
});
export type CustomerPlanPolicy = z.infer<typeof CustomerPlanPolicySchema>;

/**
 * `POST /v1/customer/subscriptions` (C-09 → C-10, Idempotency-Key). An automatic renewal charges a saved card
 * (DEC-534): the source is a saved card of C-18, or a card tokenized on the device kept with `save_card` and the
 * explicit `card_on_file` consent at the version in force; an Apple Pay token cannot be charged again and is refused.
 * A plan renewed by hand (`renewal_mode = manual`, DEC-595) takes any source, Apple Pay and a card not kept included.
 * A plan checked for eligibility is applied for first (`…/apply`) and paid with `…/pay` once approved.
 */
export const CustomerSubscribeBodySchema = z
  .strictObject({
    plan_id: z.uuid(),
    billing_cycle: BillingCycleSchema,
    /** the covered vehicles of the account: 1 … the plan's `vehicles_included` */
    vehicle_ids: z.array(z.uuid()).min(1).max(5),
    source: CustomerPaymentSourceSchema,
    save_card: z.boolean().optional(),
    card_on_file_version: z.string().min(1).max(40).optional(),
    purchase_consent: CustomerPurchaseConsentSchema.optional(),
  })
  .refine((b) => new Set(b.vehicle_ids).size === b.vehicle_ids.length, {
    message: 'a vehicle is listed twice',
    path: ['vehicle_ids'],
  })
  .refine((b) => !b.save_card || b.source.type === 'token', {
    message: 'only a card tokenized on the device can be saved',
    path: ['save_card'],
  });
export type CustomerSubscribeBody = z.infer<typeof CustomerSubscribeBodySchema>;

/**
 * `POST /v1/customer/subscriptions/{subscriptionId}/pay` (Idempotency-Key): pays a subscription waiting for its
 * payment (`pending_payment`, after a declined card) or in its grace (`past_due`, «حدّث وسيلة الدفع»).
 */
export const CustomerSubscriptionPayBodySchema = z
  .strictObject({
    source: CustomerPaymentSourceSchema,
    save_card: z.boolean().optional(),
    card_on_file_version: z.string().min(1).max(40).optional(),
    purchase_consent: CustomerPurchaseConsentSchema.optional(),
  })
  .refine((b) => !b.save_card || b.source.type === 'token', {
    message: 'only a card tokenized on the device can be saved',
    path: ['save_card'],
  });
export type CustomerSubscriptionPayBody = z.infer<typeof CustomerSubscriptionPayBodySchema>;

/**
 * `POST /v1/customer/subscriptions/apply` (C-09, Idempotency-Key; DEC-596): an application for a plan checked for
 * eligibility (`student_id_review`) — the student number and the name as on the university card. Nothing is paid
 * here: the subscription waits in `pending_eligibility` for the platform's decision, or is approved at once when the
 * number is on the venue's eligible list or was approved there within 180 days (a renewal), and is then paid with
 * `…/{subscriptionId}/pay`.
 */
export const CustomerSubscriptionApplyBodySchema = z
  .strictObject({
    plan_id: z.uuid(),
    vehicle_ids: z.array(z.uuid()).min(1).max(5),
    student_number: z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .pipe(z.string().regex(/^[A-Z0-9-]{3,32}$/)),
    student_name: z.string().trim().min(2).max(80),
  })
  .refine((b) => new Set(b.vehicle_ids).size === b.vehicle_ids.length, {
    message: 'a vehicle is listed twice',
    path: ['vehicle_ids'],
  });
export type CustomerSubscriptionApplyBody = z.infer<typeof CustomerSubscriptionApplyBodySchema>;

/**
 * `POST /v1/customer/subscriptions/{subscriptionId}/freeze` (C-14 «تجميد», Idempotency-Key; DEC-594; annex clause
 * 4): a freeze asked in advance — it starts on a service day after today and returns on a service day, freezing at
 * most the plan's counted days (Friday and Saturday never count). Once per term; it stops the service and the count.
 */
export const CustomerSubscriptionFreezeBodySchema = z
  .strictObject({ starts_on: isoDate, returns_on: isoDate })
  .refine((b) => b.returns_on > b.starts_on, {
    message: 'the return comes after the start',
    path: ['returns_on'],
  });
export type CustomerSubscriptionFreezeBody = z.infer<typeof CustomerSubscriptionFreezeBodySchema>;

/** `POST …/{subscriptionId}/cancel`, `…/resume` and `…/unfreeze`: no body. */
export const CustomerSubscriptionCommandBodySchema = z.strictObject({});

/** `PUT /v1/customer/subscriptions/{subscriptionId}/vehicles` (C-14 «تغيير السيارة»): the full new list. */
export const CustomerSubscriptionVehiclesBodySchema = z
  .strictObject({ vehicle_ids: z.array(z.uuid()).min(1).max(5) })
  .refine((b) => new Set(b.vehicle_ids).size === b.vehicle_ids.length, {
    message: 'a vehicle is listed twice',
    path: ['vehicle_ids'],
  });
export type CustomerSubscriptionVehiclesBody = z.infer<typeof CustomerSubscriptionVehiclesBodySchema>;

/** The last payment of a subscription (C-10 polls it after 3-D Secure). */
export const CustomerSubscriptionPaymentSchema = z.object({
  payment_id: z.uuid(),
  subscription_id: z.uuid(),
  status: OnlinePaymentStatusSchema,
  amount_halalas: z.number().int(),
  vat_halalas: z.number().int(),
  currency: z.literal('SAR'),
  card_brand: z.string().nullable(),
  card_last4: z.string().nullable(),
  failure_code: z.string().nullable(),
  transaction_url: z.string().nullable(),
  callback_url: z.string(),
  paid_at: iso.nullable(),
  saved_payment_method_id: z.uuid().nullable(),
  receipt: CustomerReceiptSchema.nullable(),
});
export type CustomerSubscriptionPayment = z.infer<typeof CustomerSubscriptionPaymentSchema>;

/** A subscription as C-06 / C-14 show it (no other account's data, no operator ids beyond the venue's names). */
export const CustomerSubscriptionSchema = z.object({
  subscription_id: z.uuid(),
  venue_id: z.uuid(),
  venue_name_ar: z.string(),
  venue_name_en: z.string().nullable(),
  operator_name_ar: z.string(),
  operator_name_en: z.string().nullable(),
  plan_id: z.uuid(),
  plan_name_ar: z.string(),
  plan_name_en: z.string().nullable(),
  billing_cycle: BillingCycleSchema,
  status: SubscriptionStatusSchema,
  /** the price of the current period (and of the next one unless `next_price_halalas`) */
  price_halalas: z.number().int(),
  /** the new price of the next period, once a renewal notice announced it (DEC-531) */
  next_price_halalas: z.number().int().nullable(),
  vehicles_included: z.number().int(),
  vehicles: z.array(
    z.object({ vehicle_id: z.uuid(), plate_display: z.string().nullable(), removed: z.boolean() }),
  ),
  current_period_start: iso.nullable(),
  current_period_end: iso.nullable(),
  cancel_at_period_end: z.boolean(),
  /** the next renewal (active, not canceled), else null */
  renews_at: iso.nullable(),
  pending_expires_at: iso.nullable(),
  grace_ends_at: iso.nullable(),
  frozen_at: iso.nullable(),
  frozen_reason: SubscriptionFrozenReasonSchema.nullable(),
  /** C-14: the covered vehicles can be changed once per period */
  can_change_vehicles: z.boolean(),
  can_cancel: z.boolean(),
  can_resume: z.boolean(),
  can_pay: z.boolean(),
  latest_payment: CustomerSubscriptionPaymentSchema.nullable(),
  ended_at: iso.nullable(),
  ended_reason: SubscriptionEndedReasonSchema.nullable(),
  created_at: iso,
  // --- 04 §7 (V2-036, DEC-590 … DEC-602): the plan's policies and what they mean for this subscription ---
  policy: CustomerPlanPolicySchema,
  /** a counted-day term: its first and last counted days (Riyadh dates), once paid; the last moves with a freeze */
  service_start_on: isoDate.nullable(),
  service_end_on: isoDate.nullable(),
  /** a counted-day term: the counted days left from today (today included when it serves) */
  remaining_days: z.number().int().nullable(),
  /** a plan checked for eligibility: the application (the number masked but its last 3 characters) */
  eligibility: z
    .object({
      status: SubscriptionEligibilityStatusSchema,
      source: SubscriptionEligibilitySourceSchema.nullable(),
      student_number_masked: z.string(),
      decided_at: iso.nullable(),
      reason: z.string().nullable(),
    })
    .nullable(),
  /** the freeze of the current term (scheduled, active or used), else null */
  freeze: z
    .object({
      freeze_id: z.uuid(),
      status: SubscriptionFreezeStatusSchema,
      starts_on: isoDate,
      returns_on: isoDate,
      /** the counted days asked for (Friday and Saturday never count) */
      days: z.number().int(),
      /** the counted days actually frozen once it ended (shorter on an early reactivation) */
      used_days: z.number().int().nullable(),
      ended_on: isoDate.nullable(),
      /** the last counted day the term will have if the freeze runs as asked */
      projected_end_on: isoDate.nullable(),
    })
    .nullable(),
  /** customer freezes still allowed in this term */
  freezes_left: z.number().int(),
  can_freeze: z.boolean(),
  /** withdraw a scheduled freeze, or reactivate early from an active one */
  can_unfreeze: z.boolean(),
  /** a plan renewed by hand whose term ended: the plan to renew on from C-09 (a replacement when it was replaced) */
  renew_plan_id: z.uuid().nullable(),
  /** an exceptional refund: the day by which the money is back on the original payment method (12 calendar days) */
  refund_due_at: iso.nullable(),
});
export type CustomerSubscription = z.infer<typeof CustomerSubscriptionSchema>;

export const CustomerSubscriptionListSchema = z.object({ items: z.array(CustomerSubscriptionSchema) });
export type CustomerSubscriptionList = z.infer<typeof CustomerSubscriptionListSchema>;

/** `POST /v1/customer/subscriptions` and `…/pay` → `data`: the subscription and the payment started for it. */
export const CustomerSubscriptionCheckoutSchema = z.object({
  subscription: CustomerSubscriptionSchema,
  payment: CustomerSubscriptionPaymentSchema,
});
export type CustomerSubscriptionCheckout = z.infer<typeof CustomerSubscriptionCheckoutSchema>;
