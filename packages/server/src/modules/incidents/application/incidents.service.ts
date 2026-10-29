import { Inject, Injectable } from '@nestjs/common';
import type { IncidentSeverity, IncidentStatus, IncidentType } from '@point/shared';
import { assertExplicitVenue, type ActorContext } from '../../../core/actor-context/actor-context.js';
import { audit } from '../../../core/audit/audit-writer.js';
import { newId } from '../../../core/crypto/ids.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { emitEvent } from '../../../core/outbox/outbox-writer.js';
import { DATABASE } from '../../../http/tokens.js';
import { ListCursorCodec, pageOf } from '../../venues-events/index.js';
import { scopeStillGranted, staffEligibleForVenue } from './scope.js';
import {
  INCIDENT_SELECT,
  incidentChanged,
  incidentView,
  type IncidentReadRow,
  type IncidentRow,
} from './views.js';

export interface ListIncidentsQuery {
  venue_id?: string;
  event_id?: string;
  ticket_id?: string;
  status?: IncidentStatus[];
  type?: IncidentType;
  limit: number;
  cursor?: string;
}

export interface CreateIncidentBody {
  venue_id: string;
  event_id?: string | null;
  ticket_id?: string | null;
  type: IncidentType;
  severity?: IncidentSeverity;
  description: string;
}

export interface UpdateIncidentBody {
  expected_version: number;
  status?: IncidentStatus;
  severity?: IncidentSeverity;
  owner_id?: string | null;
  resolution?: string | null;
  description?: string;
}

export interface IncidentCommandMeta {
  operation: string;
  requestId: string;
}

/**
 * 11 §6.11: open → in_review → resolved → closed, open → resolved directly, resolved → in_review to reopen;
 * `closed` is final. Key = target status, value = the statuses it may be reached from.
 */
const REACHABLE_FROM: Record<IncidentStatus, readonly IncidentStatus[]> = {
  open: [],
  in_review: ['open', 'resolved'],
  resolved: ['open', 'in_review'],
  closed: ['resolved'],
};

const incidentNotFound = () => new AppError('RESOURCE_NOT_FOUND', { resource: 'incident' });
const fieldError = (field: string, issue: string) =>
  new AppError('VALIDATION_FAILED', { fields: [{ field, issue }] });

export interface OpenIncidentInput {
  orgId: string;
  venueId: string;
  eventId?: string | null;
  ticketId?: string | null;
  type: IncidentType;
  severity?: IncidentSeverity;
  description: string;
  /** the user recorded as `opened_by` (06: NOT NULL), also for incidents opened by a system flow */
  openedBy: string;
  /** who caused it: the user of the command, or the system for an automatic incident */
  actor?: { type: 'user' | 'system'; id: string | null };
  /** created already resolved (e.g. TT-19 documents an exception handover): `incident.resolved` follows */
  resolution?: string | null;
}

/**
 * Writes an incident (L10 with the command's other appends) and `incident.opened` — the writer of
 * `POST /v1/incidents`. The flows that open incidents themselves write their own row today (DEC-240: TT-19 in its
 * use-case, TT-20 through the IncidentRecorder hook, the payment discrepancies in payments-reports, which may not
 * import this module); this function is where they may be unified later behind a hook. No realtime here: the WS
 * `incident.updated` is published by the realtime planner from the domain events (11 §8.8).
 */
export async function openIncident(tx: Tx, i: OpenIncidentInput): Promise<IncidentRow> {
  const resolution = i.resolution?.trim() || null;
  const row = await tx.one<IncidentRow>(
    `INSERT INTO incidents (id, org_id, venue_id, event_id, ticket_id, type, status, severity, description, opened_by,
                            resolution, resolved_by, resolved_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
     RETURNING *`,
    [
      newId(),
      i.orgId,
      i.venueId,
      i.eventId ?? null,
      i.ticketId ?? null,
      i.type,
      resolution ? 'resolved' : 'open',
      i.severity ?? 'medium',
      i.description,
      i.openedBy,
      resolution,
      resolution ? i.openedBy : null,
      resolution ? tx.now : null,
      tx.now,
    ],
  );
  const actor = i.actor ?? { type: 'user' as const, id: i.openedBy };
  const auto = actor.type === 'system';
  await emitIncidentEvent(tx, 'incident.opened', { ...row, status: 'open' }, actor, { auto_created: auto });
  if (resolution) await emitIncidentEvent(tx, 'incident.resolved', row, actor, { auto_created: auto });
  return row;
}

function emitIncidentEvent(
  tx: Tx,
  type: 'incident.opened' | 'incident.updated' | 'incident.resolved',
  row: IncidentRow,
  actor: { type: 'user' | 'system'; id: string | null },
  extra: Record<string, unknown> = {},
) {
  return emitEvent(tx, {
    type,
    orgId: row.org_id,
    venueId: row.venue_id,
    eventId: row.event_id,
    aggregate: { type: 'incident', id: row.id, version: row.version },
    actor,
    payload: { ...incidentChanged(row), ...extra },
  });
}

/**
 * Internal incidents (PNT-083; 07 §9.7, 11 §6.11, S-12): list, open, read, update and resolve. Staff in the
 * venue scope; a driver opens incidents for the open tickets of his venue only (canon §10 `incident.create`).
 */
@Injectable()
export class IncidentsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly cursors: ListCursorCodec,
  ) {}

  /**
   * GET /v1/incidents — newest first. `venue_id` outside the scope → SCOPE_VENUE_DENIED; `event_id` and
   * `ticket_id` are intersected with the scope (outside it the list is empty, nothing is disclosed).
   */
  async list(actor: ActorContext, q: ListIncidentsQuery) {
    if (q.venue_id) assertExplicitVenue(actor, q.venue_id);
    const venues = q.venue_id ? [q.venue_id] : [...actor.venueIds].sort();
    const statuses = q.status?.length ? [...new Set(q.status)].sort() : [];
    const scope = `incidents|${q.venue_id ?? '*'}|${q.event_id ?? ''}|${q.ticket_id ?? ''}|${statuses.join(',')}|${q.type ?? ''}`;
    const after = q.cursor ? this.cursors.decode(q.cursor, scope, 2) : null;
    const params: unknown[] = [actor.orgId, venues];
    let where = `i.org_id = $1 AND i.venue_id = ANY($2::uuid[])`;
    if (q.event_id) {
      params.push(q.event_id);
      where += ` AND i.event_id = $${params.length}`;
    }
    if (q.ticket_id) {
      params.push(q.ticket_id);
      where += ` AND i.ticket_id = $${params.length}`;
    }
    if (statuses.length) {
      params.push(statuses);
      where += ` AND i.status = ANY($${params.length}::text[])`;
    }
    if (q.type) {
      params.push(q.type);
      where += ` AND i.type = $${params.length}`;
    }
    if (after) {
      if (typeof after[0] !== 'string' || typeof after[1] !== 'string' || Number.isNaN(Date.parse(after[0])))
        throw new AppError('PAGINATION_CURSOR_INVALID');
      params.push(after[0], after[1]);
      where += ` AND (i.created_at, i.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(q.limit + 1);
    const rows = await this.db.rows<IncidentReadRow>(
      `${INCIDENT_SELECT} WHERE ${where} ORDER BY i.created_at DESC, i.id DESC LIMIT $${params.length}`,
      params,
    );
    return pageOf(rows, q.limit, incidentView, (r) =>
      this.cursors.encode(scope, [new Date(r.created_at).toISOString(), r.id]),
    );
  }

  /** GET /v1/incidents/{incidentId} — outside the scope it does not exist (RESOURCE_NOT_FOUND). */
  async get(actor: ActorContext, incidentId: string) {
    const r = await this.db.rows<IncidentReadRow>(`${INCIDENT_SELECT} WHERE i.id = $1 AND i.org_id = $2`, [
      incidentId,
      actor.orgId,
    ]);
    const row = r[0];
    if (!row || !actor.venueIds.has(row.venue_id)) throw incidentNotFound();
    return incidentView(row);
  }

  /** POST /v1/incidents (201). */
  async create(tx: Tx, actor: ActorContext, meta: IncidentCommandMeta, body: CreateIncidentBody) {
    assertExplicitVenue(actor, body.venue_id); // SCOPE_VENUE_DENIED (ASSIGNMENT_REQUIRED for a driver)
    const driver = actor.role === 'driver';
    if (driver && !body.ticket_id) throw fieldError('ticket_id', 'required_for_driver');

    let eventId = body.event_id ?? null;
    if (body.ticket_id) {
      // the ticket row is read FOR SHARE: it may not be rewritten (venue, event) while the incident points at it
      const t = await tx.maybeOne<{ venue_id: string; event_id: string; status: string }>(
        `SELECT venue_id, event_id, status FROM tickets WHERE id = $1 AND org_id = $2 FOR SHARE`,
        [body.ticket_id, actor.orgId],
      );
      if (!t || !actor.venueIds.has(t.venue_id)) throw new AppError('TICKET_NOT_FOUND');
      // a driver never reads a closed ticket (09 §5.1): it does not exist for him either here
      if (driver && (t.status === 'delivered' || t.status === 'voided'))
        throw new AppError('TICKET_NOT_FOUND');
      if (t.venue_id !== body.venue_id) throw fieldError('ticket_id', 'venue_mismatch');
      if (eventId && eventId !== t.event_id) throw fieldError('event_id', 'ticket_event_mismatch');
      eventId = t.event_id;
    } else if (eventId) {
      const e = await tx.maybeOne<{ venue_id: string }>(
        `SELECT venue_id FROM events WHERE id = $1 AND org_id = $2`,
        [eventId, actor.orgId],
      );
      if (!e || !actor.venueIds.has(e.venue_id))
        throw new AppError('RESOURCE_NOT_FOUND', { resource: 'event' });
      if (e.venue_id !== body.venue_id) throw fieldError('event_id', 'venue_mismatch');
    }
    if (!(await scopeStillGranted(tx, actor, body.venue_id)))
      throw new AppError('SCOPE_VENUE_DENIED', { venue_id: body.venue_id });

    const row = await openIncident(tx, {
      orgId: actor.orgId,
      venueId: body.venue_id,
      eventId,
      ticketId: body.ticket_id ?? null,
      type: body.type,
      severity: body.severity,
      description: body.description.trim(),
      openedBy: actor.userId,
    });
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'incident.create',
      entityType: 'incident',
      entityId: row.id,
      venueId: row.venue_id,
      requestId: meta.requestId,
      after: { status: row.status, type: row.type, severity: row.severity },
      metadata: { operation: meta.operation, ticket_id: row.ticket_id, event_id: row.event_id },
    });
    return this.view(tx, row.id);
  }

  /**
   * PATCH /v1/incidents/{incidentId}: status transitions of 11 §6.11, severity, owner, description and the
   * resolution text. `resolved` needs a resolution (in the body or already written) → VALIDATION_FAILED
   * (`resolution`, S-12 «اكتب الحل قبل إغلاق الواقعة.»). Reopening clears the previous resolution. One event per
   * change: `incident.resolved` when it becomes resolved, `incident.updated` otherwise (11 §8.8).
   */
  async update(
    tx: Tx,
    actor: ActorContext,
    meta: IncidentCommandMeta,
    incidentId: string,
    body: UpdateIncidentBody,
  ) {
    const cur = await tx.maybeOne<IncidentRow>(
      `SELECT * FROM incidents WHERE id = $1 AND org_id = $2 FOR NO KEY UPDATE`,
      [incidentId, actor.orgId],
    );
    if (!cur || !actor.venueIds.has(cur.venue_id)) throw incidentNotFound();
    if (!(await scopeStillGranted(tx, actor, cur.venue_id))) throw incidentNotFound();
    if (body.expected_version !== cur.version)
      throw new AppError('VERSION_CONFLICT', {
        entity: 'incident',
        id: cur.id,
        current_version: cur.version,
      });
    if (cur.status === 'closed')
      throw transitionError(cur, meta.operation, ['open', 'in_review', 'resolved'], 'incident_closed');

    const target = body.status ?? cur.status;
    if (target !== cur.status && !REACHABLE_FROM[target].includes(cur.status))
      throw transitionError(cur, meta.operation, REACHABLE_FROM[target]);

    const next: Partial<IncidentRow> = {};
    if (body.severity !== undefined && body.severity !== cur.severity) next.severity = body.severity;
    if (body.description !== undefined && body.description.trim() !== cur.description)
      next.description = body.description.trim();
    if (body.owner_id !== undefined && body.owner_id !== cur.owner_id) {
      if (body.owner_id !== null) {
        const owner = await staffEligibleForVenue(tx, actor.orgId, body.owner_id, cur.venue_id);
        if (!owner) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'user' });
        if (!owner.eligible) throw fieldError('owner_id', 'not_eligible');
      }
      next.owner_id = body.owner_id;
    }
    const resolutionInBody = body.resolution === undefined ? undefined : body.resolution?.trim() || null;
    if (target !== cur.status) {
      next.status = target;
      if (target === 'resolved') {
        const resolution = resolutionInBody ?? cur.resolution;
        if (!resolution) throw fieldError('resolution', 'required');
        next.resolution = resolution;
        next.resolved_by = actor.userId;
        next.resolved_at = tx.now;
      } else if (target === 'closed') {
        next.closed_at = tx.now;
        if (resolutionInBody) next.resolution = resolutionInBody;
      } else if (cur.status === 'resolved') {
        // reopened (resolved → in_review): the previous outcome no longer holds; the audit log keeps it
        next.resolution = resolutionInBody ?? null;
        next.resolved_by = null;
        next.resolved_at = null;
      }
    } else if (resolutionInBody !== undefined && resolutionInBody !== cur.resolution) {
      if (!resolutionInBody && cur.status === 'resolved') throw fieldError('resolution', 'required');
      next.resolution = resolutionInBody;
    }

    const changed = Object.keys(next) as (keyof IncidentRow)[];
    const before = Object.fromEntries(changed.map((k) => [k, plain(cur[k])]));
    const after = Object.fromEntries(changed.map((k) => [k, plain(next[k])]));
    if (!changed.length) {
      await this.audit(tx, actor, meta, cur, {}, {}, { noop: true });
      return this.view(tx, cur.id);
    }
    const sets = changed.map((k, i) => `${k} = $${i + 3}`);
    const updated = await tx.one<IncidentRow>(
      `UPDATE incidents SET ${sets.join(', ')}, version = version + 1, updated_at = $2
        WHERE id = $1 RETURNING *`,
      [cur.id, tx.now, ...changed.map((k) => next[k])],
    );
    const becameResolved = updated.status === 'resolved' && cur.status !== 'resolved';
    await emitIncidentEvent(
      tx,
      becameResolved ? 'incident.resolved' : 'incident.updated',
      updated,
      { type: 'user', id: actor.userId },
      { changed },
    );
    await this.audit(tx, actor, meta, updated, before, after, {});
    return this.view(tx, updated.id);
  }

  private async view(q: Pick<Tx, 'rows'>, id: string) {
    const [row] = await q.rows<IncidentReadRow>(`${INCIDENT_SELECT} WHERE i.id = $1`, [id]);
    return incidentView(row!);
  }

  private audit(
    tx: Tx,
    actor: ActorContext,
    meta: IncidentCommandMeta,
    row: IncidentRow,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    extra: Record<string, unknown>,
  ) {
    return audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'incident.manage',
      entityType: 'incident',
      entityId: row.id,
      venueId: row.venue_id,
      requestId: meta.requestId,
      before,
      after,
      metadata: { operation: meta.operation, ...extra },
    });
  }
}

const plain = (v: unknown) => (v instanceof Date ? v.toISOString() : (v ?? null));

function transitionError(
  cur: IncidentRow,
  command: string,
  allowedFrom: readonly IncidentStatus[],
  reason?: string,
): AppError {
  return new AppError('INVALID_STATE_TRANSITION', {
    entity_type: 'incident',
    entity_id: cur.id,
    current_status: cur.status,
    current_version: cur.version,
    command,
    allowed_from: [...allowedFrom],
    ...(reason ? { reason } : {}),
  });
}
