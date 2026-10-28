import { createLogger, SystemMonitor } from '@point/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  createS2App,
  err,
  handover,
  newDraft,
  ok,
  one,
  outboxEvents,
  RMS,
  rows,
  startDuty,
  U,
} from './dispatch-fixtures.js';
import { ORG, readyRetrieval, realtimeListener, supervisorWorker } from './supervisor-fixtures.js';

/** PNT-075 alert producers of this slice: ready_not_collected (TT-17 timer) and draft_abandoned (SystemMonitor). */
describe('ready_not_collected — job.ready_uncollected_check (TT-17, 10 §12, 14 §8)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV2'), 201);
  });
  afterEach(async () => t.close());

  const alertOf = (cycleId: string) =>
    rows(t.db, `SELECT * FROM alerts WHERE dedupe_key = $1 ORDER BY raised_at`, [
      `ready_not_collected:${cycleId}`,
    ]);

  it('ready schedules the timer at ready_at + ready.uncollected_alert_min; it raises the alert once due, then delivery resolves it', async () => {
    const rt = await realtimeListener(t);
    try {
      const a = await readyRetrieval(t);
      const readyAt = t.clock.now();
      const [job] = await outboxEvents(t.db, 'job.ready_uncollected_check');
      expect(job).toMatchObject({
        dedupe_key: `ready_uncollected:${a.cycleId}`,
        available_at: new Date(readyAt.getTime() + 10 * 60_000),
        payload: { ticket_id: a.ticketId, cycle_id: a.cycleId, ready_at: readyAt.toISOString() },
      });
      const worker = supervisorWorker(t);
      t.clock.advanceSeconds(9 * 60);
      await worker.drain();
      expect(await alertOf(a.cycleId)).toEqual([]);
      t.clock.advanceSeconds(60);
      await worker.drain();
      const [alert] = await alertOf(a.cycleId);
      expect(alert).toMatchObject({
        type: 'ready_not_collected',
        severity: 'warning',
        status: 'open',
        venue_id: RMS,
        ticket_id: a.ticketId,
        task_id: a.retrieveTaskId,
        user_id: U.DRV1,
      });
      expect(alert.details).toMatchObject({ cycle_id: a.cycleId, waited_min: 10, threshold_min: 10 });
      await rt.settle();
      expect(
        rt.notes.filter((n) => n.message.event === 'alert.raised').map((n) => n.message.data.id),
      ).toContain(alert.id);
      expect(
        await one(
          t.db,
          `SELECT count(*)::int AS n FROM audit_log WHERE action = 'job.ready_uncollected_check'`,
        ),
      ).toEqual({ n: 1 });
      // the S-03/S-02 view shows it; the handover resolves it (AlertAutoResolver on ticket.delivered)
      expect(ok(await t.get('/v1/alerts?type=ready_not_collected', 'SUP-R')).map((x: any) => x.id)).toEqual([
        alert.id,
      ]);
      ok(
        await handover(t, 'DRV1', a.ticketId, {
          verification: { method: 'paper_stub', paper_serial: a.serial },
        }),
      );
      await worker.drain();
      expect(
        (await one(t.db, `SELECT status, resolved_by FROM alerts WHERE id = $1`, [alert.id])) as unknown,
      ).toEqual({
        status: 'resolved',
        resolved_by: null,
      });
    } finally {
      await rt.close();
    }
  });

  it('a stale timer is a no-op: the vehicle was collected before the deadline', async () => {
    const a = await readyRetrieval(t);
    t.clock.advanceSeconds(120);
    ok(
      await handover(t, 'DRV1', a.ticketId, {
        verification: { method: 'paper_stub', paper_serial: a.serial },
      }),
    );
    t.clock.advanceSeconds(10 * 60);
    await supervisorWorker(t).drain();
    expect(await alertOf(a.cycleId)).toEqual([]);
    expect(
      await one(t.db, `SELECT status FROM outbox_events WHERE type = 'job.ready_uncollected_check'`),
    ).toEqual({ status: 'done' });
  });

  it('a timer that fires early comes back at the real deadline (threshold raised after scheduling)', async () => {
    const a = await readyRetrieval(t);
    await t.db.query(
      `UPDATE venues SET settings = jsonb_set(settings, '{ready}', '{"uncollected_alert_min": 15}'::jsonb, true) WHERE id = $1`,
      [RMS],
    );
    const worker = supervisorWorker(t);
    t.clock.advanceSeconds(10 * 60);
    await worker.drain();
    expect(await alertOf(a.cycleId)).toEqual([]);
    const jobs = await outboxEvents(t.db, 'job.ready_uncollected_check');
    expect(jobs).toHaveLength(2);
    expect(jobs[1].available_at.getTime() - jobs[0].available_at.getTime()).toBe(5 * 60_000);
    t.clock.advanceSeconds(5 * 60);
    await worker.drain();
    expect(await alertOf(a.cycleId)).toHaveLength(1);
  });
});

describe('draft_abandoned — SystemMonitor (14 §8, intake.draft_abandoned_alert_min)', () => {
  let t: TestApp;
  let monitor: SystemMonitor;
  beforeEach(async () => {
    t = await createS2App();
    monitor = new SystemMonitor(t.db, t.clock, createLogger({ level: 'silent' }), { retentionCron: null });
    ok(await startDuty(t, 'DRV1'), 201);
  });
  afterEach(async () => t.close());

  const live = (ticketId: string) =>
    rows(t.db, `SELECT * FROM alerts WHERE dedupe_key = $1 AND status <> 'resolved'`, [
      `draft_abandoned:${ticketId}`,
    ]);

  it('raises once the draft stayed received for the threshold, once; resolves when the draft leaves received', async () => {
    const d = await newDraft(t, 'DRV1');
    t.clock.advanceSeconds(9 * 60 + 59);
    expect((await monitor.tick()).drafts.raised).toEqual([]);
    t.clock.advanceSeconds(1);
    const r = await monitor.tick();
    expect(r.drafts.raised).toEqual([d.ticketId]);
    const [alert] = await live(d.ticketId);
    expect(alert).toMatchObject({
      org_id: ORG,
      venue_id: RMS,
      type: 'draft_abandoned',
      severity: 'warning',
      ticket_id: d.ticketId,
      task_id: d.taskId,
      user_id: U.DRV1,
    });
    expect(alert.details).toMatchObject({
      cause: 'timer',
      waited_min: 10,
      threshold_min: 10,
      display_number: d.displayNumber,
    });
    t.clock.advanceSeconds(60);
    expect((await monitor.tick()).drafts.raised).toEqual([]); // the live alert is kept, not duplicated
    expect(await live(d.ticketId)).toHaveLength(1);
    // the draft leaves `received` by any path: the monitor resolves the alert (resolved_by NULL)
    await t.db.query(
      `UPDATE tickets SET status = 'parking', submitted_at = now(), version = version + 1 WHERE id = $1`,
      [d.ticketId],
    );
    expect((await monitor.tick()).drafts.resolved).toEqual([d.ticketId]);
    expect(
      (await one(t.db, `SELECT status, resolved_by FROM alerts WHERE id = $1`, [alert.id])) as unknown,
    ).toEqual({
      status: 'resolved',
      resolved_by: null,
    });
    const ev = (await outboxEvents(t.db, 'alert.resolved')).filter(
      (e) => e.payload.aggregate.id === alert.id,
    );
    expect(ev.map((e) => e.payload.payload.auto)).toEqual([true]);
  });

  it('a refused discard keeps its details; the per-venue threshold applies; the void path resolves it inline', async () => {
    await t.db.query(
      `UPDATE venues SET settings = jsonb_set(settings, '{intake}', '{"draft_abandoned_alert_min": 3}'::jsonb, true) WHERE id = $1`,
      [RMS],
    );
    const d = await newDraft(t, 'DRV1');
    ok(
      await t.command('patch', `/v1/tickets/${d.ticketId}/intake`, {
        as: 'DRV1',
        body: { expected_version: d.version, notes: 'خدش' },
      }),
    );
    err(
      await t.command('post', `/v1/tickets/${d.ticketId}/discard-draft`, { as: 'DRV1', body: {} }),
      'DRAFT_HAS_DATA',
      409,
    );
    t.clock.advanceSeconds(3 * 60);
    expect((await monitor.tick()).drafts.raised).toEqual([]); // already live from the refused discard
    const [alert] = await live(d.ticketId);
    expect(alert.details).toMatchObject({ cause: 'discard_refused' });
    ok(
      await t.command('post', `/v1/tickets/${d.ticketId}/void`, {
        as: 'SUP-R',
        body: { reason: 'مسودة متروكة', custody_returned_to_customer: true },
      }),
    );
    expect(await live(d.ticketId)).toEqual([]);
  });
});
