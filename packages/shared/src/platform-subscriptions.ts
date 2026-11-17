/**
 * V2-030 / V2-035 — the platform console's P-05 «باقات الاشتراك» and P-07 «الاشتراكات» (docs/v2/02 §2, docs/v2/04
 * §1; DEC-531, DEC-537): the query and body shapes of their `/v1/platform/*` routes, shared by the server
 * (validation) and the web console. The routes are rows of `PLATFORM_ROUTES`.
 */
import { z } from 'zod';
import {
  BillingCycleSchema,
  SUBSCRIPTION_POLICY_LIMITS,
  SubscriptionClosurePolicySchema,
  SubscriptionEligibilityKindSchema,
  SubscriptionPlanStatusSchema,
  SubscriptionRefundPolicySchema,
  SubscriptionRenewalModeSchema,
  SubscriptionStatusSchema,
  SubscriptionTermKindSchema,
  SubscriptionVehicleChangePolicySchema,
  VenueClosureKindSchema,
} from './canon/subscriptions.js';
import { isIsoDate } from './canon/service-days.js';
import { COMPLAINT_LIMITS, ComplaintCategorySchema, ComplaintStatusSchema } from './canon/complaints.js';
import { PLATFORM_REASON_MAX } from './platform-console.js';

const cursor = z.string().min(1).max(512).optional();
const limit = (max: number, def: number) => z.coerce.number().int().min(1).max(max).default(def);
/** halalas, VAT included (04 §4); the gateway's minimum is 1.00 SAR */
const price = z.number().int().min(100).max(100_000_000);

/**
 * `GET /v1/platform/plans` (P-05): the venues whose public profile exists, with their subscription switch and their
 * plans (active and retired). `q` searches the venue name; `subscriptions` keeps the venues selling subscriptions.
 */
export const PlatformPlansQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(60).optional(),
  venue_id: z.uuid().optional(),
  subscriptions: z.enum(['enabled', 'disabled']).optional(),
  cursor,
  limit: limit(100, 50),
});
export type PlatformPlansQuery = z.infer<typeof PlatformPlansQuerySchema>;

/**
 * `POST /v1/platform/plans` (P-05, ✓): a new plan for a venue that sells subscriptions (V2-D07). With
 * `replaces_plan_id` it is a price change (03 §4): the new plan is created and the old one of the same venue is
 * retired in the same transaction; its subscribers keep their price until the first renewal announced by a renewal
 * notice that carried the new one (DEC-531).
 */
const L = SUBSCRIPTION_POLICY_LIMITS;
const weekday = z.number().int().min(0).max(6);

/**
 * The per-plan policies of 04 §7 (DEC-590), all optional: an absent field keeps the V4 behaviour (calendar term,
 * automatic renewal, prorated refund on termination, frozen by a closure, no eligibility, no daily limit, no
 * customer freeze, no capacity). A `service_days` term needs its days and weekdays and is renewed by hand and sold
 * monthly only; a customer freeze needs a counted-day term.
 */
export const PlatformPlanPoliciesSchema = z.strictObject({
  term_kind: SubscriptionTermKindSchema.optional(),
  service_days: z.number().int().min(1).max(L.service_days_max).nullish(),
  service_weekdays: z.array(weekday).min(1).max(7).nullish(),
  renewal_mode: SubscriptionRenewalModeSchema.optional(),
  daily_visit_limit: z.number().int().min(1).max(L.daily_visit_limit_max).nullish(),
  refund_policy: SubscriptionRefundPolicySchema.optional(),
  closure_policy: SubscriptionClosurePolicySchema.optional(),
  freeze_max_times: z.number().int().min(0).max(L.freeze_max_times).optional(),
  freeze_max_days: z.number().int().min(1).max(L.freeze_max_days).nullish(),
  eligibility: SubscriptionEligibilityKindSchema.optional(),
  capacity: z.number().int().min(1).max(L.capacity_max).nullish(),
  audience_ar: z.string().trim().min(2).max(L.audience_max).nullish(),
  vehicle_change: SubscriptionVehicleChangePolicySchema.optional(),
});

export const PlatformPlanCreateBodySchema = z
  .strictObject({
    venue_id: z.uuid(),
    name_ar: z.string().trim().min(2).max(60),
    name_en: z.string().trim().min(2).max(60).nullish(),
    vehicles_included: z.number().int().min(1).max(5),
    monthly_price_halalas: price.nullish(),
    yearly_price_halalas: price.nullish(),
    replaces_plan_id: z.uuid().nullish(),
    reason: z.string().max(PLATFORM_REASON_MAX).nullish(),
    ...PlatformPlanPoliciesSchema.shape,
  })
  .refine((b) => b.monthly_price_halalas != null || b.yearly_price_halalas != null, {
    message: 'a plan sells at least one cycle',
    path: ['monthly_price_halalas'],
  })
  .refine((b) => b.term_kind !== 'service_days' || (b.service_days != null && b.service_weekdays != null), {
    message: 'a counted-day term names its days and its service weekdays',
    path: ['service_days'],
  })
  .refine((b) => b.term_kind === 'service_days' || (b.service_days == null && b.service_weekdays == null), {
    message: 'counted days belong to a service_days term',
    path: ['term_kind'],
  })
  .refine((b) => b.term_kind !== 'service_days' || b.yearly_price_halalas == null, {
    message: 'a counted-day term is sold monthly only',
    path: ['yearly_price_halalas'],
  })
  .refine((b) => b.term_kind !== 'service_days' || b.renewal_mode !== 'auto', {
    message: 'a counted-day term is renewed by hand',
    path: ['renewal_mode'],
  })
  .refine((b) => !b.freeze_max_times || (b.term_kind === 'service_days' && b.freeze_max_days != null), {
    message: 'a customer freeze needs a counted-day term and its longest freeze',
    path: ['freeze_max_times'],
  })
  .refine((b) => !!b.freeze_max_times || b.freeze_max_days == null, {
    message: 'the longest freeze needs a number of freezes',
    path: ['freeze_max_days'],
  });
export type PlatformPlanCreateBody = z.infer<typeof PlatformPlanCreateBodySchema>;

/** `POST /v1/platform/plans/{planId}/retire` (✓): no longer sold; its subscribers keep it (REASON_REQUIRED). */
export const PlatformPlanRetireBodySchema = z.strictObject({
  reason: z.string().max(PLATFORM_REASON_MAX).nullish(),
});
export type PlatformPlanRetireBody = z.infer<typeof PlatformPlanRetireBodySchema>;

/** A plan as P-05 shows it. */
export const PlatformPlanSchema = z.object({
  plan_id: z.uuid(),
  venue_id: z.uuid(),
  name_ar: z.string(),
  name_en: z.string().nullable(),
  vehicles_included: z.number().int(),
  monthly_price_halalas: z.number().int().nullable(),
  yearly_price_halalas: z.number().int().nullable(),
  status: SubscriptionPlanStatusSchema,
  replaces_plan_id: z.uuid().nullable(),
  replaced_by_plan_id: z.uuid().nullable(),
  /** live subscriptions on the plan (counts only) */
  live_subscriptions: z.number().int(),
  created_at: z.string(),
  retired_at: z.string().nullable(),
  // 04 §7 (DEC-590): the plan's policies
  term_kind: SubscriptionTermKindSchema,
  service_days: z.number().int().nullable(),
  service_weekdays: z.array(z.number().int()).nullable(),
  renewal_mode: SubscriptionRenewalModeSchema,
  daily_visit_limit: z.number().int().nullable(),
  refund_policy: SubscriptionRefundPolicySchema,
  closure_policy: SubscriptionClosurePolicySchema,
  freeze_max_times: z.number().int(),
  freeze_max_days: z.number().int().nullable(),
  eligibility: SubscriptionEligibilityKindSchema,
  capacity: z.number().int().nullable(),
  /** the live subscriptions that hold a seat of the capacity (DEC-598) */
  seats_taken: z.number().int(),
  audience_ar: z.string().nullable(),
  vehicle_change: SubscriptionVehicleChangePolicySchema,
});
export type PlatformPlan = z.infer<typeof PlatformPlanSchema>;

/** `GET /v1/platform/subscriptions` (P-07): `renews_before` keeps the active ones whose period ends before it. */
export const PlatformSubscriptionsQuerySchema = z.strictObject({
  status: SubscriptionStatusSchema.optional(),
  venue_id: z.uuid().optional(),
  org_id: z.uuid().optional(),
  billing_cycle: BillingCycleSchema.optional(),
  renews_before: z.iso.datetime({ offset: true }).optional(),
  cursor,
  limit: limit(100, 50),
});
export type PlatformSubscriptionsQuery = z.infer<typeof PlatformSubscriptionsQuerySchema>;

/**
 * `GET /v1/platform/subscriptions/report` (P-07, DEC-537): counts and amounts only. `days` is the window of the
 * churn and of the new subscriptions (ending now), and of the renewals due (starting now).
 */
export const PlatformSubscriptionsReportQuerySchema = z.strictObject({
  days: z.coerce.number().int().min(1).max(365).default(30),
});
export type PlatformSubscriptionsReportQuery = z.infer<typeof PlatformSubscriptionsReportQuerySchema>;

// ------------------------------------------------------------------------------------------------ V2-036 / V2-037

const isoDate = z.string().refine(isIsoDate, { message: 'a YYYY-MM-DD date' });
const reason = z.string().max(PLATFORM_REASON_MAX);

/**
 * `POST /v1/platform/subscriptions/{subscriptionId}/eligibility` (P-07, ✓; DEC-596): the decision on an application
 * waiting in `pending_eligibility`. A rejection names its reason (REASON_REQUIRED); an approval opens the payment.
 */
export const PlatformEligibilityDecisionBodySchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  reason: reason.nullish(),
});
export type PlatformEligibilityDecisionBody = z.infer<typeof PlatformEligibilityDecisionBodySchema>;

/**
 * `POST /v1/platform/subscriptions/{subscriptionId}/exceptional-refund` (P-07, ✓, `platform.refund_issue`;
 * DEC-600): a case excluded from the non-refund condition — the remaining counted days refunded pro rata to the
 * original payment method and the subscription ended (`exceptional_refund`). The reason is recorded.
 */
export const PlatformExceptionalRefundBodySchema = z.strictObject({ reason: reason.nullish() });
export type PlatformExceptionalRefundBody = z.infer<typeof PlatformExceptionalRefundBodySchema>;

/** A student number as the university issues it: letters, digits and dashes, 3 … 32 (DEC-596). */
export const STUDENT_NUMBER = /^[A-Z0-9-]{3,32}$/;
export const StudentNumberSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(STUDENT_NUMBER));

/**
 * `POST /v1/platform/venues/{venueId}/eligible-students` (✓; DEC-597): the venue's eligible student numbers.
 * `add` adds the numbers, `remove` takes them off the list (`removed_at`, nothing deleted); every pending application
 * at the venue whose number is now listed is approved in the same transaction.
 */
export const PlatformEligibleStudentsBodySchema = z.strictObject({
  mode: z.enum(['add', 'remove']),
  student_numbers: z.array(StudentNumberSchema).min(1).max(5000),
});
export type PlatformEligibleStudentsBody = z.infer<typeof PlatformEligibleStudentsBodySchema>;

/** `GET /v1/platform/venue-closures` (P-05): a venue's announced holidays and closures, the upcoming first. */
export const PlatformVenueClosuresQuerySchema = z.strictObject({
  venue_id: z.uuid(),
  include_past: z.enum(['true', 'false']).optional(),
});
export type PlatformVenueClosuresQuery = z.infer<typeof PlatformVenueClosuresQuerySchema>;

/**
 * `POST /v1/platform/venue-closures` (✓; DEC-599): a scheduled holiday or a closure of the site, from `starts_on` to
 * `ends_on` (Riyadh dates, both included), shown to the customer before payment; the subscribers of the venue are
 * notified. The counted days are not changed by it.
 */
export const PlatformVenueClosureCreateBodySchema = z
  .strictObject({
    venue_id: z.uuid(),
    kind: VenueClosureKindSchema,
    starts_on: isoDate,
    ends_on: isoDate,
    reason_ar: z.string().trim().min(3).max(200),
  })
  .refine((b) => b.ends_on >= b.starts_on, { message: 'ends before it starts', path: ['ends_on'] });
export type PlatformVenueClosureCreateBody = z.infer<typeof PlatformVenueClosureCreateBodySchema>;

/** `POST /v1/platform/venue-closures/{closureId}/cancel` (✓): withdrawn with a reason (nothing deleted). */
export const PlatformVenueClosureCancelBodySchema = z.strictObject({ reason: reason.nullish() });
export type PlatformVenueClosureCancelBody = z.infer<typeof PlatformVenueClosureCancelBodySchema>;

/** `GET /v1/platform/complaints` (P-13): by status, category, or a reference (`PT-C-000123`). */
export const PlatformComplaintsQuerySchema = z.strictObject({
  status: ComplaintStatusSchema.optional(),
  category: ComplaintCategorySchema.optional(),
  q: z.string().trim().min(1).max(40).optional(),
  cursor,
  limit: limit(100, 50),
});
export type PlatformComplaintsQuery = z.infer<typeof PlatformComplaintsQuerySchema>;

/** `POST /v1/platform/complaints/{complaintId}/status` (✓; DEC-604): the next status and the note the customer reads. */
export const PlatformComplaintStatusBodySchema = z.strictObject({
  status: ComplaintStatusSchema,
  note: z.string().trim().min(COMPLAINT_LIMITS.note_min).max(COMPLAINT_LIMITS.note_max),
});
export type PlatformComplaintStatusBody = z.infer<typeof PlatformComplaintStatusBodySchema>;
