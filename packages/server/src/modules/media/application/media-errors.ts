import { MEDIA_CONTENT_TYPES, isTerminalTicketStatus, type TicketStatus } from '@point/shared';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import { AppError } from '../../../core/errors/app-error.js';
import { ObjectStorageError } from '../infra/object-storage.js';

/** A media id that does not exist or is out of the caller's reach (08 §1.3 rule 4: non-disclosure). */
export const mediaNotFound = () => new AppError('RESOURCE_NOT_FOUND', { resource: 'media' });

export const uploadIncomplete = (mediaId: string, uploadStatus: string) =>
  new AppError('MEDIA_UPLOAD_INCOMPLETE', { media_id: mediaId, upload_status: uploadStatus });

export const mediaTooLarge = (maxBytes: number) => new AppError('MEDIA_TOO_LARGE', { max_bytes: maxBytes });

export const mediaTypeUnsupported = () =>
  new AppError('MEDIA_TYPE_UNSUPPORTED', { allowed_types: [...MEDIA_CONTENT_TYPES] });

/**
 * A ticket addressed by id is visible when it is in the actor's organization and venue scope; a driver does
 * not see closed tickets (09 §8.2 `findTicketForActor`). Otherwise TICKET_NOT_FOUND.
 */
export function assertTicketVisible(
  actor: ActorContext,
  t: { org_id: string; venue_id: string; status: TicketStatus } | null | undefined,
): asserts t {
  if (!t || t.org_id !== actor.orgId || !actor.venueIds.has(t.venue_id))
    throw new AppError('TICKET_NOT_FOUND');
  if (actor.role === 'driver' && isTerminalTicketStatus(t.status)) throw new AppError('TICKET_NOT_FOUND');
}

/**
 * Object storage failures during `complete` (08 §4.15): no answer or a storage-side error → 504
 * DEPENDENCY_TIMEOUT (`dependency: object_storage`, retryable, never stored with the idempotency key); a
 * configuration problem → INTERNAL_ERROR; anything else is returned unchanged.
 */
export function storageFailureToAppError(e: unknown, maxBytes: number): unknown {
  if (!(e instanceof ObjectStorageError)) return e;
  switch (e.failure) {
    case 'too_large':
      return mediaTooLarge(maxBytes);
    case 'misconfigured':
      return new AppError('INTERNAL_ERROR', {}, { cause: e });
    default:
      return new AppError(
        'DEPENDENCY_TIMEOUT',
        { dependency: 'object_storage' },
        { cause: e, retryAfterS: 2 },
      );
  }
}
