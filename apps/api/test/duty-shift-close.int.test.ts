import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SEED_IDS, type TestApp } from './harness.js';
import {
  createS2App,
  err,
  expectConsistent,
  liveOffer,
  ok,
  one,
  outboxEvents,
  parkedPaperTicket,
  POOL_R,
  requestRetrieval,
  RMS,
  rows,
  startDuty,
  U,
} from './dispatch-fixtures.js';
import { holdRowLock, waitForLockWaiters } from './dispatch-locks.js';

const SHF_R = SEED_IDS.shifts['SHF-R'];

/**
 * PNT-020 × PNT-032: `POST /v1/shifts/{shiftId}/close` with the real DriverReleaseHook of the dispatch module
 * (DEC-32). The close marks the shift `closed`, then releases and ends each open session in ascending id order
 * inside one transaction; the pass run by each release must not hand the work to a colleague of the closing shift.
 */
describe('shift close through the dispatch release hook', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
  });
  afterEach(async () => t.close());

  it('revokes the live single offer, offers nothing to colleagues of the closing shift, and the next shift serves the request', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    t.clock.advanceSeconds(2);
    ok(await startDuty(t, 'DRV2'), 201);
    t.clock.advanceSeconds(2);
    ok(await startDuty(t, 'DRV3'), 201);
    const p = await parkedPaperTicket(t, 'DRV3');
    t.clock.advanceSeconds(5);
    ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);

    // DRV1 is the longest idle: he holds the single round, and his session is released first (UUIDv7 order)
    const offer = (await liveOffer(t.db, U.DRV1))!;
    expect(offer).toBeTruthy();
    const sessions = await rows<{ user_id: string; id: string }>(
      t.db,
      `SELECT user_id, id FROM duty_sessions WHERE shift_id = $1 AND status <> 'ended' ORDER BY id`,
      [SHF_R],
    );
    expect(sessions.map((s) => s.user_id)).toEqual([U.DRV1, U.DRV2, U.DRV3]);
    expect(await outboxEvents(t.db, 'task.offered')).toHaveLength(1);
    await expectConsistent(t.db);

    t.clock.advanceSeconds(3);
    const r = await t.command('post', `/v1/shifts/${SHF_R}/close`, { as: 'SUP-R', body: {} });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: SHF_R, status: 'closed' });

    // the round is revoked and the task waits in the queue: no round was created for DRV2/DRV3 meanwhile
    expect(await one(t.db, `SELECT status, close_reason FROM task_offers WHERE id = $1`, [offer.id])).toEqual(
      {
        status: 'revoked',
        close_reason: 'recipient_unavailable',
      },
    );
    expect(await one(t.db, `SELECT status, assignee_id FROM tasks WHERE id = $1`, [offer.task_id])).toEqual({
      status: 'queued',
      assignee_id: null,
    });
    expect(
      (await one(t.db, `SELECT count(*)::int AS n FROM task_offers WHERE task_id = $1`, [offer.task_id])).n,
    ).toBe(1);
    expect(await outboxEvents(t.db, 'task.offered')).toHaveLength(1);
    const revoked = await outboxEvents(t.db, 'offer.revoked');
    expect(revoked.map((e) => e.payload.payload)).toEqual([
      expect.objectContaining({
        offer_id: offer.id,
        close_reason: 'recipient_unavailable',
        recipient_ids: [U.DRV1],
      }),
    ]);
    expect(await liveOffer(t.db, U.DRV2)).toBeNull();
    expect(await liveOffer(t.db, U.DRV3)).toBeNull();

    // venues-events ended every session after its release; the hook left them to it
    expect(
      await rows(
        t.db,
        `SELECT user_id, status, end_reason FROM duty_sessions WHERE shift_id = $1 ORDER BY id`,
        [SHF_R],
      ),
    ).toEqual(
      [U.DRV1, U.DRV2, U.DRV3].map((id) => ({ user_id: id, status: 'ended', end_reason: 'shift_closed' })),
    );
    // the request still waits and nobody can serve the pool: critical alert (10 §4.6)
    expect(
      await one(t.db, `SELECT type, severity, status FROM alerts WHERE dedupe_key = $1`, [
        `no_drivers_on_duty:${POOL_R}`,
      ]),
    ).toEqual({ type: 'no_drivers_on_duty', severity: 'critical', status: 'open' });
    expect(await one(t.db, `SELECT status FROM tickets WHERE id = $1`, [p.ticketId])).toEqual({
      status: 'requested',
    });
    await expectConsistent(t.db);

    // the next shift opens; the first driver on duty gets the request (DRV1 stays in this episode's tried set)
    t.clock.advanceSeconds(60);
    const next = ok(
      await t.command('post', `/v1/venues/${RMS}/shifts`, {
        as: 'SUP-R',
        body: { name: 'الوردية التالية', starts_at: t.clock.now().toISOString() },
      }),
      201,
    );
    ok(await t.command('post', `/v1/shifts/${next.id}/open`, { as: 'SUP-R', body: {} }));
    ok(await startDuty(t, 'DRV2'), 201);
    const again = (await liveOffer(t.db, U.DRV2))!;
    expect(again.task_id).toBe(offer.task_id);
    expect(await one(t.db, `SELECT round_no FROM task_offers WHERE id = $1`, [again.id])).toEqual({
      round_no: 2,
    });
    expect(
      await one(t.db, `SELECT status FROM alerts WHERE dedupe_key = $1`, [`no_drivers_on_duty:${POOL_R}`]),
    ).toEqual({ status: 'resolved' });
    await expectConsistent(t.db);
  });

  it('a duty start queued behind a shift close on the pool lock (L1) finds no open shift: SHIFT_NOT_OPEN', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    const held = await holdRowLock(t, 'dispatch_pools', POOL_R);
    const close = t.command('post', `/v1/shifts/${SHF_R}/close`, { as: 'SUP-R', body: {} });
    await waitForLockWaiters(t, 1);
    const start = startDuty(t, 'DRV2');
    await waitForLockWaiters(t, 2);
    await held.release();
    expect((await close).status).toBe(200);
    expect(err(await start, 'SHIFT_NOT_OPEN', 409)).toEqual({ venue_id: RMS });
    expect(
      await rows(t.db, `SELECT user_id, status FROM duty_sessions WHERE shift_id = $1`, [SHF_R]),
    ).toEqual([{ user_id: U.DRV1, status: 'ended' }]);
    await expectConsistent(t.db);
  });
});
