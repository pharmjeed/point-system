import {
  addDays,
  planPolicyView,
  riyadhDate,
  serviceTerm,
  VAT_RATE_BASIS_POINTS,
  vatOfInclusive,
  type PlanPolicyColumns,
} from '@point/shared';
import type {
  CustomerLocationDetail,
  CustomerLocationFilter,
  CustomerLocationSummary,
  CustomerPriceBreakdown,
  CustomerVenueClosure,
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
 * the prices of the subscription plans (V2-032, DEC-534: the active plans of `subscription_plans` while the venue's
 * subscription switch is on — read here from the plans table, the subscriptions module owns the writes).
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
  /** the caller's account: the `subscribed` filter (V2-032) */
  accountId?: string | undefined;
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
  /** V2-036 (DEC-601): the versions the purchase consent of C-09 names */
  versions?: { terms: string; privacy: string };
}

interface PlanPrice extends PlanPolicyColumns {
  plan_id: string;
  venue_id: string;
  name_ar: string;
  vehicles_included: number;
  monthly_price_halalas: number | null;
  yearly_price_halalas: number | null;
  audience_ar: string | null;
  capacity: number | null;
  seats_taken: number;
}

/**
 * The plans a listed venue sells (C-08 / C-09; V2-032): active, while the venue's subscription switch is on, the
 * fewest vehicles and the cheapest first. A venue that does not sell subscriptions has none.
 */
async function sellablePlans(q: Q, venueIds: readonly string[]): Promise<PlanPrice[]> {
  if (!venueIds.length) return [];
  return (
    await q.query<PlanPrice>(
      `SELECT p.id AS plan_id, p.venue_id, p.name_ar, p.vehicles_included,
              p.monthly_price_halalas::float8 AS monthly_price_halalas,
              p.yearly_price_halalas::float8 AS yearly_price_halalas,
              p.term_kind, p.service_days, p.service_weekdays_mask, p.renewal_mode, p.daily_visit_limit,
              p.refund_policy, p.closure_policy, p.freeze_max_times, p.freeze_max_days, p.eligibility,
              p.vehicle_change, p.audience_ar, p.capacity,
              -- DEC-598: the seats held on the plan's replacement family (as the subscriptions module counts them)
              (WITH RECURSIVE fam(id) AS (
                 SELECT p.id
                 UNION
                 SELECT p2.id FROM subscription_plans p2 JOIN fam ON p2.replaces_plan_id = fam.id
                                                                OR p2.replaced_by_plan_id = fam.id)
               SELECT count(*)::int FROM subscriptions s2
                WHERE s2.plan_id IN (SELECT id FROM fam)
                  AND s2.status IN ('pending_payment','active','past_due','frozen')) AS seats_taken
         FROM subscription_plans p
         JOIN venue_public_profiles vp ON vp.venue_id = p.venue_id AND vp.org_id = p.org_id
        WHERE p.venue_id = ANY($1) AND p.status = 'active' AND vp.subscriptions_enabled
        ORDER BY p.vehicles_included, p.monthly_price_halalas NULLS LAST, p.yearly_price_halalas, p.created_at, p.id`,
      [venueIds],
    )
  ).rows;
}

/** The venues of the account's live subscriptions (C-07 «مشترك فيه»). */
async function subscribedVenues(q: Q, accountId: string): Promise<Set<string>> {
  const r = await q.query<{ venue_id: string }>(
    `SELECT venue_id FROM subscriptions
      WHERE account_id = $1 AND status IN ('pending_payment','active','past_due','frozen')`,
    [accountId],
  );
  return new Set(r.rows.map((x) => x.venue_id));
}

/** The net, the VAT and the total of a VAT-inclusive price (04 §4, annex clause 1: shown before payment). */
function breakdown(total: number | null): CustomerPriceBreakdown | null {
  if (total === null) return null;
  const vat = vatOfInclusive(total);
  return {
    net_halalas: total - vat,
    vat_halalas: vat,
    total_halalas: total,
    vat_rate_bp: VAT_RATE_BASIS_POINTS,
  };
}

/** The upcoming announced holidays and closures of a venue (DEC-599): those not over yet, within 180 days. */
async function upcomingClosures(q: Q, venueId: string, now: Date): Promise<CustomerVenueClosure[]> {
  const today = riyadhDate(now);
  return (
    await q.query<CustomerVenueClosure>(
      `SELECT id AS closure_id, kind, starts_on::text AS starts_on, ends_on::text AS ends_on, reason_ar
         FROM venue_closures
        WHERE venue_id = $1 AND canceled_at IS NULL AND ends_on >= $2::date AND starts_on <= $3::date
        ORDER BY starts_on, id LIMIT 20`,
      [venueId, today, addDays(today, 180)],
    )
  ).rows;
}

const cheapestMonthly = (plans: readonly PlanPrice[]): number | null => {
  const prices = plans.map((p) => p.monthly_price_halalas).filter((p): p is number => p !== null);
  return prices.length ? Math.min(...prices) : null;
};

function summaryOf(
  l: PublicLocation,
  from: { lat: number; lng: number } | null,
  plans: readonly PlanPrice[] = [],
): CustomerLocationSummary {
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
    // V2-032: the cheapest monthly plan the venue sells (03 §4), VAT included
    monthly_from_halalas: l.subscriptions_enabled ? cheapestMonthly(plans) : null,
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
 * name), offset cursor in `meta.next_cursor`; `subscribed` lists the venues of the account's live subscriptions
 * (V2-032).
 */
export async function listLocations(
  q: Q,
  deps: LocationDeps,
  query: LocationQuery,
): Promise<{ data: { items: CustomerLocationSummary[] }; next_cursor: string | null }> {
  const offset = decodeCursor(query.cursor);
  const subscribed =
    query.filter === 'subscribed' && query.accountId ? await subscribedVenues(q, query.accountId) : null;
  if (query.filter === 'subscribed' && !subscribed?.size) return { data: { items: [] }, next_cursor: null };
  const listed = await allListed(
    q,
    {
      ...(query.q ? { search: query.q } : {}),
      ...(query.filter === 'subscribable' ? { subscriptionsEnabled: true } : {}),
      ...(query.filter === 'open_now' ? { openNow: true } : {}),
    },
    deps,
  );
  const rows = subscribed ? listed.filter((l) => subscribed.has(l.venue_id)) : listed;
  const from = query.lat !== undefined && query.lng !== undefined ? { lat: query.lat, lng: query.lng } : null;
  const plans = await sellablePlans(
    q,
    rows.filter((r) => r.subscriptions_enabled).map((r) => r.venue_id),
  );
  const items = rows.map((r) =>
    summaryOf(
      r,
      from,
      plans.filter((p) => p.venue_id === r.venue_id),
    ),
  );
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
  const plans = l.subscriptions_enabled ? await sellablePlans(q, [l.venue_id]) : [];
  return {
    ...summaryOf(l, null, plans),
    address: l.address,
    timezone: l.timezone,
    opening_hours: l.opening_hours,
    photo_urls: l.photos.slice(0, 10).map((p) => p.url),
    // V2-032 (C-08 → C-09): the plans sold here, VAT included; V2-036: their policies, the price's net and VAT, the
    // capacity, the consent's versions and a counted-day term's dates if paid now
    plans: plans.map((p) => ({
      plan_id: p.plan_id,
      name_ar: p.name_ar,
      vehicles_included: p.vehicles_included,
      monthly_price_halalas: p.monthly_price_halalas,
      yearly_price_halalas: p.yearly_price_halalas,
      policy: planPolicyView(p),
      audience_ar: p.audience_ar,
      monthly_breakdown: breakdown(p.monthly_price_halalas),
      yearly_breakdown: breakdown(p.yearly_price_halalas),
      sold_out: p.capacity !== null && p.seats_taken >= p.capacity,
      terms_version: deps.versions?.terms ?? '',
      privacy_version: deps.versions?.privacy ?? '',
      term_preview:
        p.term_kind === 'service_days' && p.service_days && p.service_weekdays_mask
          ? (({ startOn, endOn }) => ({ starts_on: startOn, ends_on: endOn }))(
              serviceTerm(deps.now, p.service_days, p.service_weekdays_mask),
            )
          : null,
    })),
    closures: await upcomingClosures(q, l.venue_id, deps.now),
  };
}
