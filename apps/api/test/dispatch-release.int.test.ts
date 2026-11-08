import { SEED_IDS } from '@point/db/seed';
import { lockPools, lockUsers, releaseDriverWork } from '@point/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  accept,
  createS2App,
  err,
  expectConsistent,
  keyPickup,
  liveOffer,
  newDraft,
  ok,
  one,
  openBroadcastBySql,
  outboxEvents,
  parkedPaperTicket,
  POOL_R,
  requestRetrieval,
  rows,
  startDuty,
  U,
} from './dispatch-fixtures.js';

/**
 * DEC-32 seam (core/hooks/driver-release.ts) implemented by dispatch: identity-access (disable, transfer) and
 * venues-events (shift close, forced end) call releaseDriverWork() holding L1 (pool) and L3 (users).
 */
describe('DriverReleaseHook — releaseDriverWork (DEC-32; 10 §9.1, §9.5, §9.8)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
  });
  afterEach(async () => t.close());

  /** DRV3 longest idle, then DRV1; DRV2 parks the tickets (available last). */
  async function setup() {
    ok(await startDuty(t, 'DRV3'), 201);
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV1'), 201);
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV2'), 201);
    const a = await parkedPaperTicket(t, 'DRV2');
    const b = await parkedPaperTicket(t, 'DRV2');
    const c = await parkedPaperTicket(t, 'DRV2');
    t.clock.advanceSeconds(10);
    // A: offered to DRV3 (longest idle), accepted — key not picked up yet
    const ra = ok(await requestRetrieval(t, 'SUP-R', a.ticketId), 201);
    const oa = (await liveOffer(t.db, U.DRV3))!;
    ok(await accept(t, 'DRV3', oa.id));
    // B: a broadcast DRV3 reserves as his next task
    t.clock.advanceSeconds(1);
    const rb = ok(await requestRetrieval(t, 'SUP-R', b.ticketId), 201);
    const ob = await one(
      t.db,
      `SELECT o.id FROM task_offers o WHERE o.task_id = $1 AND o.status = 'active'`,
      [rb.task.id],
    );
    await t.db.query(
      `UPDATE task_offers SET status = 'revoked', closed_at = now(), close_reason = 'converted_to_broadcast' WHERE id = $1`,
      [ob.id],
    );
    await t.db.query(`UPDATE tasks SET status = 'queued', queued_at = $2 WHERE id = $1`, [
      rb.task.id,
      new Date(t.clock.now().getTime() + 1),
    ]);
    const bb = await openBroadcastBySql(t.db, rb.task.id);
    expect(ok(await accept(t, 'DRV3', bb)).result).toBe('assigned_waiting');
    return { a, b, c, ra, rb };
  }

  it('requeues the next task and the pre-pickup accepted retrieval with their priority, revokes live single offers, passes without him', async () => {
    const { a, b, c, ra, rb } = await setup();
    // C: a live single offer for DRV1 (DRV2 holds nothing: he parked and became available later)
    t.clock.advanceSeconds(1);
    const rc = ok(await requestRetrieval(t, 'SUP-R', c.ticketId), 201);
    expect((await liveOffer(t.db, U.DRV1))?.task_id).toBe(rc.task.id);
    const before = await rows(
      t.db,
      `SELECT id, priority_at FROM tasks WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[ra.task.id, rb.task.id]],
    );

    // what identity-access does on disable: L1 pool → L3 user → releaseDriverWork
    t.clock.advanceSeconds(5);
    await t.db.transaction(async (tx) => {
      await lockPools(tx, [POOL_R]);
      await lockUsers(tx, [U.DRV3]);
      await releaseDriverWork(tx, {
        orgId: SEED_IDS.org,
        driverId: U.DRV3,
        poolId: POOL_R,
        reason: 'disabled',
        actorId: U.ADM1,
      });
      // the caller then ends the duty in the same transaction
      await tx.query(
        `UPDATE duty_sessions SET status = 'ended', ended_at = $2, end_reason = 'disabled', available_since = NULL, version = version + 1
          WHERE user_id = $1 AND status <> 'ended'`,
        [U.DRV3, tx.now],
      );
    });

    const after = await rows(
      t.db,
      `SELECT id, status, assignee_id, priority_at, queued_at FROM tasks WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[ra.task.id, rb.task.id]],
    );
    for (const x of after) {
      expect(x.assignee_id).toBeNull();
      expect(['queued', 'offered']).toContain(x.status);
      expect(x.priority_at).toEqual(before.find((y) => y.id === x.id)!.priority_at); // original priority
      expect(x.queued_at).toEqual(t.clock.now()); // new episode
    }
    expect(await one(t.db, `SELECT status FROM tickets WHERE id = $1`, [a.ticketId])).toEqual({
      status: 'requested',
    });
    expect(await one(t.db, `SELECT status FROM tickets WHERE id = $1`, [b.ticketId])).toEqual({
      status: 'requested',
    });
    expect(await one(t.db, `SELECT accepted_by FROM retrieval_cycles WHERE id = $1`, [ra.cycle.id])).toEqual({
      accepted_by: null,
    });
    const withdrawn = (await outboxEvents(t.db, 'task.withdrawn')).map((e) => e.payload.payload);
    expect(withdrawn).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task_id: ra.task.id,
          from_assignee_id: U.DRV3,
          previous_status: 'accepted',
          trigger: 'disabled',
        }),
        expect.objectContaining({
          task_id: rb.task.id,
          from_assignee_id: U.DRV3,
          previous_status: 'assigned_waiting',
          trigger: 'disabled',
        }),
      ]),
    );
    // nothing was offered to the released driver
    expect(await liveOffer(t.db, U.DRV3)).toBeNull();
    await expectConsistent(t.db);
  });

  it('revokes the driver’s live single offer (recipient_unavailable; transfer → transfer) and requeues it in the same episode', async () => {
    ok(await startDuty(t, 'DRV3'), 201);
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV2'), 201);
    const p = await parkedPaperTicket(t, 'DRV2');
    ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    const offer = (await liveOffer(t.db, U.DRV3))!;
    await t.db.transaction(async (tx) => {
      await lockPools(tx, [POOL_R]);
      await releaseDriverWork(tx, {
        orgId: SEED_IDS.org,
        driverId: U.DRV3,
        poolId: POOL_R,
        reason: 'transfer',
        actorId: U.ADM1,
      });
      await tx.query(
        `UPDATE duty_sessions SET status = 'ended', ended_at = $2, end_reason = 'transfer', available_since = NULL WHERE user_id = $1 AND status <> 'ended'`,
        [U.DRV3, tx.now],
      );
    });
    expect(await one(t.db, `SELECT status, close_reason FROM task_offers WHERE id = $1`, [offer.id])).toEqual(
      {
        status: 'revoked',
        close_reason: 'transfer',
      },
    );
    // DRV3 stays tried for this episode; DRV2 (available) gets the next round
    expect((await liveOffer(t.db, U.DRV2))?.task_id).toBe(offer.task_id);
    await expectConsistent(t.db);
  });

  it('nothing to release: a no-op; a picked-up key is never released silently', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    await t.db.transaction(async (tx) => {
      await lockPools(tx, [POOL_R]);
      await releaseDriverWork(tx, {
        orgId: SEED_IDS.org,
        driverId: U.DRV1,
        poolId: POOL_R,
        reason: 'forced',
        actorId: U['SUP-R'],
      });
    });
    expect((await outboxEvents(t.db, 'task.withdrawn')).length).toBe(0);

    ok(await startDuty(t, 'DRV2'), 201);
    const p = await parkedPaperTicket(t, 'DRV2');
    ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    const o = (await liveOffer(t.db, U.DRV1))!;
    ok(await accept(t, 'DRV1', o.id));
    ok(await keyPickup(t, 'DRV1', o.task_id, p.slotId));
    await t.db.transaction(async (tx) => {
      await lockPools(tx, [POOL_R]);
      await releaseDriverWork(tx, {
        orgId: SEED_IDS.org,
        driverId: U.DRV1,
        poolId: POOL_R,
        reason: 'forced',
        actorId: U['SUP-R'],
      });
    });
    expect(await one(t.db, `SELECT status, assignee_id FROM tasks WHERE id = $1`, [o.task_id])).toEqual({
      status: 'accepted',
      assignee_id: U.DRV1,
    });
  });

  it('identity-access disable goes through the hook: next task back to the queue, then the driver is disabled', async () => {
    const { rb } = await setup();
    // DRV3 holds no custody: A is accepted before key pickup, B is his next task
    const r = await t.command('post', `/v1/drivers/${U.DRV3}/disable`, {
      as: 'ADM1',
      body: { reason: 'إيقاف مؤقت' },
    });
    expect(r.status).toBe(200);
    expect(
      await one(t.db, `SELECT status, assignee_id FROM tasks WHERE id = $1`, [rb.task.id]),
    ).toMatchObject({ assignee_id: null });
    expect(
      await one(
        t.db,
        `SELECT count(*)::int AS n FROM duty_sessions WHERE user_id = $1 AND status <> 'ended'`,
        [U.DRV3],
      ),
    ).toEqual({ n: 0 });
    await expectConsistent(t.db);
    // a draft (park in progress) blocks the disable instead (CUSTODY_OPEN, no override)
    await newDraft(t, 'DRV1');
    err(
      await t.command('post', `/v1/drivers/${U.DRV1}/disable`, {
        as: 'ADM1',
        body: { reason: 'إيقاف مؤقت' },
      }),
      'CUSTODY_OPEN',
      409,
    );
  });
});
