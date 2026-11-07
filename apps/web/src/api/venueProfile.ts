import type { OpeningHours, VenueCategory, VenuePublicStatus } from '@shared/venue-profile';
import { api, apiFetch } from './client';
import type { UploadInstruction } from './types';

/**
 * V2-004 — the venue public profile (docs/07_openapi.yaml `VenuePublicProfile`, `PlatformVenueProfile`): the staff
 * routes of S-13 (`/v1/venues/{venueId}/public-profile…`, the staff cookie) and the platform routes of P-04
 * (`/v1/platform/venues…`, the platform cookie). Field names follow the contract exactly.
 */
export type { OpeningHours, VenueCategory, VenuePublicStatus };

export interface ProfilePhoto {
  id: string;
  url: string;
  expires_at: string;
}

export interface ReviewNote {
  kind: 'sent_back' | 'hidden';
  reason: string;
  at: string;
}

export interface VenuePublicProfile {
  venue_id: string;
  venue: { code: string; name_ar: string; name_en: string | null; status: 'active' | 'inactive' };
  status: VenuePublicStatus | null;
  category: VenueCategory | null;
  address: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  opening_hours: OpeningHours;
  photos: ProfilePhoto[];
  subscriptions_enabled: boolean;
  pay_per_visit_halalas: number | null;
  approved_at: string | null;
  review_note: ReviewNote | null;
  version: number;
  updated_at: string | null;
}

export interface PlatformVenueProfile extends VenuePublicProfile {
  org: {
    id: string;
    name_ar: string;
    name_en: string | null;
    operator_status: 'invited' | 'trial' | 'active' | 'suspended' | 'terminated';
  };
  approved_by: string | null;
}

export interface PlatformVenueListItem {
  venue_id: string;
  venue: { code: string; name_ar: string; status: 'active' | 'inactive' };
  org: { id: string; name_ar: string; operator_status: string };
  status: VenuePublicStatus;
  category: VenueCategory;
  city: string | null;
  photo_count: number;
  subscriptions_enabled: boolean;
  pay_per_visit_halalas: number | null;
  version: number;
  updated_at: string;
}

export interface PutVenueProfileBody {
  expected_version: number;
  category: VenueCategory;
  address: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  opening_hours: OpeningHours;
  photo_ids: string[];
}

const staffPath = (venueId: string, tail = '') =>
  `/v1/venues/${encodeURIComponent(venueId)}/public-profile${tail}`;
const platformPath = (venueId: string, tail = '') => `/v1/platform/venues/${encodeURIComponent(venueId)}${tail}`;

export const venueProfileKeys = {
  staff: (venueId: string) => ['venue-public-profile', venueId] as const,
  platformList: (filters: object) => ['platform', 'venues', filters] as const,
  platformOne: (venueId: string) => ['platform', 'venue', venueId] as const,
};

// ------------------------------------------------------------------ staff (S-13, venue.manage)

export async function fetchVenueProfile(venueId: string, signal?: AbortSignal) {
  return (await api.get<VenuePublicProfile>(staffPath(venueId), { signal })).data;
}

export async function putVenueProfile(venueId: string, body: PutVenueProfileBody, key: string) {
  return (await api.put<VenuePublicProfile>(staffPath(venueId), { body, idempotencyKey: key })).data;
}

export async function requestVenuePhoto(
  venueId: string,
  body: { content_type: string; byte_size: number },
  key: string,
) {
  return (
    await api.post<{ photo_id: string; upload: UploadInstruction }>(staffPath(venueId, '/photos'), {
      body,
      idempotencyKey: key,
    })
  ).data;
}

export async function submitVenueProfile(venueId: string, expectedVersion: number, key: string) {
  return (
    await api.post<VenuePublicProfile>(staffPath(venueId, '/submit'), {
      body: { expected_version: expectedVersion },
      idempotencyKey: key,
    })
  ).data;
}

// ------------------------------------------------------------------ platform (P-04)

export interface PlatformVenueFilters {
  status?: VenuePublicStatus | undefined;
  city?: string | undefined;
  org_id?: string | undefined;
}

export async function fetchPlatformVenues(filters: PlatformVenueFilters, cursor?: string, signal?: AbortSignal) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, String(v));
  if (cursor) params.set('cursor', cursor);
  params.set('limit', '50');
  const r = await apiFetch<PlatformVenueListItem[]>('GET', `/v1/platform/venues?${params.toString()}`, {
    signal,
  });
  return { items: r.data ?? [], nextCursor: r.meta.next_cursor ?? null };
}

export async function fetchPlatformVenue(venueId: string, signal?: AbortSignal) {
  return (await api.get<PlatformVenueProfile>(platformPath(venueId), { signal })).data;
}

export type ReviewAction = 'approve' | 'send-back' | 'hide' | 'unhide';

export async function reviewVenue(
  venueId: string,
  action: ReviewAction,
  body: { expected_version: number; reason?: string },
  key: string,
) {
  return (await api.post<PlatformVenueProfile>(platformPath(venueId, `/${action}`), { body, idempotencyKey: key }))
    .data;
}

export async function setVenuePricing(
  venueId: string,
  body: { expected_version: number; subscriptions_enabled: boolean; pay_per_visit_halalas: number | null },
  key: string,
) {
  return (await api.put<PlatformVenueProfile>(platformPath(venueId, '/pricing'), { body, idempotencyKey: key }))
    .data;
}
