import { rooms } from '@point/shared';
import type { EventEnvelope, Tx } from '../../../core/db/tx.js';
import { registerTxPlanner, unregisterTxPlanner, type TxPlanner } from '../../../core/db/tx-planners.js';
import { newId } from '../../../core/crypto/ids.js';
import { publishRealtime, type RealtimeMessage } from '../../../core/realtime/realtime-publisher.js';
import { ticketUpdateRequests } from '../domain/realtime-rules.js';
import { requestTicketUpdate } from './ticket-updates.js';

/** Rooms per NOTIFY: keeps every publication far below the 8000-byte limit (no `job.ws_publish` fallback). */
export const ROOMS_PER_PUBLISH = 60;

const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : new Date(d).toISOString();

async function publishChunked(
  tx: Tx,
  orgId: string,
  target: string[],
  msg: Omit<RealtimeMessage, 'id'>,
): Promise<void> {
  const unique = [...new Set(target)];
  for (let i = 0; i < unique.length; i += ROOMS_PER_PUBLISH)
    await publishRealtime(tx, orgId, unique.slice(i, i + ROOMS_PER_PUBLISH), { ...msg, id: newId() });
}

const envelopeOf = (ev: EventEnvelope) => ({
  aggregate: ev.aggregate,
  actor: ev.actor,
  occurred_at: ev.occurred_at,
});

/**
 * `sync.required` for event status changes (11 §8.9, 14 §3.5): the venue supervisors and the drivers on
 * duty in the event's pool refetch the event list (`scope = events`, D-05 choice of DEC-37).
 */
async function eventSync(tx: Tx, ev: EventEnvelope): Promise<void> {
  const id =
    (ev.payload as { event_id?: string }).event_id ??
    (ev.aggregate.type === 'event' ? ev.aggregate.id : null);
  if (!id) return;
  const e = await tx.maybeOne<{ id: string; venue_id: string; dispatch_pool_id: string }>(
    `SELECT id, venue_id, dispatch_pool_id FROM events WHERE id = $1`,
    [id],
  );
  if (!e) return;
  await publishChunked(
    tx,
    ev.org_id,
    [rooms.venueSupervisors(e.venue_id), rooms.poolDrivers(e.dispatch_pool_id)],
    {
      ...envelopeOf(ev),
      event: 'sync.required',
      venue_id: e.venue_id,
      dispatch_pool_id: e.dispatch_pool_id,
      event_id: e.id,
      data: {
        cause: ev.type,
        reason: 'event_status_changed',
        scope: 'events',
        event_id: e.id,
        dispatch_pool_id: e.dispatch_pool_id,
      },
    },
  );
}

/**
 * `sync.required` for shift open/close (11 §8.9 `scope = home`, 14 §3.5): the venue supervisors and the
 * pool's on-duty drivers; at open also the drivers assigned to the venue (nobody is on duty in a pool
 * without an open shift, D-03 waits for it); at close also the users whose duty the close ended, so their
 * sockets leave the pool room at once (the gateway re-evaluates the rooms of `user:` targets).
 */
async function shiftSync(tx: Tx, ev: EventEnvelope): Promise<void> {
  const p = ev.payload as { shift_id?: string; ended_duty_session_ids?: string[] };
  const id = p.shift_id ?? (ev.aggregate.type === 'shift' ? ev.aggregate.id : null);
  if (!id) return;
  const sh = await tx.maybeOne<{ id: string; venue_id: string; dispatch_pool_id: string }>(
    `SELECT id, venue_id, dispatch_pool_id FROM shifts WHERE id = $1`,
    [id],
  );
  if (!sh) return;
  const users =
    ev.type === 'shift.opened'
      ? await tx.rows<{ id: string }>(
          `SELECT a.driver_id AS id FROM driver_assignments a JOIN users u ON u.id = a.driver_id
            WHERE a.venue_id = $1 AND a.status = 'active' AND u.status = 'active' ORDER BY a.driver_id`,
          [sh.venue_id],
        )
      : Array.isArray(p.ended_duty_session_ids) && p.ended_duty_session_ids.length
        ? await tx.rows<{ id: string }>(
            `SELECT DISTINCT user_id AS id FROM duty_sessions WHERE id = ANY($1::uuid[]) ORDER BY user_id`,
            [p.ended_duty_session_ids],
          )
        : [];
  await publishChunked(
    tx,
    ev.org_id,
    [
      rooms.venueSupervisors(sh.venue_id),
      rooms.poolDrivers(sh.dispatch_pool_id),
      ...users.map((u) => rooms.user(u.id)),
    ],
    {
      ...envelopeOf(ev),
      event: 'sync.required',
      venue_id: sh.venue_id,
      dispatch_pool_id: sh.dispatch_pool_id,
      data: {
        cause: ev.type,
        reason: 'shift_status_changed',
        scope: 'home',
        shift_id: sh.id,
        dispatch_pool_id: sh.dispatch_pool_id,
      },
    },
  );
}

/**
 * `channel.status` (07 §4.3 «every room of the organization», 14 §3.6, 11 §8.10): the admins, every
 * venue's supervisors and every pool's on-duty drivers (the D-15 / S-02 bar). One message per change.
 */
async function channelStatus(tx: Tx, ev: EventEnvelope): Promise<void> {
  const p = ev.payload as { channel_id?: string; to?: string };
  if (p.to !== 'healthy' && p.to !== 'degraded' && p.to !== 'down') return;
  const venues = await tx.rows<{ id: string }>(`SELECT id FROM venues WHERE org_id = $1 ORDER BY id`, [
    ev.org_id,
  ]);
  const pools = await tx.rows<{ id: string }>(`SELECT id FROM dispatch_pools WHERE org_id = $1 ORDER BY id`, [
    ev.org_id,
  ]);
  const channelId = p.channel_id ?? ev.aggregate.id;
  await publishChunked(
    tx,
    ev.org_id,
    [
      rooms.orgAdmins(ev.org_id),
      ...venues.map((v) => rooms.venueSupervisors(v.id)),
      ...pools.map((x) => rooms.poolDrivers(x.id)),
    ],
    {
      ...envelopeOf(ev),
      aggregate: { type: 'whatsapp_channel', id: channelId, version: null },
      event: 'channel.status',
      data: { cause: 'wa.channel_health_changed', whatsapp: p.to, changed_at: ev.occurred_at },
    },
  );
}

interface IncidentRow {
  id: string;
  org_id: string;
  venue_id: string;
  event_id: string | null;
  ticket_id: string | null;
  type: string;
  status: string;
  severity: string;
  description: string;
  resolution: string | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  opened_by_id: string;
  opened_by_name: string;
  opened_by_code: string | null;
  owner_id: string | null;
  owner_name: string | null;
  owner_code: string | null;
  resolved_by_id: string | null;
  resolved_by_name: string | null;
  resolved_by_code: string | null;
}

const userRef = (id: string | null, name: string | null, code: string | null) =>
  id ? { id, full_name: name ?? '', ...(code ? { employee_code: code } : {}) } : null;

/** `Incident` (07) read fresh from the row (11 §1.6). */
export async function loadIncidentView(tx: Pick<Tx, 'maybeOne'>, incidentId: string) {
  const r = await tx.maybeOne<IncidentRow>(
    `SELECT i.id, i.org_id, i.venue_id, i.event_id, i.ticket_id, i.type, i.status, i.severity, i.description,
            i.resolution, i.resolved_at, i.closed_at, i.version, i.created_at, i.updated_at,
            ob.id AS opened_by_id, ob.full_name AS opened_by_name, ob.employee_code AS opened_by_code,
            ow.id AS owner_id, ow.full_name AS owner_name, ow.employee_code AS owner_code,
            rb.id AS resolved_by_id, rb.full_name AS resolved_by_name, rb.employee_code AS resolved_by_code
       FROM incidents i
       JOIN users ob ON ob.id = i.opened_by
       LEFT JOIN users ow ON ow.id = i.owner_id
       LEFT JOIN users rb ON rb.id = i.resolved_by
      WHERE i.id = $1`,
    [incidentId],
  );
  if (!r) return null;
  return {
    row: r,
    view: {
      id: r.id,
      venue_id: r.venue_id,
      event_id: r.event_id,
      ticket_id: r.ticket_id,
      type: r.type,
      status: r.status,
      severity: r.severity,
      description: r.description,
      opened_by: userRef(r.opened_by_id, r.opened_by_name, r.opened_by_code)!,
      owner: userRef(r.owner_id, r.owner_name, r.owner_code),
      resolution: r.resolution,
      resolved_by: userRef(r.resolved_by_id, r.resolved_by_name, r.resolved_by_code),
      resolved_at: iso(r.resolved_at),
      closed_at: iso(r.closed_at),
      version: r.version,
      created_at: iso(r.created_at)!,
      updated_at: iso(r.updated_at),
    },
  };
}

/** `incident.updated` (07 §4.3; 11 §8.8): `Incident` + `cause` to the venue supervisors (S-12). */
async function incidentUpdated(tx: Tx, ev: EventEnvelope): Promise<void> {
  const id =
    (ev.payload as { incident_id?: string }).incident_id ??
    (ev.aggregate.type === 'incident' ? ev.aggregate.id : null);
  if (!id) return;
  const found = await loadIncidentView(tx, id);
  if (!found) return;
  await publishRealtime(tx, ev.org_id, [rooms.venueSupervisors(found.row.venue_id)], {
    ...envelopeOf(ev),
    aggregate: { type: 'incident', id, version: found.row.version },
    event: 'incident.updated',
    id: newId(),
    venue_id: found.row.venue_id,
    event_id: found.row.event_id,
    data: { ...found.view, cause: ev.type },
  });
}

/**
 * Non-dispatch realtime (DEC-48; 07 §4.3; 11 §9): `ticket.updated` (coalesced per ticket, see
 * {@link requestTicketUpdate}), `sync.required`, `channel.status` and `incident.updated`, published inside
 * the producing transaction. `task.*`, `offer.*` and `driver.*` belong to the dispatch realtime, `alert.*` to
 * core/alerts.
 */
export const notificationsRealtimePlanner: TxPlanner = {
  name: 'notifications-realtime',
  async plan(tx, events) {
    for (const ev of events) {
      for (const r of ticketUpdateRequests(ev))
        await requestTicketUpdate(tx, r.ticketId, {
          cause: r.cause,
          actor: ev.actor,
          extraUserIds: r.extraUserIds,
          creator: r.creator,
          supervisorsOnly: r.supervisorsOnly,
          message: r.message,
        });
      switch (ev.type) {
        case 'event.opened':
        case 'event.closing_started':
        case 'event.closed':
          await eventSync(tx, ev);
          break;
        case 'shift.opened':
        case 'shift.closed':
          await shiftSync(tx, ev);
          break;
        case 'wa.channel_health_changed':
          await channelStatus(tx, ev);
          break;
        case 'incident.opened':
        case 'incident.updated':
        case 'incident.resolved':
          await incidentUpdated(tx, ev);
          break;
      }
    }
  },
};

export function startNotificationsRealtime(): void {
  registerTxPlanner(notificationsRealtimePlanner);
}

export function stopNotificationsRealtime(): void {
  unregisterTxPlanner(notificationsRealtimePlanner.name);
}
