import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import { assertExplicitVenue } from '../../../core/actor-context/actor-context.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { isUuid, notFound, type VenuesResource } from '../domain/errors.js';

export type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;

/**
 * A venue the caller names in the path (`/v1/venues/{venueId}/…`, 08 §1.3 rule 4):
 * - org scope (owner, admin): every venue of the organization is in scope, so a venue outside the set does not
 *   exist for the caller → 404 RESOURCE_NOT_FOUND (`resource: venue`);
 * - a driver without an active assignment → ASSIGNMENT_REQUIRED;
 * - anyone else outside their scope → 403 SCOPE_VENUE_DENIED (no existence probe: a supervisor cannot tell a
 *   missing venue from one outside their scope).
 */
export function assertVenueParam(actor: ActorContext, venueId: string): void {
  if (actor.orgScope) {
    if (!isUuid(venueId) || !actor.venueIds.has(venueId)) throw notFound('venue');
    return;
  }
  if (!isUuid(venueId)) {
    if (actor.role === 'driver' && !actor.assignment) throw new AppError('ASSIGNMENT_REQUIRED');
    throw new AppError('SCOPE_VENUE_DENIED', { venue_id: venueId });
  }
  assertExplicitVenue(actor, venueId);
}

/** A resource addressed by its id: missing, in another org or outside the scope → 404 of that resource. */
export function assertResourceInScope(
  actor: ActorContext,
  row: { org_id: string; venue_id: string } | null | undefined,
  resource: VenuesResource,
): asserts row is { org_id: string; venue_id: string } {
  if (!row || row.org_id !== actor.orgId || !actor.venueIds.has(row.venue_id)) throw notFound(resource);
}

/**
 * TOCTOU re-check inside the command transaction, after the locks (09 §8.4): the venue scope the guard saw is
 * still granted (an org scope row, or an active venue scope row; the owner always has the organization).
 * A revoked scope answers as the guard would have: SCOPE_VENUE_DENIED for a venue named in the path, the
 * resource's 404 for a resource addressed by id.
 */
export async function recheckVenueScope(
  tx: Pick<Tx, 'query'>,
  actor: ActorContext,
  venueId: string,
  onDenied: { explicit: true } | { resource: VenuesResource },
): Promise<void> {
  if (actor.role === 'owner') return;
  const r = await tx.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM role_scopes rs
        WHERE rs.user_id = $1 AND rs.revoked_at IS NULL AND (rs.scope_type = 'org' OR rs.venue_id = $2)
     ) AS ok`,
    [actor.userId, venueId],
  );
  if (r.rows[0]?.ok) return;
  if ('explicit' in onDenied) throw new AppError('SCOPE_VENUE_DENIED', { venue_id: venueId });
  throw notFound(onDenied.resource);
}
