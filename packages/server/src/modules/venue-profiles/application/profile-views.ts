import {
  normalizeOpeningHours,
  type OpeningHours,
  type OperatorStatus,
  type VenueCategory,
  type VenuePublicStatus,
} from '@point/shared';
import { num, type ProfileRow, type ReviewNote } from '../infra/profile-rows.js';
import { signProfilePhotos, type PhotoSigner, type ProfilePhotoDto } from './photo-urls.js';

/** 07 `VenuePublicProfile` — what the operator (S-13) and the reviewer (P-04) see of one profile. */
export interface VenuePublicProfileDto {
  venue_id: string;
  venue: { code: string; name_ar: string; name_en: string | null; status: 'active' | 'inactive' };
  /** null: the venue has no public profile yet (the first PUT creates it with `expected_version: 0`) */
  status: VenuePublicStatus | null;
  category: VenueCategory | null;
  address: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  opening_hours: OpeningHours;
  photos: ProfilePhotoDto[];
  subscriptions_enabled: boolean;
  pay_per_visit_halalas: number | null;
  approved_at: string | null;
  review_note: ReviewNote | null;
  /** 0 when there is no profile yet */
  version: number;
  updated_at: string | null;
}

/** 07 `PlatformVenueProfile`: the same profile with its operator, for the platform console. */
export interface PlatformVenueProfileDto extends VenuePublicProfileDto {
  org: { id: string; name_ar: string; name_en: string | null; operator_status: OperatorStatus };
  approved_by: string | null;
}

export async function profileView(
  row: ProfileRow,
  note: ReviewNote | null,
  signer: PhotoSigner,
): Promise<VenuePublicProfileDto> {
  return {
    venue_id: row.venue_id,
    venue: {
      code: row.venue_code,
      name_ar: row.venue_name_ar,
      name_en: row.venue_name_en,
      status: row.venue_status,
    },
    status: row.status,
    category: row.category,
    address: row.address,
    city: row.city,
    lat: num(row.lat),
    lng: num(row.lng),
    opening_hours: normalizeOpeningHours(row.opening_hours),
    photos: await signProfilePhotos(signer, row.org_id, row.venue_id, row.photo_asset_ids),
    subscriptions_enabled: row.subscriptions_enabled,
    pay_per_visit_halalas: num(row.pay_per_visit_halalas),
    approved_at: row.approved_at?.toISOString() ?? null,
    review_note: note,
    version: row.version,
    updated_at: row.updated_at.toISOString(),
  };
}

export async function platformProfileView(
  row: ProfileRow,
  note: ReviewNote | null,
  signer: PhotoSigner,
): Promise<PlatformVenueProfileDto> {
  return {
    ...(await profileView(row, note, signer)),
    org: {
      id: row.org_id,
      name_ar: row.org_name_ar,
      name_en: row.org_name_en,
      operator_status: row.operator_status,
    },
    approved_by: row.approved_by,
  };
}

/** The empty profile of a venue that has none yet (GET before the first save). */
export function emptyProfileView(venue: {
  id: string;
  code: string;
  name_ar: string;
  name_en: string | null;
  status: 'active' | 'inactive';
  address: string | null;
  city: string | null;
}): VenuePublicProfileDto {
  return {
    venue_id: venue.id,
    venue: { code: venue.code, name_ar: venue.name_ar, name_en: venue.name_en, status: venue.status },
    status: null,
    category: null,
    address: venue.address,
    city: venue.city,
    lat: null,
    lng: null,
    opening_hours: { always_open: false, days: {} },
    photos: [],
    subscriptions_enabled: false,
    pay_per_visit_halalas: null,
    approved_at: null,
    review_note: null,
    version: 0,
    updated_at: null,
  };
}

/** The audit diff of a profile: the reviewed fields, never a photo URL. */
export function profileAuditState(p: {
  status: VenuePublicStatus | null;
  category: VenueCategory | null;
  address: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  opening_hours: OpeningHours;
  photo_ids: readonly string[];
  version: number;
}): Record<string, unknown> {
  return {
    status: p.status,
    category: p.category,
    address: p.address,
    city: p.city,
    lat: p.lat,
    lng: p.lng,
    opening_hours: p.opening_hours,
    photo_ids: [...p.photo_ids],
    version: p.version,
  };
}
