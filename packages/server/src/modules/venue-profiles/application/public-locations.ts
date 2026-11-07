import { isOpenAt, normalizeOpeningHours, type OpeningHours, type VenueCategory } from '@point/shared';
import { isOperatorActive } from '../../../core/operator-status.js';
import { num, PROFILE_COLUMNS, PROFILE_FROM, type ProfileRow, type Q } from '../infra/profile-rows.js';
import { signProfilePhotos, type PhotoSigner, type ProfilePhotoDto } from './photo-urls.js';

/**
 * The public read model of the listed locations (V2-004; consumed by `GET /v1/customer/locations[/{venueId}]` of
 * V2-010, C-07/C-08). A location is listed when, and only when (DEC-493):
 *
 * - its profile is `approved` (not `draft`, `submitted` or `hidden`);
 * - its operator is active (`organizations.operator_status = 'active'`: invited, trial, suspended and terminated
 *   operators are off the map, 02 §4);
 * - its venue is active (`venues.status = 'active'`).
 *
 * The fields follow the customer contracts of DEC-482 (`CustomerLocationSummary` / `CustomerLocationDetail`) minus
 * what V2-010 adds (distance, plans, monthly price). Photos are short-lived presigned links of the private bucket,
 * never public URLs. Read-only, no operator scope: the customer reads across operators by design.
 */
export interface PublicLocation {
  venue_id: string;
  name_ar: string;
  name_en: string | null;
  category: VenueCategory;
  operator_name_ar: string;
  operator_name_en: string | null;
  address: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  timezone: string;
  opening_hours: OpeningHours;
  /** at `deps.now`; null when the hours are unknown */
  open_now: boolean | null;
  subscriptions_enabled: boolean;
  pay_per_visit_halalas: number | null;
  photos: ProfilePhotoDto[];
}

export interface PublicLocationFilters {
  category?: VenueCategory;
  city?: string;
  /** only the locations that sell subscriptions (C-07 «يقبل الاشتراك») */
  subscriptionsEnabled?: boolean;
  /** only the locations open at `deps.now` (C-07 «مفتوح الآن») */
  openNow?: boolean;
  /** case-insensitive part of the Arabic or English name */
  search?: string;
  /** a page size, 1 … 200 (default 50); ordered by Arabic name then id */
  limit?: number;
  /** keyset: the last item of the previous page */
  after?: { name_ar: string; venue_id: string };
}

export type PublicLocationDeps = PhotoSigner;

/**
 * The list's SQL form of the listing rule; the operator part is `isOperatorActive` (core/operator-status.ts,
 * DEC-487: `operator_status = 'active'` only), applied in one query so a page never needs a read per operator.
 */
const OPERATOR_ACTIVE = `o.operator_status = 'active'`;
const LISTED = `p.status = 'approved' AND ${OPERATOR_ACTIVE} AND v.status = 'active'`;
const LISTED_BUT_OPERATOR = `p.status = 'approved' AND v.status = 'active'`;

type Row = ProfileRow & { timezone: string };

async function toPublic(row: Row, deps: PublicLocationDeps): Promise<PublicLocation> {
  const hours = normalizeOpeningHours(row.opening_hours);
  return {
    venue_id: row.venue_id,
    name_ar: row.venue_name_ar,
    name_en: row.venue_name_en,
    category: row.category,
    operator_name_ar: row.org_name_ar,
    operator_name_en: row.org_name_en,
    address: row.address,
    city: row.city,
    lat: num(row.lat),
    lng: num(row.lng),
    timezone: row.timezone,
    opening_hours: hours,
    open_now: isOpenAt(hours, deps.now),
    subscriptions_enabled: row.subscriptions_enabled,
    pay_per_visit_halalas: num(row.pay_per_visit_halalas),
    photos: await signProfilePhotos(deps, row.org_id, row.venue_id, row.photo_asset_ids),
  };
}

/** The listed locations matching the filters (see {@link PublicLocation} for the listing rule). */
export async function listPublicLocations(
  db: Q,
  filters: PublicLocationFilters,
  deps: PublicLocationDeps,
): Promise<PublicLocation[]> {
  const limit = Math.min(Math.max(Math.trunc(filters.limit ?? 50), 1), 200);
  const params: unknown[] = [];
  const where = [LISTED];
  if (filters.category) {
    params.push(filters.category);
    where.push(`p.category = $${params.length}`);
  }
  if (filters.city) {
    params.push(filters.city);
    where.push(`v.city = $${params.length}`);
  }
  if (filters.subscriptionsEnabled !== undefined) {
    params.push(filters.subscriptionsEnabled);
    where.push(`p.subscriptions_enabled = $${params.length}`);
  }
  if (filters.search?.trim()) {
    params.push(`%${filters.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`(v.name_ar ILIKE $${params.length} OR coalesce(v.name_en, '') ILIKE $${params.length})`);
  }
  if (filters.after) {
    params.push(filters.after.name_ar, filters.after.venue_id);
    where.push(`(v.name_ar, p.venue_id) > ($${params.length - 1}::text, $${params.length}::uuid)`);
  }
  const r = await db.query<Row>(
    `SELECT ${PROFILE_COLUMNS}, v.timezone FROM ${PROFILE_FROM}
      WHERE ${where.join(' AND ')}
      ORDER BY v.name_ar, p.venue_id
      ${filters.openNow ? '' : `LIMIT ${limit}`}`,
    params,
  );
  // «open now» depends on the clock and the weekly hours: filtered after the read, then the page is cut
  const rows = filters.openNow
    ? r.rows.filter((x) => isOpenAt(normalizeOpeningHours(x.opening_hours), deps.now) === true)
    : r.rows;
  return Promise.all(rows.slice(0, limit).map((x) => toPublic(x, deps)));
}

/** One listed location, or null when it is not listed (V2-010 answers `VENUE_NOT_LISTED`). */
export async function getPublicLocation(
  db: Q,
  venueId: string,
  deps: PublicLocationDeps,
): Promise<PublicLocation | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(venueId)) return null;
  const r = await db.query<Row>(
    `SELECT ${PROFILE_COLUMNS}, v.timezone FROM ${PROFILE_FROM} WHERE p.venue_id = $1 AND ${LISTED_BUT_OPERATOR}`,
    [venueId],
  );
  const row = r.rows[0];
  // the operator rule of the platform (V2-005): the same isOperatorActive the rest of V2 reads
  if (!row || !(await isOperatorActive(db, row.org_id))) return null;
  return toPublic(row, deps);
}
