/**
 * Ticket timeline entry written when a photo upload completes (PNT-027). Canon §7.1 has no domain event for
 * a plain photo upload, so this type is written to `ticket_events` only (no outbox event, no realtime
 * message) until the canon names it — DEC-PROPOSED-1 in docs/progress/notes/pnt-027.md.
 * The late inspection completion uses the canon event `ticket.inspection_completed` (11 §6.3, §8.2).
 */
export const PHOTO_UPLOADED_TIMELINE_TYPE = 'ticket.photo_uploaded';
