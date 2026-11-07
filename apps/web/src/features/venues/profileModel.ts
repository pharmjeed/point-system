import {
  OPENING_DAYS,
  OpeningHoursInputSchema,
  VENUE_PROFILE_MAX_PHOTOS,
  categoryAllowsSubscriptions,
  type OpeningDay,
} from '@shared/venue-profile';
import type {
  OpeningHours,
  PutVenueProfileBody,
  VenueCategory,
  VenuePublicProfile,
  VenuePublicStatus,
} from '@/api/venueProfile';
import { venueProfile as copy } from '@/i18n/ar.staff';

/**
 * The S-13 «ملف الموقع العام» form (O-04, V2-004) and the P-04 review rules, as pure functions: the form state, the
 * body of `PUT /v1/venues/{venueId}/public-profile` (full replacement), the local checks (the same zod schema as the
 * server for the hours, DEC-490) and which actions each side may take in each status (DEC-492).
 */
export { OPENING_DAYS, VENUE_PROFILE_MAX_PHOTOS };
export type { OpeningDay };

export interface IntervalForm {
  open: string;
  close: string;
}

export interface ProfileForm {
  category: VenueCategory | '';
  address: string;
  city: string;
  lat: string;
  lng: string;
  alwaysOpen: boolean;
  days: Record<OpeningDay, IntervalForm[]>;
  photoIds: string[];
}

const emptyDays = (): Record<OpeningDay, IntervalForm[]> =>
  Object.fromEntries(OPENING_DAYS.map((d) => [d, []])) as unknown as Record<OpeningDay, IntervalForm[]>;

export function toForm(p: VenuePublicProfile): ProfileForm {
  const days = emptyDays();
  for (const d of OPENING_DAYS)
    days[d] = (p.opening_hours.days[d] ?? []).map((i) => ({ open: i.open, close: i.close }));
  return {
    category: p.category ?? '',
    address: p.address ?? '',
    city: p.city ?? '',
    lat: p.lat === null ? '' : String(p.lat),
    lng: p.lng === null ? '' : String(p.lng),
    alwaysOpen: p.opening_hours.always_open,
    days,
    photoIds: p.photos.map((x) => x.id),
  };
}

/** Western digits only on the wire (canon §2 rule 10): Arabic-Indic digits and the Arabic decimal sign accepted. */
export function parseCoordinate(raw: string): number | null | 'invalid' {
  const s = raw
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/٫/g, '.');
  if (!s) return null;
  if (!/^-?\d{1,3}(\.\d{1,6})?$/.test(s)) return 'invalid';
  return Number(s);
}

export function hoursOf(form: ProfileForm): OpeningHours {
  const days: OpeningHours['days'] = {};
  for (const d of OPENING_DAYS) if (form.days[d].length) days[d] = form.days[d].map((i) => ({ ...i }));
  return { always_open: form.alwaysOpen, days };
}

/** Local checks before a save: field id → message (the server checks again and answers per field). */
export function validateForm(form: ProfileForm): Record<string, string> {
  const out: Record<string, string> = {};
  if (!form.category) out.category = copy.issues.required;
  const lat = parseCoordinate(form.lat);
  const lng = parseCoordinate(form.lng);
  if (lat === 'invalid' || (typeof lat === 'number' && Math.abs(lat) > 90)) out.lat = copy.issues.number;
  if (lng === 'invalid' || (typeof lng === 'number' && Math.abs(lng) > 180)) out.lng = copy.issues.number;
  if (!out.lat && !out.lng && (lat === null) !== (lng === null)) out.lng = copy.issues.pair;
  if (!OpeningHoursInputSchema.safeParse(hoursOf(form)).success) out.opening_hours = copy.issues.hours;
  return out;
}

/** What submit needs (DEC-491), shown before the server says it. */
export function missingForSubmit(form: ProfileForm): string[] {
  const out: string[] = [];
  if (!form.address.trim()) out.push('address');
  if (!form.city.trim()) out.push('city');
  if (!form.lat.trim() || !form.lng.trim()) out.push('lat');
  if (!form.alwaysOpen && OPENING_DAYS.every((d) => form.days[d].length === 0)) out.push('opening_hours');
  return out;
}

export function toBody(form: ProfileForm, version: number): PutVenueProfileBody {
  const lat = parseCoordinate(form.lat);
  const lng = parseCoordinate(form.lng);
  return {
    expected_version: version,
    category: form.category as VenueCategory,
    address: form.address.trim() || null,
    city: form.city.trim() || null,
    lat: typeof lat === 'number' ? lat : null,
    lng: typeof lng === 'number' ? lng : null,
    opening_hours: hoursOf(form),
    photo_ids: [...form.photoIds],
  };
}

/** Same content as the saved profile (the submit button needs a saved draft). */
export function sameAsSaved(form: ProfileForm, saved: VenuePublicProfile): boolean {
  return JSON.stringify(toBody(form, 0)) === JSON.stringify(toBody(toForm(saved), 0));
}

/** The operator may edit and request photos in any status but hidden; submit only a draft (DEC-492). */
export const operatorCanEdit = (status: VenuePublicStatus | null) => status !== 'hidden';
export const operatorCanSubmit = (status: VenuePublicStatus | null) => status === 'draft';

export type PlatformAction = 'approve' | 'send-back' | 'hide' | 'unhide';

/** P-04 actions per status (`platform.venue_review`); pricing is `platform.plan_manage` in any status. */
export function reviewActionsFor(
  status: VenuePublicStatus,
  permissions: readonly string[],
): PlatformAction[] {
  if (!permissions.includes('platform.venue_review')) return [];
  switch (status) {
    case 'submitted':
      return ['approve', 'send-back'];
    case 'approved':
      return ['hide'];
    case 'hidden':
      return ['unhide'];
    default:
      return [];
  }
}

export const canPrice = (permissions: readonly string[]) => permissions.includes('platform.plan_manage');
export const subscriptionsAllowed = (category: VenueCategory | null) =>
  !!category && categoryAllowsSubscriptions(category);

/** «20» SAR → 2000 halalas; empty → null (no price); anything else → 'invalid'. */
export function parseSar(raw: string): number | null | 'invalid' {
  const s = raw
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/٫/g, '.');
  if (!s) return null;
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return 'invalid';
  const halalas = Math.round(Number(s) * 100);
  return halalas > 0 ? halalas : 'invalid';
}

export const formatSar = (halalas: number) => (halalas / 100).toFixed(halalas % 100 === 0 ? 0 : 2);

export const mapLink = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`;
