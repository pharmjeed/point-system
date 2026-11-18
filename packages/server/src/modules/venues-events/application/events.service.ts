import { Inject, Injectable } from '@nestjs/common';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import { newId } from '../../../core/crypto/ids.js';
import type { Database } from '../../../core/db/database.js';
import { lockEvents } from '../../../core/db/locks.js';
import { assertOperatorOperating } from '../../../core/operator-status.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { emitEvent } from '../../../core/outbox/outbox-writer.js';
import { DATABASE } from '../../../http/tokens.js';
import { assertVersion, invalidTransition, isUuid, notFound, validationFailed } from '../domain/errors.js';
import {
  assertCancelable,
  assertEventEditable,
  assertPoolChangeAllowed,
  assertStartClosing,
  openTransition,
  requireReason,
} from '../domain/event-lifecycle.js';
import { mergedPricing, newEventPricing, pricingIssues, scheduleIssues } from '../domain/pricing.js';
import { ListCursorCodec, pageOf } from '../infra/cursor.js';
import { EVENT_COLUMNS, toVenueEvent, type VenueEventRow } from '../infra/rows.js';
import { assertResourceInScope, assertVenueParam, recheckVenueScope } from '../infra/scope.js';
import type {
  CancelEventBody,
  CreateEventBody,
  ListEventsQuery,
  UpdateEventBody,
  VersionOnlyBody,
} from './schemas.js';
import { auditCommand, patchSet, type CommandMeta } from './support.js';
import { venueSettingsFor } from './venues.service.js';

const EVENT_PATCH_COLUMNS = [
  'name_ar',
  'host_name',
  'event_date',
  'starts_at',
  'ends_at',
  'dispatch_pool_id',
  'pricing_mode',
  'fee_halalas',
  'allowed_payment_methods',
] as const;

/** Tickets listed in EVENT_CLOSE_BLOCKED for a cancel (the count is always complete). */
const CANCEL_BLOCKERS_SHOWN = 50;

/** The venue's default pool, or the pool named in the body if it belongs to the venue (else 404 dispatch_pool). */
export async function resolveVenuePool(
  tx: Pick<Tx, 'maybeOne'>,
  orgId: string,
  venueId: string,
  poolId: string | undefined,
): Promise<{ id: string; status: string }> {
  const pool = poolId
    ? await tx.maybeOne<{ id: string; status: string }>(
        `SELECT id, status FROM dispatch_pools WHERE id = $1 AND venue_id = $2 AND org_id = $3`,
        [poolId, venueId, orgId],
      )
    : await tx.maybeOne<{ id: string; status: string }>(
        `SELECT id, status FROM dispatch_pools WHERE venue_id = $1 AND org_id = $2 AND is_default`,
        [venueId, orgId],
      );
  if (!pool) throw notFound('dispatch_pool');
  return pool;
}

@Injectable()
export class EventsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly cursors: ListCursorCodec,
  ) {}

  /** GET /v1/venues/{venueId}/events — newest event date first. */
  async list(actor: ActorContext, venueId: string, q: ListEventsQuery) {
    assertVenueParam(actor, venueId);
    const statuses = q.status ? [...new Set(q.status)].sort() : [];
    const scope = `events|${venueId}|${statuses.join(',')}|${q.from ?? ''}|${q.to ?? ''}`;
    const after = q.cursor ? this.cursors.decode(q.cursor, scope, 2) : null;
    const params: unknown[] = [venueId, actor.orgId];
    let where = `e.venue_id = $1 AND e.org_id = $2`;
    if (statuses.length > 0) {
      params.push(statuses);
      where += ` AND e.status = ANY($${params.length}::text[])`;
    }
    if (q.from) {
      params.push(q.from);
      where += ` AND e.event_date >= $${params.length}::date`;
    }
    if (q.to) {
      params.push(q.to);
      where += ` AND e.event_date <= $${params.length}::date`;
    }
    if (after) {
      params.push(after[0], after[1]);
      where += ` AND (e.event_date, e.id) < ($${params.length - 1}::date, $${params.length}::uuid)`;
    }
    params.push(q.limit + 1);
    const rows = await this.db.rows<VenueEventRow>(
      `SELECT ${EVENT_COLUMNS} FROM events e WHERE ${where}
        ORDER BY e.event_date DESC, e.id DESC LIMIT $${params.length}`,
      params,
    );
    return pageOf(rows, q.limit, toVenueEvent, (r) => this.cursors.encode(scope, [r.event_date, r.id]));
  }

  async get(actor: ActorContext, eventId: string) {
    if (!isUuid(eventId)) throw notFound('event');
    const row = await this.db
      .query<VenueEventRow>(`SELECT ${EVENT_COLUMNS} FROM events e WHERE e.id = $1`, [eventId])
      .then((r) => r.rows[0]);
    assertResourceInScope(actor, row, 'event');
    return toVenueEvent(row as VenueEventRow);
  }

  /**
   * POST /v1/venues/{venueId}/events — a `draft` event on the venue's default pool unless one is named (07).
   * Fee and methods default to the venue `pricing.*` settings (13 §3); `included` with a fee or `per_vehicle`
   * without a positive fee → VALIDATION_FAILED (PNT-019 AC1).
   */
  async create(tx: Tx, actor: ActorContext, meta: CommandMeta, venueId: string, body: CreateEventBody) {
    assertVenueParam(actor, venueId);
    await recheckVenueScope(tx, actor, venueId, { explicit: true });
    const settings = await venueSettingsFor(tx, venueId);
    const pricing = newEventPricing(body, settings);
    const issues = [...pricingIssues(pricing), ...scheduleIssues(body.starts_at, body.ends_at)];
    if (issues.length > 0) throw validationFailed(issues);
    const pool = await resolveVenuePool(tx, actor.orgId, venueId, body.dispatch_pool_id);
    const row = await tx.one<VenueEventRow>(
      `INSERT INTO events AS e (id, org_id, venue_id, dispatch_pool_id, name_ar, host_name, event_date, starts_at,
                                ends_at, status, pricing_mode, fee_halalas, allowed_payment_methods,
                                next_display_number, created_by, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', $10, $11, $12, 1, $13, 1, $14, $14)
       RETURNING ${EVENT_COLUMNS}`,
      [
        newId(),
        actor.orgId,
        venueId,
        pool.id,
        body.name_ar,
        body.host_name ?? null,
        body.event_date,
        body.starts_at ?? null,
        body.ends_at ?? null,
        pricing.pricing_mode,
        pricing.fee_halalas,
        pricing.allowed_payment_methods,
        actor.userId,
        tx.now,
      ],
    );
    await auditCommand(tx, actor, meta, {
      action: 'event.manage',
      entityType: 'event',
      entityId: row.id,
      venueId,
      after: {
        status: 'draft',
        dispatch_pool_id: pool.id,
        event_date: row.event_date,
        pricing_mode: row.pricing_mode,
        fee_halalas: Number(row.fee_halalas),
        allowed_payment_methods: row.allowed_payment_methods,
      },
    });
    return toVenueEvent(row);
  }

  /**
   * PATCH /v1/events/{eventId} (`expected_version` mandatory). Draft or open only (13 §3): closing →
   * INVALID_STATE_TRANSITION, closed/canceled → EVENT_ALREADY_CLOSED. Pricing stays editable and applies to new
   * tickets only (13 §3, FR-ORG-05, DEC-43); the dispatch pool is fixed once the event opened.
   */
  async update(tx: Tx, actor: ActorContext, meta: CommandMeta, eventId: string, body: UpdateEventBody) {
    const ev = await this.lockEvent(tx, actor, eventId);
    assertVersion('event', ev, body.expected_version);
    assertEventEditable(ev, meta.operation);
    const { expected_version: _v, ...patch } = body;
    if (patch.dispatch_pool_id !== undefined && patch.dispatch_pool_id !== ev.dispatch_pool_id) {
      assertPoolChangeAllowed(ev, meta.operation);
      await resolveVenuePool(tx, actor.orgId, ev.venue_id, patch.dispatch_pool_id);
    }
    const pricing = mergedPricing(
      {
        pricing_mode: ev.pricing_mode,
        fee_halalas: Number(ev.fee_halalas),
        allowed_payment_methods: ev.allowed_payment_methods,
      },
      patch,
    );
    const startsAt = patch.starts_at !== undefined ? patch.starts_at : ev.starts_at?.toISOString();
    const endsAt = patch.ends_at !== undefined ? patch.ends_at : ev.ends_at?.toISOString();
    const issues = [...pricingIssues(pricing), ...scheduleIssues(startsAt, endsAt)];
    if (issues.length > 0) throw validationFailed(issues);

    const current = { ...ev, fee_halalas: Number(ev.fee_halalas) } as unknown as Record<string, unknown>;
    const diff = patchSet(current, patch, EVENT_PATCH_COLUMNS, 3);
    let row = ev;
    if (diff.sets.length > 0) {
      row = await tx.one<VenueEventRow>(
        `UPDATE events e SET ${diff.sets.join(', ')}, version = version + 1
          WHERE e.id = $1 AND e.version = $2 RETURNING ${EVENT_COLUMNS}`,
        [eventId, ev.version, ...diff.params],
      );
    }
    await auditCommand(tx, actor, meta, {
      action: 'event.manage',
      entityType: 'event',
      entityId: eventId,
      venueId: ev.venue_id,
      before: diff.before,
      after: diff.after,
      ...(diff.sets.length === 0 ? { metadata: { noop: true } } : {}),
    });
    return toVenueEvent(row);
  }

  /**
   * POST /v1/events/{eventId}/open — draft → open, or closing → open (reopen, canon §5 note), with an active
   * dispatch pool (11 §6.4). Emits `event.opened` (`reopened: true` for a reopen). A suspended or terminated
   * operator opens nothing (OPERATOR_SUSPENDED, V2-005).
   */
  async open(tx: Tx, actor: ActorContext, meta: CommandMeta, eventId: string, body: VersionOnlyBody) {
    await assertOperatorOperating(tx, actor.orgId);
    const ev = await this.lockEvent(tx, actor, eventId);
    assertVersion('event', ev, body.expected_version);
    const { reopened } = openTransition(ev, meta.operation);
    const pool = await tx.one<{ status: string }>(`SELECT status FROM dispatch_pools WHERE id = $1`, [
      ev.dispatch_pool_id,
    ]);
    if (pool.status !== 'active') {
      throw invalidTransition({
        entityType: 'event',
        entityId: ev.id,
        currentStatus: ev.status,
        currentVersion: ev.version,
        command: meta.operation,
        allowedFrom: ['draft', 'closing'],
        reason: 'dispatch_pool_inactive',
      });
    }
    const row = await tx.one<VenueEventRow>(
      `UPDATE events e SET status = 'open', opened_at = COALESCE(e.opened_at, $3), opened_by = COALESCE(e.opened_by, $4),
              closing_started_at = NULL, version = version + 1
        WHERE e.id = $1 AND e.version = $2 RETURNING ${EVENT_COLUMNS}`,
      [eventId, ev.version, tx.now, actor.userId],
    );
    await emitEvent(tx, {
      type: 'event.opened',
      orgId: actor.orgId,
      venueId: row.venue_id,
      dispatchPoolId: row.dispatch_pool_id,
      eventId: row.id,
      aggregate: { type: 'event', id: row.id, version: row.version },
      actor: { type: 'user', id: actor.userId },
      payload: {
        event_id: row.id,
        status: 'open',
        by: actor.userId,
        ...(reopened ? { reopened: true } : {}),
      },
    });
    await auditCommand(tx, actor, meta, {
      action: 'event.manage',
      entityType: 'event',
      entityId: eventId,
      venueId: row.venue_id,
      before: { status: ev.status },
      after: { status: 'open' },
      ...(reopened ? { metadata: { reopened: true } } : {}),
    });
    return toVenueEvent(row);
  }

  /**
   * POST /v1/events/{eventId}/cancel — draft or open, a reason of 3+ characters (REASON_REQUIRED, checked with the
   * input before the event is loaded), and no ticket other than `voided` (else EVENT_CLOSE_BLOCKED, FR-ORG-07).
   * Audit only: canon §7.1 has no domain event for a cancel.
   */
  async cancel(tx: Tx, actor: ActorContext, meta: CommandMeta, eventId: string, body: CancelEventBody) {
    const reason = requireReason(body.reason);
    const ev = await this.lockEvent(tx, actor, eventId);
    assertVersion('event', ev, body.expected_version);
    assertCancelable(ev, meta.operation);
    const tickets = await tx.rows<{ id: string; display_number: number; status: string; total: number }>(
      `SELECT id, display_number, status, count(*) OVER ()::int AS total
         FROM tickets WHERE event_id = $1 AND status <> 'voided'
        ORDER BY display_number LIMIT ${CANCEL_BLOCKERS_SHOWN}`,
      [eventId],
    );
    if (tickets.length > 0) {
      throw new AppError('EVENT_CLOSE_BLOCKED', {
        reason: 'non_voided_tickets',
        ticket_count: tickets[0]!.total,
        blockers: {
          non_voided_tickets: tickets.map((t) => ({
            id: t.id,
            display_number: t.display_number,
            status: t.status,
          })),
        },
      });
    }
    const row = await tx.one<VenueEventRow>(
      `UPDATE events e SET status = 'canceled', canceled_at = $3, cancel_reason = $4, version = version + 1
        WHERE e.id = $1 AND e.version = $2 RETURNING ${EVENT_COLUMNS}`,
      [eventId, ev.version, tx.now, reason],
    );
    await auditCommand(tx, actor, meta, {
      action: 'event.manage',
      entityType: 'event',
      entityId: eventId,
      venueId: row.venue_id,
      reason,
      before: { status: ev.status },
      after: { status: 'canceled' },
    });
    return toVenueEvent(row);
  }

  /**
   * POST /v1/events/{eventId}/start-closing (PNT-087; 11 §6.4) — open → closing: intake stops (EVENT_NOT_OPEN at
   * L2 in StartIntake) while retrievals, handovers and the money commands go on. Emits `event.closing_started`.
   */
  async startClosing(tx: Tx, actor: ActorContext, meta: CommandMeta, eventId: string, body: VersionOnlyBody) {
    const ev = await this.lockEvent(tx, actor, eventId);
    assertVersion('event', ev, body.expected_version);
    assertStartClosing(ev, meta.operation);
    const row = await tx.one<VenueEventRow>(
      `UPDATE events e SET status = 'closing', closing_started_at = $3, version = version + 1
        WHERE e.id = $1 AND e.version = $2 RETURNING ${EVENT_COLUMNS}`,
      [eventId, ev.version, tx.now],
    );
    await emitEvent(tx, {
      type: 'event.closing_started',
      orgId: actor.orgId,
      venueId: row.venue_id,
      dispatchPoolId: row.dispatch_pool_id,
      eventId: row.id,
      aggregate: { type: 'event', id: row.id, version: row.version },
      actor: { type: 'user', id: actor.userId },
      payload: { event_id: row.id, status: 'closing', by: actor.userId },
    });
    await auditCommand(tx, actor, meta, {
      action: 'event.manage',
      entityType: 'event',
      entityId: eventId,
      venueId: row.venue_id,
      before: { status: 'open' },
      after: { status: 'closing' },
    });
    return toVenueEvent(row);
  }

  /** Scope (404 outside) → L2 lock (`FOR NO KEY UPDATE`, canon §14ب) → TOCTOU scope re-check → fresh row. */
  private async lockEvent(tx: Tx, actor: ActorContext, eventId: string): Promise<VenueEventRow> {
    if (!isUuid(eventId)) throw notFound('event');
    const head = await tx.maybeOne<{ org_id: string; venue_id: string }>(
      `SELECT org_id, venue_id FROM events WHERE id = $1`,
      [eventId],
    );
    assertResourceInScope(actor, head, 'event');
    await lockEvents(tx, [eventId]);
    await recheckVenueScope(tx, actor, head.venue_id, { resource: 'event' });
    return tx.one<VenueEventRow>(`SELECT ${EVENT_COLUMNS} FROM events e WHERE e.id = $1`, [eventId]);
  }
}
