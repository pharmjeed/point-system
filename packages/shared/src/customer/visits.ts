/**
 * The customer's visits (V2-015: C-12 «سيارتي الآن», C-16 «زياراتي», C-13 the rating; docs/v2/01 R3/R4, docs/v2/05
 * §1; DEC-516 … DEC-518). A visit is a ticket of one of the account's linked `customers` rows at any operator
 * (`listAccountVisits`, DEC-504) — never voided ones. What the customer sees is deliberately small (V2-D12, R3): no key
 * tag, no key slot, no parking spot, no staff, no operator notes; the handover code only through its own route when
 * the car is ready (DEC-38, DEC-517).
 */
import { z } from 'zod';
import { TicketStatusSchema } from '../canon/enums.js';
import { OnlinePaymentStatusSchema } from '../canon/payments-online.js';

const iso = z.iso.datetime({ offset: true });

/** `tickets.entitlement` (V2-014, DEC-502). */
export const CustomerVisitEntitlementSchema = z.enum(['none', 'subscription', 'app_paid', 'event_included']);

/**
 * The money side of a visit as the customer sees it (R4). V2-022 (DEC-521, DEC-522): `payable_in_app` = the «ادفع X
 * ريال» area of C-12 is offered (the fee is due, entitlement `none`, open, at least 1.00 SAR); `online_payment` = the
 * visit's latest payment in the app (its status after 3-D Secure, read from the server, never from the return).
 */
export const CustomerVisitPaymentSchema = z.object({
  entitlement: CustomerVisitEntitlementSchema,
  /** `tickets.payment_status`: nothing to pay, due at handover, collected, or waived by a supervisor. */
  payment_status: z.enum(['not_required', 'due', 'collected', 'waived']),
  /** The visit fee incl. VAT, in halalas (0 when nothing is due). */
  fee_halalas: z.int().min(0),
  payable_in_app: z.boolean(),
  online_payment: z
    .object({ payment_id: z.uuid(), status: OnlinePaymentStatusSchema, paid_at: iso.nullable() })
    .nullable(),
});
export type CustomerVisitPayment = z.infer<typeof CustomerVisitPaymentSchema>;

/** One line of C-16 (and the head of C-12). */
export const CustomerVisitSummarySchema = z.object({
  ticket_id: z.uuid(),
  venue_id: z.uuid(),
  venue_name_ar: z.string(),
  venue_name_en: z.string().nullable(),
  /** «تشغيل: …» (V2-D01) */
  operator_name_ar: z.string(),
  operator_name_en: z.string().nullable(),
  status: TicketStatusSchema,
  /** not delivered yet */
  open: z.boolean(),
  channel: z.enum(['whatsapp', 'paper', 'app']),
  plate_display: z.string().nullable(),
  received_at: iso,
  delivered_at: iso.nullable(),
  /** whole minutes from the intake to the delivery (null while open) */
  duration_min: z.int().min(0).nullable(),
  payment: CustomerVisitPaymentSchema,
  rated: z.boolean(),
});
export type CustomerVisitSummary = z.infer<typeof CustomerVisitSummarySchema>;

/** `GET /v1/customer/visits?cursor&limit` (C-16): newest first, `meta.next_cursor`. */
export const CUSTOMER_VISITS_PAGE_MAX = 50;
export const CustomerVisitListQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(CUSTOMER_VISITS_PAGE_MAX).default(20),
});
/** What the app sends (`limit` defaults to 20 on the server). */
export interface CustomerVisitListQuery {
  cursor?: string;
  limit?: number;
}

export const CustomerVisitListSchema = z.object({ items: z.array(CustomerVisitSummarySchema) });
export type CustomerVisitList = z.infer<typeof CustomerVisitListSchema>;

/** The steps of C-12's live timeline (from the ticket and its current cycle; null = not reached). */
export const CUSTOMER_VISIT_STEPS = [
  'received',
  'parked',
  'requested',
  'accepted',
  'on_the_way',
  'ready',
  'delivered',
] as const;
export type CustomerVisitStep = (typeof CUSTOMER_VISIT_STEPS)[number];
export const CustomerVisitTimelineSchema = z.array(
  z.object({ step: z.enum(CUSTOMER_VISIT_STEPS), at: iso.nullable() }),
);

/** «اطلب السيارة» on C-12: what the server would do with a request now (the source of truth stays the command). */
export const CustomerVisitRequestStateSchema = z.object({
  /** a request is accepted now: the car is parked with no open cycle, or being parked with no early request yet */
  can_request: z.boolean(),
  /** a request made while the car was being parked, waiting for the parking to finish (DEC-13) */
  pending_early: z.boolean(),
  /** the time of the open request (the early press time once converted) */
  requested_at: iso.nullable(),
});

/**
 * How this visit is handed over (DEC-517): `app_code` — the code is shown on C-12 when ready (an app ticket);
 * `whatsapp` — it reaches the customer in W-05 (a WhatsApp ticket of the account); `staff` — no code (paper stub or
 * the supervisor's identity exception).
 */
export const CustomerVisitHandoverSchema = z.object({
  method: z.enum(['app_code', 'whatsapp', 'staff']),
  /** `GET …/handover-code` answers now (the car is ready and the code is live). */
  code_available: z.boolean(),
  code_expires_at: iso.nullable(),
});

/** A photo of the intake inspection: a short-lived presigned link (≤ 300 s, DEC-494) read again on every display. */
export const CustomerVisitPhotoSchema = z.object({
  kind: z.enum(['photo_front', 'photo_rear', 'photo_left', 'photo_right', 'photo_extra', 'photo_damage']),
  url: z.url(),
  expires_at: iso,
});

export const CustomerVisitRatingSchema = z.object({
  ticket_id: z.uuid(),
  stars: z.int().min(1).max(5),
  note: z.string().nullable(),
  rated_at: iso,
});
export type CustomerVisitRating = z.infer<typeof CustomerVisitRatingSchema>;

/** `GET /v1/customer/visits/{ticketId}` → `data` (C-12). */
export const CustomerVisitDetailSchema = CustomerVisitSummarySchema.extend({
  timeline: CustomerVisitTimelineSchema,
  request: CustomerVisitRequestStateSchema,
  handover: CustomerVisitHandoverSchema,
  photos: z.array(CustomerVisitPhotoSchema),
  rating: CustomerVisitRatingSchema.nullable(),
  /** C-13 is offered: delivered, not rated yet */
  can_rate: z.boolean(),
  vehicle_make: z.string().nullable(),
  vehicle_color: z.string().nullable(),
});
export type CustomerVisitDetail = z.infer<typeof CustomerVisitDetailSchema>;

/**
 * `POST /v1/customer/visits/{ticketId}/request` → `data` (201): the same retrieval command as the WhatsApp «طلب
 * السيارة» (10 §7.2/§7.3, DEC-516). `requested` — a cycle and its queued task; `requested_early` — recorded while the
 * car is being parked, the request starts once it is parked (DEC-13).
 */
export const CustomerVisitRequestResultSchema = z.object({
  outcome: z.enum(['requested', 'requested_early']),
  visit: CustomerVisitDetailSchema,
});
export type CustomerVisitRequestResult = z.infer<typeof CustomerVisitRequestResultSchema>;

/** The request carries no body: an empty object (or none) only. */
export const CustomerVisitRequestBodySchema = z.strictObject({});

/**
 * `GET /v1/customer/visits/{ticketId}/handover-code` → `data` (DEC-38, DEC-517): only while the car is `ready` and its
 * code is live; decrypted from `claim_codes.code_ciphertext` for this account's session only, never logged, cached or
 * shown to staff.
 */
export const CustomerHandoverCodeSchema = z.object({
  ticket_id: z.uuid(),
  code: z.string().regex(/^[0-9]{6}$/),
  expires_at: iso,
  attempts_left: z.int().min(0),
});
export type CustomerHandoverCode = z.infer<typeof CustomerHandoverCodeSchema>;

/** `POST /v1/customer/visits/{ticketId}/rating` (C-13): once per visit, after the delivery. */
export const CUSTOMER_RATING_NOTE_MAX = 500;
export const CustomerVisitRatingBodySchema = z.strictObject({
  stars: z.int().min(1).max(5),
  note: z
    .string()
    .trim()
    .max(CUSTOMER_RATING_NOTE_MAX)
    .transform((v) => (v.length ? v : null))
    .nullable()
    .optional(),
});
export type CustomerVisitRatingBody = z.input<typeof CustomerVisitRatingBodySchema>;
