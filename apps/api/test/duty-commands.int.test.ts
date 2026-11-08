import { SEED_IDS } from '@point/db/seed';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  auditCount,
  createDrivers,
  createS2App,
  err,
  expectConsistent,
  LYL,
  newDraft,
  ok,
  one,
  outboxEvents,
  parkedPaperTicket,
  POOL_R,
  requestRetrieval,
  RMS,
  startDuty,
  U,
} from './dispatch-fixtures.js';
import { holdRowLock, waitForLockWaiters } from './dispatch-locks.js';

const brk = (t: TestApp, as: string, active: boolean) =>
  t.command('post', '/v1/me/duty/break', { as, body: { active } });
const end = (t: TestApp, as: string) => t.command('post', '/v1/me/duty/end', { as, body: {} });

describe('PNT-024 — duty start / break / end', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
  });
  afterEach(async () => t.close());

  it('start: 201, on_duty with available_since = now, events, audit, joins the pass', async () => {
    const d = ok(await startDuty(t, 'DRV1'), 201);
    expect(d.duty_session).toMatchObject({
      user_id: U.DRV1,
      venue_id: RMS,
      dispatch_pool_id: POOL_R,
      shift_id: SEED_IDS.shifts['SHF-R'],
      status: 'on_duty',
      available_since: t.clock.now().toISOString(),
      connection_state: 'online',
      end_reason: null,
    });
    expect(d.driver_state).toBe('available');
    expect(d.checks).toEqual({ audio_tested: false, push_enabled: false, pwa_installed: false });
    const started = await outboxEvents(t.db, 'driver.duty_started');
    expect(started.map((e) => e.payload.payload)).toEqual([
      {
        user_id: U.DRV1,
        duty_session_id: d.duty_session.id,
        shift_id: SEED_IDS.shifts['SHF-R'],
        dispatch_pool_id: POOL_R,
      },
    ]);
    const avail = await outboxEvents(t.db, 'driver.availability_changed');
    expect(avail.at(-1)!.payload.payload).toMatchObject({ user_id: U.DRV1, driver_state: 'available' });
    expect(await auditCount(t.db, 'duty.self', d.duty_session.id)).toBe(1);
    const pool = await one(t.db, `SELECT pass_count FROM dispatch_pools WHERE id = $1`, [POOL_R]);
    expect(Number(pool.pass_count)).toBeGreaterThan(0);
    await expectConsistent(t.db);
  });

  it('DUTY_ALREADY_STARTED with a new key; the same key replays the 201', async () => {
    const key = 'duty-start-replay-1';
    const first = await t.command('post', '/v1/me/duty/start', { as: 'DRV1', body: {}, key });
    const d = ok(first, 201);
    const again = await t.command('post', '/v1/me/duty/start', { as: 'DRV1', body: {}, key });
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.data).toEqual(first.body.data);
    expect(err(await startDuty(t, 'DRV1'), 'DUTY_ALREADY_STARTED', 409)).toEqual({
      duty_session_id: d.duty_session.id,
    });
  });

  it('SHIFT_NOT_OPEN when the pool has no open shift', async () => {
    await t.db.query(`UPDATE shifts SET status = 'closed', closed_at = now() WHERE id = $1`, [
      SEED_IDS.shifts['SHF-R'],
    ]);
    expect(err(await startDuty(t, 'DRV1'), 'SHIFT_NOT_OPEN', 409)).toEqual({ venue_id: RMS });
  });

  it('ASSIGNMENT_REQUIRED for a driver without an active assignment', async () => {
    const [id] = await createDrivers(t.db, 1);
    await t.db.query(`UPDATE driver_assignments SET status = 'ended', ends_at = now() WHERE driver_id = $1`, [
      id,
    ]);
    err(await startDuty(t, id!), 'ASSIGNMENT_REQUIRED', 403);
    err(await t.get('/v1/me/home', id!), 'ASSIGNMENT_REQUIRED', 403);
  });

  it('DRIVER_DISABLED: the account is re-checked under the locks (TOCTOU, 09 §8.4)', async () => {
    const lock = await holdRowLock(t, 'dispatch_pools', POOL_R);
    const pending = startDuty(t, 'DRV3');
    await waitForLockWaiters(t, 1);
    await t.db.query(
      `UPDATE users SET status = 'disabled', disabled_at = now(), disabled_reason = 'x' WHERE id = $1`,
      [U.DRV3],
    );
    await lock.release();
    err(await pending, 'DRIVER_DISABLED', 409);
    expect(
      await one(t.db, `SELECT count(*)::int AS n FROM duty_sessions WHERE user_id = $1`, [U.DRV3]),
    ).toEqual({
      n: 0,
    });
  });

  it('a supervisor with can_drive starts duty in his scope only; without can_drive the guard refuses', async () => {
    err(await startDuty(t, 'SUP-RD', { venue_id: LYL }), 'SCOPE_VENUE_DENIED', 403);
    const d = ok(await startDuty(t, 'SUP-RD'), 201);
    expect(d.duty_session).toMatchObject({ venue_id: RMS, status: 'on_duty' });
    const row = await one(t.db, `SELECT assignment_id FROM duty_sessions WHERE id = $1`, [d.duty_session.id]);
    expect(row.assignment_id).toBeNull();
    err(await startDuty(t, 'SUP-R'), 'PERMISSION_DENIED', 403);
    // a driver naming another venue is refused too
    err(await startDuty(t, 'DRV1', { venue_id: LYL }), 'SCOPE_VENUE_DENIED', 403);
  });

  it('VALIDATION_FAILED for unknown fields', async () => {
    err(await startDuty(t, 'DRV1', { venue: RMS }), 'VALIDATION_FAILED', 422);
    err(await brk(t, 'DRV1', 'yes' as unknown as boolean), 'VALIDATION_FAILED', 422);
  });

  it('break: available_since NULL while on break (the constraint holds); ending it sets available_since = now', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    t.clock.advanceSeconds(10);
    const b = ok(await brk(t, 'DRV1', true));
    expect(b).toMatchObject({ status: 'on_break', available_since: null });
    await expectConsistent(t.db);
    err(await brk(t, 'DRV1', true), 'INVALID_STATE_TRANSITION', 409);
    t.clock.advanceSeconds(10);
    const e = ok(await brk(t, 'DRV1', false));
    expect(e).toMatchObject({ status: 'on_duty', available_since: t.clock.now().toISOString() });
    expect(err(await brk(t, 'DRV1', false), 'INVALID_STATE_TRANSITION', 409)).toMatchObject({
      entity_type: 'duty_session',
      current_status: 'on_duty',
      allowed_from: ['on_break'],
    });
    expect((await outboxEvents(t.db, 'driver.break_started')).length).toBe(1);
    expect((await outboxEvents(t.db, 'driver.break_ended')).length).toBe(1);
    await expectConsistent(t.db);
  });

  it('break with an active task → DRIVER_NOT_AVAILABLE; custody without a task → CUSTODY_OPEN', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    const draft = await newDraft(t, 'DRV1');
    expect(err(await brk(t, 'DRV1', true), 'DRIVER_NOT_AVAILABLE', 409)).toEqual({
      active_task_id: draft.taskId,
      next_task_id: null,
    });
    ok(await startDuty(t, 'DRV2'), 201);
    // a key left with DRV2 on a parked ticket (e.g. after an official transfer): custody without a task
    const parked = await parkedPaperTicket(t, 'DRV2');
    await t.db.query(`UPDATE tickets SET key_holder_type = 'driver', key_holder_id = $2 WHERE id = $1`, [
      parked.ticketId,
      U.DRV2,
    ]);
    expect(err(await brk(t, 'DRV2', true), 'CUSTODY_OPEN', 409)).toEqual({
      items: [
        {
          type: 'key',
          ticket_id: parked.ticketId,
          display_number: parked.displayNumber,
          holder_type: 'driver',
        },
      ],
    });
  });

  it('DUTY_REQUIRED: break and end without an open duty', async () => {
    err(await brk(t, 'DRV1', true), 'DUTY_REQUIRED', 409);
    err(await end(t, 'DRV1'), 'DUTY_REQUIRED', 409);
  });

  it('end: DUTY_END_BLOCKED_CUSTODY with a draft; otherwise ended (self) and off_duty', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    const draft = await newDraft(t, 'DRV1');
    const blocked = err(await end(t, 'DRV1'), 'DUTY_END_BLOCKED_CUSTODY', 409);
    expect(blocked.items).toEqual(
      expect.arrayContaining([
        { type: 'vehicle', ticket_id: draft.ticketId, display_number: draft.displayNumber },
        { type: 'key', ticket_id: draft.ticketId, display_number: draft.displayNumber },
        { type: 'draft', ticket_id: draft.ticketId, display_number: draft.displayNumber },
      ]),
    );
    ok(await startDuty(t, 'DRV2'), 201);
    const ended = ok(await end(t, 'DRV2'));
    expect(ended).toMatchObject({ status: 'ended', end_reason: 'self', available_since: null });
    expect(ended.ended_at).toBe(t.clock.now().toISOString());
    const ev = (await outboxEvents(t.db, 'driver.duty_ended')).map((e) => e.payload.payload);
    expect(ev).toEqual([
      { user_id: U.DRV2, duty_session_id: ended.id, end_reason: 'self', ended_by: U.DRV2 },
    ]);
    const last = (await outboxEvents(t.db, 'driver.availability_changed')).at(-1)!.payload.payload;
    expect(last).toMatchObject({ user_id: U.DRV2, driver_state: 'off_duty' });
    expect((ok(await t.get('/v1/me/home', 'DRV2')) as any).driver_state).toBe('off_duty');
    await expectConsistent(t.db);
  });

  it('starting a break revokes the live single offer (recipient_unavailable) and the pass re-offers it', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    const parked = await parkedPaperTicket(t, 'DRV1');
    t.clock.advanceSeconds(5);
    ok(await requestRetrieval(t, 'SUP-R', parked.ticketId), 201);
    const offer = await one(
      t.db,
      `SELECT o.id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id WHERE r.user_id = $1 AND o.status = 'active'`,
      [U.DRV1],
    );
    t.clock.advanceSeconds(1);
    ok(await startDuty(t, 'DRV2'), 201);
    ok(await brk(t, 'DRV1', true));
    const closed = await one(t.db, `SELECT status, close_reason FROM task_offers WHERE id = $1`, [offer.id]);
    expect(closed).toEqual({ status: 'revoked', close_reason: 'recipient_unavailable' });
    // same episode: DRV1 stays in the tried set, DRV2 gets the next single round
    const next = await one(
      t.db,
      `SELECT r.user_id, o.round_no FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id WHERE o.status = 'active'`,
    );
    expect(next).toEqual({ user_id: U.DRV2, round_no: 2 });
    await expectConsistent(t.db);
  });
});
