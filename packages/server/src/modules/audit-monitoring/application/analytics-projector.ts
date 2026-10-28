import {
  DOMAIN_EVENT_TYPES,
  SERVER_ANALYTICS_PROPERTIES,
  analyticsName,
  findPiiValues,
  serverAnalyticsSchema,
  type DomainEventType,
} from '@point/shared';
import type { ZodType } from 'zod';
import type { EventEnvelope, Tx } from '../../../core/db/tx.js';
import { createLogger, type Logger } from '../../../core/logging/logger.js';
import { metrics } from '../../../core/metrics/metrics.js';
import type { EventProjector, OutboxRow } from '../../../core/outbox/dispatcher.js';
import { PROJECTIONS, isUuid, type Projection, type Projector } from './analytics-projections.js';

const DOMAIN_TYPES: ReadonlySet<string> = new Set(DOMAIN_EVENT_TYPES);

export type ProjectionOutcome = 'written' | 'duplicate' | 'rejected';

export interface AnalyticsProjectorOptions {
  /** server build version stored in `analytics_events.app_version` (15 §5) */
  appVersion?: string;
  logger?: Logger;
}

/**
 * AnalyticsProjector (15 §6, §13.1): consumes the domain-event rows of the outbox in the worker, in the same
 * transaction that marks the row `done` (exactly once per committed event), and writes one
 * `analytics_events` row (`source = 'server'`) per event. Idempotent: the event id is stored as
 * `properties.source_event_id` and a second projection of the same event (an admin retry of a domain-event
 * row) finds it through `ix_analytics_name_time` and writes nothing. A property set refused by the allow-list
 * (unknown key, PII-looking value) is logged and counted, and the event is still marked done without a row
 * (15 §13.1); a single invalid value is stored as `null`.
 */
export function createAnalyticsProjector(opts: AnalyticsProjectorOptions = {}): EventProjector & {
  projectEnvelope(tx: Tx, env: EventEnvelope, venueId?: string | null): Promise<ProjectionOutcome>;
} {
  const appVersion = opts.appVersion ?? process.env.APP_VERSION ?? 'dev';
  const logger = opts.logger ?? createLogger({ name: 'point-worker' });

  const reject = (type: string, reason: string, extra: Record<string, unknown> = {}) => {
    metrics.analyticsRejected.inc({ source: 'server', reason });
    logger.error({ event_type: type, reason, ...extra }, 'analytics projection refused');
    return 'rejected' as const;
  };

  async function projectEnvelope(
    tx: Tx,
    env: EventEnvelope,
    venueId: string | null = null,
  ): Promise<ProjectionOutcome> {
    const type = env?.type;
    if (!type || !DOMAIN_TYPES.has(type)) return reject(String(type), 'unknown_type');
    const at = new Date(env.occurred_at);
    if (!isUuid(env.id) || !isUuid(env.org_id) || Number.isNaN(at.getTime()))
      return reject(type, 'invalid_envelope', { outbox_id: env?.id });
    const name = analyticsName(type as DomainEventType);
    const seen = await tx.maybeOne(
      `SELECT 1 FROM analytics_events
        WHERE name = $1 AND occurred_at = $2 AND source = 'server' AND properties->>'source_event_id' = $3
        LIMIT 1`,
      [name, at, env.id],
    );
    if (seen) return 'duplicate';

    const project: Projector = PROJECTIONS[type as DomainEventType];
    const projection: Projection = await project({
      tx,
      env: env as EventEnvelope<Record<string, any>>,
      p: (env.payload ?? {}) as Record<string, any>,
      at,
    });
    const shape = SERVER_ANALYTICS_PROPERTIES[type as DomainEventType] as Record<string, ZodType>;
    const properties: Record<string, unknown> = {};
    const invalid: string[] = [];
    for (const [key, value] of Object.entries(projection.properties)) {
      if (value === undefined) continue;
      const field = shape[key];
      if (!field) return reject(type, 'unknown_property', { key, outbox_id: env.id });
      const r = field.safeParse(value);
      if (r.success) properties[key] = r.data;
      else {
        properties[key] = null;
        invalid.push(key);
      }
    }
    if (invalid.length) {
      metrics.analyticsRejected.inc({ source: 'server', reason: 'invalid_value' });
      logger.warn(
        { event_type: type, keys: invalid, outbox_id: env.id },
        'analytics values outside their lists',
      );
    }
    const strict = serverAnalyticsSchema(type as DomainEventType).safeParse(properties);
    if (!strict.success) return reject(type, 'invalid_properties', { outbox_id: env.id });
    if (findPiiValues(strict.data).length) return reject(type, 'pii_value', { outbox_id: env.id });

    const actor = env.actor ?? { type: 'system', id: null };
    let actorRole: string = actor.type === 'customer' ? 'customer' : 'system';
    let actorId: string | null = null;
    if (actor.type === 'user' && isUuid(actor.id)) {
      actorId = actor.id;
      actorRole =
        (await tx.maybeOne<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [actor.id]))?.role ??
        'system';
    }
    const uuid = (v: unknown) => (isUuid(v) ? v : null);
    await tx.query(
      `INSERT INTO analytics_events (name, source, occurred_at, received_at, org_id, venue_id, event_id, dispatch_pool_id,
                                     actor_role, actor_id, ticket_id, task_id, cycle_id, app_version, properties)
       VALUES ($1, 'server', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        name,
        at,
        tx.now,
        env.org_id,
        uuid(env.venue_id) ?? uuid(venueId),
        uuid(env.event_id),
        uuid(env.dispatch_pool_id),
        actorRole,
        actorId,
        uuid(projection.ticketId),
        uuid(projection.taskId),
        uuid(projection.cycleId),
        appVersion,
        JSON.stringify({ ...strict.data, source_event_id: env.id }),
      ],
    );
    return 'written';
  }

  return {
    name: 'analytics',
    accepts: (type: string) => DOMAIN_TYPES.has(type),
    async project(tx: Tx, row: OutboxRow) {
      // the outbox row's payload holds the full canon §7 envelope (emitEvent). A failing projection must
      // not keep the event from being done (it would end `dead` and raise outbox_lag): its writes are
      // rolled back to the savepoint, the error is logged and counted.
      await tx.savepoint('analytics_projection');
      try {
        await projectEnvelope(tx, row.payload as EventEnvelope, row.venue_id);
      } catch (err) {
        await tx.rollbackTo('analytics_projection');
        reject(row.type, 'projection_error', { outbox_id: row.id, err: (err as Error).message });
      }
    },
    projectEnvelope,
  };
}
