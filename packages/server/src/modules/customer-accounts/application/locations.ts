import type {
  CustomerLocationDetail,
  CustomerLocationFilter,
  CustomerLocationSummary,
} from '@point/shared/customer';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import type { ObjectStorage } from '../../media/index.js';
import {
  getPublicLocation,
  listPublicLocations,
  type PublicLocation,
  type PublicLocationFilters,
} from '../../venue-profiles/index.js';

type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;

/**
 * The listed locations as the customer sees them (C-06/C-07/C-08; docs/v2/05 §1.1, DEC-482), on V2-004's public read
 * model (`listPublicLocations` / `getPublicLocation`: approved profile, active venue, active operator, presigned
 * photos, `open_now` from the weekly hours). This module adds what the customer API owns (DEC-499): the distance
 * from the caller's position and its ordering, the offset cursor of `meta.next_cursor`, the `subscribed` filter, and
 * the prices of the subscription plans — none until the plans exist (V2-03x).
 */

/** Great-circle distance in metres. */
export function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
}

export interface LocationQuery {
  q?: string | undefined;
  filter?: CustomerLocationFilter | undefined;
  lat?: number | undefined;
  lng?: number | undefined;
  cursor?: string | undefined;
  limit: number;
}

export interface LocationDeps {
  storage: ObjectStorage;
  now: Date;
  /** MEDIA_READ_URL_TTL_S (V2-004 caps the photo links at 300 s) */
  ttlS: number;
}

function summaryOf(l: PublicLocation, from: { lat: number; lng: number } | null): CustomerLocationSummary {
  return {
    venue_id: l.venue_id,
    name_ar: l.name_ar,
    name_en: l.name_en,
    category: l.category,
    operator_name_ar: l.operator_name_ar,
    operator_name_en: l.operator_name_en,
    city: l.city,
    lat: l.lat,
    lng: l.lng,
    distance_m:
      from && l.lat !== null && l.lng !== null ? distanceMetres(from, { lat: l.lat, lng: l.lng }) : null,
    open_now: l.open_now,
    subscriptions_enabled: l.subscriptions_enabled,
    // halalas, VAT included (C-09): the price the platform set for non-subscribers (V2-D05)
    pay_per_visit_halalas: l.pay_per_visit_halalas,
    // subscription plans (03 §4) arrive with V2-03x: no location sells one yet
    monthly_from_halalas: null,
  };
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

/** Every listed location matching the filters, read in V2-004's keyset pages (the listed set is small). */
async function allListed(
  q: Q,
  filters: PublicLocationFilters,
  deps: LocationDeps,
): Promise<PublicLocation[]> {
  const out: PublicLocation[] = [];
  const PAGE = 200;
  for (;;) {
    const last = out.at(-1);
    const page = await listPublicLocations(
      q,
      {
        ...filters,
        limit: PAGE,
        ...(last ? { after: { name_ar: last.name_ar, venue_id: last.venue_id } } : {}),
      },
      deps,
    );
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}

/**
 * `GET /v1/customer/locations` (C-07): search by name, filter, order by distance from the given position (else by
 * name), offset cursor in `meta.next_cursor`; `subscribed` lists the venues of the account's live subscriptions —
 * none until subscriptions exist (V2-03x).
 */
export async function listLocations(
  q: Q,
  deps: LocationDeps,
  query: LocationQuery,
): Promise<{ data: { items: CustomerLocationSummary[] }; next_cursor: string | null }> {
  const offset = decodeCursor(query.cursor);
  if (query.filter === 'subscribed') return { data: { items: [] }, next_cursor: null };
  const rows = await allListed(
    q,
    {
      ...(query.q ? { search: query.q } : {}),
      ...(query.filter === 'subscribable' ? { subscriptionsEnabled: true } : {}),
      ...(query.filter === 'open_now' ? { openNow: true } : {}),
    },
    deps,
  );
  const from = query.lat !== undefined && query.lng !== undefined ? { lat: query.lat, lng: query.lng } : null;
  const items = rows.map((r) => summaryOf(r, from));
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
  deps: LocationDeps,
  from: { lat: number; lng: number } | null,
  limit: number,
): Promise<CustomerLocationSummary[]> {
  return (await listLocations(q, deps, { ...(from ?? {}), limit })).data.items;
}

/**
 * `GET /v1/customer/locations/{venueId}` (C-08). A venue that is not listed — unknown, not approved, inactive, or
 * of an operator that is not active — answers VENUE_NOT_LISTED alike (05 §5): the app learns nothing about it.
 */
export async function getLocation(
  q: Q,
  deps: LocationDeps,
  venueId: string,
): Promise<CustomerLocationDetail> {
  const l = await getPublicLocation(q, venueId, deps);
  if (!l) throw new AppError('VENUE_NOT_LISTED');
  return {
    ...summaryOf(l, null),
    address: l.address,
    timezone: l.timezone,
    opening_hours: l.opening_hours,
    photo_urls: l.photos.slice(0, 10).map((p) => p.url),
    plans: [],
  };
}
