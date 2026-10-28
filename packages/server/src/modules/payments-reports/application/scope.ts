import type { Role } from '@point/shared';
import {
  assertExplicitVenue,
  hasPermission,
  type ActorContext,
} from '../../../core/actor-context/actor-context.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import type { TicketQueryable } from '../../tickets-custody/index.js';

/**
 * Scope rules of the money and report routes (09 §3, 08 §1.3 rule 4): a resource addressed by its id (event,
 * payment, ticket, export) outside the caller's venues is that resource's 404; a venue the caller names
 * (`venue_id` in the query, body or export filters) is SCOPE_VENUE_DENIED.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export type ScopedResource = 'event' | 'payment' | 'export' | 'driver';

export const notFound = (resource: ScopedResource) => new AppError('RESOURCE_NOT_FOUND', { resource });

/** `events` row as the money commands and reports read it. */
export interface EventRow {
  id: string;
  org_id: string;
  venue_id: string;
  dispatch_pool_id: string;
  name_ar: string;
  event_date: string;
  status: 'draft' | 'open' | 'closing' | 'closed' | 'canceled';
  pricing_mode: 'included' | 'per_vehicle';
  fee_halalas: number;
  allowed_payment_methods: ('cash' | 'pos')[];
  opened_at: Date | null;
  closing_started_at: Date | null;
  closed_at: Date | null;
  closed_by: string | null;
  close_summary: Record<string, unknown> | null;
  version: number;
}

export const EVENT_SELECT = `SELECT e.id, e.org_id, e.venue_id, e.dispatch_pool_id, e.name_ar, e.event_date::text AS event_date,
  e.status, e.pricing_mode, e.fee_halalas, e.allowed_payment_methods, e.opened_at, e.closing_started_at, e.closed_at,
  e.closed_by, e.close_summary, e.version FROM events e`;

/** An event addressed by id (path or body): unknown, malformed, another org or outside the venues → 404 event. */
export async function findEventInScope(
  q: TicketQueryable,
  actor: ActorContext,
  eventId: string,
): Promise<EventRow> {
  if (!isUuid(eventId)) throw notFound('event');
  const r = await q.query<EventRow>(`${EVENT_SELECT} WHERE e.id = $1`, [eventId]);
  const ev = r.rows[0];
  if (!ev || ev.org_id !== actor.orgId || !actor.venueIds.has(ev.venue_id)) throw notFound('event');
  return ev;
}

/** A venue named by the caller (query, body, export filters): SCOPE_VENUE_DENIED outside the scope. */
export function assertNamedVenue(actor: ActorContext, venueId: string): void {
  if (!isUuid(venueId)) throw new AppError('SCOPE_VENUE_DENIED', { venue_id: venueId });
  assertExplicitVenue(actor, venueId);
}

/**
 * TOCTOU re-check after the locks (09 §8.4): the staff scope the guard saw is still granted — an org scope row
 * or an active venue scope row (the owner always has the organization). A revoked scope answers as the guard
 * would have: the resource's 404 for a resource addressed by id, SCOPE_VENUE_DENIED for a named venue.
 */
export async function recheckStaffScope(
  tx: Pick<Tx, 'query'>,
  actor: ActorContext,
  venueId: string,
  onDenied: { resource: ScopedResource } | { notFound: 'TICKET_NOT_FOUND' } | { explicit: true },
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
  if ('notFound' in onDenied) throw new AppError(onDenied.notFound);
  throw notFound(onDenied.resource);
}

/** Venues a staff user may read now (org scope → every venue of the org); used by the export job. */
export async function staffVenueIds(
  q: TicketQueryable,
  userId: string,
): Promise<{
  orgId: string;
  role: string;
  venueIds: string[];
  orgScope: boolean;
  canReadAudit: boolean;
} | null> {
  const u = (
    await q.query<{ org_id: string; role: Role; status: string }>(
      `SELECT org_id, role, status FROM users WHERE id = $1`,
      [userId],
    )
  ).rows[0];
  if (!u || u.status !== 'active' || u.role === 'driver') return null;
  const scopes = (
    await q.query<{ scope_type: 'org' | 'venue'; venue_id: string | null }>(
      `SELECT scope_type, venue_id FROM role_scopes WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    )
  ).rows;
  const orgScope = u.role === 'owner' || scopes.some((s) => s.scope_type === 'org');
  const venueIds = orgScope
    ? (await q.query<{ id: string }>(`SELECT id FROM venues WHERE org_id = $1`, [u.org_id])).rows.map(
        (v) => v.id,
      )
    : scopes.filter((s) => s.venue_id).map((s) => s.venue_id!);
  return {
    orgId: u.org_id,
    role: u.role,
    venueIds,
    orgScope,
    canReadAudit: hasPermission({ role: u.role, canDrive: false }, 'audit.read'),
  };
}
