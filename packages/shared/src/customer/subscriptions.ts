/**
 * The customer's subscriptions (V2-032; docs/v2/01 R2, C-08, C-09, C-10, C-14; docs/v2/04 §1; DEC-532, DEC-534):
 * subscribing to a venue's plan (C-09 → C-10, paid by the pay flow of C-10 with a card kept for the renewals), the list
 * of C-14, cancel at the end of the period, resume, and the covered vehicles (changed once per period). Amounts in
 * halalas, VAT included (C-09); the server decides every amount and every period boundary.
 */
import { z } from 'zod';
import {
  BillingCycleSchema,
  SubscriptionEndedReasonSchema,
  SubscriptionFrozenReasonSchema,
  SubscriptionStatusSchema,
} from '../canon/subscriptions.js';
import { OnlinePaymentStatusSchema } from '../canon/payments-online.js';
import { CustomerPaymentSourceSchema, CustomerReceiptSchema } from './payments.js';

const iso = z.iso.datetime({ offset: true });

/**
 * `POST /v1/customer/subscriptions` (C-09 → C-10, Idempotency-Key). The renewals charge a saved card (DEC-534): the
 * source is a saved card of C-18, or a card tokenized on the device kept with `save_card` and the explicit
 * `card_on_file` consent at the version in force; an Apple Pay token cannot be charged again and is refused.
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
  })
  .refine((b) => !b.save_card || b.source.type === 'token', {
    message: 'only a card tokenized on the device can be saved',
    path: ['save_card'],
  });
export type CustomerSubscriptionPayBody = z.infer<typeof CustomerSubscriptionPayBodySchema>;

/** `POST …/{subscriptionId}/cancel` and `…/resume`: no body. */
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
