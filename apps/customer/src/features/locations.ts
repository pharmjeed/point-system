/**
 * C-07 المواقع and C-08 صفحة الموقع (V2-012, docs/v2/01 R2): search, the three filters of 01 (subscribed /
 * accepts subscription / open now), the map region, «فتح في الخرائط» links, opening hours and prices. Pure: the
 * screens hold the state, the server decides what is listed and whether it is open (`open_now`, DEC-499).
 *
 * Subscription prices are «قريبًا» until phase V4 sells plans (C-09/C-14, V2-030…V2-032; DEC-506): the screen
 * shows the per-visit price only and never a subscribe button that leads nowhere.
 */
import {
  WEEKDAY_KEYS,
  type CustomerLocationDetail,
  type CustomerLocationFilter,
  type CustomerLocationListQuery,
  type CustomerLocationSummary,
  type OpeningHours,
  type WeekdayKey,
} from '@point/shared/customer';
import { fmt, isolate, type AppLocale, type Dictionary } from '../i18n';
import { formatMoney } from '../i18n/format';
import { locationRow, type LocationRow } from './home';

/** The chips of C-07: «الكل» plus the three server filters. */
export type LocationFilterChip = 'all' | CustomerLocationFilter;
export const LOCATION_FILTER_CHIPS: readonly LocationFilterChip[] = [
  'all',
  'subscribed',
  'subscribable',
  'open_now',
];

/** Page size of C-07 (the server allows up to 50). */
export const LOCATIONS_PAGE_SIZE = 20;

/** The list query of the current search box and chip (blank search = no `q`). */
export function locationsQuery(
  search: string,
  chip: LocationFilterChip,
  cursor?: string | null,
): CustomerLocationListQuery {
  const q = search.trim().slice(0, 60);
  return {
    ...(q ? { q } : {}),
    ...(chip === 'all' ? {} : { filter: chip }),
    ...(cursor ? { cursor } : {}),
    limit: LOCATIONS_PAGE_SIZE,
  };
}

/** Appends a page, never listing a venue twice (a venue that moved between pages keeps its first place). */
export function mergePage(
  current: readonly CustomerLocationSummary[],
  page: readonly CustomerLocationSummary[],
): CustomerLocationSummary[] {
  const seen = new Set(current.map((l) => l.venue_id));
  return [...current, ...page.filter((l) => !seen.has(l.venue_id))];
}

const localName = (ar: string, en: string | null, locale: AppLocale) => (locale === 'en' && en ? en : ar);

// ------------------------------------------------------------------ map

export interface MapPin {
  id: string;
  title: string;
  description: string;
  lat: number;
  lng: number;
}

export interface MapRegion {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
}

/** Riyadh, when nothing on the list has coordinates yet. */
export const DEFAULT_REGION: MapRegion = {
  latitude: 24.7136,
  longitude: 46.6753,
  latitudeDelta: 0.35,
  longitudeDelta: 0.35,
};

/** The pins of the locations that have coordinates (a location without them stays on the list only). */
export function mapPins(
  items: readonly CustomerLocationSummary[],
  dict: Dictionary,
  locale: AppLocale,
): MapPin[] {
  return items.flatMap((l) =>
    l.lat === null || l.lng === null
      ? []
      : [
          {
            id: l.venue_id,
            title: localName(l.name_ar, l.name_en, locale),
            description: fmt(dict.home.operatedBy, {
              operator: localName(l.operator_name_ar, l.operator_name_en, locale),
            }),
            lat: l.lat,
            lng: l.lng,
          },
        ],
  );
}

/** A region that shows every pin with a margin (at least ~1 km across). */
export function regionFor(pins: readonly MapPin[]): MapRegion {
  if (pins.length === 0) return DEFAULT_REGION;
  const lats = pins.map((p) => p.lat);
  const lngs = pins.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max(0.01, (maxLat - minLat) * 1.4),
    longitudeDelta: Math.max(0.01, (maxLng - minLng) * 1.4),
  };
}

/** Whether this build can draw the map (Android needs a Google Maps key in the build, DEC-506). */
export const mapAvailable = (platform: string, config: { maps: { android: boolean } }): boolean =>
  platform === 'ios' || (platform === 'android' && config.maps.android);

/**
 * «فتح في الخرائط»: Apple Maps on iOS, the `geo:` intent on Android (any maps app the customer has), with the
 * venue name as label. Without coordinates, a search for the address. `null` when there is nothing to open.
 */
export function mapsUrl(
  platform: string,
  loc: { lat: number | null; lng: number | null; name: string; address?: string | null },
): string | null {
  const label = encodeURIComponent(loc.name);
  if (loc.lat !== null && loc.lng !== null) {
    const ll = `${loc.lat},${loc.lng}`;
    return platform === 'ios' ? `https://maps.apple.com/?ll=${ll}&q=${label}` : `geo:${ll}?q=${ll}(${label})`;
  }
  const where = loc.address?.trim();
  if (!where) return null;
  const q = encodeURIComponent(`${loc.name} ${where}`);
  return platform === 'ios' ? `https://maps.apple.com/?q=${q}` : `geo:0,0?q=${q}`;
}

/** The web fallback when the platform cannot open its own link (no maps app). */
export function webMapsUrl(loc: { lat: number | null; lng: number | null; name: string }): string | null {
  if (loc.lat === null || loc.lng === null) return null;
  return `https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lng}`;
}

// ------------------------------------------------------------------ C-08

export interface HoursLine {
  day: WeekdayKey;
  label: string;
  /** `07:00–20:00`, several intervals joined, or «مغلق». */
  text: string;
  today: boolean;
}

/** Riyadh weekday of an instant (UTC+3, no daylight saving: DEC-481). */
export function riyadhWeekday(now: number): WeekdayKey {
  const d = new Date(now + 3 * 3_600_000);
  return WEEKDAY_KEYS[d.getUTCDay()] as WeekdayKey;
}

/** The week from Sunday (Saudi week), in the venue's local time; `close` before `open` runs past midnight. */
export function hoursLines(hours: OpeningHours, dict: Dictionary, now: number): HoursLine[] {
  const today = riyadhWeekday(now);
  return WEEKDAY_KEYS.map((day) => {
    const intervals = hours.days[day] ?? [];
    const text = hours.always_open
      ? dict.locations.allDay
      : intervals.length === 0
        ? dict.locations.closedDay
        : intervals.map((i) => isolate(`${i.open}–${i.close}`)).join(dict.locations.listSeparator);
    return { day, label: dict.locations.weekdays[day], text, today: day === today };
  });
}

export interface PriceLine {
  label: string;
  value: string;
  /** «قريبًا» (subscriptions arrive with phase V4). */
  soon: boolean;
}

export interface LocationDetailView {
  row: LocationRow;
  title: string;
  operator: string;
  address: string | null;
  openNow: string | null;
  prices: PriceLine[];
  /** At least one price is «قريبًا»: the note under the prices. */
  subscriptionsSoon: boolean;
}

export function locationDetailView(
  loc: CustomerLocationDetail,
  dict: Dictionary,
  locale: AppLocale,
): LocationDetailView {
  const row = locationRow(loc, dict, locale);
  const prices: PriceLine[] = [];
  if (loc.pay_per_visit_halalas !== null)
    prices.push({
      label: dict.locations.perVisit,
      value: isolate(formatMoney(loc.pay_per_visit_halalas, dict)),
      soon: false,
    });
  if (loc.subscriptions_enabled) {
    prices.push({ label: dict.locations.monthly, value: dict.locations.soon, soon: true });
    prices.push({ label: dict.locations.yearly, value: dict.locations.soon, soon: true });
  }
  const address = [loc.address, loc.city]
    .filter((p): p is string => !!p && p.trim() !== '')
    .join(dict.locations.listSeparator);
  return {
    row,
    title: row.title,
    operator: row.operator,
    address: address || null,
    openNow: loc.open_now === null ? null : loc.open_now ? dict.home.openNow : dict.home.closedNow,
    prices,
    subscriptionsSoon: prices.some((p) => p.soon),
  };
}

/** C-07 empty state: what the customer can change (03 §6). */
export function emptyText(search: string, chip: LocationFilterChip, dict: Dictionary): string {
  if (chip === 'subscribed') return dict.locations.emptySubscribed;
  if (search.trim() || chip !== 'all') return dict.locations.emptyFiltered;
  return dict.locations.empty;
}
