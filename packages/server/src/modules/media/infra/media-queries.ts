import type {
  InspectionStatus,
  MediaContentType,
  MediaKind,
  MediaUploadStatus,
  TicketStatus,
} from '@point/shared';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';

/** Anything that runs SQL: a transaction or the pool (queries outside a transaction). */
export type MediaQueryRunner = Pick<Database, 'query'> | Pick<Tx, 'query'>;

/** A `media_assets` row (06_schema.sql §7). */
export interface MediaRow {
  id: string;
  org_id: string;
  ticket_id: string;
  inspection_id: string | null;
  kind: MediaKind;
  storage_key: string;
  content_type: MediaContentType;
  byte_size: number | null;
  sha256: string | null;
  upload_status: MediaUploadStatus;
  uploaded_by: string;
  captured_at: Date | null;
  uploaded_at: Date | null;
  deleted_at: Date | null;
  delete_reason: string | null;
  created_at: Date;
}

/** 07_openapi `Media` (the storage key and the hash are internal and never leave the server). */
export interface MediaDto {
  id: string;
  ticket_id: string;
  kind: MediaKind;
  content_type: MediaContentType;
  byte_size: number | null;
  upload_status: MediaUploadStatus;
  captured_at: string | null;
  uploaded_at: string | null;
  uploaded_by: string;
}

export function toMediaDto(r: MediaRow): MediaDto {
  return {
    id: r.id,
    ticket_id: r.ticket_id,
    kind: r.kind,
    content_type: r.content_type,
    byte_size: r.byte_size,
    upload_status: r.upload_status,
    captured_at: r.captured_at ? r.captured_at.toISOString() : null,
    uploaded_at: r.uploaded_at ? r.uploaded_at.toISOString() : null,
    uploaded_by: r.uploaded_by,
  };
}

/** The ticket columns the photo rules need, read straight from `tickets` (no dependency on tickets-custody). */
export interface MediaTicketFacts {
  id: string;
  org_id: string;
  venue_id: string;
  event_id: string;
  dispatch_pool_id: string;
  display_number: number;
  status: TicketStatus;
  created_by: string;
  inspection_status: InspectionStatus;
  submitted_at: Date | null;
  version: number;
}

const MEDIA_COLUMNS = `id, org_id, ticket_id, inspection_id, kind, storage_key, content_type, byte_size, sha256,
  upload_status, uploaded_by, captured_at, uploaded_at, deleted_at, delete_reason, created_at`;

const TICKET_COLUMNS = `id, org_id, venue_id, event_id, dispatch_pool_id, display_number, status, created_by,
  inspection_status, submitted_at, version`;

export async function findTicketFacts(
  q: MediaQueryRunner,
  ticketId: string,
  orgId: string,
): Promise<MediaTicketFacts | null> {
  const r = await q.query<MediaTicketFacts>(
    `SELECT ${TICKET_COLUMNS} FROM tickets WHERE id = $1 AND org_id = $2`,
    [ticketId, orgId],
  );
  return r.rows[0] ?? null;
}

export async function findMedia(
  q: MediaQueryRunner,
  mediaId: string,
  orgId: string,
): Promise<MediaRow | null> {
  const r = await q.query<MediaRow>(
    `SELECT ${MEDIA_COLUMNS} FROM media_assets WHERE id = $1 AND org_id = $2`,
    [mediaId, orgId],
  );
  return r.rows[0] ?? null;
}

/**
 * Row lock on a media row, taken after its ticket (L5): media rows are dependents of the ticket, and every
 * writer of a ticket's media locks the ticket first.
 */
export async function lockMediaRow(tx: Tx, mediaId: string): Promise<MediaRow | null> {
  return tx.maybeOne<MediaRow>(`SELECT ${MEDIA_COLUMNS} FROM media_assets WHERE id = $1 FOR NO KEY UPDATE`, [
    mediaId,
  ]);
}

export interface MediaWithTicket extends MediaRow {
  venue_id: string;
  ticket_status: TicketStatus;
  ticket_created_by: string;
}

/** Media + the ticket facts needed for scope and access, and whether `readerId` holds an open task on it. */
export async function findMediaWithTicket(
  q: MediaQueryRunner,
  mediaId: string,
  orgId: string,
  readerId: string,
  openTaskStatuses: readonly string[],
): Promise<(MediaWithTicket & { reader_has_open_task: boolean }) | null> {
  const r = await q.query<MediaWithTicket & { reader_has_open_task: boolean }>(
    `SELECT m.id, m.org_id, m.ticket_id, m.inspection_id, m.kind, m.storage_key, m.content_type, m.byte_size, m.sha256,
            m.upload_status, m.uploaded_by, m.captured_at, m.uploaded_at, m.deleted_at, m.delete_reason, m.created_at,
            t.venue_id, t.status AS ticket_status, t.created_by AS ticket_created_by,
            EXISTS (SELECT 1 FROM tasks k
                     WHERE k.ticket_id = t.id AND k.assignee_id = $3 AND k.status = ANY($4::text[])) AS reader_has_open_task
       FROM media_assets m JOIN tickets t ON t.id = m.ticket_id
      WHERE m.id = $1 AND m.org_id = $2`,
    [mediaId, orgId, readerId, [...openTaskStatuses]],
  );
  return r.rows[0] ?? null;
}

/**
 * Photos of non-required kinds that still hold a slot of `inspection.max_extra_photos`: uploaded ones, and
 * pending ones whose upload window (`uploadWindowStart`) is still open. A pending row whose presigned URL
 * expired can no longer receive an upload and stops counting.
 */
export async function countExtraPhotoSlots(
  tx: Tx,
  ticketId: string,
  requiredKinds: readonly MediaKind[],
  uploadWindowStart: Date,
): Promise<number> {
  const r = await tx.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM media_assets
      WHERE ticket_id = $1 AND NOT (kind = ANY($2::text[]))
        AND (upload_status = 'uploaded' OR (upload_status = 'pending' AND created_at > $3))`,
    [ticketId, [...requiredKinds], uploadWindowStart],
  );
  return r.n;
}

export interface NewPendingMedia {
  id: string;
  orgId: string;
  ticketId: string;
  kind: MediaKind;
  storageKey: string;
  contentType: MediaContentType;
  byteSize: number;
  sha256: string | null;
  uploadedBy: string;
  capturedAt: Date | null;
  createdAt: Date;
}

export async function insertPendingMedia(tx: Tx, m: NewPendingMedia): Promise<MediaRow> {
  return tx.one<MediaRow>(
    `INSERT INTO media_assets (id, org_id, ticket_id, kind, storage_key, content_type, byte_size, sha256,
                               upload_status, uploaded_by, captured_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11)
     RETURNING ${MEDIA_COLUMNS}`,
    [
      m.id,
      m.orgId,
      m.ticketId,
      m.kind,
      m.storageKey,
      m.contentType,
      m.byteSize,
      m.sha256,
      m.uploadedBy,
      m.capturedAt,
      m.createdAt,
    ],
  );
}

export async function markMediaUploaded(
  tx: Tx,
  m: {
    id: string;
    storageKey: string;
    byteSize: number;
    sha256: string;
    contentType: MediaContentType;
    at: Date;
  },
): Promise<MediaRow> {
  return tx.one<MediaRow>(
    `UPDATE media_assets
        SET storage_key = $2, byte_size = $3, sha256 = $4, content_type = $5, upload_status = 'uploaded', uploaded_at = $6
      WHERE id = $1 AND upload_status = 'pending'
      RETURNING ${MEDIA_COLUMNS}`,
    [m.id, m.storageKey, m.byteSize, m.sha256, m.contentType, m.at],
  );
}

/**
 * Distinct kinds of the ticket's `uploaded` photos, sorted — what PNT-028 compares with
 * `inspection.required_photos` (TT-03) and the discard-draft check uses (TT-04: no uploaded photo).
 * `capturedAtOrBefore` keeps only photos taken by then (`COALESCE(captured_at, created_at)`), e.g. the
 * intake submission time for a late inspection completion (11 §6.3).
 */
export async function listUploadedPhotoKinds(
  q: MediaQueryRunner,
  ticketId: string,
  opts: { capturedAtOrBefore?: Date } = {},
): Promise<MediaKind[]> {
  const r = await q.query<{ kind: MediaKind }>(
    `SELECT DISTINCT kind FROM media_assets
      WHERE ticket_id = $1 AND upload_status = 'uploaded'
        AND ($2::timestamptz IS NULL OR COALESCE(captured_at, created_at) <= $2::timestamptz)
      ORDER BY kind`,
    [ticketId, opts.capturedAtOrBefore ?? null],
  );
  return r.rows.map((x) => x.kind);
}

/** The ticket's photos as 07 `Media` objects (TicketDetail.media), oldest first; deleted ones only on request. */
export async function listTicketMedia(
  q: MediaQueryRunner,
  ticketId: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<MediaDto[]> {
  const r = await q.query<MediaRow>(
    `SELECT ${MEDIA_COLUMNS} FROM media_assets
      WHERE ticket_id = $1 AND ($2::boolean OR upload_status <> 'deleted')
      ORDER BY created_at, id`,
    [ticketId, opts.includeDeleted ?? false],
  );
  return r.rows.map(toMediaDto);
}
