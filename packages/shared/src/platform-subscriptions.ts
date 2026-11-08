/**
 * V2-030 / V2-035 — the platform console's P-05 «باقات الاشتراك» and P-07 «الاشتراكات» (docs/v2/02 §2, docs/v2/04
 * §1; DEC-531, DEC-537): the query and body shapes of their `/v1/platform/*` routes, shared by the server
 * (validation) and the web console. The routes are rows of `PLATFORM_ROUTES`.
 */
import { z } from 'zod';
import {
  BillingCycleSchema,
  SubscriptionPlanStatusSchema,
  SubscriptionStatusSchema,
} from './canon/subscriptions.js';
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
  })
  .refine((b) => b.monthly_price_halalas != null || b.yearly_price_halalas != null, {
    message: 'a plan sells at least one cycle',
    path: ['monthly_price_halalas'],
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
