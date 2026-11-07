/**
 * Listed locations (`venue_public_profiles` with `status = 'approved'`, docs/v2/03_Data_Model.md §2) as the
 * customer sees them: `GET /v1/customer/locations` and `GET /v1/customer/locations/{venueId}` (05 §1, C-07, C-08).
 * Amounts in halalas (VAT included, C-09); times in the venue time zone (Asia/Riyadh). Shapes chosen in V2-011
 * (DEC-482).
 */
import { z } from 'zod';

/** `venue_public_profiles.category` (03 §2). */
export const VENUE_PUBLIC_CATEGORIES = [
  'hall',
  'office',
  'mall',
  'hospital',
  'residential',
  'hotel',
  'club',
  'other',
] as const;
export type VenuePublicCategory = (typeof VENUE_PUBLIC_CATEGORIES)[number];
export const VenuePublicCategorySchema = z.enum(VENUE_PUBLIC_CATEGORIES);

/** Keys of `venue_public_profiles.opening_hours` (DEC-482). */
export const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

/** `HH:MM` local time; `24:00` closes at midnight. */
const hhmm = z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$|^24:00$/);

/**
 * `opening_hours`: per weekday, a list of `{ open, close }` intervals in the venue's local time. A `close`
 * earlier than `open` runs past midnight into the next day; a missing or empty day is closed; the
 * `always_open` flag means 24/7 (DEC-482).
 */
export const OpeningHoursSchema = z.object({
  always_open: z.boolean().default(false),
  days: z
    .partialRecord(z.enum(WEEKDAY_KEYS), z.array(z.object({ open: hhmm, close: hhmm })).max(4))
    .default({}),
});
export type OpeningHours = z.infer<typeof OpeningHoursSchema>;

const halalas = z.int().positive();

/** One location in a list (C-06 «أقرب المواقع», C-07). */
export const CustomerLocationSummarySchema = z.object({
  venue_id: z.uuid(),
  name_ar: z.string(),
  name_en: z.string().nullable(),
  category: VenuePublicCategorySchema,
  /** «تشغيل: …» (V2-D01): the operator's short name. */
  operator_name_ar: z.string(),
  operator_name_en: z.string().nullable(),
  city: z.string().nullable(),
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  /** Metres from the `lat`/`lng` of the query, `null` without one. */
  distance_m: z.int().min(0).nullable(),
  /** From `opening_hours` at the server's time in the venue time zone; `null` when the hours are unknown. */
  open_now: z.boolean().nullable(),
  subscriptions_enabled: z.boolean(),
  /** Pay-per-visit price for non-subscribers (V2-D05), `null` = none. */
  pay_per_visit_halalas: halalas.nullable(),
  /** Cheapest active monthly plan, `null` when the location sells no subscription. */
  monthly_from_halalas: halalas.nullable(),
});
export type CustomerLocationSummary = z.infer<typeof CustomerLocationSummarySchema>;

export const CUSTOMER_LOCATION_FILTERS = ['subscribed', 'subscribable', 'open_now'] as const;
export type CustomerLocationFilter = (typeof CUSTOMER_LOCATION_FILTERS)[number];

/** `GET /v1/customer/locations` query (C-07): search, filter, optional position, cursor paging. */
export const CustomerLocationListQuerySchema = z.strictObject({
  q: z.string().trim().max(60).optional(),
  filter: z.enum(CUSTOMER_LOCATION_FILTERS).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
/** What a client sends (all optional; the server applies `limit`'s default). */
export type CustomerLocationListQuery = Partial<z.output<typeof CustomerLocationListQuerySchema>>;

/** `GET /v1/customer/locations` → `data` (the next page cursor is `meta.next_cursor`, 07 §1.6). */
export const CustomerLocationListSchema = z.object({ items: z.array(CustomerLocationSummarySchema) });
export type CustomerLocationList = z.infer<typeof CustomerLocationListSchema>;

/** A plan as sold on C-08/C-09 (`subscription_plans`, 03 §4). */
export const CustomerLocationPlanSchema = z.object({
  plan_id: z.uuid(),
  name_ar: z.string(),
  vehicles_included: z.int().min(1).max(5),
  monthly_price_halalas: halalas.nullable(),
  yearly_price_halalas: halalas.nullable(),
});
export type CustomerLocationPlan = z.infer<typeof CustomerLocationPlanSchema>;

/** `GET /v1/customer/locations/{venueId}` → `data` (C-08). An unlisted venue → `VENUE_NOT_LISTED` (05 §5). */
export const CustomerLocationDetailSchema = CustomerLocationSummarySchema.extend({
  address: z.string().nullable(),
  timezone: z.string(),
  opening_hours: OpeningHoursSchema,
  photo_urls: z.array(z.url()).max(10),
  plans: z.array(CustomerLocationPlanSchema),
});
export type CustomerLocationDetail = z.infer<typeof CustomerLocationDetailSchema>;
