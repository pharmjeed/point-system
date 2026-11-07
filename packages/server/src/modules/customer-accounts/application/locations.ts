import {
  OpeningHoursSchema,
  WEEKDAY_KEYS,
  type CustomerLocationDetail,
  type CustomerLocationFilter,
  type CustomerLocationSummary,
  type OpeningHours,
  type VenuePublicCategory,
} from '@point/shared/customer';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import type { ObjectStorage } from '../../media/index.js';

type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;

/**
 * The listed locations as the customer sees them (C-06/C-07/C-08; docs/v2/05 §1.1, DEC-482). A location is listed
 * when its public profile is approved by the platform, its venue is active and its operator is an active operator
 * (`organizations.operator_status = 'active'`): a suspended or terminated operator disappears from the app at once.
 * V2-004 builds the operator side of the same profiles (`listPublicLocations`/`getPublicLocation`); this module keeps
 * the same filters for the customer API and is reconciled with it on merge (DEC-499).
 */
const LOCATION_LISTED = `
  FROM venue_public_profiles p
  JOIN venues v ON v.id = p.venue_id AND v.org_id = p.org_id
  JOIN organizations o ON o.id = p.org_id
 WHERE p.status = 'approved' AND v.status = 'active' AND o.operator_status = 'active'`;

interface ListedRow {
  venue_id: string;
  org_id: string;
  name_ar: string;
  name_en: string | null;
  city: string | null;
  address: string | null;
  timezone: string;
  category: VenuePublicCategory;
  lat: string | null;
  lng: string | null;
  opening_hours: unknown;
  photo_asset_ids: string[];
  subscriptions_enabled: boolean;
  pay_per_visit_halalas: string | null;
  operator_name_ar: string;
  operator_name_en: string | null;
}

const LOCATION_SELECT = `
SELECT p.venue_id, p.org_id, v.name_ar, v.name_en, v.city, v.address, v.timezone, p.category, p.lat::text AS lat,
       p.lng::text AS lng, p.opening_hours, p.photo_asset_ids, p.subscriptions_enabled,
       p.pay_per_visit_halalas::text AS pay_per_visit_halalas, o.name_ar AS operator_name_ar,
       o.name_en AS operator_name_en`;

/** `{}` (the column default) means the hours were never entered: `open_now` is then unknown (null). */
function parseHours(raw: unknown): OpeningHours | null {
  if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) return null;
  const r = OpeningHoursSchema.safeParse(raw);
  return r.success ? r.data : null;
}

const minutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** The weekday (0 = Sunday) and minute of the day of an instant in an IANA time zone. */
export function localClock(instant: Date, timeZone: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    day: WEEKDAY_INDEX[get('weekday')] ?? 0,
    minute: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/**
 * Open at an instant in the venue's time zone (DEC-482): intervals of the local day, a `close` at or before `open`
 * runs past midnight into the next day, `24:00` closes at midnight, a missing day is closed, `always_open` is 24/7.
 */
export function isOpenAt(hours: OpeningHours, instant: Date, timeZone: string): boolean {
  if (hours.always_open) return true;
  const { day, minute } = localClock(instant, timeZone);
  const today = hours.days[WEEKDAY_KEYS[day]!] ?? [];
  const yesterday = hours.days[WEEKDAY_KEYS[(day + 6) % 7]!] ?? [];
  for (const { open, close } of today) {
    const o = minutes(open);
    const c = minutes(close);
    if (c > o ? minute >= o && minute < c : minute >= o) return true;
  }
  for (const { open, close } of yesterday) {
    const o = minutes(open);
    const c = minutes(close);
    if (c <= o && minute < c) return true;
  }
  return false;
}

/** Great-circle distance in metres. */
export function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
}

const num = (v: string | null) => (v === null ? null : Number(v));

function summaryOf(
  r: ListedRow,
  now: Date,
  from: { lat: number; lng: number } | null,
): CustomerLocationSummary {
  const lat = num(r.lat);
  const lng = num(r.lng);
  const hours = parseHours(r.opening_hours);
  return {
    venue_id: r.venue_id,
    name_ar: r.name_ar,
    name_en: r.name_en,
    category: r.category,
    operator_name_ar: r.operator_name_ar,
    operator_name_en: r.operator_name_en,
    city: r.city,
    lat,
    lng,
    distance_m: from && lat !== null && lng !== null ? distanceMetres(from, { lat, lng }) : null,
    open_now: hours ? isOpenAt(hours, now, r.timezone) : null,
    subscriptions_enabled: r.subscriptions_enabled,
    // halalas, VAT included (C-09): the price the platform set for non-subscribers (V2-D05)
    pay_per_visit_halalas: r.pay_per_visit_halalas === null ? null : Number(r.pay_per_visit_halalas),
    // subscription plans (03 §4) arrive with V2-03x: no location sells one yet
    monthly_from_halalas: null,
  };
}

export interface LocationQuery {
  q?: string | undefined;
  filter?: CustomerLocationFilter | undefined;
  lat?: number | undefined;
  lng?: number | undefined;
  cursor?: string | undefined;
  limit: number;
}

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown };
    if (typeof v.o === 'number' && Number.isInteger(v.o) && v.o >= 0) return v.o;
  } catch {
    // fall through
  }
  throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'cursor', issue: 'invalid' }] });
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * `GET /v1/customer/locations` (C-07): search by name, filter, order by distance from the given position (else by
 * name), offset cursor in `meta.next_cursor`. The listed set is small (approved venues of the platform), so it is
 * read whole and `open_now` / distance are computed here in the venue's time zone; `subscribed` lists the venues of
 * the account's live subscriptions — none until subscriptions exist (V2-03x).
 */
export async function listLocations(
  q: Q,
  now: Date,
  query: LocationQuery,
): Promise<{ data: { items: CustomerLocationSummary[] }; next_cursor: string | null }> {
  const offset = decodeCursor(query.cursor);
  if (query.filter === 'subscribed') return { data: { items: [] }, next_cursor: null };
  const params: unknown[] = [];
  let where = '';
  if (query.q) {
    params.push(`%${escapeLike(query.q)}%`);
    where += ` AND (v.name_ar ILIKE $${params.length} OR v.name_en ILIKE $${params.length} OR v.city ILIKE $${params.length})`;
  }
  if (query.filter === 'subscribable') where += ' AND p.subscriptions_enabled';
  const rows = (
    await q.query<ListedRow>(
      `${LOCATION_SELECT} ${LOCATION_LISTED}${where} ORDER BY v.name_ar, p.venue_id`,
      params,
    )
  ).rows;
  const from = query.lat !== undefined && query.lng !== undefined ? { lat: query.lat, lng: query.lng } : null;
  let items = rows.map((r) => summaryOf(r, now, from));
  if (query.filter === 'open_now') items = items.filter((l) => l.open_now === true);
  if (from)
    items.sort(
      (a, b) =>
        (a.distance_m ?? Number.MAX_SAFE_INTEGER) - (b.distance_m ?? Number.MAX_SAFE_INTEGER) ||
        a.venue_id.localeCompare(b.venue_id),
    );
  const page = items.slice(offset, offset + query.limit);
  const next = offset + query.limit < items.length ? encodeCursor(offset + query.limit) : null;
  return { data: { items: page }, next_cursor: next };
}

/** Nearby locations of C-06 (≤ `limit`, by distance when a position is given). */
export async function nearbyLocations(
  q: Q,
  now: Date,
  from: { lat: number; lng: number } | null,
  limit: number,
): Promise<CustomerLocationSummary[]> {
  const r = await listLocations(q, now, { ...(from ?? {}), limit });
  return r.data.items;
}

/** Object key of a public venue photo (`venue_public_profiles.photo_asset_ids`, DEC-499). */
export const venuePhotoKey = (venueId: string, assetId: string) => `venue-public/${venueId}/${assetId}`;

/**
 * `GET /v1/customer/locations/{venueId}` (C-08). A venue that is not listed — unknown, not approved, inactive, or
 * of an operator that is not active — answers VENUE_NOT_LISTED alike (05 §5): the app learns nothing about it.
 * Photos are short-lived presigned links of the private bucket only (09 §6.3), never public URLs.
 */
export async function getLocation(
  q: Q,
  storage: ObjectStorage,
  now: Date,
  venueId: string,
  urlTtlS: number,
): Promise<CustomerLocationDetail> {
  if (!/^[0-9a-f-]{36}$/i.test(venueId)) throw new AppError('VENUE_NOT_LISTED');
  const r = (await q.query<ListedRow>(`${LOCATION_SELECT} ${LOCATION_LISTED} AND p.venue_id = $1`, [venueId]))
    .rows[0];
  if (!r) throw new AppError('VENUE_NOT_LISTED');
  const photos = await Promise.all(
    r.photo_asset_ids.slice(0, 10).map((id) =>
      storage.presignDownload(venuePhotoKey(r.venue_id, id), {
        expiresInS: urlTtlS,
        now,
        cacheControl: 'private, no-store',
      }),
    ),
  );
  return {
    ...summaryOf(r, now, null),
    address: r.address,
    timezone: r.timezone,
    opening_hours: parseHours(r.opening_hours) ?? OpeningHoursSchema.parse({}),
    photo_urls: photos.map((p) => p.url),
    plans: [],
  };
}
