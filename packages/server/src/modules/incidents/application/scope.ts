import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import type { Tx } from '../../../core/db/tx.js';

/**
 * TOCTOU re-check inside the command transaction, after the locks (09 §8.4): the venue the guard granted is
 * still granted — the owner always; staff through an active org or venue role scope; a driver through his
 * active assignment. Callers answer a revoked scope as the guard would have (the resource's not-found code
 * for a resource addressed by id, SCOPE_VENUE_DENIED for a venue named in the request).
 */
export async function scopeStillGranted(
  tx: Pick<Tx, 'query'>,
  actor: ActorContext,
  venueId: string,
): Promise<boolean> {
  if (actor.role === 'owner') return true;
  const r =
    actor.role === 'driver'
      ? await tx.query(
          `SELECT 1 FROM driver_assignments a JOIN users u ON u.id = a.driver_id
            WHERE a.driver_id = $1 AND a.venue_id = $2 AND a.status = 'active' AND u.status = 'active' LIMIT 1`,
          [actor.userId, venueId],
        )
      : await tx.query(
          `SELECT 1 FROM role_scopes rs JOIN users u ON u.id = rs.user_id
            WHERE rs.user_id = $1 AND rs.revoked_at IS NULL AND (rs.scope_type = 'org' OR rs.venue_id = $2)
              AND u.status = 'active' LIMIT 1`,
          [actor.userId, venueId],
        );
  return r.rows.length > 0;
}

/**
 * A staff user who may own or handle work of a venue (incident owner, custody holder `supervisor`): an active
 * owner, admin or supervisor of the organization whose scope covers the venue. `null` = no such user in the
 * organization (RESOURCE_NOT_FOUND for the caller), `false` = exists but not eligible.
 */
export async function staffEligibleForVenue(
  tx: Pick<Tx, 'query'>,
  orgId: string,
  userId: string,
  venueId: string,
): Promise<{ eligible: boolean; role: string } | null> {
  const r = await tx.query<{ role: string; status: string; in_scope: boolean }>(
    `SELECT u.role, u.status,
            (u.role = 'owner' OR EXISTS (
               SELECT 1 FROM role_scopes rs
                WHERE rs.user_id = u.id AND rs.revoked_at IS NULL AND (rs.scope_type = 'org' OR rs.venue_id = $3)
            )) AS in_scope
       FROM users u WHERE u.id = $1 AND u.org_id = $2`,
    [userId, orgId, venueId],
  );
  const u = r.rows[0];
  if (!u) return null;
  return { eligible: u.role !== 'driver' && u.status === 'active' && u.in_scope, role: u.role };
}
