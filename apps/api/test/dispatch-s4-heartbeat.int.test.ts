import { connectionStateAt, registerPassGate, type OutboxDispatcher } from '@point/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  accept,
  createS2App,
  expectConsistent,
  keyPickup,
  liveOffer,
  ok,
  one,
  outboxEvents,
  parkedPaperTicket,
  requestRetrieval,
  RMS,
  rows,
  startDuty,
  U,
} from './dispatch-fixtures.js';
import { captureRealtime, dutyId, s4Worker } from './dispatch-s4-fixtures.js';

/** The HTTP heartbeat as the client sends it: not idempotent, no Idempotency-Key (canon §9.1). */
const beat = (t: TestApp, as: string) =>
  t.command('post', '/v1/me/heartbeat', {
    as,
    key: null,
    body: { visible: true, audio_unlocked: true, ws_connected: false },
  });

describe('PNT-062 — job.heartbeat_sweep (connection state only) and the safety-net sweep', () => {
  let t: TestApp;
  let worker: OutboxDispatcher;
  beforeEach(async () => {
    t = await createS2App();
    worker = s4Worker(t);
  });
  afterEach(async () => {
    registerPassGate(null);
    await t.close();
  });

  it('connectionStateAt: online ≤ 45 s, uncertain ≤ 120 s, then offline (canon §12 heartbeat.*)', () => {
    const t0 = new Date('2026-10-27T16:00:00Z');
    const cfg = { uncertain_after_s: 45, offline_after_s: 120 };
    const at = (s: number) => new Date(t0.getTime() + s * 1000);
    expect(connectionStateAt(t0, t0, at(45), cfg)).toBe('online');
    expect(connectionStateAt(t0, t0, at(46), cfg)).toBe('uncertain');
    expect(connectionStateAt(t0, t0, at(120), cfg)).toBe('uncertain');
    expect(connectionStateAt(t0, t0, at(121), cfg)).toBe('offline');
    expect(connectionStateAt(null, t0, at(10), cfg)).toBe('online');
  });

  it('uncertain then offline without touching availability or tasks; offline with custody raises the alert; a heartbeat resolves it', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    ok(await startDuty(t, 'DRV2'), 201);
    const p = await parkedPaperTicket(t, 'DRV2');
    const req = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    ok(await accept(t, 'DRV1', (await liveOffer(t.db, U.DRV1))!.id));
    ok(await keyPickup(t, 'DRV1', req.task.id, p.slotId));
    const session = await dutyId(t, 'DRV1');
    const before = await one(t.db, `SELECT version, available_since FROM duty_sessions WHERE id = $1`, [
      session,
    ]);
    // DRV2 keeps beating; DRV1 goes silent
    const ws = await captureRealtime(t);
    t.clock.advanceSeconds(40);
    ok(await beat(t, 'DRV2'));
    t.clock.advanceSeconds(6); // 46 s without a heartbeat from DRV1
    await worker.drain();
    expect(
      await one(t.db, `SELECT connection_state, version, available_since FROM duty_sessions WHERE id = $1`, [
        session,
      ]),
    ).toEqual({
      connection_state: 'uncertain',
      version: before.version, // descriptive (10 §2.7)
      available_since: before.available_since,
    });
    expect(
      (
        await one(
          t.db,
          `SELECT connection_state FROM duty_sessions WHERE user_id = $1 AND status <> 'ended'`,
          [U.DRV2],
        )
      ).connection_state,
    ).toBe('online');
    t.clock.advanceSeconds(75); // 121 s
    await worker.drain();
    expect(
      (await one(t.db, `SELECT connection_state FROM duty_sessions WHERE id = $1`, [session]))
        .connection_state,
    ).toBe('offline');
    const changes = (await outboxEvents(t.db, 'driver.connection_changed'))
      .map((e) => e.payload.payload)
      .filter((x) => x.user_id === U.DRV1);
    expect(changes.map((c) => [c.from, c.to, c.holds_custody, c.had_active_task])).toEqual([
      ['online', 'uncertain', true, true],
      ['uncertain', 'offline', true, true],
    ]);
    // the offline driver keeps his running task (EC-45, I-13)
    expect(await one(t.db, `SELECT status, assignee_id FROM tasks WHERE id = $1`, [req.task.id])).toEqual({
      status: 'accepted',
      assignee_id: U.DRV1,
    });
    const alert = await one(t.db, `SELECT * FROM alerts WHERE dedupe_key = $1`, [
      `driver_connection_lost_with_custody:${session}`,
    ]);
    expect(alert).toMatchObject({ severity: 'warning', status: 'open', user_id: U.DRV1 });
    expect(alert.details).toMatchObject({
      duty_session_id: session,
      holds_custody: true,
      display_number: p.displayNumber,
    });
    await ws.settle();
    // supervisors see the connection change; it is not sent to the driver's own room
    const seen = ws.of('driver.state_changed').filter((m) => m.message.data.driver.id === U.DRV1);
    expect(seen.map((m) => [m.rooms, m.message.data.connection_state])).toEqual([
      [[`venue:${RMS}:supervisors`], 'uncertain'],
      [[`venue:${RMS}:supervisors`], 'offline'],
    ]);
    // back online: the next sweep resolves the alert
    ok(await beat(t, 'DRV1'));
    t.clock.advanceSeconds(15);
    await worker.drain();
    expect(await one(t.db, `SELECT status, resolved_by FROM alerts WHERE id = $1`, [alert.id])).toEqual({
      status: 'resolved',
      resolved_by: null,
    });
    await expectConsistent(t.db);
    await ws.stop();
  });

  it('the sweep chain is seeded once at duty start and reschedules itself every heartbeat.interval_s', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    ok(await startDuty(t, 'DRV2'), 201);
    const pending = await rows(
      t.db,
      `SELECT available_at FROM outbox_events WHERE dedupe_key = 'heartbeat_sweep' AND status = 'pending'`,
    );
    expect(pending).toHaveLength(1);
    t.clock.advanceSeconds(15);
    await worker.drain();
    const next = await rows(
      t.db,
      `SELECT available_at FROM outbox_events WHERE dedupe_key = 'heartbeat_sweep' AND status = 'pending'`,
    );
    expect(next).toHaveLength(1);
    expect(new Date(next[0]!.available_at).getTime()).toBe(t.clock.now().getTime() + 15_000);
  });

  it('PNT-062 AC1: with the in-transaction pass switched off, the 5 s sweep still dispatches the request', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    const p = await parkedPaperTicket(t, 'DRV1');
    registerPassGate((reason) => reason === 'sweep');
    const req = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    expect(req.task.status).toBe('queued');
    expect(await liveOffer(t.db, U.DRV1)).toBeNull();
    t.clock.advanceSeconds(5);
    await worker.drain();
    expect((await liveOffer(t.db, U.DRV1))?.task_id).toBe(req.task.id);
    await expectConsistent(t.db);
  });
});
