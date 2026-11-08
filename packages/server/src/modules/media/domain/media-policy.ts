import {
  MEDIA_CONTENT_TYPES,
  type MediaContentType,
  type MediaKind,
  type Role,
  type TicketStatus,
} from '@point/shared';

/**
 * Pure rules of the private inspection photos (PNT-027). No I/O, no clock: callers pass every input.
 * Sources: 07 §2.2 (media routes), 09 §3 (`ticket.intake`, `ticket.read_photos`), 09 §5.1, 09 §6, 08 §4.14,
 * canon §5.7 (`media_assets.*`) and §12 (`inspection.*`).
 */

/** The creator may request an upload while the ticket is `received`, or `parking` to finish missing photos. */
export const UPLOAD_TICKET_STATUSES = ['received', 'parking'] as const satisfies readonly TicketStatus[];

export function isUploadAllowedStatus(status: TicketStatus): boolean {
  return (UPLOAD_TICKET_STATUSES as readonly TicketStatus[]).includes(status);
}

export function isSupportedContentType(value: string): value is MediaContentType {
  return (MEDIA_CONTENT_TYPES as readonly string[]).includes(value);
}

/**
 * Normalizes a declared content type for the membership check: media types are case-insensitive (RFC 9110),
 * parameters are not accepted (`image/jpeg; q=1` is unsupported).
 */
export function normalizeContentType(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * A kind counts against `inspection.max_extra_photos` when the venue does not require it: the extra and
 * damage photos, and any angle the venue left out of `inspection.required_photos`. Retakes of a required
 * kind are not limited (02 D-06: a retake replaces the tile of the same kind).
 */
export function isExtraKind(kind: MediaKind, requiredKinds: readonly MediaKind[]): boolean {
  return !requiredKinds.includes(kind);
}

/** The stored (sanitized) type: re-encoded in the declared format, HEIC as JPEG (no HEVC encoder). */
export const SANITIZED_CONTENT_TYPE: Readonly<Record<MediaContentType, MediaContentType>> = {
  'image/jpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
  'image/heic': 'image/jpeg',
};

const EXTENSION: Readonly<Record<MediaContentType, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

export function extensionFor(contentType: MediaContentType): string {
  return EXTENSION[contentType];
}

/**
 * Key of the sanitized object, exactly 09 §6.1: `org/{orgId}/tickets/{ticketId}/{mediaId}.{ext}`, the
 * extension of the stored (sanitized) type. Deterministic, so an interrupted completion can be resumed.
 */
export function sanitizedStorageKey(
  orgId: string,
  ticketId: string,
  mediaId: string,
  declared: MediaContentType,
): string {
  return `org/${orgId}/tickets/${ticketId}/${mediaId}.${extensionFor(SANITIZED_CONTENT_TYPE[declared])}`;
}

/**
 * Key the presigned PUT writes to: the unsanitized original lives under its own `incoming/` prefix (so a
 * bucket lifecycle rule can expire anything a crash left behind) with a random nonce, and is deleted by
 * `complete` before the row becomes `uploaded` (09 §6.2).
 */
export function uploadStorageKey(orgId: string, ticketId: string, mediaId: string, nonce: string): string {
  if (!/^[a-f0-9]{16,64}$/.test(nonce)) throw new Error('upload key nonce must be 16-64 lowercase hex chars');
  return `incoming/${orgId}/${ticketId}/${mediaId}-${nonce}`;
}

export const UPLOAD_KEY_PREFIX = 'incoming/';

export interface PhotoReader {
  role: Role;
  userId: string;
}

export interface PhotoTicketFacts {
  createdBy: string;
  status: TicketStatus;
  /** the reader is the assignee of an open task (canon OPEN_TASK_STATUSES) on the ticket */
  readerHasOpenTask: boolean;
}

/**
 * `ticket.read_photos` = the `ticket.read_full` condition (09 §3, §5.1; 07 §1.10): owner/admin/supervisor in
 * scope (the caller checks the venue scope first); a driver only as the assignee of an open task on the
 * ticket or as its creator during `received`/`parking`.
 */
export function canReadTicketPhotos(reader: PhotoReader, ticket: PhotoTicketFacts): boolean {
  if (reader.role !== 'driver') return true;
  if (ticket.readerHasOpenTask) return true;
  return ticket.createdBy === reader.userId && isUploadAllowedStatus(ticket.status);
}

/** 09 §6.3: a read link lives at most 300 s; MEDIA_READ_URL_TTL_S may shorten it. */
export const MAX_READ_URL_TTL_S = 300;
/** S3 SigV4 presigned URLs cannot outlive 7 days. */
export const MAX_PRESIGN_TTL_S = 7 * 24 * 3600;

export function readUrlTtlSeconds(configured: number): number {
  return Math.min(Math.max(Math.trunc(configured), 1), MAX_READ_URL_TTL_S);
}

export function uploadUrlTtlSeconds(configured: number): number {
  return Math.min(Math.max(Math.trunc(configured), 1), MAX_PRESIGN_TTL_S);
}

/**
 * Expiry of a SigV4-style presigned URL: the signing time has a one-second resolution (`X-Amz-Date`), the
 * URL is valid for `ttl` seconds after it.
 */
export function presignedExpiry(now: Date, ttlSeconds: number): Date {
  return new Date(Math.floor(now.getTime() / 1000) * 1000 + ttlSeconds * 1000);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Path ids that are not UUIDs address nothing (→ the resource's not-found code, never a 500). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
