import { Inject, Injectable } from '@nestjs/common';
import {
  TELEMETRY_LIMITS,
  clientTelemetrySchema,
  parseTelemetryEvent,
  type TelemetryBatch,
  type TelemetryRejectReason,
} from '@point/shared';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import type { Clock } from '../../../core/clock/clock.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import type { Logger } from '../../../core/logging/logger.js';
import { metrics } from '../../../core/metrics/metrics.js';
import { CLOCK, DATABASE, LOGGER } from '../../../http/tokens.js';
import { SlidingWindowLimiter } from './rate-limiter.js';

export type ClientRejectReason =
  TelemetryRejectReason | 'out_of_window' | 'unknown_reference' | 'offer_already_seen';

interface ClientRow {
  name: string;
  occurredAt: Date;
  ticketId: string | null;
  taskId: string | null;
  eventId: string | null;
  properties: Record<string, unknown>;
}

export interface TelemetryResult {
  accepted: number;
  rejected: Partial<Record<ClientRejectReason, number>>;
}

/**
 * `POST /v1/telemetry` (15 §9, PNT-090): batched client measurements written to `analytics_events`
 * (`source = 'client'`). Batch-level problems answer the request (size → VALIDATION_FAILED, a foreign
 * device → VALIDATION_FAILED, the per-device rate → RATE_LIMITED); an event that fails the catalog (unknown
 * name, unknown or denylisted property, value outside its list, PII-looking value, time outside
 * [now − 24 h, now + 5 min]) is dropped without failing the batch and counted in the log and
 * `point_analytics_rejected_total` (15 §9.2). Organization, actor and duty context come from the session,
 * never from the body (15 §9.3 «الإثراء»).
 */
@Injectable()
export class TelemetryIngest {
  private readonly limiter = new SlidingWindowLimiter(TELEMETRY_LIMITS.perDevicePerMinute);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async ingest(
    actor: ActorContext,
    body: TelemetryBatch,
    bodyBytes: number,
    requestId: string,
  ): Promise<TelemetryResult> {
    if (bodyBytes > TELEMETRY_LIMITS.maxBytes)
      throw new AppError('VALIDATION_FAILED', {
        fields: [
          { field: '(body)', issue: 'too_large', message: `at most ${TELEMETRY_LIMITS.maxBytes} bytes` },
        ],
      });
    // keyed by user too: a device id named by someone else's batch never spends the owner's allowance
    const limited = this.limiter.consume(
      `${actor.userId}:${body.device_id ?? `session:${actor.sessionId}`}`,
      body.events.length,
      this.clock.now().getTime(),
    );
    if (!limited.ok)
      throw new AppError(
        'RATE_LIMITED',
        { retry_after_s: limited.retryAfterS },
        { retryAfterS: limited.retryAfterS },
      );

    const rejected: Partial<Record<ClientRejectReason, number>> = {};
    const reject = (reason: ClientRejectReason) => {
      rejected[reason] = (rejected[reason] ?? 0) + 1;
      metrics.analyticsRejected.inc({ source: 'client', reason });
    };

    const accepted = await this.db.transaction(async (tx) => {
      if (body.device_id) {
        const own = await tx.maybeOne(
          `SELECT 1 FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
          [body.device_id, actor.userId],
        );
        if (!own)
          throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'device_id', issue: 'not_owned' }] });
      }
      const rows: ClientRow[] = [];
      const parsed = body.events.map((raw) => parseTelemetryEvent(raw));
      const refs = await this.knownRefs(tx, actor.orgId, parsed);
      for (const p of parsed) {
        if (!p.ok) {
          reject(p.reason);
          continue;
        }
        const { event } = p;
        const occurredAt = new Date(event.occurred_at);
        const delta = occurredAt.getTime() - tx.now.getTime();
        if (delta < -TELEMETRY_LIMITS.pastWindowMs || delta > TELEMETRY_LIMITS.futureWindowMs) {
          reject('out_of_window');
          continue;
        }
        if (
          (event.ticket_id && !refs.tickets.has(event.ticket_id)) ||
          (event.task_id && !refs.tasks.has(event.task_id))
        ) {
          reject('unknown_reference');
          continue;
        }
        const properties: Record<string, unknown> = { ...p.properties };
        if (event.screen && properties.screen === undefined) properties.screen = event.screen;
        if (event.seq !== undefined) properties.client_seq = event.seq;
        if (body.client_session_id) properties.client_session_id = body.client_session_id;
        const row: ClientRow = {
          name: event.name,
          occurredAt,
          ticketId: event.ticket_id ?? null,
          taskId: event.task_id ?? null,
          eventId: null,
          properties,
        };
        if (event.name === 'offer_card_seen') {
          // 15 §9.4: written only while offer_recipients.seen_at is empty, which it then fills — so the
          // WebSocket path (client.offer_seen) and this batch path never both record the same sighting
          const offerId = String(p.properties.offer_id);
          const seen = await markOfferSeen(tx, actor, offerId, occurredAt <= tx.now ? occurredAt : tx.now);
          if (!seen) {
            reject(await unseenReason(tx, actor, offerId));
            continue;
          }
          row.taskId = seen.task_id;
          row.ticketId = seen.ticket_id;
          row.eventId = seen.event_id;
        } else if (event.name === 'offer_card_removed') {
          const offer = await tx.maybeOne<{ task_id: string; ticket_id: string; event_id: string }>(
            `SELECT t.id AS task_id, t.ticket_id, t.event_id FROM offer_recipients r
               JOIN task_offers o ON o.id = r.offer_id JOIN tasks t ON t.id = o.task_id
              WHERE r.offer_id = $1 AND r.user_id = $2 AND t.org_id = $3`,
            [p.properties.offer_id, actor.userId, actor.orgId],
          );
          if (!offer) {
            reject('unknown_reference');
            continue;
          }
          row.taskId = offer.task_id;
          row.ticketId = offer.ticket_id;
          row.eventId = offer.event_id;
        }
        rows.push(row);
      }
      await insertClientRows(tx, actor, body.app_version, rows);
      return rows.length;
    });

    const dropped = Object.values(rejected).reduce((s, n) => s + (n ?? 0), 0);
    if (dropped > 0)
      this.logger.info(
        { request_id: requestId, user_id: actor.userId, accepted, rejected },
        'telemetry events dropped by the allow-list',
      );
    return { accepted, rejected };
  }

  /**
   * WebSocket `client.offer_seen` (07 §4, the primary path of 15 §9.4), inside the caller's transaction: fills
   * `offer_recipients.seen_at` once and writes the `offer_card_seen` row (`via: ws`). `mode` and
   * `eligible_as` come from the offer; `receive_latency_ms` is the client's measurement when it sends one,
   * otherwise the time from the offer round's creation to this message. A repeated or foreign sighting
   * writes nothing (counted in `point_analytics_rejected_total`).
   */
  async recordOfferSeen(
    tx: Tx,
    actor: ActorContext,
    payload: { offer_id?: unknown; receive_latency_ms?: unknown } | null | undefined,
  ): Promise<'recorded' | ClientRejectReason> {
    const offerId = typeof payload?.offer_id === 'string' ? payload.offer_id : '';
    if (!UUID.test(offerId)) return this.dropped('invalid_event');
    const seen = await markOfferSeen(tx, actor, offerId, tx.now);
    if (!seen) return this.dropped(await unseenReason(tx, actor, offerId));
    const clientLatency = payload?.receive_latency_ms;
    const properties = {
      offer_id: offerId,
      mode: seen.mode,
      via: 'ws',
      receive_latency_ms:
        typeof clientLatency === 'number' &&
        Number.isInteger(clientLatency) &&
        Math.abs(clientLatency) <= TELEMETRY_LIMITS.pastWindowMs
          ? clientLatency
          : Math.max(0, tx.now.getTime() - new Date(seen.offer_created_at).getTime()),
      eligible_as: seen.eligible_as,
    };
    const parsed = clientTelemetrySchema('offer_card_seen').safeParse(properties);
    if (!parsed.success) return this.dropped('invalid_properties');
    await insertClientRows(tx, actor, null, [
      {
        name: 'offer_card_seen',
        occurredAt: tx.now,
        ticketId: seen.ticket_id,
        taskId: seen.task_id,
        eventId: seen.event_id,
        properties: parsed.data,
      },
    ]);
    return 'recorded';
  }

  private dropped(reason: ClientRejectReason): ClientRejectReason {
    metrics.analyticsRejected.inc({ source: 'client', reason });
    return reason;
  }

  /** Ticket and task ids named by the batch that exist in the actor's organization (one query each). */
  private async knownRefs(tx: Tx, orgId: string, parsed: ReturnType<typeof parseTelemetryEvent>[]) {
    const ticketIds = new Set<string>();
    const taskIds = new Set<string>();
    for (const p of parsed) {
      if (!p.ok) continue;
      if (p.event.ticket_id) ticketIds.add(p.event.ticket_id);
      if (p.event.task_id) taskIds.add(p.event.task_id);
    }
    const tickets = ticketIds.size
      ? await tx.rows<{ id: string }>(`SELECT id FROM tickets WHERE org_id = $1 AND id = ANY($2::uuid[])`, [
          orgId,
          [...ticketIds],
        ])
      : [];
    const tasks = taskIds.size
      ? await tx.rows<{ id: string }>(`SELECT id FROM tasks WHERE org_id = $1 AND id = ANY($2::uuid[])`, [
          orgId,
          [...taskIds],
        ])
      : [];
    return { tickets: new Set(tickets.map((r) => r.id)), tasks: new Set(tasks.map((r) => r.id)) };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fills `seen_at` of the actor's recipient row when still empty; null when there was nothing to fill. */
function markOfferSeen(tx: Tx, actor: ActorContext, offerId: string, at: Date) {
  return tx.maybeOne<{
    task_id: string;
    ticket_id: string;
    event_id: string;
    mode: 'single' | 'broadcast';
    offer_created_at: Date;
    eligible_as: 'accept' | 'reserve_next' | 'view_only';
  }>(
    `UPDATE offer_recipients r SET seen_at = $3
       FROM task_offers o JOIN tasks t ON t.id = o.task_id
      WHERE r.offer_id = $1 AND r.user_id = $2 AND r.seen_at IS NULL AND o.id = r.offer_id AND t.org_id = $4
      RETURNING t.id AS task_id, t.ticket_id, t.event_id, o.mode, o.created_at AS offer_created_at, r.eligible_as`,
    [offerId, actor.userId, at, actor.orgId],
  );
}

/** Why a sighting wrote nothing: already seen by this recipient, or not an offer of theirs at all. */
async function unseenReason(tx: Tx, actor: ActorContext, offerId: string): Promise<ClientRejectReason> {
  const mine = await tx.maybeOne(
    `SELECT 1 FROM offer_recipients r JOIN task_offers o ON o.id = r.offer_id
      WHERE r.offer_id = $1 AND r.user_id = $2 AND o.org_id = $3`,
    [offerId, actor.userId, actor.orgId],
  );
  return mine ? 'offer_already_seen' : 'unknown_reference';
}

/** One multi-row insert (L10). venue/pool from the open duty session; actor from the session (15 §5). */
async function insertClientRows(tx: Tx, actor: ActorContext, appVersion: string | null, rows: ClientRow[]) {
  if (rows.length === 0) return;
  const cols = 15;
  const values: unknown[] = [];
  const tuples = rows.map((r, i) => {
    values.push(
      r.name,
      'client',
      r.occurredAt,
      tx.now,
      actor.orgId,
      actor.duty?.venueId ?? null,
      r.eventId,
      actor.duty?.poolId ?? null,
      actor.role,
      actor.userId,
      r.ticketId,
      r.taskId,
      null,
      appVersion,
      JSON.stringify(r.properties),
    );
    return `(${Array.from({ length: cols }, (_, k) => `$${i * cols + k + 1}`).join(', ')})`;
  });
  await tx.query(
    `INSERT INTO analytics_events (name, source, occurred_at, received_at, org_id, venue_id, event_id, dispatch_pool_id,
                                   actor_role, actor_id, ticket_id, task_id, cycle_id, app_version, properties)
     VALUES ${tuples.join(', ')}`,
    values,
  );
}
