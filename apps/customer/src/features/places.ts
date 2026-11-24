/**
 * C-06 by subscription (owner's decision, DEC-639): the app is for subscribers of the places Point serves, each place
 * with its own subscription. Without a subscription (and no visit in progress) the home is «أين تركن عادةً؟», a map of
 * the places that sell one with a sheet to choose and subscribe (owner's option 2); with one it is the entry pass
 * circle with the place, the covered car and the renewal (owner's option 4). A visit in progress always shows the
 * circle (a guest visit linked from WhatsApp, or a subscription that ended mid-visit). Pure.
 */
import type {
  CustomerHome,
  CustomerHomeSubscription,
  CustomerLocationSummary,
  VenuePublicCategory,
} from '@point/shared/customer';
import { fmt, isolate, type AppLocale, type Dictionary } from '../i18n';
import { formatDate, formatDistance, formatMoney } from '../i18n/format';

/** The statuses that hold a place (the entry pass is shown): paid, in grace, or frozen. */
export const ENTITLED_STATUSES: ReadonlySet<CustomerHomeSubscription['status']> = new Set([
  'active',
  'past_due',
  'frozen',
]);

export type HomeMode = 'visit' | 'subscribed' | 'choose';

export function homeMode(home: Pick<CustomerHome, 'current_visit' | 'subscriptions'>): HomeMode {
  if (home.current_visit) return 'visit';
  return home.subscriptions.some((s) => ENTITLED_STATUSES.has(s.status)) ? 'subscribed' : 'choose';
}

/** The subscriptions that hold a place, active ones first (the circle names the first). */
export function heldSubscriptions(
  home: Pick<CustomerHome, 'subscriptions'>,
): readonly CustomerHomeSubscription[] {
  const rank = (s: CustomerHomeSubscription) => (s.status === 'active' ? 0 : s.status === 'past_due' ? 1 : 2);
  return home.subscriptions.filter((s) => ENTITLED_STATUSES.has(s.status)).sort((a, b) => rank(a) - rank(b));
}

const localName = (ar: string, en: string | null, locale: AppLocale) => (locale === 'en' && en ? en : ar);

/** «مشترك · برج الأعمال — العليا» (and «+1» for each other place). */
export function subscribedChip(
  held: readonly CustomerHomeSubscription[],
  dict: Dictionary,
  locale: AppLocale,
): string {
  const first = held[0];
  if (!first) return '';
  const venue = isolate(localName(first.venue_name_ar, first.venue_name_en, locale));
  return held.length > 1
    ? fmt(dict.home.subscribedMore, { venue, n: held.length - 1 })
    : fmt(dict.home.subscribed, { venue });
}

/** The line under the circle: renewal or end date and cycle, or why the subscription needs attention. */
export function subscriptionLine(sub: CustomerHomeSubscription, dict: Dictionary): string {
  if (sub.status === 'past_due') return dict.home.subPastDue;
  if (sub.status === 'frozen') return dict.home.subFrozen;
  const cycle = sub.billing_cycle === 'yearly' ? dict.subscribe.yearly : dict.subscribe.monthly;
  if (!sub.current_period_end) return cycle;
  const date = isolate(formatDate(sub.current_period_end));
  return sub.cancel_at_period_end
    ? fmt(dict.home.subEnds, { date })
    : fmt(dict.home.subRenews, { date, cycle });
}

export interface PlaceCard {
  id: string;
  title: string;
  category: VenuePublicCategory;
  /** «1.2 كم · مفتوح الآن»; empty parts dropped. */
  facts: string;
  /** «345.00 ر.س / شهر» */
  price: string;
  lat: number | null;
  lng: number | null;
  /** The price on the map pin («345 ر.س»): whole riyals, short. */
  pin: string;
}

/** The places that sell a subscription, in the server's order (nearest first when a position was given). */
export function placeCards(
  locations: readonly CustomerLocationSummary[],
  dict: Dictionary,
  locale: AppLocale,
): PlaceCard[] {
  return locations.flatMap((l) => {
    if (!l.subscriptions_enabled || l.monthly_from_halalas === null) return [];
    const facts: string[] = [];
    if (l.distance_m !== null) facts.push(isolate(formatDistance(l.distance_m, dict)));
    if (l.open_now !== null) facts.push(l.open_now ? dict.home.openNow : dict.home.closedNow);
    return [
      {
        id: l.venue_id,
        title: localName(l.name_ar, l.name_en, locale),
        category: l.category,
        facts: facts.join(' · '),
        price: fmt(dict.home.places.perMonth, {
          amount: isolate(formatMoney(l.monthly_from_halalas, dict)),
        }),
        lat: l.lat,
        lng: l.lng,
        pin: fmt(dict.home.places.pin, { amount: String(Math.round(l.monthly_from_halalas / 100)) }),
      },
    ];
  });
}

export interface PinSpot {
  id: string;
  /** 0 … 1 across the map, left to right */
  x: number;
  /** 0 … 1 down the map, north at the top */
  y: number;
}

/**
 * Where each place sits on the drawn map: its coordinates scaled into the box of all of them (north up, east
 * right), kept off the edges by `margin`; one place, or places on one spot, sit in the middle. Places without
 * coordinates are left out (they stay in the sheet's list).
 */
export function pinSpots(places: readonly PlaceCard[], margin = 0.15): PinSpot[] {
  const located = places.filter(
    (p): p is PlaceCard & { lat: number; lng: number } => p.lat !== null && p.lng !== null,
  );
  if (located.length === 0) return [];
  const lats = located.map((p) => p.lat);
  const lngs = located.map((p) => p.lng);
  const [minLat, maxLat, minLng, maxLng] = [
    Math.min(...lats),
    Math.max(...lats),
    Math.min(...lngs),
    Math.max(...lngs),
  ];
  const span = 1 - margin * 2;
  const scale = (v: number, lo: number, hi: number) => (hi - lo < 1e-9 ? 0.5 : (v - lo) / (hi - lo));
  return located.map((p) => ({
    id: p.id,
    x: margin + span * scale(p.lng, minLng, maxLng),
    y: margin + span * (1 - scale(p.lat, minLat, maxLat)),
  }));
}
