import {
  affectedVenueIds,
  autoResolveAlerts,
  raiseAlert,
  raiseAlertForAffectedVenues,
  type AlertRow,
} from '../../../core/alerts/alerts.js';
import type { Clock } from '../../../core/clock/clock.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import type { Logger } from '../../../core/logging/logger.js';
import { metrics } from '../../../core/metrics/metrics.js';
import { venueSettings } from '../../../core/settings/settings-service.js';
import {
  OUTBOX_LAG_RESOLVE_AFTER_MS,
  TASK_STUCK_THRESHOLD_MIN,
  isOutboxLagging,
  lagResolvable,
  outboxLagThresholdS,
  type OutboxHealth,
  type StuckPhase,
} from '../domain/monitor-rules.js';
import { ensureRetentionScheduled } from './retention-purge.js';

/** Only one process evaluates the alert conditions per tick (api and worker both run the monitor). */
const MONITOR_LOCK = 'point_system_monitor';

export interface SystemMonitorOptions {
  /** loop interval (MONITOR_INTERVAL_S, default 10 s) */
  intervalMs?: number;
  /** 14 §8: `outbox_lag` resolves after this long below the threshold with no dead row (2 minutes) */
  lagResolveAfterMs?: number;
  /** RETENTION_PURGE_CRON_UTC: the monitor keeps one job.retention_purge scheduled; null disables that */
  retentionCron?: string | null;
}

export interface OrgLagReport extends OutboxHealth {
  orgId: string;
  thresholdS: number;
  lagging: boolean;
  /** venues whose live alert was raised or refreshed */
  raised: string[];
  /** venues whose alert was resolved */
  resolved: string[];
}

export interface StuckTask {
  task_id: string;
  org_id: string;
  venue_id: string;
  dispatch_pool_id: string;
  event_id: string;
  ticket_id: string;
  type: 'park' | 'retrieve' | 'repark';
  status: string;
  assignee_id: string | null;
  phase: StuckPhase;
  since: Date;
}

export interface MonitorReport {
  /** false when another process held the evaluation lock */
  evaluated: boolean;
  outbox: OrgLagReport[];
  stuck: { raised: string[]; resolved: string[] };
  /** `draft_abandoned` raised (ticket ids) and resolved because the draft left `received` (PNT-075) */
  drafts: { raised: string[]; resolved: string[] };
}

export interface AbandonedDraft {
  ticket_id: string;
  org_id: string;
  venue_id: string;
  dispatch_pool_id: string;
  event_id: string;
  display_number: number;
  created_by: string;
  created_at: Date;
  task_id: string | null;
}

/**
 * SystemMonitor (PNT-094; 04 §6.7, 14 §8, 15 §12): a loop that cannot live in the outbox (it watches it).
 *  - refreshes the Prometheus gauges of 05 §12.2 in every process that runs it;
 *  - raises `outbox_lag` (critical, `outbox_lag:{venue_id}`, one row per venue with an open or closing
 *    event, DEC-46) when the oldest due row is older than `ops.outbox_lag_alert_s` or any row is `dead`, and
 *    resolves it once the lag stayed below the threshold for two minutes with no dead row — the moment it
 *    turned healthy is kept in the alert's `details.below_since`, so any process can continue the window;
 *  - raises/resolves `task_stuck` (StuckDetector, `task_stuck:{task_id}`);
 *  - raises `draft_abandoned` (`draft_abandoned:{ticket_id}`) for intake drafts left in `received` beyond
 *    `intake.draft_abandoned_alert_min`, and resolves the live ones whose draft left `received` (14 §8);
 *  - keeps the daily job.retention_purge scheduled.
 * It runs in the worker and in the api (a stopped worker is still detected); a transaction-scoped advisory
 * lock lets one process evaluate per tick. Time comes from the injected clock; `tick()` is public for tests.
 */
export class SystemMonitor {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private stopped = true;
  readonly intervalMs: number;
  private readonly lagResolveAfterMs: number;

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly opts: SystemMonitorOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 10_000;
    this.lagResolveAfterMs = opts.lagResolveAfterMs ?? OUTBOX_LAG_RESOLVE_AFTER_MS;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = () => {
      if (this.stopped) return;
      this.running = this.tick()
        .catch((err) => this.logger.error({ err: (err as Error).message }, 'system monitor tick failed'))
        .finally(() => {
          this.running = null;
          if (!this.stopped) this.timer = setTimeout(loop, this.intervalMs);
        });
    };
    this.timer = setTimeout(loop, 0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  async tick(): Promise<MonitorReport> {
    await this.refreshGauges().catch((err) =>
      this.logger.warn({ err: (err as Error).message }, 'system monitor gauges failed'),
    );
    const report = await this.db.transaction(async (tx): Promise<MonitorReport | null> => {
      const lock = await tx.one<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`, [
        MONITOR_LOCK,
      ]);
      if (!lock.ok) return null;
      const outbox = await this.evaluateOutboxLag(tx);
      const stuck = await this.evaluateStuckTasks(tx);
      const drafts = await this.evaluateAbandonedDrafts(tx);
      if (this.opts.retentionCron !== null)
        await ensureRetentionScheduled(
          tx,
          this.opts.retentionCron ?? process.env.RETENTION_PURGE_CRON_UTC ?? '0 2 * * *',
        );
      return { evaluated: true, outbox, stuck, drafts };
    });
    return (
      report ?? {
        evaluated: false,
        outbox: [],
        stuck: { raised: [], resolved: [] },
        drafts: { raised: [], resolved: [] },
      }
    );
  }

  // ------------------------------------------------------------------ outbox_lag

  /** Per organization (each has its `ops.outbox_lag_alert_s`). */
  async outboxHealth(q: Pick<Tx, 'rows'>, now: Date) {
    return q.rows<{ org_id: string; settings: unknown; oldest_due: Date | null; due: number; dead: number }>(
      `SELECT o.id AS org_id, o.settings,
              (SELECT min(e.available_at) FROM outbox_events e
                WHERE e.org_id = o.id AND ((e.status = 'pending' AND e.available_at <= $1)
                                        OR (e.status = 'processing' AND e.locked_until < $1))) AS oldest_due,
              (SELECT count(*)::int FROM outbox_events e
                WHERE e.org_id = o.id AND ((e.status = 'pending' AND e.available_at <= $1)
                                        OR (e.status = 'processing' AND e.locked_until < $1))) AS due,
              (SELECT count(*)::int FROM outbox_events e WHERE e.org_id = o.id AND e.status = 'dead') AS dead
         FROM organizations o ORDER BY o.id`,
      [now],
    );
  }

  private async evaluateOutboxLag(tx: Tx): Promise<OrgLagReport[]> {
    const out: OrgLagReport[] = [];
    for (const h of await this.outboxHealth(tx, tx.now)) {
      const thresholdS = outboxLagThresholdS(h.settings);
      const health: OutboxHealth = {
        oldestDueAgeS: h.oldest_due
          ? Math.max(0, (tx.now.getTime() - new Date(h.oldest_due).getTime()) / 1000)
          : 0,
        dueCount: h.due,
        deadCount: h.dead,
      };
      const lagging = isOutboxLagging(health, thresholdS);
      const live = await tx.rows<AlertRow>(
        `SELECT * FROM alerts WHERE org_id = $1 AND type = 'outbox_lag' AND status <> 'resolved' ORDER BY id FOR NO KEY UPDATE`,
        [h.org_id],
      );
      const report: OrgLagReport = {
        orgId: h.org_id,
        thresholdS,
        lagging,
        ...health,
        raised: [],
        resolved: [],
      };
      const details = {
        oldest_due_age_s: Math.floor(health.oldestDueAgeS),
        threshold_s: thresholdS,
        due_count: health.dueCount,
        dead_count: health.deadCount,
      };
      if (lagging) {
        const venues = [
          ...new Set([...(await affectedVenueIds(tx, h.org_id)), ...live.map((a) => a.venue_id)]),
        ];
        if (venues.length) {
          const rows = await raiseAlertForAffectedVenues(tx, {
            orgId: h.org_id,
            type: 'outbox_lag',
            dedupeKey: (venueId) => `outbox_lag:${venueId}`,
            venueIds: venues,
            details: { ...details, below_since: null },
          });
          report.raised = rows.map((r) => r.venue_id);
        }
      } else if (live.length) {
        const resolvable: AlertRow[] = [];
        for (const a of live) {
          const since = typeof a.details?.below_since === 'string' ? new Date(a.details.below_since) : null;
          if (since && !Number.isNaN(since.getTime())) {
            if (lagResolvable(since, tx.now, this.lagResolveAfterMs)) resolvable.push(a);
            continue;
          }
          // first healthy observation: the two-minute window starts now (kept in the row, not in memory)
          await raiseAlert(tx, {
            orgId: h.org_id,
            venueId: a.venue_id,
            type: 'outbox_lag',
            dedupeKey: a.dedupe_key ?? `outbox_lag:${a.venue_id}`,
            details: { ...a.details, ...details, below_since: tx.now.toISOString() },
          });
        }
        if (resolvable.length) {
          const resolved = await autoResolveAlerts(tx, {
            orgId: h.org_id,
            dedupeKeys: [...new Set(resolvable.map((a) => a.dedupe_key ?? `outbox_lag:${a.venue_id}`))],
            note: 'outbox lag below the threshold for two minutes and no dead row',
          });
          report.resolved = resolved.map((r) => r.venue_id);
        }
      }
      if (report.raised.length || report.resolved.length)
        this.logger.warn(
          {
            org_id: h.org_id,
            lagging,
            ...details,
            raised: report.raised.length,
            resolved: report.resolved.length,
          },
          'outbox_lag',
        );
      out.push(report);
    }
    return out;
  }

  // ------------------------------------------------------------------ task_stuck (StuckDetector)

  async stuckTasks(q: Pick<Tx, 'rows'>, now: Date): Promise<StuckTask[]> {
    const t = TASK_STUCK_THRESHOLD_MIN;
    return q.rows<StuckTask>(
      `SELECT k.id AS task_id, k.org_id, k.venue_id, k.dispatch_pool_id, k.event_id, k.ticket_id, k.type, k.status, k.assignee_id,
              CASE WHEN k.type = 'retrieve' AND k.status = 'accepted' THEN 'retrieve_accepted'
                   WHEN k.type = 'retrieve' THEN 'retrieve_in_progress'
                   ELSE 'park_in_progress' END AS phase,
              CASE WHEN k.type = 'retrieve' AND k.status = 'accepted' THEN COALESCE(k.accepted_at, k.claimed_at)
                   WHEN k.type = 'retrieve' THEN COALESCE(k.started_at, k.accepted_at)
                   ELSE COALESCE(k.started_at, k.created_at) END AS since
         FROM tasks k LEFT JOIN retrieval_cycles c ON c.id = k.cycle_id
        WHERE k.status IN ('accepted','in_progress')
          AND ((k.type = 'retrieve' AND k.status = 'accepted'
                AND COALESCE(k.accepted_at, k.claimed_at) <= $1::timestamptz - make_interval(mins => $2))
            OR (k.type = 'retrieve' AND k.status = 'in_progress' AND c.ready_at IS NULL
                AND COALESCE(k.started_at, k.accepted_at) <= $1::timestamptz - make_interval(mins => $3))
            OR (k.type IN ('park','repark') AND k.status = 'in_progress'
                AND COALESCE(k.started_at, k.created_at) <= $1::timestamptz - make_interval(mins => $4)))
        ORDER BY k.id`,
      [now, t.retrieve_accepted, t.retrieve_in_progress, t.park_in_progress],
    );
  }

  private async evaluateStuckTasks(tx: Tx) {
    const stuck = await this.stuckTasks(tx, tx.now);
    const byTask = new Map(stuck.map((s) => [s.task_id, s]));
    const live = await tx.rows<AlertRow>(
      `SELECT * FROM alerts WHERE type = 'task_stuck' AND status <> 'resolved' ORDER BY id FOR NO KEY UPDATE`,
    );
    const resolved: string[] = [];
    const raised: string[] = [];
    // progress or closing (start, readiness, completion, cancel, withdrawal, reassignment) resolves (14 §8)
    for (const a of live) {
      const s = a.task_id ? byTask.get(a.task_id) : undefined;
      const samePhase =
        s && a.details?.phase === s.phase && (a.details?.assignee_id ?? null) === s.assignee_id;
      if (samePhase) continue;
      const r = await autoResolveAlerts(tx, {
        orgId: a.org_id,
        venueId: a.venue_id,
        dedupeKeys: [a.dedupe_key ?? `task_stuck:${a.task_id}`],
        note: 'task progressed or closed',
      });
      resolved.push(...r.map((x) => x.task_id ?? x.id));
    }
    const counts = new Map<string, number>();
    for (const s of stuck) {
      counts.set(s.type, (counts.get(s.type) ?? 0) + 1);
      const since = new Date(s.since);
      const { created } = await raiseAlert(tx, {
        orgId: s.org_id,
        venueId: s.venue_id,
        type: 'task_stuck',
        dedupeKey: `task_stuck:${s.task_id}`,
        poolId: s.dispatch_pool_id,
        eventId: s.event_id,
        ticketId: s.ticket_id,
        taskId: s.task_id,
        userId: s.assignee_id,
        details: {
          phase: s.phase,
          task_type: s.type,
          status: s.status,
          assignee_id: s.assignee_id,
          since: since.toISOString(),
          stuck_min: Math.floor((tx.now.getTime() - since.getTime()) / 60_000),
          threshold_min: TASK_STUCK_THRESHOLD_MIN[s.phase],
        },
      });
      if (created) raised.push(s.task_id);
    }
    metrics.tasksStuck.reset();
    for (const [type, n] of counts) metrics.tasksStuck.set({ type }, n);
    return { raised, resolved };
  }

  // ------------------------------------------------------------------ draft_abandoned (14 §8, 15 §12)

  /**
   * Drafts still `received` (TT-01 → TT-03 not done) for at least `intake.draft_abandoned_alert_min` of their
   * venue, measured from the draft's creation (the moment custody passed to the driver). The 1-minute floor is
   * the setting's lower bound (canon §12), so no draft below it is ever read.
   */
  async abandonedDrafts(tx: Tx, now: Date): Promise<AbandonedDraft[]> {
    const candidates = await tx.rows<AbandonedDraft>(
      `SELECT t.id AS ticket_id, t.org_id, t.venue_id, t.dispatch_pool_id, t.event_id, t.display_number, t.created_by,
              t.created_at, k.id AS task_id
         FROM tickets t
         LEFT JOIN tasks k ON k.ticket_id = t.id AND k.type = 'park' AND k.status = 'in_progress'
        WHERE t.status = 'received' AND t.created_at <= $1::timestamptz - interval '1 minute'
        ORDER BY t.venue_id, t.created_at, t.id`,
      [now],
    );
    const thresholds = new Map<string, number>();
    const out: AbandonedDraft[] = [];
    for (const c of candidates) {
      let min = thresholds.get(c.venue_id);
      if (min === undefined) {
        min = (await venueSettings(tx, c.venue_id)).intake.draft_abandoned_alert_min;
        thresholds.set(c.venue_id, min);
      }
      if (now.getTime() - new Date(c.created_at).getTime() >= min * 60_000) out.push(c);
    }
    return out;
  }

  private async evaluateAbandonedDrafts(tx: Tx) {
    const raised: string[] = [];
    const resolved: string[] = [];
    // a draft that left `received` (submitted, voided, reconciled) no longer needs a supervisor (14 §8)
    const gone = await tx.rows<{ org_id: string; venue_id: string; dedupe_key: string; ticket_id: string }>(
      `SELECT a.org_id, a.venue_id, a.dedupe_key, a.ticket_id FROM alerts a JOIN tickets t ON t.id = a.ticket_id
        WHERE a.type = 'draft_abandoned' AND a.status <> 'resolved' AND t.status <> 'received'
        ORDER BY a.id`,
    );
    for (const a of gone) {
      const r = await autoResolveAlerts(tx, {
        orgId: a.org_id,
        venueId: a.venue_id,
        dedupeKeys: [a.dedupe_key],
        note: 'draft left received',
      });
      resolved.push(...r.map((x) => x.ticket_id ?? x.id));
    }
    for (const d of await this.abandonedDrafts(tx, tx.now)) {
      const dedupeKey = `draft_abandoned:${d.ticket_id}`;
      // a live alert (from this timer or from a refused discard, 08) keeps its details
      const live = await tx.maybeOne(
        `SELECT 1 FROM alerts WHERE venue_id = $1 AND dedupe_key = $2 AND status <> 'resolved'`,
        [d.venue_id, dedupeKey],
      );
      if (live) continue;
      const since = new Date(d.created_at);
      const threshold = (await venueSettings(tx, d.venue_id)).intake.draft_abandoned_alert_min;
      const { created } = await raiseAlert(tx, {
        orgId: d.org_id,
        venueId: d.venue_id,
        type: 'draft_abandoned',
        dedupeKey,
        poolId: d.dispatch_pool_id,
        eventId: d.event_id,
        ticketId: d.ticket_id,
        taskId: d.task_id,
        userId: d.created_by,
        details: {
          display_number: d.display_number,
          cause: 'timer',
          since: since.toISOString(),
          waited_min: Math.floor((tx.now.getTime() - since.getTime()) / 60_000),
          threshold_min: threshold,
        },
      });
      if (created) raised.push(d.ticket_id);
    }
    return { raised, resolved };
  }

  // ------------------------------------------------------------------ gauges (05 §12.2)

  async refreshGauges(): Promise<void> {
    const now = this.clock.now();
    const outbox = await this.db.rows<{ type: string; due: number; oldest: Date | null; dead: number }>(
      `SELECT type,
              count(*) FILTER (WHERE status <> 'dead')::int AS due,
              min(available_at) FILTER (WHERE status <> 'dead') AS oldest,
              count(*) FILTER (WHERE status = 'dead')::int AS dead
         FROM outbox_events
        WHERE (status = 'pending' AND available_at <= $1) OR (status = 'processing' AND locked_until < $1) OR status = 'dead'
        GROUP BY type`,
      [now],
    );
    metrics.outboxDue.reset();
    metrics.outboxOldestPending.reset();
    metrics.outboxDead.reset();
    for (const r of outbox) {
      if (r.due) metrics.outboxDue.set({ type: r.type }, r.due);
      if (r.oldest)
        metrics.outboxOldestPending.set(
          { type: r.type },
          Math.max(0, (now.getTime() - new Date(r.oldest).getTime()) / 1000),
        );
      if (r.dead) metrics.outboxDead.set({ type: r.type }, r.dead);
    }

    const pools = await this.db.rows<{
      pool: string;
      open_tasks: number;
      broadcasts: number;
      eligible: number;
    }>(
      `SELECT p.id AS pool,
              (SELECT count(*)::int FROM tasks k WHERE k.dispatch_pool_id = p.id AND k.type = 'retrieve'
                  AND k.status NOT IN ('completed','canceled')) AS open_tasks,
              (SELECT count(*)::int FROM task_offers o WHERE o.dispatch_pool_id = p.id AND o.status = 'active'
                  AND o.mode = 'broadcast') AS broadcasts,
              (SELECT count(*)::int FROM duty_sessions d WHERE d.dispatch_pool_id = p.id AND d.status = 'on_duty') AS eligible
         FROM dispatch_pools p WHERE p.status = 'active'`,
    );
    metrics.dispatchOpenTasks.reset();
    metrics.dispatchBroadcastOpen.reset();
    metrics.dispatchEligibleDrivers.reset();
    for (const p of pools) {
      metrics.dispatchOpenTasks.set({ pool: p.pool }, p.open_tasks);
      metrics.dispatchBroadcastOpen.set({ pool: p.pool }, p.broadcasts);
      metrics.dispatchEligibleDrivers.set({ pool: p.pool }, p.eligible);
    }

    const venues = await this.db.rows<{ venue: string; on_duty: number; uncertain: number }>(
      `SELECT venue_id AS venue, count(*)::int AS on_duty,
              count(*) FILTER (WHERE connection_state <> 'online')::int AS uncertain
         FROM duty_sessions WHERE status <> 'ended' GROUP BY venue_id`,
    );
    metrics.driversOnDuty.reset();
    metrics.driversConnectionUncertain.reset();
    for (const v of venues) {
      metrics.driversOnDuty.set({ venue: v.venue }, v.on_duty);
      metrics.driversConnectionUncertain.set({ venue: v.venue }, v.uncertain);
    }

    const inbound = await this.db.rows<{ n: number; oldest: Date | null }>(
      `SELECT count(*)::int AS n, min(received_at) AS oldest FROM whatsapp_inbound_events WHERE status = 'pending'`,
    );
    metrics.waInboundBacklog.set(inbound[0]?.n ?? 0);
    const oldest = inbound[0]?.oldest;
    metrics.waInboundLag.set(oldest ? Math.max(0, (now.getTime() - new Date(oldest).getTime()) / 1000) : 0);

    metrics.dbPoolInUse.set(Math.max(0, this.db.pool.totalCount - this.db.pool.idleCount));
  }
}
