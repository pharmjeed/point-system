import { SEED_IDS } from '@point/db/seed';
import { createSessionCookie } from '@point/server/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OutboxDispatcher } from '@point/server';
import { CSRF, newKey, type TestApp } from './harness.js';
import {
  accept,
  auditCount,
  createS2App,
  err,
  expectConsistent,
  handover,
  keyPickup,
  LYL,
  liveOffer,
  markReady,
  newDraft,
  ok,
  one,
  outboxEvents,
  RMS,
  rows,
  startDuty,
  startRetrieval,
  U,
} from './dispatch-fixtures.js';
import {
  captureRealtime,
  dutyId,
  forceEnd,
  requestedTicket,
  s4Worker,
  threeDrivers,
  transfer,
} from './dispatch-s4-fixtures.js';

const DUMMY = '00000000-0000-4000-8000-0000deadbeef';

describe('PNT-084 — POST /v1/duty-sessions/{sessionId}/force-end and the live drivers list', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    await threeDrivers(t);
  });
  afterEach(async () => t.close());

  it('DUTY_END_BLOCKED_CUSTODY (no override) while he holds a vehicle, a key, a task in progress or a parking', async () => {
    const d = await newDraft(t, 'DRV1'); // vehicle + key with DRV1, park in progress
    const items = err(
      await forceEnd(t, 'SUP-R', await dutyId(t, 'DRV1')),
      'DUTY_END_BLOCKED_CUSTODY',
      409,
    ).items;
    expect(items.map((i: { type: string }) => i.type).sort()).toEqual(['key', 'task', 'vehicle']);
    expect(items).toContainEqual(
      expect.objectContaining({ type: 'task', ticket_id: d.ticketId, task_id: d.taskId }),
    );
    err(await forceEnd(t, 'SUP-R', await dutyId(t, 'DRV1'), 'ab'), 'REASON_REQUIRED', 422);
    err(await forceEnd(t, 'DRV2', await dutyId(t, 'DRV1')), 'PERMISSION_DENIED', 403);
    err(await forceEnd(t, 'SUP-R', DUMMY), 'RESOURCE_NOT_FOUND', 404);
    ok(await startDuty(t, 'DRV7'), 201);
    err(await forceEnd(t, 'SUP-R', await dutyId(t, 'DRV7')), 'RESOURCE_NOT_FOUND', 404); // LYL: out of scope
    expect(
      (await one(t.db, `SELECT status FROM duty_sessions WHERE user_id = $1 AND status <> 'ended'`, [U.DRV1]))
        .status,
    ).toBe('on_duty');
  });

  it('otherwise: the reserved next task and the accepted retrieval before key pickup go back with their priority, single offers revoked, sync.required, audit', async () => {
    // DRV3 accepted A (no key yet); DRV2 holds a single for B
    const a = await requestedTicket(t, 'DRV1');
    ok(await accept(t, 'DRV3', (await liveOffer(t.db, U.DRV3))!.id));
    const b = await requestedTicket(t, 'DRV1');
    const bOffer = (await liveOffer(t.db, U.DRV2))!;
    expect(bOffer.task_id).toBe(b.retrieveTaskId);
    const before = await one(t.db, `SELECT priority_at FROM tasks WHERE id = $1`, [a.retrieveTaskId]);
    const ws = await captureRealtime(t);
    const session = await dutyId(t, 'DRV3');
    const ended = ok(await forceEnd(t, 'SUP-R', session, 'غادر السائق الموقع'));
    expect(ended).toMatchObject({
      id: session,
      status: 'ended',
      end_reason: 'forced',
      available_since: null,
    });
    const ta = await one(t.db, `SELECT status, assignee_id, priority_at FROM tasks WHERE id = $1`, [
      a.retrieveTaskId,
    ]);
    expect(ta.assignee_id).toBeNull();
    expect(['queued', 'offered', 'broadcast']).toContain(ta.status);
    expect(ta.priority_at).toEqual(before.priority_at);
    expect((await outboxEvents(t.db, 'task.withdrawn')).map((e) => e.payload.payload)).toEqual([
      expect.objectContaining({ task_id: a.retrieveTaskId, from_assignee_id: U.DRV3, trigger: 'supervisor' }),
    ]);
    expect((await outboxEvents(t.db, 'driver.duty_ended')).at(-1)!.payload.payload).toMatchObject({
      user_id: U.DRV3,
      end_reason: 'forced',
      ended_by: U['SUP-R'],
    });
    expect(await auditCount(t.db, 'duty.force_end', session)).toBe(1);
    await ws.settle();
    expect(ws.of('sync.required', `user:${U.DRV3}`).map((m) => m.message.data)).toEqual([
      { cause: 'driver.duty_ended', reason: 'duty_force_ended', scope: 'home' },
    ]);
    const live = ws.of('driver.state_changed').find((m) => m.message.data.driver.id === U.DRV3)!;
    expect(live.rooms.sort()).toEqual([`user:${U.DRV3}`, `venue:${RMS}:supervisors`].sort());
    expect(live.message.data).toMatchObject({ driver_state: 'off_duty', duty_session_id: null });
    // his broadcast recipient rows stay, but he can no longer accept
    err(await accept(t, 'DRV3', bOffer.id), 'DUTY_REQUIRED', 409);
    err(await forceEnd(t, 'SUP-R', session), 'INVALID_STATE_TRANSITION', 409);
    await expectConsistent(t.db);
    await ws.stop();
  });

  it('GET /v1/drivers carries the live state with the duty session id (the path id of force-end)', async () => {
    const res = await t.get('/v1/drivers?venue_id=' + RMS, 'SUP-R');
    expect(res.status).toBe(200);
    const drv1 = res.body.data.find((x: { user: { id: string } }) => x.user.id === U.DRV1);
    expect(drv1.live).toMatchObject({
      driver_state: 'available',
      connection_state: 'online',
      duty_session_id: await dutyId(t, 'DRV1'),
    });
  });
});

describe('PNT-086 — driver transfers between venues (AC-10, AC-16)', () => {
  let t: TestApp;
  let worker: OutboxDispatcher;
  beforeEach(async () => {
    t = await createS2App();
    worker = s4Worker(t);
    await threeDrivers(t);
  });
  afterEach(async () => t.close());

  it('TRANSFER_SCOPE_DENIED without both venues; RESOURCE_NOT_FOUND; DRIVER_DISABLED; TRANSFER_ALREADY_PENDING', async () => {
    expect(
      err(
        await transfer(t, 'SUP-R', U.DRV1, { to_venue_id: LYL, reason: 'نقل للحاجة' }),
        'TRANSFER_SCOPE_DENIED',
        403,
      ),
    ).toEqual({ missing_venue_id: LYL });
    err(await transfer(t, 'DRV2', U.DRV1, { to_venue_id: LYL, reason: 'نقل' }), 'PERMISSION_DENIED', 403);
    err(
      await transfer(t, 'SUP-RL', DUMMY, { to_venue_id: LYL, reason: 'نقل للحاجة' }),
      'RESOURCE_NOT_FOUND',
      404,
    );
    err(await transfer(t, 'SUP-RL', U.DRV1, { to_venue_id: LYL }), 'REASON_REQUIRED', 422);
    const later = new Date(t.clock.now().getTime() + 3600_000).toISOString();
    const pending = ok(
      await transfer(t, 'SUP-RL', U.DRV1, { to_venue_id: LYL, scheduled_at: later, reason: 'نقل مجدول' }),
      201,
    );
    expect(pending).toMatchObject({
      status: 'pending',
      from_venue_id: RMS,
      to_venue_id: LYL,
      scheduled_at: later,
    });
    expect(
      err(
        await transfer(t, 'SUP-RL', U.DRV1, { to_venue_id: LYL, reason: 'نقل آخر' }),
        'TRANSFER_ALREADY_PENDING',
        409,
      ),
    ).toEqual({ transfer_id: pending.id });
    err(
      await t.command('post', `/v1/transfers/${pending.id}/cancel`, { as: 'SUP-RL', body: { reason: ' ' } }),
      'REASON_REQUIRED',
      422,
    );
    expect(
      err(
        await t.command('post', `/v1/transfers/${pending.id}/cancel`, {
          as: 'SUP-R',
          body: { reason: 'تراجع' },
        }),
        'TRANSFER_SCOPE_DENIED',
        403,
      ),
    ).toEqual({ missing_venue_id: LYL });
    ok(
      await t.command('post', `/v1/transfers/${pending.id}/cancel`, {
        as: 'SUP-RL',
        body: { reason: 'تراجع' },
      }),
    );
    err(
      await t.command('post', `/v1/transfers/${pending.id}/cancel`, {
        as: 'SUP-RL',
        body: { reason: 'تراجع' },
      }),
      'INVALID_STATE_TRANSITION',
      409,
    );
    await t.db.query(`UPDATE users SET status = 'disabled', disabled_at = now() WHERE id = $1`, [U.DRV4]);
    err(await transfer(t, 'SUP-RL', U.DRV4, { to_venue_id: LYL, reason: 'نقل' }), 'DRIVER_DISABLED', 409);
  });

  it('immediate with a key in hand: TRANSFER_BLOCKED_CUSTODY with no transfer row and no alert', async () => {
    const a = await requestedTicket(t, 'DRV1');
    ok(await accept(t, 'DRV3', (await liveOffer(t.db, U.DRV3))!.id));
    ok(await keyPickup(t, 'DRV3', a.retrieveTaskId, a.slotId));
    const items = err(
      await transfer(t, 'SUP-RL', U.DRV3, { to_venue_id: LYL, reason: 'نقل' }),
      'TRANSFER_BLOCKED_CUSTODY',
      409,
    ).items;
    expect(items).toEqual([expect.objectContaining({ type: 'key', ticket_id: a.ticketId })]);
    expect((await rows(t.db, `SELECT 1 FROM driver_transfers`)).length).toBe(0);
    expect((await rows(t.db, `SELECT 1 FROM alerts WHERE type = 'transfer_blocked'`)).length).toBe(0);
  });

  it('immediate: the next task and the accepted retrieval before pickup back to the old queue with their priority; new assignment; sessions revoked; history kept', async () => {
    // DRV3 retrieves A (accepted, no key) and has B reserved as next? (a single driver holds one movement: A accepted)
    const a = await requestedTicket(t, 'DRV1');
    ok(await accept(t, 'DRV3', (await liveOffer(t.db, U.DRV3))!.id));
    const b = await requestedTicket(t, 'DRV1');
    const bOffer = (await liveOffer(t.db, U.DRV2))!; // DRV2 holds a single for B
    const aBefore = await one(t.db, `SELECT priority_at FROM tasks WHERE id = $1`, [a.retrieveTaskId]);
    const oldAssignment = await one(
      t.db,
      `SELECT id FROM driver_assignments WHERE driver_id = $1 AND status = 'active'`,
      [U.DRV3],
    );
    const ws = await captureRealtime(t);
    const done = ok(await transfer(t, 'SUP-RL', U.DRV3, { to_venue_id: LYL, reason: 'دعم قاعة ليلتي' }), 201);
    expect(done).toMatchObject({
      status: 'completed',
      from_venue_id: RMS,
      to_venue_id: LYL,
      completed_at: t.clock.now().toISOString(),
    });
    // A back in the RMS queue with its priority (new episode, task.withdrawn trigger transfer)
    const ta = await one(t.db, `SELECT status, assignee_id, priority_at, venue_id FROM tasks WHERE id = $1`, [
      a.retrieveTaskId,
    ]);
    expect(ta).toMatchObject({ assignee_id: null, priority_at: aBefore.priority_at, venue_id: RMS });
    expect((await outboxEvents(t.db, 'task.withdrawn')).map((e) => e.payload.payload)).toEqual([
      expect.objectContaining({ task_id: a.retrieveTaskId, from_assignee_id: U.DRV3, trigger: 'transfer' }),
    ]);
    // assignments: the old one ended, a new active one with the transfer id (one active, AC-10 keeps the id)
    expect(
      await one(t.db, `SELECT status FROM driver_assignments WHERE id = $1`, [oldAssignment.id]),
    ).toEqual({ status: 'ended' });
    expect(
      await one(
        t.db,
        `SELECT venue_id, transfer_id FROM driver_assignments WHERE driver_id = $1 AND status = 'active'`,
        [U.DRV3],
      ),
    ).toEqual({ venue_id: LYL, transfer_id: done.id });
    expect(
      await one(
        t.db,
        `SELECT status, end_reason FROM duty_sessions WHERE user_id = $1 ORDER BY started_at DESC LIMIT 1`,
        [U.DRV3],
      ),
    ).toEqual({ status: 'ended', end_reason: 'transfer' });
    expect(
      (await rows(t.db, `SELECT 1 FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL`, [U.DRV3]))
        .length,
    ).toBe(0);
    expect((await outboxEvents(t.db, 'driver.transferred')).map((e) => e.payload.payload)).toEqual([
      expect.objectContaining({
        transfer_id: done.id,
        driver_id: U.DRV3,
        from_venue_id: RMS,
        to_venue_id: LYL,
        ended_assignment_id: oldAssignment.id,
        returned_task_ids: [a.retrieveTaskId],
      }),
    ]);
    await ws.settle();
    expect(ws.of('session.revoked', `user:${U.DRV3}`).map((m) => m.message.data)).toEqual([
      { reason: 'transfer' },
    ]);
    expect(
      ws
        .of('driver.state_changed')
        .find((m) => m.message.data.driver.id === U.DRV3)!
        .rooms.sort(),
    ).toEqual([`venue:${LYL}:supervisors`, `venue:${RMS}:supervisors`].sort());
    // the old session is revoked (AC-16): its stale accept is refused before anything else
    err(await accept(t, 'DRV3', bOffer.id), 'AUTH_SESSION_REVOKED', 401);
    // a new session in the new venue: an old RMS offer is not even visible (PNT-086 AC2)
    const cookie = (await createSessionCookie(t.db, U.DRV3, { now: t.clock.now(), hours: 4 })).cookie;
    const stale = await request(t.app.getHttpServer())
      .post(`/v1/task-offers/${bOffer.id}/accept`)
      .set(CSRF)
      .set('Cookie', cookie)
      .set('Idempotency-Key', newKey())
      .send({});
    expect({ status: stale.status, code: stale.body.error?.code }).toEqual({
      status: 404,
      code: 'OFFER_NOT_FOUND',
    });
    // history keeps the original venue and actor
    expect(
      await one(t.db, `SELECT venue_id, accepted_by FROM retrieval_cycles WHERE id = $1`, [a.cycleId]),
    ).toEqual({ venue_id: RMS, accepted_by: null });
    expect(await auditCount(t.db, 'driver.transfer', done.id)).toBe(1);
    void b;
    await expectConsistent(t.db);
    await ws.stop();
  });

  it('scheduled: blocked at activation (transfer_blocked for both venues), re-evaluated when his custody ends, then completed', async () => {
    const a = await requestedTicket(t, 'DRV1');
    ok(await accept(t, 'DRV3', (await liveOffer(t.db, U.DRV3))!.id));
    ok(await keyPickup(t, 'DRV3', a.retrieveTaskId, a.slotId));
    const at = new Date(t.clock.now().getTime() + 60_000).toISOString();
    const pending = ok(
      await transfer(t, 'SUP-RL', U.DRV3, { to_venue_id: LYL, scheduled_at: at, reason: 'دعم مجدول' }),
      201,
    );
    expect(pending.status).toBe('pending');
    t.clock.advanceSeconds(60);
    await worker.drain();
    const blocked = await one(t.db, `SELECT status, blocked_details FROM driver_transfers WHERE id = $1`, [
      pending.id,
    ]);
    expect(blocked.status).toBe('blocked');
    expect(blocked.blocked_details).toMatchObject({
      code: 'TRANSFER_BLOCKED_CUSTODY',
      items: [expect.objectContaining({ type: 'key', ticket_id: a.ticketId })],
    });
    expect(
      (
        await rows(
          t.db,
          `SELECT venue_id, severity, status FROM alerts WHERE dedupe_key = $1 ORDER BY venue_id`,
          [`transfer_blocked:${pending.id}`],
        )
      ).map((r) => [r.venue_id, r.severity, r.status]),
    ).toEqual(
      [
        [LYL, 'info', 'open'],
        [RMS, 'info', 'open'],
      ].sort((x, y) => (x[0]! < y[0]! ? -1 : 1)),
    );
    expect((await outboxEvents(t.db, 'driver.transfer_blocked')).length).toBe(1);
    // he finishes the retrieval: the handover ends his custody → job.transfer_activate → completed
    ok(await startRetrieval(t, 'DRV3', a.retrieveTaskId));
    ok(await markReady(t, 'DRV3', a.retrieveTaskId));
    ok(
      await handover(t, 'DRV3', a.ticketId, {
        verification: { method: 'paper_stub', paper_serial: a.serial },
      }),
    );
    await worker.drain();
    expect((await one(t.db, `SELECT status FROM driver_transfers WHERE id = $1`, [pending.id])).status).toBe(
      'completed',
    );
    expect(
      (
        await rows(t.db, `SELECT status FROM alerts WHERE dedupe_key = $1`, [
          `transfer_blocked:${pending.id}`,
        ])
      ).map((r) => r.status),
    ).toEqual(['resolved', 'resolved']);
    expect(
      await one(t.db, `SELECT venue_id FROM driver_assignments WHERE driver_id = $1 AND status = 'active'`, [
        U.DRV3,
      ]),
    ).toEqual({ venue_id: LYL });
    await expectConsistent(t.db);
  });

  it('a scheduled transfer canceled before its time does nothing at activation; the cancel resolves a blocked alert', async () => {
    const at = new Date(t.clock.now().getTime() + 60_000).toISOString();
    const pending = ok(
      await transfer(t, 'SUP-RL', U.DRV2, { to_venue_id: LYL, scheduled_at: at, reason: 'دعم' }),
      201,
    );
    ok(
      await t.command('post', `/v1/transfers/${pending.id}/cancel`, {
        as: 'SUP-RL',
        body: { reason: 'لا حاجة' },
      }),
    );
    t.clock.advanceSeconds(61);
    await worker.drain();
    expect(await one(t.db, `SELECT status FROM driver_transfers WHERE id = $1`, [pending.id])).toEqual({
      status: 'canceled',
    });
    expect(
      await one(t.db, `SELECT venue_id FROM driver_assignments WHERE driver_id = $1 AND status = 'active'`, [
        U.DRV2,
      ]),
    ).toEqual({ venue_id: RMS });
    void SEED_IDS;
  });
});
