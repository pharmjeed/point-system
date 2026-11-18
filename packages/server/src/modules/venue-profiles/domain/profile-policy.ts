import { hasOpeningHours, type OpeningHours, type VenuePublicStatus } from '@point/shared';
import { AppError } from '../../../core/errors/app-error.js';

/**
 * Pure rules of the venue public profile (V2-004, DEC-490 … DEC-494). No I/O, no clock.
 *
 * Status machine (`venue_public_profiles.status`):
 *
 * | command                      | from                          | to          | who      |
 * |------------------------------|-------------------------------|-------------|----------|
 * | PUT public-profile (a change)| (none), draft, submitted, approved | draft  | operator |
 * | submit                       | draft                         | submitted   | operator |
 * | approve                      | submitted                     | approved    | platform |
 * | send-back (reason)           | submitted                     | draft       | platform |
 * | hide (reason)                | approved                      | hidden      | platform |
 * | unhide (reason)              | hidden                        | approved    | platform |
 * | pricing                      | any                           | (unchanged) | platform |
 *
 * A hidden profile is the platform's decision: the operator can neither edit nor resubmit it (DEC-492).
 */

export const ENTITY_TYPE = 'venue_public_profile';

/** Audit actions of the platform review (platform_audit_log and the operator's audit_log). */
export const REVIEW_ACTIONS = {
  approve: 'venue_profile.approve',
  sendBack: 'venue_profile.send_back',
  hide: 'venue_profile.hide',
  unhide: 'venue_profile.unhide',
  pricing: 'venue_profile.pricing',
} as const;

export const OPERATOR_OPERATIONS = {
  get: 'GET /v1/venues/{venueId}/public-profile',
  put: 'PUT /v1/venues/{venueId}/public-profile',
  photos: 'POST /v1/venues/{venueId}/public-profile/photos',
  submit: 'POST /v1/venues/{venueId}/public-profile/submit',
} as const;

export const PLATFORM_OPERATIONS = {
  approve: 'POST /v1/platform/venues/{venueId}/approve',
  sendBack: 'POST /v1/platform/venues/{venueId}/send-back',
  hide: 'POST /v1/platform/venues/{venueId}/hide',
  unhide: 'POST /v1/platform/venues/{venueId}/unhide',
  pricing: 'PUT /v1/platform/venues/{venueId}/pricing',
} as const;

export const EDITABLE_FROM: readonly VenuePublicStatus[] = ['draft', 'submitted', 'approved'];
export const SUBMIT_FROM: readonly VenuePublicStatus[] = ['draft'];
export const APPROVE_FROM: readonly VenuePublicStatus[] = ['submitted'];
export const SEND_BACK_FROM: readonly VenuePublicStatus[] = ['submitted'];
export const HIDE_FROM: readonly VenuePublicStatus[] = ['approved'];
export const UNHIDE_FROM: readonly VenuePublicStatus[] = ['hidden'];

export function invalidProfileTransition(a: {
  venueId: string;
  status: VenuePublicStatus;
  version: number;
  command: string;
  allowedFrom: readonly VenuePublicStatus[];
  reason?: string;
}): AppError {
  return new AppError('INVALID_STATE_TRANSITION', {
    entity_type: ENTITY_TYPE,
    entity_id: a.venueId,
    current_status: a.status,
    current_version: a.version,
    command: a.command,
    allowed_from: [...a.allowedFrom],
    ...(a.reason ? { reason: a.reason } : {}),
  });
}

export function assertFrom(
  row: { venue_id: string; status: VenuePublicStatus; version: number },
  command: string,
  allowedFrom: readonly VenuePublicStatus[],
  reason?: string,
): void {
  if (!allowedFrom.includes(row.status)) {
    throw invalidProfileTransition({
      venueId: row.venue_id,
      status: row.status,
      version: row.version,
      command,
      allowedFrom,
      ...(reason ? { reason } : {}),
    });
  }
}

export function profileNotFound(): AppError {
  return new AppError('RESOURCE_NOT_FOUND', { resource: ENTITY_TYPE });
}

export function profileVersionConflict(venueId: string, current: number): AppError {
  return new AppError('VERSION_CONFLICT', { entity: ENTITY_TYPE, id: venueId, current_version: current });
}

export interface SubmitFacts {
  address: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  opening_hours: OpeningHours;
}

/**
 * What a profile must carry before it can be submitted (DEC-491): the address and the city (shown on C-08 and
 * filtered by P-04), the map position, and at least one open interval in the week. Photos are optional.
 */
export function missingForSubmit(p: SubmitFacts): { field: string; issue: 'required_to_submit' }[] {
  const out: { field: string; issue: 'required_to_submit' }[] = [];
  if (!p.address) out.push({ field: 'address', issue: 'required_to_submit' });
  if (!p.city) out.push({ field: 'city', issue: 'required_to_submit' });
  if (p.lat === null || p.lng === null) out.push({ field: 'lat', issue: 'required_to_submit' });
  if (!hasOpeningHours(p.opening_hours)) out.push({ field: 'opening_hours', issue: 'required_to_submit' });
  return out;
}

/**
 * Object keys of the profile photos (DEC-494), apart from the ticket photos of 09 §6.1. The presigned PUT writes the
 * unsanitized original under `incoming/` (expired by the bucket lifecycle rule like the ticket uploads); the PUT
 * of the profile sanitizes it to the final key before the photo is attached. Both are derived from the ids, so no
 * table is needed for an upload in progress.
 */
export function photoUploadKey(orgId: string, venueId: string, photoId: string): string {
  return `incoming/${orgId}/venues/${venueId}/${photoId.toLowerCase()}`;
}

export function photoStorageKey(orgId: string, venueId: string, photoId: string): string {
  return `org/${orgId}/venues/${venueId}/photos/${photoId.toLowerCase()}`;
}
