import {
  affectedVenueIds,
  autoResolveAlerts,
  channelDownDedupeKey,
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
import {
  MESSAGING_LIMIT_KEY_PREFIX,
  SERVICE_QUOTA_KEY_PREFIX,
  WA_MESSAGING_LIMIT_SILENCE_MS,
  WA_QUOTA_MONTH_TIME_ZONE,
  WA_QUOTA_REFRESH_MS,
  WA_QUOTA_RESOLVE_AFTER_MS,
  WA_SERVICE_WINDOW_HOURS,
  waQuotaConditions,
  type WaQuotaCondition,
  type WaQuotaSnapshot,
} from '../domain/wa-quota.js';
import { ensureRetentionScheduled } from './retention-purge.js';

/** Only one process evaluates the alert conditions per tick (api and worker both run the monitor). */
const MONITOR_LOCK = 'point_system_monitor';
/**
 * The WhatsApp quota decisions take a lock of their own, in a transaction of their own: a tick of another process
 * holding MONITOR_LOCK never makes them skip, and a failing count never rolls back `outbox_lag`, `task_stuck` or
 * `draft_abandoned`.
 */
const QUOTA_LOCK = 'point_system_monitor_wa_quota';

export interface SystemMonitorOptions {
  /** loop interval (MONITOR_INTERVAL_S, default 10 s) */
  intervalMs?: number;
  /** 14 §8: `outbox_lag` resolves after this long below the threshold with no dead row (2 minutes) */
  lagResolveAfterMs?: number;
  /** RETENTION_PURGE_CRON_UTC: the monitor keeps one job.retention_purge scheduled; null disables that */
  retentionCron?: string | null;
  /**
   * the WhatsApp quota counts (12 §13) are taken at most this often per process — for the gauges and for the alert
   * decisions (default 60 s; 0 = every tick)
   */
  quotaRefreshMs?: number;
  /** a live quota alert resolves once its condition stayed false this long (default 2 minutes) */
  quotaResolveAfterMs?: number;
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

/** A WhatsApp quota alert row (GAP-9): its venue and dedupe key. */
export interface QuotaAlertRef {
  venue_id: string;
  dedupe_key: string;
}

export interface MonitorReport {
  /** false when another process held the evaluation lock */
  evaluated: boolean;
  outbox: OrgLagReport[];
  stuck: { raised: string[]; resolved: string[] };
  /** `draft_abandoned` raised (ticket ids) and resolved because the draft left `received` (PNT-075) */
  drafts: { raised: string[]; resolved: string[] };
  /** `wa_channel_down` raised for venues whose event opened while the channel was down (venue ids) */
  channelDown: string[];
  /**
   * WhatsApp quota alerts (12 §13, raised as `wa_send_failed`, GAP-9) created and resolved by this tick; `evaluated`
   * is false when no decision was due in this process, another process was deciding, or the count failed
   */
  quota: QuotaReport;
}

export interface QuotaReport {
  evaluated: boolean;
  raised: QuotaAlertRef[];
  resolved: QuotaAlertRef[];
}

const NO_QUOTA_DECISION: QuotaReport = { evaluated: false, raised: [], resolved: [] };

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
 *  - counts the WhatsApp quotas of 12 §13 (`point_wa_service_messages_month`,
 *    `point_wa_unique_users_24h_outside_window`) at most once a minute per process, and raises/resolves their
 *    alerts at its thresholds from that count, in a transaction and under a lock of their own (GAP-9);
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
  private readonly quotaRefreshMs: number;
  private readonly quotaResolveAfterMs: number;
  private quotaCache: { atMs: number; rows: WaQuotaSnapshot[] } | null = null;
  /** the clock instant of this process's last quota decision (or failed attempt) */
  private lastQuotaDecisionMs: number | null = null;

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly opts: SystemMonitorOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 10_000;
    this.lagResolveAfterMs = opts.lagResolveAfterMs ?? OUTBOX_LAG_RESOLVE_AFTER_MS;
    this.quotaRefreshMs = opts.quotaRefreshMs ?? WA_QUOTA_REFRESH_MS;
    this.quotaResolveAfterMs = opts.quotaResolveAfterMs ?? WA_QUOTA_RESOLVE_AFTER_MS;
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
    const quotaDue = this.quotaDecisionDue();
    // a due quota decision counts afresh and sets the quota gauges itself: no second count for the gauges
    await this.refreshGauges({ quota: !quotaDue }).catch((err) =>
      this.logger.warn({ err: (err as Error).message }, 'system monitor gauges failed'),
    );
    let failure: unknown = null;
    const report = await this.db
      .transaction(async (tx): Promise<Omit<MonitorReport, 'quota'> | null> => {
        const lock = await tx.one<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`, [
          MONITOR_LOCK,
        ]);
        if (!lock.ok) return null;
        const outbox = await this.evaluateOutboxLag(tx);
        const stuck = await this.evaluateStuckTasks(tx);
        const drafts = await this.evaluateAbandonedDrafts(tx);
        const channelDown = await this.evaluateChannelDown(tx);
        if (this.opts.retentionCron !== null)
          await ensureRetentionScheduled(
            tx,
            this.opts.retentionCron ?? process.env.RETENTION_PURGE_CRON_UTC ?? '0 2 * * *',
          );
        return { evaluated: true, outbox, stuck, drafts, channelDown };
      })
      .catch((err: unknown) => {
        failure = err;
        return null;
      });
    // the quotas are decided whatever the tick did, and their failure never undoes it
    const quota = quotaDue ? await this.decideWaQuota() : NO_QUOTA_DECISION;
    if (failure) throw failure;
    return {
      ...(report ?? {
        evaluated: false,
        outbox: [],
        stuck: { raised: [], resolved: [] },
        drafts: { raised: [], resolved: [] },
        channelDown: [],
      }),
      quota,
    };
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
    // 15 §12 «مهام معلقة»: past twice the threshold is the monitoring-only critical level
    const critical = new Map<string, number>();
    for (const s of stuck) {
      counts.set(s.type, (counts.get(s.type) ?? 0) + 1);
      const since = new Date(s.since);
      if (tx.now.getTime() - since.getTime() >= 2 * TASK_STUCK_THRESHOLD_MIN[s.phase] * 60_000)
        critical.set(s.type, (critical.get(s.type) ?? 0) + 1);
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
    metrics.tasksStuckCritical.reset();
    for (const [type, n] of critical) metrics.tasksStuckCritical.set({ type }, n);
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

  // ------------------------------------------------------------------ wa_channel_down for late venues (14 §8, DEC-46)

  /**
   * 14 §8 / DEC-46: while a channel is `down`, every venue with an open or closing event has its `wa_channel_down`
   * row. The transition to `down` raises it for the venues of that instant (whatsapp `setChannelHealth`); a venue
   * whose event opens or reopens during the outage gets its row here (critical, with its escalation Push) — as
   * `outbox_lag` reaches newly affected venues. A venue that already has a live row, or whose row a supervisor
   * resolved during this outage, is left alone; the transition back to `healthy` resolves them all.
   */
  private async evaluateChannelDown(tx: Tx): Promise<string[]> {
    const raised: string[] = [];
    const down = await tx.rows<{ id: string; org_id: string; since: Date | null }>(
      `SELECT id, org_id, health_changed_at AS since FROM whatsapp_channel
        WHERE is_active AND health_status = 'down' ORDER BY org_id`,
    );
    for (const c of down) {
      const venues = await affectedVenueIds(tx, c.org_id);
      if (!venues.length) continue;
      const key = channelDownDedupeKey(c.id);
      const since = c.since ? new Date(c.since) : new Date(0);
      // uq_alerts_live_dedupe for the live rows, ix_alerts_manual_resolved for the resolutions of this outage
      const covered = await tx.rows<{ venue_id: string; details: Record<string, unknown> }>(
        `SELECT venue_id, details FROM alerts
          WHERE venue_id = ANY($2::uuid[]) AND dedupe_key = $3 AND status <> 'resolved'
         UNION ALL
         SELECT venue_id, details FROM alerts
          WHERE org_id = $1 AND dedupe_key = $3 AND status = 'resolved' AND resolved_by IS NOT NULL
            AND resolved_at >= $4`,
        [c.org_id, venues, key, since],
      );
      const have = new Set(covered.map((r) => r.venue_id));
      const missing = venues.filter((v) => !have.has(v));
      if (!missing.length) continue;
      // the reason of this outage: from a row already raised, else from the audit row of the transition
      const reason =
        covered.map((r) => r.details?.reason).find((x): x is string => typeof x === 'string') ??
        (
          await tx.maybeOne<{ reason: string | null }>(
            `SELECT metadata->>'reason' AS reason FROM audit_log
              WHERE entity_type = 'whatsapp_channel' AND entity_id = $1 AND after->>'health_status' = 'down'
              ORDER BY occurred_at DESC LIMIT 1`,
            [c.id],
          )
        )?.reason ??
        'down';
      for (const venueId of missing) {
        const { created } = await raiseAlert(tx, {
          orgId: c.org_id,
          venueId,
          type: 'wa_channel_down',
          dedupeKey: key,
          details: { channel_id: c.id, reason },
        });
        if (created) raised.push(venueId);
      }
      if (raised.length)
        this.logger.error(
          { channel_id: c.id, venues: raised.length },
          'wa_channel_down for venues opened during the outage',
        );
    }
    return raised;
  }

  // ------------------------------------------------------------------ WhatsApp quotas (GAP-9: 12 §13, F-03, F-18)

  /**
   * The two quota counts of every organization's active channel at `tx.now` (05 §12.2, 12 §13):
   *  - service messages: session texts the provider accepted (`wa_message_id` set, not `failed`) on the channel since
   *    the start of the month in WA_QUOTA_MONTH_TIME_ZONE (F-03 counts per business number);
   *  - unique users outside the window: distinct customers sent a template (accepted, not `failed`) in the last 24 h
   *    with no inbound message from them in the 24 h before that send (F-04, F-18), for the whole organization (the
   *    limit is per business portfolio).
   * `ix_whatsapp_messages_accepted` (migration 0005) makes both range scans; the window test is one probe of
   * `ix_whatsapp_messages_customer` per send. JIT is off for the transaction: compiling these plans costs far more
   * than running them.
   */
  async waQuota(tx: Tx): Promise<WaQuotaSnapshot[]> {
    await tx.query(`SET LOCAL jit = off`);
    const channels = await tx.rows<{
      org_id: string;
      channel_id: string;
      tier: string | null;
      month: string;
      month_start: Date;
    }>(
      `SELECT c.org_id, c.id AS channel_id, c.messaging_limit_tier AS tier,
              to_char($1::timestamptz AT TIME ZONE $2, 'YYYY-MM') AS month,
              date_trunc('month', $1::timestamptz AT TIME ZONE $2) AT TIME ZONE $2 AS month_start
         FROM whatsapp_channel c WHERE c.is_active ORDER BY c.org_id`,
      [tx.now, WA_QUOTA_MONTH_TIME_ZONE],
    );
    const out: WaQuotaSnapshot[] = [];
    for (const c of channels) {
      const service = await tx.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM whatsapp_messages m
          WHERE m.org_id = $1 AND m.direction = 'outbound' AND m.wa_message_id IS NOT NULL
            AND m.channel_id = $2 AND m.kind = 'session_text' AND m.status <> 'failed'
            AND m.queued_at >= $3 AND m.queued_at <= $4`,
        [c.org_id, c.channel_id, c.month_start, tx.now],
      );
      const outside = await tx.one<{ n: number }>(
        `SELECT count(DISTINCT m.customer_id)::int AS n
           FROM whatsapp_messages m
           LEFT JOIN LATERAL (
             SELECT 1 AS hit FROM whatsapp_messages i
              WHERE i.customer_id = m.customer_id AND i.direction = 'inbound'
                AND i.received_at > m.queued_at - make_interval(hours => $3) AND i.received_at <= m.queued_at
              LIMIT 1) w ON true
          WHERE m.org_id = $1 AND m.direction = 'outbound' AND m.wa_message_id IS NOT NULL
            AND m.kind = 'template' AND m.status <> 'failed' AND m.customer_id IS NOT NULL
            AND m.queued_at > $2::timestamptz - make_interval(hours => $3) AND m.queued_at <= $2
            AND w.hit IS NULL`,
        [c.org_id, tx.now, WA_SERVICE_WINDOW_HOURS],
      );
      out.push({
        orgId: c.org_id,
        channelId: c.channel_id,
        month: c.month,
        serviceMessagesMonth: service.n,
        uniqueUsers24hOutsideWindow: outside.n,
        limitTier: c.tier,
      });
    }
    return out;
  }

  /**
   * The quota counts for the gauges of 05 §12.2, recounted at most every `quotaRefreshMs` in this process (in a
   * short transaction of their own) — the last count of this process otherwise, whether a gauge refresh or a quota
   * decision made it. Never used to decide an alert: a decision counts afresh in its own transaction.
   */
  async waQuotaSnapshot(): Promise<WaQuotaSnapshot[]> {
    const at = this.clock.now().getTime();
    const cached = this.quotaCache;
    if (cached && at >= cached.atMs && at - cached.atMs < this.quotaRefreshMs) return cached.rows;
    const rows = await this.db.transaction((t) => this.waQuota(t));
    this.keepQuotaSnapshot(at, rows);
    return rows;
  }

  /** The gauges carry the highest organization's value (one active channel per organization, one in V1). */
  private keepQuotaSnapshot(atMs: number, rows: WaQuotaSnapshot[]): void {
    this.quotaCache = { atMs, rows };
    metrics.waServiceMessagesMonth.set(rows.reduce((m, r) => Math.max(m, r.serviceMessagesMonth), 0));
    metrics.waUniqueUsers24h.set(rows.reduce((m, r) => Math.max(m, r.uniqueUsers24hOutsideWindow), 0));
  }

  /** At most one quota decision per `quotaRefreshMs` in this process (a clock moved back decides again). */
  private quotaDecisionDue(): boolean {
    if (this.lastQuotaDecisionMs === null) return true;
    const now = this.clock.now().getTime();
    return now < this.lastQuotaDecisionMs || now - this.lastQuotaDecisionMs >= this.quotaRefreshMs;
  }

  /**
   * One quota decision: a transaction of its own under QUOTA_LOCK, the counts taken in it (READ COMMITTED: they see
   * everything committed before, including the previous decision of any process), the alerts raised and resolved
   * from them, the gauges set from the same counts. The api and the worker both decide, each at most once a
   * minute; the lock orders their decisions, each on a newer count than the one before, so a process never acts
   * on an older snapshot than the decision it follows. A failure is logged and retried at the next due tick.
   */
  private async decideWaQuota(): Promise<QuotaReport> {
    try {
      const done = await this.db.transaction(async (tx) => {
        const lock = await tx.one<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`, [
          QUOTA_LOCK,
        ]);
        if (!lock.ok) return null;
        const snapshots = await this.waQuota(tx);
        const decided = await this.evaluateWaQuota(tx, snapshots);
        return { atMs: tx.now.getTime(), snapshots, decided };
      });
      // another process is deciding at this instant: this one tries again at its next tick
      if (!done) return NO_QUOTA_DECISION;
      this.lastQuotaDecisionMs = done.atMs;
      this.keepQuotaSnapshot(done.atMs, done.snapshots);
      return { evaluated: true, ...done.decided };
    } catch (err) {
      this.lastQuotaDecisionMs = this.clock.now().getTime();
      this.logger.warn({ err: (err as Error).message }, 'system monitor whatsapp quota failed');
      return NO_QUOTA_DECISION;
    }
  }

  /**
   * 12 §13 thresholds → alerts (DEC-PROPOSED-1 of docs/progress/notes/server-gaps.md), from `snapshots` counted in
   * `tx`. A condition that holds is raised as `wa_send_failed` (warning, ticket-less) for every venue with an open or
   * closing event plus the venues already alerted (DEC-46); a live row is rewritten only when its details changed. A
   * condition that ended (the month changed, the 24 h count fell under the threshold, the limit rose or became
   * unlimited, the channel changed) resolves automatically once it stayed false for `quotaResolveAfterMs`; the
   * instant it turned false is kept in the row's `details.below_since`, and a condition holding again clears it. A
   * supervisor's resolution is kept: the service-message alert stays resolved for the rest of its month (the month
   * is part of its key), the messaging-limit alert for its 24 h window.
   */
  private async evaluateWaQuota(
    tx: Tx,
    snapshots: WaQuotaSnapshot[],
  ): Promise<Pick<QuotaReport, 'raised' | 'resolved'>> {
    const raised: QuotaAlertRef[] = [];
    const resolved: QuotaAlertRef[] = [];
    const live = await tx.rows<AlertRow>(
      `SELECT * FROM alerts WHERE type = 'wa_send_failed' AND status <> 'resolved'
          AND (starts_with(dedupe_key, $1) OR starts_with(dedupe_key, $2))
        ORDER BY id FOR NO KEY UPDATE`,
      [SERVICE_QUOTA_KEY_PREFIX, MESSAGING_LIMIT_KEY_PREFIX],
    );
    const holding = new Map<string, { orgId: string; condition: WaQuotaCondition }>();
    for (const s of snapshots)
      for (const condition of waQuotaConditions(s))
        holding.set(condition.dedupeKey, { orgId: s.orgId, condition });

    // ended conditions: the window starts at the first false observation and is kept in the row
    const ended = new Map<string, Set<string>>();
    for (const a of live) {
      if (!a.dedupe_key || holding.has(a.dedupe_key)) continue;
      const since = typeof a.details?.below_since === 'string' ? new Date(a.details.below_since) : null;
      if (!since || Number.isNaN(since.getTime())) {
        await tx.query(
          `UPDATE alerts SET details = details || jsonb_build_object('below_since', $2::text) WHERE id = $1`,
          [a.id, tx.now.toISOString()],
        );
        continue;
      }
      if (tx.now.getTime() - since.getTime() < this.quotaResolveAfterMs) continue;
      const keys = ended.get(a.org_id) ?? new Set<string>();
      keys.add(a.dedupe_key);
      ended.set(a.org_id, keys);
    }
    for (const [orgId, keys] of ended) {
      const rows = await autoResolveAlerts(tx, {
        orgId,
        dedupeKeys: [...keys],
        note: 'whatsapp quota back under the 12 §13 threshold',
      });
      resolved.push(...rows.map((a) => ({ venue_id: a.venue_id, dedupe_key: a.dedupe_key ?? '' })));
    }

    for (const [key, { orgId, condition }] of holding) {
      const liveRows = live.filter((a) => a.dedupe_key === key);
      // the live rows follow the count (and lose a `below_since`): rewritten only when the details changed
      for (const a of liveRows) {
        if (sameJson(a.details, condition.details)) continue;
        await raiseAlert(tx, {
          orgId,
          venueId: a.venue_id,
          type: 'wa_send_failed',
          dedupeKey: key,
          details: condition.details,
        });
      }
      const liveVenues = new Set(liveRows.map((a) => a.venue_id));
      const missing = (await affectedVenueIds(tx, orgId)).filter((v) => !liveVenues.has(v)).sort();
      if (!missing.length) continue;
      // a supervisor's resolution holds (ix_alerts_manual_resolved, migration 0007)
      const silentSince = key.startsWith(SERVICE_QUOTA_KEY_PREFIX)
        ? new Date(0)
        : new Date(tx.now.getTime() - WA_MESSAGING_LIMIT_SILENCE_MS);
      const silenced = new Set(
        (
          await tx.rows<{ venue_id: string }>(
            `SELECT DISTINCT venue_id FROM alerts
              WHERE org_id = $1 AND dedupe_key = $2 AND status = 'resolved' AND resolved_by IS NOT NULL
                AND resolved_at > $3 AND venue_id = ANY($4::uuid[])`,
            [orgId, key, silentSince, missing],
          )
        ).map((r) => r.venue_id),
      );
      for (const venueId of missing) {
        if (silenced.has(venueId)) continue;
        const { created } = await raiseAlert(tx, {
          orgId,
          venueId,
          type: 'wa_send_failed',
          dedupeKey: key,
          details: condition.details,
        });
        if (created) raised.push({ venue_id: venueId, dedupe_key: key });
      }
    }
    if (raised.length || resolved.length)
      this.logger.warn(
        {
          raised: raised.map((r) => r.dedupe_key),
          resolved: resolved.map((r) => r.dedupe_key),
          quotas: snapshots.map((s) => ({
            org_id: s.orgId,
            service_messages_month: s.serviceMessagesMonth,
            unique_users_24h_outside_window: s.uniqueUsers24hOutsideWindow,
            messaging_limit_tier: s.limitTier,
          })),
        },
        'whatsapp quota',
      );
    return { raised, resolved };
  }

  // ------------------------------------------------------------------ gauges (05 §12.2)

  /** The gauges of 05 §12.2; `quota: false` leaves the two quota gauges to the quota decision of the same tick. */
  async refreshGauges(opts: { quota?: boolean } = {}): Promise<void> {
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
      oldest_open: Date | null;
      broadcasts: number;
      eligible: number;
    }>(
      `SELECT p.id AS pool,
              (SELECT count(*)::int FROM tasks k WHERE k.dispatch_pool_id = p.id AND k.type = 'retrieve'
                  AND k.status NOT IN ('completed','canceled')) AS open_tasks,
              (SELECT min(k.priority_at) FROM tasks k JOIN retrieval_cycles c ON c.id = k.cycle_id
                WHERE k.dispatch_pool_id = p.id AND k.type = 'retrieve' AND k.status NOT IN ('completed','canceled')
                  AND c.ready_at IS NULL) AS oldest_open,
              (SELECT count(*)::int FROM task_offers o WHERE o.dispatch_pool_id = p.id AND o.status = 'active'
                  AND o.mode = 'broadcast') AS broadcasts,
              (SELECT count(*)::int FROM duty_sessions d WHERE d.dispatch_pool_id = p.id AND d.status = 'on_duty') AS eligible
         FROM dispatch_pools p WHERE p.status = 'active'`,
    );
    metrics.dispatchOpenTasks.reset();
    metrics.dispatchOldestOpenRequest.reset();
    metrics.dispatchBroadcastOpen.reset();
    metrics.dispatchEligibleDrivers.reset();
    for (const p of pools) {
      metrics.dispatchOpenTasks.set({ pool: p.pool }, p.open_tasks);
      // 15 §12 «تجاوز زمن الانتظار الكلي» (now − priority_at of the oldest request not ready yet); 0 without one
      metrics.dispatchOldestOpenRequest.set(
        { pool: p.pool },
        p.oldest_open ? Math.max(0, (now.getTime() - new Date(p.oldest_open).getTime()) / 1000) : 0,
      );
      metrics.dispatchBroadcastOpen.set({ pool: p.pool }, p.broadcasts);
      metrics.dispatchEligibleDrivers.set({ pool: p.pool }, p.eligible);
    }

    const venues = await this.db.rows<{ venue: string; on_duty: number; uncertain: number }>(
      `SELECT venue_id AS venue, count(*)::int AS on_duty,
              count(*) FILTER (WHERE connection_state <> 'online')::int AS uncertain
         FROM duty_sessions WHERE status <> 'ended' GROUP BY venue_id`,
    );
    // 15 §12 «غياب السائقين قبل الطلبات»: a venue with an open event and an open shift but no duty reads 0
    const staffed = await this.db.rows<{ venue: string }>(
      `SELECT DISTINCT e.venue_id AS venue FROM events e
         JOIN shifts s ON s.venue_id = e.venue_id AND s.status = 'open'
        WHERE e.status = 'open'`,
    );
    metrics.driversOnDuty.reset();
    metrics.driversConnectionUncertain.reset();
    for (const v of staffed) {
      metrics.driversOnDuty.set({ venue: v.venue }, 0);
      metrics.driversConnectionUncertain.set({ venue: v.venue }, 0);
    }
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

    // read from the database in every process: the health transition and the last webhook may have happened in
    // another process (the worker never receives a webhook), and a gauge never set reads 0 («healthy», 1970)
    const wa = await this.db.rows<{ health: number | null; last: Date | null }>(
      `SELECT max(CASE c.health_status WHEN 'down' THEN 2 WHEN 'degraded' THEN 1 ELSE 0 END)::int AS health,
              max((SELECT max(e.received_at) FROM whatsapp_inbound_events e WHERE e.org_id = c.org_id)) AS last
         FROM whatsapp_channel c WHERE c.is_active`,
    );
    if (typeof wa[0]?.health === 'number') metrics.waChannelHealth.set(wa[0].health);
    if (wa[0]?.last) metrics.waWebhookLastReceived.set(new Date(wa[0].last).getTime() / 1000);

    metrics.dbPoolInUse.set(Math.max(0, this.db.pool.totalCount - this.db.pool.idleCount));

    if (opts.quota ?? true) await this.waQuotaSnapshot();
  }
}

/** Equal JSON values whatever the key order (jsonb stores its keys in its own order). */
function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}
