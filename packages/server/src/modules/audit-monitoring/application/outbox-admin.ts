import { Inject, Injectable } from '@nestjs/common';
import type { OutboxStatus } from '@point/shared';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import { audit } from '../../../core/audit/audit-writer.js';
import type { Env } from '../../../core/config/env.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { redact } from '../../../core/logging/redact.js';
import { metrics } from '../../../core/metrics/metrics.js';
import type { OutboxRow } from '../../../core/outbox/dispatcher.js';
import { OUTBOX_NOTIFY_CHANNEL } from '../../../core/outbox/outbox-writer.js';
import { DATABASE, ENV } from '../../../http/tokens.js';
import { CursorCodec, isIdCursor } from './cursor.js';

type Row = OutboxRow & { processed_at: Date | null };

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

/** 07 `OutboxEvent`; the payload is shown redacted (`payload_preview`, 09 §3: «الحمولات منقّحة»). */
export function outboxEventView(r: Row) {
  return {
    id: r.id,
    type: r.type,
    aggregate_type: r.aggregate_type,
    aggregate_id: r.aggregate_id,
    aggregate_version: r.aggregate_version,
    venue_id: r.venue_id,
    ordering_key: r.ordering_key,
    dedupe_key: r.dedupe_key,
    status: r.status as OutboxStatus,
    attempts: r.attempts,
    max_attempts: r.max_attempts,
    available_at: iso(r.available_at)!,
    locked_by: r.locked_by,
    locked_until: iso(r.locked_until),
    last_error: r.last_error,
    created_at: iso(r.created_at)!,
    processed_at: iso(r.processed_at),
    payload_preview: redact(r.payload ?? {}),
  };
}

/** Aggregates with a `version` column (06): a job scheduled on another version is stale (04 §6.5, 11 §8.11). */
export const VERSIONED_AGGREGATE_TABLES: Readonly<Record<string, string>> = {
  ticket: 'tickets',
  task: 'tasks',
  task_offer: 'task_offers',
  duty_session: 'duty_sessions',
  user: 'users',
  driver_transfer: 'driver_transfers',
  incident: 'incidents',
  event: 'events',
  shift: 'shifts',
};

/** Statuses listed when the caller gives none: what an operator looks at («العالقة/الفاشلة»). */
export const DEFAULT_OUTBOX_LIST_STATUSES: OutboxStatus[] = ['pending', 'processing', 'failed', 'dead'];

export interface OutboxListFilters {
  status?: OutboxStatus[];
  type?: string;
  older_than_s?: number;
  limit: number;
  cursor?: string;
}

export type RetryOutcome = 'requeued' | 'canceled_stale' | 'canceled_superseded';

/** `GET /v1/admin/outbox` and `POST /v1/admin/outbox/{outboxId}/retry` (PNT-092, 07 §2.7, 09 §3). */
@Injectable()
export class OutboxAdmin {
  private readonly cursors: CursorCodec;
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) env: Env,
  ) {
    this.cursors = new CursorCodec(env.SESSION_SECRET);
  }

  /** Newest first (`seq` descending). */
  async list(actor: ActorContext, f: OutboxListFilters, now: Date) {
    const after = f.cursor ? this.cursors.decode('outbox', f.cursor, isIdCursor).id : null;
    const statuses = f.status?.length ? [...new Set(f.status)] : DEFAULT_OUTBOX_LIST_STATUSES;
    const rows = await this.db.rows<Row>(
      `SELECT * FROM outbox_events
        WHERE org_id = $1
          AND ($2::uuid[] IS NULL OR venue_id = ANY($2::uuid[]))
          AND status = ANY($3::text[])
          AND ($4::text IS NULL OR type = $4)
          AND ($5::int IS NULL OR available_at <= $6::timestamptz - make_interval(secs => $5))
          AND ($7::bigint IS NULL OR seq < $7)
        ORDER BY seq DESC
        LIMIT $8`,
      [
        actor.orgId,
        actor.orgScope ? null : [...actor.venueIds],
        statuses,
        f.type ?? null,
        f.older_than_s ?? null,
        now,
        after,
        f.limit + 1,
      ],
    );
    const page = rows.slice(0, f.limit);
    const last = page.at(-1);
    return {
      data: page.map(outboxEventView),
      next_cursor:
        rows.length > f.limit && last ? this.cursors.encode('outbox', { id: Number(last.seq) }) : null,
    };
  }

  /**
   * Re-queues a `failed`/`dead` row (attempts reset, due now, workers woken). A job scheduled on an aggregate
   * version that has changed since — or whose aggregate is gone — is not replayed: it is closed `canceled`
   * (04 §6.5: «أي اختلاف = إنهاء المؤقت دون أثر»; PNT-092 AC). A job whose dedupe key already has a pending
   * twin is closed `canceled` too (uq_outbox_dedupe_pending: the pending one does the work). Domain events
   * are always re-queued: their consumers are idempotent and check `aggregate_version` themselves.
   */
  async retry(tx: Tx, actor: ActorContext, outboxId: string, requestId: string) {
    const row = await tx.maybeOne<Row>(
      `SELECT * FROM outbox_events WHERE id = $1 AND org_id = $2 FOR NO KEY UPDATE`,
      [outboxId, actor.orgId],
    );
    if (!row || (!actor.orgScope && !(row.venue_id && actor.venueIds.has(row.venue_id))))
      throw new AppError('RESOURCE_NOT_FOUND', { resource: 'outbox_event' });
    if (row.status !== 'failed' && row.status !== 'dead')
      throw new AppError('INVALID_STATE_TRANSITION', {
        entity_type: 'outbox_event',
        entity_id: row.id,
        current_status: row.status,
        command: 'POST /v1/admin/outbox/{outboxId}/retry',
        allowed_from: ['failed', 'dead'],
      });

    let outcome: RetryOutcome = 'requeued';
    let currentVersion: number | null = null;
    const table = row.aggregate_type ? VERSIONED_AGGREGATE_TABLES[row.aggregate_type] : undefined;
    if (row.type.startsWith('job.') && row.aggregate_version !== null && row.aggregate_id && table) {
      const cur = await tx.maybeOne<{ version: number }>(`SELECT version FROM ${table} WHERE id = $1`, [
        row.aggregate_id,
      ]);
      currentVersion = cur?.version ?? null;
      if (!cur || cur.version !== row.aggregate_version) outcome = 'canceled_stale';
    }
    if (outcome === 'requeued' && row.dedupe_key) {
      const twin = await tx.maybeOne<{ id: string }>(
        `SELECT id FROM outbox_events WHERE dedupe_key = $1 AND status IN ('pending','processing') AND id <> $2 LIMIT 1`,
        [row.dedupe_key, row.id],
      );
      if (twin) outcome = 'canceled_superseded';
    }

    const updated =
      outcome === 'requeued'
        ? await tx.one<Row>(
            `UPDATE outbox_events
                SET status = 'pending', attempts = 0, available_at = $2, locked_by = NULL, locked_until = NULL, processed_at = NULL
              WHERE id = $1 RETURNING *`,
            [row.id, tx.now],
          )
        : await tx.one<Row>(
            `UPDATE outbox_events
                SET status = 'canceled', processed_at = $2, locked_by = NULL, locked_until = NULL,
                    last_error = left($3 || COALESCE(' | previous: ' || last_error, ''), 2000)
              WHERE id = $1 RETURNING *`,
            [
              row.id,
              tx.now,
              outcome === 'canceled_stale'
                ? `retry not replayed: ${row.aggregate_type} ${row.aggregate_id} is at version ${currentVersion ?? 'none'}, the job was scheduled on ${row.aggregate_version}`
                : `retry not replayed: a pending job with the same dedupe key exists`,
            ],
          );
    // 05 §12.2: a row an admin closes ends `canceled` (the worker counts the other results)
    if (outcome !== 'requeued') metrics.outboxEvents.inc({ type: row.type, status: 'canceled' });
    if (outcome === 'requeued') {
      // the retried row is due now: wake the workers after COMMIT (04 §6.2)
      tx.onBeforeCommit(async () => {
        await tx.query(`SELECT pg_notify($1, $2)`, [OUTBOX_NOTIFY_CHANNEL, row.venue_id ?? '']);
      }, 'outbox-notify');
    }
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'outbox.manage',
      entityType: 'outbox_event',
      entityId: row.id,
      venueId: row.venue_id,
      requestId,
      before: { status: row.status, attempts: row.attempts, available_at: iso(row.available_at) },
      after: { status: updated.status, attempts: updated.attempts, available_at: iso(updated.available_at) },
      metadata: {
        command: 'retry',
        outcome,
        type: row.type,
        aggregate_type: row.aggregate_type,
        aggregate_version: row.aggregate_version,
        current_version: currentVersion,
      },
    });
    return outboxEventView(updated);
  }
}
