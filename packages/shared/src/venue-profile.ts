/**
 * The public profile of a venue (V2-004, O-04 / P-04; `venue_public_profiles` of migration 0008): the weekly opening
 * hours, the operator's edit body, the platform review bodies and the «open now» rule used by the customer app's
 * locations (C-07). Shared by the server (validation) and the web app (the S-13 form, the P-04 console) — DEC-490.
 */
import { z } from 'zod';
import { VENUE_CATEGORIES, VENUE_PUBLIC_STATUSES } from './canon/platform.js';

/** Days of `opening_hours`, in the Saudi week order (Sunday first) and the JavaScript `getUTCDay()` order. */
export const OPENING_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type OpeningDay = (typeof OPENING_DAYS)[number];

/** At most this many intervals per day (morning and evening shifts, a split for prayer times). */
export const MAX_INTERVALS_PER_DAY = 3;
/** At most this many photos on a public profile. */
export const VENUE_PROFILE_MAX_PHOTOS = 6;
/** The operator's address and city lengths (written to `venues.address` / `venues.city`, DEC-491). */
export const VENUE_ADDRESS_MAX = 200;
export const VENUE_CITY_MAX = 80;
/** Reasons of the platform review actions (send back, hide, unhide): 3 … 500 characters, like 08 §4.16. */
export const REVIEW_REASON_MIN = 3;
export const REVIEW_REASON_MAX = 500;

const HHMM = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;

/** `HH:MM` → minutes since midnight; `24:00` (end of day) → 1440. */
export function minutesOf(hhmm: string): number {
  if (hhmm === '24:00') return 1440;
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

export const OpeningIntervalSchema = z
  .strictObject({
    open: z.string().regex(HHMM, 'time_format'),
    close: z.string().refine((v) => v === '24:00' || HHMM.test(v), 'time_format'),
  })
  .refine((i) => !HHMM.test(i.open) || minutesOf(i.close) > minutesOf(i.open), {
    message: 'close_before_open',
    path: ['close'],
  });
export type OpeningInterval = z.infer<typeof OpeningIntervalSchema>;

const dayIntervals = z
  .array(OpeningIntervalSchema)
  .max(MAX_INTERVALS_PER_DAY)
  .superRefine((list, ctx) => {
    const sorted = [...list].sort((a, b) => minutesOf(a.open) - minutesOf(b.open));
    for (let i = 1; i < sorted.length; i++) {
      if (minutesOf(sorted[i]!.open) < minutesOf(sorted[i - 1]!.close)) {
        ctx.addIssue({ code: 'custom', message: 'overlapping_intervals', path: [i] });
        return;
      }
    }
  });

/**
 * The weekly opening hours (`venue_public_profiles.opening_hours`): a key per open day with up to three
 * `{open, close}` intervals in Riyadh local time (`HH:MM`, 24 h; `close` may be `24:00`). A missing day (or an
 * empty list) is closed; a venue open past midnight writes the rest on the next day (`00:00`–…). `{}` = not set
 * (the 0008 default). Intervals of a day may not overlap.
 */
export const OpeningHoursSchema = z.strictObject(
  Object.fromEntries(OPENING_DAYS.map((d) => [d, dayIntervals.optional()])) as Record<
    OpeningDay,
    z.ZodOptional<typeof dayIntervals>
  >,
);
export type OpeningHours = Partial<Record<OpeningDay, OpeningInterval[]>>;

/** At least one open interval in the week (required to submit, DEC-491). */
export function hasOpeningHours(hours: OpeningHours): boolean {
  return OPENING_DAYS.some((d) => (hours[d]?.length ?? 0) > 0);
}

/** Riyadh is UTC+03:00 all year (no daylight saving, DEC-343). */
const RIYADH_OFFSET_MS = 3 * 3600_000;

/** Whether the venue is open at `at` (C-07 «مفتوح الآن»), read in Riyadh local time. */
export function isOpenAt(hours: OpeningHours, at: Date): boolean {
  const local = new Date(at.getTime() + RIYADH_OFFSET_MS);
  const day = OPENING_DAYS[local.getUTCDay()]!;
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  return (hours[day] ?? []).some((i) => minute >= minutesOf(i.open) && minute < minutesOf(i.close));
}

export const VenuePublicStatusSchema = z.enum(VENUE_PUBLIC_STATUSES);
export const VenueCategorySchema = z.enum(VENUE_CATEGORIES);

const version0 = z.number().int().min(0);
const version1 = z.number().int().min(1);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v === '' ? null : v));

/**
 * `PUT /v1/venues/{venueId}/public-profile` — full replacement by the operator (O-04). `expected_version` is the
 * profile's `version`, `0` when the venue has no profile yet (the first save creates it as `draft`).
 */
export const PutVenuePublicProfileBodySchema = z
  .strictObject({
    expected_version: version0,
    category: VenueCategorySchema,
    address: optionalText(VENUE_ADDRESS_MAX),
    city: optionalText(VENUE_CITY_MAX),
    lat: z.number().min(-90).max(90).nullable(),
    lng: z.number().min(-180).max(180).nullable(),
    opening_hours: OpeningHoursSchema,
    photo_ids: z
      .array(z.uuid())
      .max(VENUE_PROFILE_MAX_PHOTOS)
      .refine((ids) => new Set(ids.map((i) => i.toLowerCase())).size === ids.length, 'duplicate_photo'),
  })
  .refine((b) => (b.lat === null) === (b.lng === null), {
    message: 'coordinates_pair',
    path: ['lng'],
  });
export type PutVenuePublicProfileBody = z.output<typeof PutVenuePublicProfileBodySchema>;

/** `POST /v1/venues/{venueId}/public-profile/submit`. */
export const SubmitVenuePublicProfileBodySchema = z.strictObject({ expected_version: version1 });

/** `POST /v1/venues/{venueId}/public-profile/photos` — a presigned upload for one new photo. */
export const RequestVenuePhotoBodySchema = z.strictObject({
  // checked against the media content types → MEDIA_TYPE_UNSUPPORTED, the size against MEDIA_MAX_BYTES
  content_type: z.string().min(1).max(255),
  byte_size: z.number().int().min(1),
});

/** `POST /v1/platform/venues/{venueId}/approve`. */
export const ApproveVenueBodySchema = z.strictObject({ expected_version: version1 });

/** `send-back`, `hide`, `unhide`: the reason is mandatory (REASON_REQUIRED). */
export const ReviewReasonBodySchema = z.strictObject({
  expected_version: version1,
  reason: z.string().trim().min(REVIEW_REASON_MIN).max(REVIEW_REASON_MAX),
});

/** `PUT /v1/platform/venues/{venueId}/pricing` — only the platform sets prices (V2-D05, V2-D07). */
export const VenuePricingBodySchema = z.strictObject({
  expected_version: version1,
  subscriptions_enabled: z.boolean(),
  pay_per_visit_halalas: z.number().int().min(1).max(100_000_000).nullable(),
});

/** Categories that never sell subscriptions: halls and events are «included» or paid per visit (V2-D07). */
export const NON_SUBSCRIPTION_CATEGORIES = ['hall'] as const satisfies readonly (typeof VENUE_CATEGORIES)[number][];

export function categoryAllowsSubscriptions(category: string): boolean {
  return !(NON_SUBSCRIPTION_CATEGORIES as readonly string[]).includes(category);
}
