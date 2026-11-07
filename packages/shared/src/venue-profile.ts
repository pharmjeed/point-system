/**
 * The public profile of a venue (V2-004, O-04 / P-04; `venue_public_profiles` of migration 0008): the weekly opening
 * hours, the operator's edit body, the platform review bodies and the «open now» rule used by the customer app's
 * locations (C-07). Shared by the server (validation) and the web app (the S-13 form, the P-04 console) — DEC-490.
 */
import { z } from 'zod';
export type { VenueCategory, VenuePublicStatus } from './canon/platform.js';
import { VENUE_CATEGORIES, VENUE_PUBLIC_STATUSES } from './canon/platform.js';
import {
  OpeningHoursSchema as CustomerOpeningHoursSchema,
  WEEKDAY_KEYS,
  type OpeningHours as CustomerOpeningHours,
  type WeekdayKey,
} from './customer/locations.js';

/**
 * The weekly opening hours keep the shape the customer contracts chose (DEC-482, `customer/locations.ts`):
 * `{ always_open, days: { sun…sat: [{ open, close }] } }` in the venue's local time (Asia/Riyadh), `close` earlier
 * than `open` running past midnight into the next day, `24:00` closing at midnight, a missing or empty day closed.
 * The operator's write is checked more strictly here (DEC-490): no unknown key, no empty interval, no overlap.
 */
export const OPENING_DAYS = WEEKDAY_KEYS;
export type OpeningDay = WeekdayKey;
export type OpeningHours = CustomerOpeningHours;
export type OpeningInterval = { open: string; close: string };

/** At most this many intervals per day (the customer schema's bound). */
export const MAX_INTERVALS_PER_DAY = 4;
/** At most this many photos on a public profile (the customer detail allows 10 URLs). */
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

/** The part of an interval inside its own day, `[from, to)` in minutes (an overnight interval ends at 1440). */
function sameDaySpan(i: OpeningInterval): [number, number] {
  const open = minutesOf(i.open);
  const close = minutesOf(i.close);
  return [open, close > open ? close : 1440];
}

export const OpeningIntervalSchema = z
  .strictObject({
    open: z.string().regex(HHMM, 'time_format'),
    close: z.string().refine((v) => v === '24:00' || HHMM.test(v), 'time_format'),
  })
  .refine((i) => !HHMM.test(i.open) || i.open !== i.close, {
    message: 'empty_interval',
    path: ['close'],
  });

const dayIntervals = z
  .array(OpeningIntervalSchema)
  .max(MAX_INTERVALS_PER_DAY)
  .superRefine((list, ctx) => {
    const spans = list.map(sameDaySpan).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) {
      if (spans[i]![0] < spans[i - 1]![1]) {
        ctx.addIssue({ code: 'custom', message: 'overlapping_intervals', path: [i] });
        return;
      }
    }
  });

/** The operator's write of `opening_hours` (PUT public-profile): the DEC-482 shape, strictly. */
export const OpeningHoursInputSchema = z.strictObject({
  always_open: z.boolean(),
  days: z.strictObject(
    Object.fromEntries(OPENING_DAYS.map((d) => [d, dayIntervals.optional()])) as Record<
      OpeningDay,
      z.ZodOptional<typeof dayIntervals>
    >,
  ),
});

/** A stored value (the 0008 default `{}` included) in the DEC-482 shape; an unreadable value counts as unknown. */
export function normalizeOpeningHours(raw: unknown): OpeningHours {
  const r = CustomerOpeningHoursSchema.safeParse(raw ?? {});
  return r.success ? canonicalOpeningHours(r.data) : { always_open: false, days: {} };
}

/**
 * The stored form (DEC-490): days in week order, each day's intervals by opening time, empty days dropped, every
 * interval exactly `{ open, close }` — so two equal schedules compare equal whatever order they were typed in.
 */
export function canonicalOpeningHours(hours: OpeningHours): OpeningHours {
  const days: OpeningHours['days'] = {};
  for (const d of OPENING_DAYS) {
    const list = hours.days[d];
    if (!list?.length) continue;
    days[d] = [...list]
      .sort((a, b) => minutesOf(a.open) - minutesOf(b.open))
      .map((i) => ({ open: i.open, close: i.close }));
  }
  return { always_open: hours.always_open, days };
}

/** At least one open interval in the week, or 24/7 (required to submit, DEC-491). */
export function hasOpeningHours(hours: OpeningHours): boolean {
  return hours.always_open || OPENING_DAYS.some((d) => (hours.days[d]?.length ?? 0) > 0);
}

/** Riyadh is UTC+03:00 all year (no daylight saving, DEC-343). */
const RIYADH_OFFSET_MS = 3 * 3600_000;

/**
 * Whether the venue is open at `at` (C-07 «مفتوح الآن»), in Riyadh local time; `null` when the hours are unknown
 * (`CustomerLocationSummary.open_now`). An overnight interval of the previous day still counts after midnight.
 */
export function isOpenAt(hours: OpeningHours, at: Date): boolean | null {
  if (hours.always_open) return true;
  if (!hasOpeningHours(hours)) return null;
  const local = new Date(at.getTime() + RIYADH_OFFSET_MS);
  const dayIndex = local.getUTCDay();
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const today = hours.days[OPENING_DAYS[dayIndex]!] ?? [];
  const yesterday = hours.days[OPENING_DAYS[(dayIndex + 6) % 7]!] ?? [];
  if (today.some((i) => minute >= minutesOf(i.open) && minute < sameDaySpan(i)[1])) return true;
  return yesterday.some((i) => minutesOf(i.close) < minutesOf(i.open) && minute < minutesOf(i.close));
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
    opening_hours: OpeningHoursInputSchema,
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
export const NON_SUBSCRIPTION_CATEGORIES = [
  'hall',
] as const satisfies readonly (typeof VENUE_CATEGORIES)[number][];

export function categoryAllowsSubscriptions(category: string): boolean {
  return !(NON_SUBSCRIPTION_CATEGORIES as readonly string[]).includes(category);
}
