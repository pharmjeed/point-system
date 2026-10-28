import type { EventStatus, SetupStatus } from '@point/shared';
import type { Q } from '../infra/scope.js';

/**
 * Small read helpers for the modules that build on venues, events and shifts (duty start PNT-024, intake PNT-025,
 * `GET /v1/me/home`, dispatch). They read without locks: a command that needs the row stable locks it itself in
 * canon §14ب order (pool L1, event L2).
 */

/** The default dispatch pool of a venue (exactly one, DEC-21). */
export async function findDefaultDispatchPool(
  q: Q,
  venueId: string,
): Promise<{ id: string; venue_id: string; status: SetupStatus } | null> {
  const r = await q.query<{ id: string; venue_id: string; status: SetupStatus }>(
    `SELECT id, venue_id, status FROM dispatch_pools WHERE venue_id = $1 AND is_default`,
    [venueId],
  );
  return r.rows[0] ?? null;
}

export interface VenueOpenEvent {
  id: string;
  name_ar: string;
  status: EventStatus;
  dispatch_pool_id: string;
  event_date: string;
}

/**
 * Events of a venue in the given statuses (default `open`, the events that accept intake — EVENT_NOT_OPEN
 * otherwise; DEC-37 picks one when several are open), newest first. `GET /v1/me/home` `open_events` may pass
 * `['open', 'closing']`.
 */
export async function listVenueEventsByStatus(
  q: Q,
  venueId: string,
  statuses: readonly EventStatus[] = ['open'],
): Promise<VenueOpenEvent[]> {
  const r = await q.query<VenueOpenEvent>(
    `SELECT id, name_ar, status, dispatch_pool_id, event_date::text AS event_date
       FROM events WHERE venue_id = $1 AND status = ANY($2::text[])
      ORDER BY event_date DESC, opened_at DESC NULLS LAST, id DESC`,
    [venueId, [...statuses]],
  );
  return r.rows;
}
