import type { SetupStatus } from '@point/shared';
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
