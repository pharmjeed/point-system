import { SEED_IDS } from '@point/db/seed';
import { createLogger, dispatchJobs, metrics, OutboxDispatcher, requestDispatchPass } from '@point/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  accept,
  createS2App,
  err,
  expectConsistent,
  liveOffer,
  newDraft,
  ok,
  one,
  openBroadcastBySql,
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

const DUMMY = '00000000-0000-4000-8000-0000deadbeef';
const brk = (t: TestApp, as: string, active: boolean) =>
  t.command('post', '/v1/me/duty/break', { as, body: { active } });

/** DRV3 longest idle, then DRV2, then DRV1 (who parks the tickets and becomes available last). */
async function threeDrivers(t: TestApp) {
  ok(await startDuty(t, 'DRV3'), 201);
  t.clock.advanceSeconds(10);
  ok(await startDuty(t, 'DRV2'), 201);
  t.clock.advanceSeconds(10);
  ok(await startDuty(t, 'DRV1'), 201);
}

/** A parked ticket (by DRV1) whose retrieval was requested by SUP-R; returns the retrieve task. */
async function requested(t: TestApp) {
  const p = await parkedPaperTicket(t, 'DRV1');
  t.clock.advanceSeconds(1);
  const r = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
  return {
    ...p,
    retrieveTaskId: r.task.id as string,
    cycleId: r.cycle.id as string,
    status: r.task.status as string,
  };
}

/**
 * Turns the task's live single round into a broadcast to every on-duty driver of the pool (S4 does it in the
 * pass, 10 §4.4) in a new episode, so nobody is in the tried set.
 */
async function asBroadcast(t: TestApp, taskId: string): Promise<string> {
  await t.db.query(
    `UPDATE task_offers SET status = 'revoked', closed_at = now(), close_reason = 'converted_to_broadcast', version = version + 1
      WHERE task_id = $1 AND status = 'active'`,
    [taskId],
  );
  await t.db.query(
    `UPDATE tasks SET status = 'queued', queued_at = $2, version = version + 1 WHERE id = $1`,
    [taskId, new Date(t.clock.now().getTime() + 1)],
  );
  return openBroadcastBySql(t.db, taskId);
}

describe('PNT-032 — dispatch pass v1', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
  });
  afterEach(async () => t.close());

  it('oldest request → longest idle driver; expiry and reminder from the venue settings; job.offer_expire at expires_at + grace', async () => {
    await t.db.query(`UPDATE venues SET settings = $2 WHERE id = $1`, [
      RMS,
      JSON.stringify({
        dispatch: { single_offer_ttl_s: 45, single_offer_reminder_s: 20, accept_grace_ms: 2000 },
      }),
    ]);
    await threeDrivers(t);
    const a = await parkedPaperTicket(t, 'DRV1');
    const b = await parkedPaperTicket(t, 'DRV1');
    t.clock.advanceSeconds(1);
    const ra = ok(await requestRetrieval(t, 'SUP-R', a.ticketId), 201);
    t.clock.advanceSeconds(1);
    const rb = ok(await requestRetrieval(t, 'SUP-R', b.ticketId), 201);
    const oa = await one(
      t.db,
      `SELECT o.*, r.user_id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id WHERE o.task_id = $1`,
      [ra.task.id],
    );
    const ob = await one(
      t.db,
      `SELECT o.*, r.user_id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id WHERE o.task_id = $1`,
      [rb.task.id],
    );
    expect(oa.user_id).toBe(U.DRV3); // longest idle
    expect(ob.user_id).toBe(U.DRV2); // next longest idle (DRV3 holds a live single offer)
    expect(oa).toMatchObject({ mode: 'single', round_no: 1, status: 'active' });
    expect(new Date(oa.expires_at).getTime() - new Date(oa.created_at).getTime()).toBe(45_000);
    expect(new Date(oa.reminder_at).getTime() - new Date(oa.created_at).getTime()).toBe(20_000);
    const timer = await one(
      t.db,
      `SELECT available_at, aggregate_type, aggregate_id, aggregate_version, payload FROM outbox_events WHERE dedupe_key = $1`,
      [`offer_expire:${oa.id}`],
    );
    expect(timer).toMatchObject({ aggregate_type: 'task_offer', aggregate_id: oa.id, aggregate_version: 1 });
    expect(new Date(timer.available_at).getTime()).toBe(new Date(oa.expires_at).getTime() + 2000);
    const offered = (await outboxEvents(t.db, 'task.offered')).map((e) => e.payload.payload);
    expect(offered).toEqual([
      expect.objectContaining({ task_id: ra.task.id, recipient_id: U.DRV3, round_no: 1 }),
      expect.objectContaining({ task_id: rb.task.id, recipient_id: U.DRV2, round_no: 1 }),
    ]);
    // the safety-net sweep is seeded once
    expect(
      (
        await rows(
          t.db,
          `SELECT id FROM outbox_events WHERE dedupe_key = 'dispatch_sweep' AND status = 'pending'`,
        )
      ).length,
    ).toBe(1);
    await expectConsistent(t.db);
  });

  it('a newer request waits while the only idle driver holds a live single offer (R-2); the pass never crosses pools', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    ok(await startDuty(t, 'DRV7'), 201); // LYL pool
    const a = await parkedPaperTicket(t, 'DRV1');
    const b = await parkedPaperTicket(t, 'DRV1');
    ok(await requestRetrieval(t, 'SUP-R', a.ticketId), 201);
    const rb = ok(await requestRetrieval(t, 'SUP-R', b.ticketId), 201);
    expect(rb.task.status).toBe('queued');
    expect(await liveOffer(t.db, U.DRV7)).toBeNull();
    await expectConsistent(t.db);
  });
});

describe('PNT-032 — POST /v1/task-offers/{offerId}/accept', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    await threeDrivers(t);
  });
  afterEach(async () => t.close());

  it('accepted: task, round, recipient, cycle, ticket and duty in one transaction; task.claimed once; audit', async () => {
    const r = await requested(t);
    const offer = (await liveOffer(t.db, U.DRV3))!;
    t.clock.advanceSeconds(3);
    const res = ok(await accept(t, 'DRV3', offer.id));
    expect(res).toMatchObject({ result: 'accepted', driver_state: 'retrieving' });
    expect(res.task).toMatchObject({ id: r.retrieveTaskId, status: 'accepted', assignee: { id: U.DRV3 } });
    expect(res.ticket).toMatchObject({ status: 'assigned' });
    expect(
      await one(t.db, `SELECT status, close_reason, accepted_by FROM task_offers WHERE id = $1`, [offer.id]),
    ).toEqual({
      status: 'accepted',
      close_reason: 'accepted',
      accepted_by: U.DRV3,
    });
    expect(await one(t.db, `SELECT response FROM offer_recipients WHERE offer_id = $1`, [offer.id])).toEqual({
      response: 'accepted',
    });
    expect(
      await one(t.db, `SELECT accepted_by, assigned_at FROM retrieval_cycles WHERE id = $1`, [r.cycleId]),
    ).toEqual({
      accepted_by: U.DRV3,
      assigned_at: t.clock.now(),
    });
    expect(
      await one(t.db, `SELECT available_since FROM duty_sessions WHERE user_id = $1 AND status = 'on_duty'`, [
        U.DRV3,
      ]),
    ).toEqual({
      available_since: null,
    });
    const claimed = (await outboxEvents(t.db, 'task.claimed')).map((e) => e.payload.payload);
    expect(claimed).toEqual([
      expect.objectContaining({
        task_id: r.retrieveTaskId,
        offer_id: offer.id,
        mode: 'single',
        claimed_by: U.DRV3,
        result: 'accepted',
      }),
    ]);
    const audit = await one(t.db, `SELECT metadata FROM audit_log WHERE action = 'offer.accept'`);
    expect(audit.metadata).toMatchObject({
      result: 'accepted',
      oldest_actionable_task_id: r.retrieveTaskId,
      offer_id: offer.id,
    });
    await expectConsistent(t.db);
  });

  it('OFFER_NOT_FOUND for an unknown offer or one outside the caller’s venue; NOT_OFFER_RECIPIENT in the same pool', async () => {
    await requested(t);
    const offer = (await liveOffer(t.db, U.DRV3))!;
    err(await accept(t, 'DRV3', DUMMY), 'OFFER_NOT_FOUND', 404);
    err(await accept(t, 'DRV3', 'not-a-uuid'), 'OFFER_NOT_FOUND', 404);
    ok(await startDuty(t, 'DRV7'), 201);
    err(await accept(t, 'DRV7', offer.id), 'OFFER_NOT_FOUND', 404);
    err(await accept(t, 'DRV2', offer.id), 'NOT_OFFER_RECIPIENT', 403);
  });

  it('TASK_ALREADY_CLAIMED for the loser of a broadcast, whose recipient row becomes rejected_late', async () => {
    const r = await requested(t);
    const offerId = await asBroadcast(t, r.retrieveTaskId);
    ok(await accept(t, 'DRV2', offerId));
    expect(err(await accept(t, 'DRV3', offerId), 'TASK_ALREADY_CLAIMED', 409)).toEqual({
      task_id: r.retrieveTaskId,
    });
    expect(
      await one(t.db, `SELECT response FROM offer_recipients WHERE offer_id = $1 AND user_id = $2`, [
        offerId,
        U.DRV3,
      ]),
    ).toEqual({
      response: 'rejected_late',
    });
    // the winner's other device gets 200 with the current result, not an error (10 §5.6)
    expect(ok(await accept(t, 'DRV2', offerId)).result).toBe('accepted');
    await expectConsistent(t.db);
  });

  it('OFFER_REVOKED for a round closed by a break; OFFER_EXPIRED after expires_at + grace (EC-05/EC-06)', async () => {
    const revoked = async () =>
      (await metrics.dispatchOffers.get()).values.find(
        (v) => v.labels.mode === 'single' && v.labels.outcome === 'revoked',
      )?.value ?? 0;
    const r = await requested(t);
    const first = (await liveOffer(t.db, U.DRV3))!;
    const before = await revoked();
    ok(await brk(t, 'DRV3', true));
    expect(await revoked()).toBe(before + 1); // point_dispatch_offers_total{mode,outcome} (05 §12.2)
    ok(await brk(t, 'DRV3', false));
    expect(err(await accept(t, 'DRV3', first.id), 'OFFER_REVOKED', 410)).toEqual({
      offer_id: first.id,
      close_reason: 'recipient_unavailable',
    });
    // the task was re-offered to DRV2 (DRV3 tried in this episode)
    const second = (await liveOffer(t.db, U.DRV2))!;
    expect(second.task_id).toBe(r.retrieveTaskId);
    t.clock.advanceSeconds(32); // ttl 30 s + grace 1.5 s
    expect(err(await accept(t, 'DRV2', second.id), 'OFFER_EXPIRED', 410)).toEqual({ offer_id: second.id });
  });

  it('within the grace after expires_at the accept still wins (DEC-47)', async () => {
    await requested(t);
    const offer = (await liveOffer(t.db, U.DRV3))!;
    t.clock.advanceSeconds(31);
    expect(ok(await accept(t, 'DRV3', offer.id)).result).toBe('accepted');
  });

  it('DUTY_REQUIRED and DRIVER_ON_BREAK for broadcast recipients who left; ASSIGNMENT_REQUIRED re-checked under the locks', async () => {
    const r = await requested(t);
    const offerId = await asBroadcast(t, r.retrieveTaskId);
    ok(await brk(t, 'DRV2', true));
    err(await accept(t, 'DRV2', offerId), 'DRIVER_ON_BREAK', 409);
    ok(await t.command('post', '/v1/me/duty/end', { as: 'DRV1', body: {} }));
    err(await accept(t, 'DRV1', offerId), 'DUTY_REQUIRED', 409);
    // TOCTOU: the assignment ends while the accept waits for the pool lock
    const lock = await holdRowLock(t, 'dispatch_pools', POOL_R);
    const pending = accept(t, 'DRV3', offerId);
    await waitForLockWaiters(t, 1);
    await t.db.query(`UPDATE driver_assignments SET status = 'ended', ends_at = now() WHERE driver_id = $1`, [
      U.DRV3,
    ]);
    await lock.release();
    err(await pending, 'ASSIGNMENT_REQUIRED', 403);
  });

  it('NEXT_TASK_ALREADY_RESERVED when busy with a next task; assigned_waiting for a busy driver on a broadcast', async () => {
    const a = await requested(t);
    const b = await requested(t);
    // DRV1 is busy with a draft and reserves A as his next task from a broadcast
    await newDraft(t, 'DRV1');
    const ba = await asBroadcast(t, a.retrieveTaskId);
    const res = ok(await accept(t, 'DRV1', ba));
    expect(res).toMatchObject({ result: 'assigned_waiting', driver_state: 'busy_with_next' });
    expect(res.ticket.status).toBe('assigned_waiting');
    const bb = await asBroadcast(t, b.retrieveTaskId);
    expect(err(await accept(t, 'DRV1', bb), 'NEXT_TASK_ALREADY_RESERVED', 409)).toEqual({
      next_task_id: a.retrieveTaskId,
    });
    await expectConsistent(t.db);
  });

  it('OLDER_REQUEST_PENDING: an older live round of the same driver blocks a newer one (priority guard)', async () => {
    const a = await requested(t);
    const b = await requested(t);
    const oa = await asBroadcast(t, a.retrieveTaskId);
    const ob = await asBroadcast(t, b.retrieveTaskId);
    expect(err(await accept(t, 'DRV2', ob), 'OLDER_REQUEST_PENDING', 409)).toEqual({
      older_task_id: a.retrieveTaskId,
      older_offer_id: oa,
    });
    ok(await accept(t, 'DRV2', oa));
    // the pass after the accept turned B into a single round for the longest idle driver (10 §4.5)
    expect(err(await accept(t, 'DRV3', ob), 'OFFER_REVOKED', 410).close_reason).toBe('converted_to_single');
    const single = (await liveOffer(t.db, U.DRV3))!;
    expect(single.task_id).toBe(b.retrieveTaskId);
    expect(ok(await accept(t, 'DRV3', single.id)).result).toBe('accepted');
    await expectConsistent(t.db);
  });

  it('DRIVER_NOT_AVAILABLE for a single round accepted by a driver who became busy', async () => {
    const r = await requested(t);
    await newDraft(t, 'DRV1');
    // a single round addressed to DRV1 while he is busy (only reachable by a bug: kept as a backstop)
    await t.db.query(
      `UPDATE task_offers SET status = 'revoked', closed_at = now(), close_reason = 'reassigned' WHERE task_id = $1 AND status = 'active'`,
      [r.retrieveTaskId],
    );
    const o = await one(
      t.db,
      `INSERT INTO task_offers (org_id, task_id, dispatch_pool_id, mode, round_no, status, created_at, expires_at)
       SELECT org_id, id, dispatch_pool_id, 'single', 9, 'active', $2, $2::timestamptz + interval '30 seconds' FROM tasks WHERE id = $1 RETURNING id`,
      [r.retrieveTaskId, t.clock.now()],
    );
    await t.db.query(
      `INSERT INTO offer_recipients (offer_id, user_id, duty_session_id, eligible_as)
       SELECT $1, user_id, id, 'accept' FROM duty_sessions WHERE user_id = $2 AND status <> 'ended'`,
      [o.id, U.DRV1],
    );
    const d = err(await accept(t, 'DRV1', o.id), 'DRIVER_NOT_AVAILABLE', 409);
    expect(d.next_task_id).toBeNull();
    expect(d.active_task_id).toBeTruthy();
  });
});

describe('PNT-032 — races (separate connections, AC-04)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
  });
  afterEach(async () => t.close());

  it('twenty parallel accepts of one offer from the same driver’s devices: one assignment, all 200', async () => {
    await threeDrivers(t);
    const r = await requested(t);
    const offer = (await liveOffer(t.db, U.DRV3))!;
    const results = await Promise.all(Array.from({ length: 20 }, () => accept(t, 'DRV3', offer.id)));
    expect(results.map((x) => x.status)).toEqual(results.map(() => 200));
    expect(new Set(results.map((x) => x.body.data.result))).toEqual(new Set(['accepted']));
    expect((await outboxEvents(t.db, 'task.claimed')).length).toBe(1);
    expect(
      await one(t.db, `SELECT status, assignee_id, version FROM tasks WHERE id = $1`, [r.retrieveTaskId]),
    ).toMatchObject({
      status: 'accepted',
      assignee_id: U.DRV3,
    });
    await expectConsistent(t.db);
  });

  it('parallel accepts of one broadcast by different drivers: exactly one winner, the others TASK_ALREADY_CLAIMED', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    for (const d of ['DRV2', 'DRV3', 'DRV4', 'DRV5', 'DRV6']) ok(await startDuty(t, d), 201);
    const r = await requested(t);
    const offerId = await asBroadcast(t, r.retrieveTaskId);
    const drivers = ['DRV1', 'DRV2', 'DRV3', 'DRV4', 'DRV5', 'DRV6'];
    const results = await Promise.all(drivers.map((d) => accept(t, d, offerId)));
    const winners = results.map((x, i) => [x, drivers[i]] as const).filter(([x]) => x.status === 200);
    expect(winners).toHaveLength(1);
    expect(results.filter((x) => x.status === 409).map((x) => x.body.error.code)).toEqual(
      Array(5).fill('TASK_ALREADY_CLAIMED'),
    );
    const winner = (U as Record<string, string>)[winners[0]![1]!];
    expect(await one(t.db, `SELECT accepted_by FROM task_offers WHERE id = $1`, [offerId])).toEqual({
      accepted_by: winner,
    });
    expect((await outboxEvents(t.db, 'task.claimed')).length).toBe(1);
    expect(
      (
        await rows(
          t.db,
          `SELECT 1 FROM offer_recipients WHERE offer_id = $1 AND response = 'rejected_late'`,
          [offerId],
        )
      ).length,
    ).toBe(5);
    await expectConsistent(t.db);
  });

  it('two drivers accept their own single offers in parallel: both win, nothing crosses', async () => {
    await threeDrivers(t);
    const a = await requested(t);
    const b = await requested(t);
    const oa = (await liveOffer(t.db, U.DRV3))!;
    const ob = (await liveOffer(t.db, U.DRV2))!;
    expect([oa.task_id, ob.task_id].sort()).toEqual([a.retrieveTaskId, b.retrieveTaskId].sort());
    const [x, y] = await Promise.all([accept(t, 'DRV3', oa.id), accept(t, 'DRV2', ob.id)]);
    expect([x.status, y.status]).toEqual([200, 200]);
    await expectConsistent(t.db);
  });
});

describe('PNT-032 — worker timers (job.offer_expire, job.dispatch_pass, job.dispatch_sweep)', () => {
  let t: TestApp;
  let worker: OutboxDispatcher;
  beforeEach(async () => {
    t = await createS2App();
    worker = new OutboxDispatcher(t.db, t.clock, createLogger({ level: 'silent' }), {
      workerId: 'test-worker',
    });
    for (const h of dispatchJobs()) worker.register(h);
  });
  afterEach(async () => t.close());
  /** point_dispatch_offers_total{mode="single",outcome="expired"} (05 §12.2) */
  const expiredCount = async () =>
    (await metrics.dispatchOffers.get()).values.find(
      (v) => v.labels.mode === 'single' && v.labels.outcome === 'expired',
    )?.value ?? 0;

  it('expiry: the round expires after expires_at + grace, the silent driver rotates, the next idle driver gets the task', async () => {
    await threeDrivers(t);
    const r = await requested(t);
    const expiredBefore = await expiredCount();
    const first = (await liveOffer(t.db, U.DRV3))!;
    await worker.drain(); // nothing due yet (the timer is at +31.5 s)
    expect((await one(t.db, `SELECT status FROM task_offers WHERE id = $1`, [first.id])).status).toBe(
      'active',
    );
    // the timer does the work here (the 5 s sweep would otherwise expire it defensively first)
    await t.db.query(`DELETE FROM outbox_events WHERE type = 'job.dispatch_sweep'`);
    t.clock.advanceSeconds(32);
    await worker.drain();
    expect(await one(t.db, `SELECT status, close_reason FROM task_offers WHERE id = $1`, [first.id])).toEqual(
      {
        status: 'expired',
        close_reason: 'expired',
      },
    );
    // DEC-26: DRV3 is moved to the back of the idle order; the task went to DRV2 (DRV3 is tried)
    expect(
      await one(t.db, `SELECT available_since FROM duty_sessions WHERE user_id = $1 AND status = 'on_duty'`, [
        U.DRV3,
      ]),
    ).toEqual({
      available_since: t.clock.now(),
    });
    const second = (await liveOffer(t.db, U.DRV2))!;
    expect(second.task_id).toBe(r.retrieveTaskId);
    expect((await outboxEvents(t.db, 'offer.expired')).map((e) => e.payload.payload)).toEqual([
      { offer_id: first.id, task_id: r.retrieveTaskId, recipient_id: U.DRV3 },
    ]);
    expect((await rows(t.db, `SELECT 1 FROM audit_log WHERE action = 'job.offer_expire'`)).length).toBe(1);
    expect(await expiredCount()).toBe(expiredBefore + 1);
    await expectConsistent(t.db);
  });

  it('a stale timer is a no-op after the accept; an early timer reschedules itself', async () => {
    /** point_timer_stale_total{job} (05 §12.2; 11 §8.11 «مهام قديمة») */
    const staleCount = async (job: string) =>
      (await metrics.timerStale.get()).values.find((v) => v.labels.job === job)?.value ?? 0;
    await threeDrivers(t);
    await requested(t);
    const offer = (await liveOffer(t.db, U.DRV3))!;
    const staleBefore = await staleCount('job.offer_expire');
    ok(await accept(t, 'DRV3', offer.id));
    t.clock.advanceSeconds(32);
    await worker.drain();
    expect((await one(t.db, `SELECT status FROM task_offers WHERE id = $1`, [offer.id])).status).toBe(
      'accepted',
    );
    expect((await outboxEvents(t.db, 'offer.expired')).length).toBe(0);
    // the timer ended done with no effect and is counted as stale (one row: the accepted round's expiry)
    expect(
      await one(t.db, `SELECT status FROM outbox_events WHERE dedupe_key = $1`, [`offer_expire:${offer.id}`]),
    ).toEqual({ status: 'done' });
    expect(await staleCount('job.offer_expire')).toBe(staleBefore + 1);

    const r2 = await requested(t);
    const o2 = (await liveOffer(t.db, U.DRV2))!;
    expect(o2.task_id).toBe(r2.retrieveTaskId);
    // the timer fires at expires_at (before the grace) because another process's clock is ahead
    await t.db.query(
      `UPDATE outbox_events SET available_at = available_at - interval '1 second' WHERE dedupe_key = $1`,
      [`offer_expire:${o2.id}`],
    );
    t.clock.advanceSeconds(30.6);
    await worker.drain();
    expect((await one(t.db, `SELECT status FROM task_offers WHERE id = $1`, [o2.id])).status).toBe('active');
    const again = await one(
      t.db,
      `SELECT status, available_at FROM outbox_events WHERE dedupe_key = $1 AND status = 'pending'`,
      [`offer_expire:${o2.id}`],
    );
    expect(again.status).toBe('pending');
    t.clock.advanceSeconds(1);
    await worker.drain();
    expect((await one(t.db, `SELECT status FROM task_offers WHERE id = $1`, [o2.id])).status).toBe('expired');
    // neither the early timer (rescheduled) nor the one that expired the round is stale
    expect(await staleCount('job.offer_expire')).toBe(staleBefore + 1);
    await expectConsistent(t.db);
  });

  it('the pass expires overdue rounds defensively when the worker lags (EC-36)', async () => {
    await threeDrivers(t);
    await requested(t);
    const first = (await liveOffer(t.db, U.DRV3))!;
    const expiredBefore = await expiredCount();
    t.clock.advanceSeconds(40);
    ok(await startDuty(t, 'DRV4'), 201); // any pass of the pool
    expect((await one(t.db, `SELECT status FROM task_offers WHERE id = $1`, [first.id])).status).toBe(
      'expired',
    );
    // counted by the pass that closed it; the late job.offer_expire finds it closed and counts nothing
    expect(await expiredCount()).toBe(expiredBefore + 1);
    await worker.drain();
    expect(await expiredCount()).toBe(expiredBefore + 1);
    await expectConsistent(t.db);
  });

  it('job.dispatch_pass runs a pass for a pool; job.dispatch_sweep re-pairs and always schedules its successor', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    const p = await parkedPaperTicket(t, 'DRV1');
    ok(await t.command('post', '/v1/me/duty/end', { as: 'DRV1', body: {} }));
    const r = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    expect(r.task.status).toBe('queued');
    // a driver appears without a pass (e.g. a duty row written by another process) — only the timers can pair
    ok(await startDuty(t, 'DRV2'), 201);
    await t.db.query(
      `UPDATE task_offers SET status = 'revoked', closed_at = now(), close_reason = 'reassigned' WHERE task_id = $1 AND status = 'active'`,
      [r.task.id],
    );
    await t.db.query(`UPDATE tasks SET status = 'queued', queued_at = $2 WHERE id = $1`, [
      r.task.id,
      new Date(t.clock.now().getTime() + 1),
    ]);
    await t.db.transaction((tx) =>
      requestDispatchPass(tx, { id: POOL_R, org_id: SEED_IDS.org, venue_id: RMS }, 'requeued'),
    );
    // 11 §8.11: payload {dispatch_pool_id, reason}, dedupe dispatch_pass:<pool_id>
    expect(
      await one(
        t.db,
        `SELECT payload, dedupe_key FROM outbox_events WHERE type = 'job.dispatch_pass' AND status = 'pending'`,
      ),
    ).toEqual({
      payload: { dispatch_pool_id: POOL_R, reason: 'requeued' },
      dedupe_key: `dispatch_pass:${POOL_R}`,
    });
    await worker.drain();
    expect((await liveOffer(t.db, U.DRV2))?.task_id).toBe(r.task.id);
    // the sweep: pending, done after its interval, followed by a new pending one
    const before = await rows(
      t.db,
      `SELECT id FROM outbox_events WHERE dedupe_key = 'dispatch_sweep' AND status = 'pending'`,
    );
    expect(before.length).toBe(1);
    t.clock.advanceSeconds(6);
    await worker.drain();
    const after = await rows(
      t.db,
      `SELECT id, status FROM outbox_events WHERE dedupe_key = 'dispatch_sweep' ORDER BY seq`,
    );
    expect(after.filter((x) => x.status === 'done').length).toBeGreaterThanOrEqual(1);
    expect(after.filter((x) => x.status === 'pending').length).toBe(1);
    await expectConsistent(t.db);
  });

  it('11 §3.3 claimed_elsewhere: the sweep closes a live round whose task can no longer be offered (offer.revoked)', async () => {
    await threeDrivers(t);
    const r = await requested(t);
    const offer = (await liveOffer(t.db, U.DRV3))!;
    expect(offer.task_id).toBe(r.retrieveTaskId);
    // an inconsistent state no command leaves: the task closed while its round stayed active
    await t.db.query(
      `UPDATE tasks SET status = 'canceled', canceled_at = $2, cancel_reason = 'supervisor_cancel' WHERE id = $1`,
      [r.retrieveTaskId, t.clock.now()],
    );
    const revoked = async () =>
      (await metrics.dispatchOffers.get()).values.find(
        (v) => v.labels.mode === 'single' && v.labels.outcome === 'revoked',
      )?.value ?? 0;
    const before = await revoked();
    // a worker whose log lines are kept (05 §7.6 / 10 §12.3 fields of the sweep's pass)
    const lines: Record<string, unknown>[] = [];
    const logged = new OutboxDispatcher(
      t.db,
      t.clock,
      createLogger({ level: 'info', destination: { write: (l: string) => void lines.push(JSON.parse(l)) } }),
      { workerId: 'test-worker-logged' },
    );
    for (const h of dispatchJobs()) logged.register(h);
    t.clock.advanceSeconds(6); // the next job.dispatch_sweep (its offer_expire timer is not due yet)
    await logged.drain();
    expect(
      lines.find((l) => l.msg === 'dispatch sweep closed a live round whose task can no longer be offered'),
    ).toMatchObject({ level: 'error', pool_id: POOL_R, offer_id: offer.id, outcome: 'claimed_elsewhere' });
    // the sweep's pass that repaired something is an info line with the 10 §12.3 fields
    const pass = lines.find(
      (l) => l.msg === 'dispatch pass' && l.pass_reason === 'sweep' && l.pool_id === POOL_R,
    );
    expect(pass).toMatchObject({ level: 'info', orphans_closed: 1, offers_created: 0 });
    expect(typeof pass?.lock_wait_ms).toBe('number');
    expect(typeof pass?.duration_ms).toBe('number');
    expect(await one(t.db, `SELECT status, close_reason FROM task_offers WHERE id = $1`, [offer.id])).toEqual(
      {
        status: 'revoked',
        close_reason: 'claimed_elsewhere',
      },
    );
    expect(
      (await outboxEvents(t.db, 'offer.revoked'))
        .map((e) => e.payload.payload)
        .filter((p) => p.offer_id === offer.id),
    ).toEqual([
      expect.objectContaining({
        offer_id: offer.id,
        task_id: r.retrieveTaskId,
        close_reason: 'claimed_elsewhere',
      }),
    ]);
    expect(await revoked()).toBe(before + 1);
  });
});
