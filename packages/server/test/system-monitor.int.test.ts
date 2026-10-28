import { SEED_IDS } from '@point/db/seed';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { metrics } from '../src/core/metrics/metrics.js';
import { OutboxDispatcher } from '../src/core/outbox/dispatcher.js';
import { emitEvent, enqueue } from '../src/core/outbox/outbox-writer.js';
import { createAnalyticsProjector } from '../src/modules/audit-monitoring/application/analytics-projector.js';
import { SystemMonitor } from '../src/modules/audit-monitoring/jobs/system-monitor.js';
import {
  LYL,
  ORG,
  POOL_R,
  RMS,
  U,
  insertDuty,
  insertRetrieveTask,
  insertTicket,
  seededDb,
} from './audit-monitoring-fixtures.js';
import { silentLogger, type TestContext } from './helpers.js';

const T0 = '2026-10-27T16:00:00.000Z';

/** PNT-094: SystemMonitor — outbox_lag (14 §8, DEC-46), task_stuck (StuckDetector), gauges (05 §12.2). */
describe('SystemMonitor', () => {
  let t: TestContext;
  let monitor: SystemMonitor;
  let dispatcher: OutboxDispatcher;

  const liveLag = async () =>
    (
      await t.db.query<{
        venue_id: string;
        dedupe_key: string;
        severity: string;
        details: any;
        status: string;
      }>(
        `SELECT venue_id, dedupe_key, severity, details, status FROM alerts
          WHERE type = 'outbox_lag' AND status <> 'resolved' ORDER BY venue_id`,
      )
    ).rows;
  const emitSomething = () =>
    t.db.transaction((tx) =>
      emitEvent(tx, {
        type: 'driver.enabled',
        orgId: ORG,
        aggregate: { type: 'user', id: U.DRV1, version: 1 },
        actor: { type: 'user', id: U.ADM1 },
        payload: { user_id: U.DRV1, enabled_by: U.ADM1 },
      }),
    );

  beforeAll(async () => {
    t = await seededDb();
    monitor = new SystemMonitor(t.db, t.clock, silentLogger, { retentionCron: null });
    dispatcher = new OutboxDispatcher(t.db, t.clock, silentLogger).registerProjector(
      createAnalyticsProjector({ logger: silentLogger }),
    );
  });
  afterAll(async () => t.close());
  beforeEach(async () => {
    t.clock.set(T0);
    await t.db.query(`DELETE FROM alerts`);
    await t.db.query(`DELETE FROM outbox_events`);
    await t.db.query(`DELETE FROM analytics_events`);
    await t.db.query(`UPDATE events SET status = 'open' WHERE id = ANY($1)`, [
      Object.values(SEED_IDS.events),
    ]);
  });

  it('AC: a stopped worker raises outbox_lag within ops.outbox_lag_alert_s + one interval, once per affected venue', async () => {
    await emitSomething(); // due now; no dispatcher runs ("the worker is stopped")
    t.clock.advanceSeconds(30);
    let r = await monitor.tick();
    expect(r.evaluated).toBe(true);
    expect(r.outbox[0]).toMatchObject({ lagging: false, dueCount: 1 });
    expect(await liveLag()).toEqual([]); // 30 s is the threshold itself

    t.clock.advanceSeconds(1); // 31 s > 30 s
    r = await monitor.tick();
    expect(r.outbox[0]).toMatchObject({ lagging: true, thresholdS: 30 });
    const live = await liveLag();
    expect(live.map((a) => a.venue_id)).toEqual([RMS, LYL].sort()); // DEC-46: both venues have open events
    expect(live.every((a) => a.severity === 'critical')).toBe(true);
    expect(live.map((a) => a.dedupe_key).sort()).toEqual([`outbox_lag:${RMS}`, `outbox_lag:${LYL}`].sort());
    expect(live[0]!.details).toMatchObject({
      threshold_s: 30,
      due_count: 1,
      dead_count: 0,
      below_since: null,
    });
    const raised = await t.db.query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE type = 'alert.raised' AND payload->'payload'->>'type' = 'outbox_lag'`,
    );
    expect(raised.rows[0].n).toBe(2);

    // the condition persists: details refreshed, no second alert
    t.clock.advanceSeconds(10);
    await monitor.tick();
    const again = await liveLag();
    expect(again).toHaveLength(2);
    expect(again[0]!.details.oldest_due_age_s).toBeGreaterThanOrEqual(41);
  });

  it('auto-resolves after two minutes below the threshold with no dead row (state kept in the alert)', async () => {
    await emitSomething();
    t.clock.advanceSeconds(45);
    await monitor.tick();
    expect(await liveLag()).toHaveLength(2);

    await dispatcher.drain(); // the worker is back: the backlog (incl. the alert.raised events) is processed
    await monitor.tick();
    const live = await liveLag();
    expect(live).toHaveLength(2);
    expect(live[0]!.details.below_since).toBe(t.clock.now().toISOString());

    // a second process continues the window from the row (no in-memory state)
    const other = new SystemMonitor(t.db, t.clock, silentLogger, { retentionCron: null });
    t.clock.advanceSeconds(119);
    await other.tick();
    expect(await liveLag()).toHaveLength(2);

    t.clock.advanceSeconds(1);
    const r = await other.tick();
    expect(r.outbox[0]!.resolved.sort()).toEqual([RMS, LYL].sort());
    expect(await liveLag()).toEqual([]);
    const resolved = await t.db.query(
      `SELECT status, resolved_by, resolved_at FROM alerts WHERE type = 'outbox_lag' ORDER BY venue_id`,
    );
    expect(resolved.rows.every((a) => a.status === 'resolved' && a.resolved_by === null)).toBe(true);
    expect(new Date(resolved.rows[0].resolved_at).toISOString()).toBe(t.clock.now().toISOString());
  });

  it('lag coming back inside the window restarts it', async () => {
    await emitSomething();
    t.clock.advanceSeconds(40);
    await monitor.tick();
    await dispatcher.drain();
    await monitor.tick(); // below_since = now
    t.clock.advanceSeconds(60);
    await emitSomething();
    t.clock.advanceSeconds(35); // the new row is 35 s old
    await monitor.tick();
    const live = await liveLag();
    expect(live[0]!.details.below_since).toBeNull();
    await dispatcher.drain();
    await monitor.tick();
    t.clock.advanceSeconds(100);
    await monitor.tick();
    expect(await liveLag()).toHaveLength(2); // only 100 s of the new window
    t.clock.advanceSeconds(20);
    await monitor.tick();
    expect(await liveLag()).toEqual([]);
  });

  it('a dead row raises outbox_lag until it is handled; venues without an open event get no row', async () => {
    await t.db.query(`UPDATE events SET status = 'closed', closed_at = $1 WHERE venue_id = $2`, [T0, LYL]);
    const dead = await t.db.transaction((tx) =>
      enqueue(tx, {
        type: 'job.dispatch_pass',
        orgId: ORG,
        venueId: RMS,
        dedupeKey: `dispatch_pass:${POOL_R}`,
      }),
    );
    await t.db.query(
      `UPDATE outbox_events SET status = 'dead', attempts = 8, processed_at = $2 WHERE id = $1`,
      [dead, T0],
    );
    await monitor.tick();
    let live = await liveLag();
    expect(live.map((a) => a.venue_id)).toEqual([RMS]);
    expect(live[0]!.details).toMatchObject({ dead_count: 1 });
    await dispatcher.drain();
    t.clock.advanceSeconds(300);
    await monitor.tick();
    expect(await liveLag()).toHaveLength(1); // still dead: no window starts

    await t.db.query(`UPDATE outbox_events SET status = 'canceled' WHERE id = $1`, [dead]); // handled (retry/cancel)
    await dispatcher.drain();
    await monitor.tick();
    live = await liveLag();
    expect(live[0]!.details.below_since).not.toBeNull();
    t.clock.advanceSeconds(120);
    await monitor.tick();
    expect(await liveLag()).toEqual([]);
  });

  it('one process evaluates per tick (advisory lock); the gauges are refreshed anyway', async () => {
    await emitSomething();
    t.clock.advanceSeconds(90);
    const c = await t.db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('point_system_monitor'))`);
      const r = await monitor.tick();
      expect(r.evaluated).toBe(false);
      expect(await liveLag()).toEqual([]);
      const due = await metrics.outboxDue.get();
      expect(due.values.find((v) => v.labels.type === 'driver.enabled')?.value).toBe(1);
      const age = await metrics.outboxOldestPending.get();
      expect(age.values.find((v) => v.labels.type === 'driver.enabled')?.value).toBe(90);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    expect((await monitor.tick()).evaluated).toBe(true);
  });

  it('gauges: dead rows, open tasks, eligible drivers per pool, drivers on duty and uncertain per venue', async () => {
    const dead = await t.db.transaction((tx) => enqueue(tx, { type: 'job.offer_expire', orgId: ORG }));
    await t.db.query(`UPDATE outbox_events SET status = 'dead' WHERE id = $1`, [dead]);
    const d1 = await insertDuty(t.db, { userId: U.DRV1 });
    const d2 = await insertDuty(t.db, { userId: U.DRV2, status: 'on_break', connection: 'uncertain' });
    try {
      await monitor.refreshGauges();
      const val = async (
        g: { get(): Promise<{ values: { labels: Record<string, unknown>; value: number }[] }> },
        label: string,
        v: string,
      ) => (await g.get()).values.find((x) => x.labels[label] === v)?.value;
      expect(await val(metrics.outboxDead, 'type', 'job.offer_expire')).toBe(1);
      expect(await val(metrics.dispatchEligibleDrivers, 'pool', POOL_R)).toBe(1);
      expect(await val(metrics.driversOnDuty, 'venue', RMS)).toBe(2);
      expect(await val(metrics.driversConnectionUncertain, 'venue', RMS)).toBe(1);
      expect(await val(metrics.dispatchOpenTasks, 'pool', POOL_R)).toBe(0);
    } finally {
      await t.db.query(`DELETE FROM duty_sessions WHERE id = ANY($1)`, [[d1, d2]]);
    }
  });

  it('task_stuck (StuckDetector, 14 §8): raised past the threshold, resolved on progress, raised again per phase', async () => {
    const event = SEED_IDS.events['EVT-R1'];
    const ticket = await insertTicket(t.db, { eventId: event, status: 'assigned', submittedAt: T0 });
    const { taskId, cycleId } = await insertRetrieveTask(t.db, {
      ticketId: ticket,
      eventId: event,
      status: 'accepted',
      assigneeId: U.DRV3,
      acceptedAt: '2026-10-27T15:49:00Z', // 11 minutes before T0 (threshold 10)
    });
    const parkTicket = await insertTicket(t.db, { eventId: event, status: 'parking', submittedAt: T0 });
    const parkTaskId = (
      await t.db.query<{ id: string }>(
        `INSERT INTO tasks (org_id, venue_id, dispatch_pool_id, event_id, ticket_id, type, status, priority_at, assignee_id, started_at, created_at)
         VALUES ($1, $2, $3, $4, $5, 'park', 'in_progress', $6, $7, $6, $6) RETURNING id`,
        [ORG, RMS, POOL_R, event, parkTicket, '2026-10-27T15:39:00Z', U.DRV4], // 21 minutes (threshold 20)
      )
    ).rows[0]!.id;
    const freshTicket = await insertTicket(t.db, { eventId: event, status: 'assigned', submittedAt: T0 });
    const fresh = await insertRetrieveTask(t.db, {
      ticketId: freshTicket,
      eventId: event,
      status: 'accepted',
      assigneeId: U.DRV5,
      acceptedAt: '2026-10-27T15:55:00Z', // 5 minutes: not stuck
    });
    const live = async () =>
      (
        await t.db.query<{
          id: string;
          task_id: string;
          details: any;
          user_id: string;
          venue_id: string;
          severity: string;
        }>(
          `SELECT id, task_id, details, user_id, venue_id, severity FROM alerts
            WHERE type = 'task_stuck' AND status <> 'resolved' ORDER BY task_id`,
        )
      ).rows;

    let r = await monitor.tick();
    expect(r.stuck.raised.sort()).toEqual([taskId, parkTaskId].sort());
    let alerts = await live();
    const first = alerts.find((a) => a.task_id === taskId)!;
    expect(first).toMatchObject({ user_id: U.DRV3, venue_id: RMS, severity: 'warning' });
    expect(first.details).toMatchObject({ phase: 'retrieve_accepted', stuck_min: 11, threshold_min: 10 });
    expect(alerts.find((a) => a.task_id === parkTaskId)!.details).toMatchObject({
      phase: 'park_in_progress',
      stuck_min: 21,
      threshold_min: 20,
    });
    expect(alerts.find((a) => a.task_id === fresh.taskId)).toBeUndefined();
    const gauge = async (type: string) =>
      (await metrics.tasksStuck.get()).values.find((v) => v.labels.type === type)?.value;
    expect(await gauge('retrieve')).toBe(1);
    expect(await gauge('park')).toBe(1);
    await t.db.query(`UPDATE tasks SET status = 'completed', completed_at = $2 WHERE id = $1`, [
      fresh.taskId,
      T0,
    ]);

    // the condition persists: one live alert per task, details refreshed
    t.clock.advanceSeconds(60);
    r = await monitor.tick();
    expect(r.stuck.raised).toEqual([]);
    alerts = await live();
    expect(alerts).toHaveLength(2);
    expect(alerts.find((a) => a.task_id === taskId)!.details.stuck_min).toBe(12);

    // progress: the retrieval starts → resolved automatically (resolved_by NULL)
    const now = t.clock.now();
    await t.db.query(`UPDATE tasks SET status = 'in_progress', started_at = $2 WHERE id = $1`, [taskId, now]);
    await t.db.query(`UPDATE retrieval_cycles SET started_at = $2 WHERE id = $1`, [cycleId, now]);
    r = await monitor.tick();
    expect(r.stuck.resolved).toContain(taskId);
    const resolved = await t.db.query(`SELECT status, resolved_by FROM alerts WHERE id = $1`, [first.id]);
    expect(resolved.rows[0]).toEqual({ status: 'resolved', resolved_by: null });

    // 21 minutes later, still not ready: a new alert in the next phase
    t.clock.advanceSeconds(21 * 60);
    r = await monitor.tick();
    expect(r.stuck.raised).toEqual([taskId]);
    const second = (await live()).find((a) => a.task_id === taskId)!;
    expect(second.id).not.toBe(first.id);
    expect(second.details).toMatchObject({ phase: 'retrieve_in_progress', threshold_min: 20 });

    // readiness and the end of parking resolve both
    await t.db.query(`UPDATE retrieval_cycles SET ready_at = $2 WHERE id = $1`, [cycleId, t.clock.now()]);
    await t.db.query(`UPDATE tasks SET status = 'completed', completed_at = $2 WHERE id = $1`, [
      parkTaskId,
      t.clock.now(),
    ]);
    r = await monitor.tick();
    expect(r.stuck.resolved.sort()).toEqual([taskId, parkTaskId].sort());
    expect(await live()).toEqual([]);
    expect(await gauge('retrieve')).toBeUndefined();
  });

  it('keeps the daily job.retention_purge scheduled (retention:<date>, RETENTION_PURGE_CRON_UTC)', async () => {
    const m = new SystemMonitor(t.db, t.clock, silentLogger, { retentionCron: '0 2 * * *' });
    await m.tick();
    await m.tick();
    const rows = await t.db.query<{ dedupe_key: string; available_at: Date; status: string }>(
      `SELECT dedupe_key, available_at, status FROM outbox_events WHERE type = 'job.retention_purge'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.dedupe_key).toBe('retention:2026-10-28');
    expect(new Date(rows.rows[0]!.available_at).toISOString()).toBe('2026-10-28T02:00:00.000Z');
  });
});
