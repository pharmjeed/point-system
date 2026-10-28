import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OutboxDispatcher } from '@point/server';
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
  outboxEvents,
  parkedPaperTicket,
  POOL_R,
  requestRetrieval,
  RMS,
  rows,
  startDuty,
  U,
} from './dispatch-fixtures.js';
import {
  brk,
  captureRealtime,
  liveSingle,
  reassign,
  requestedTicket,
  s4Worker,
  threeDrivers,
} from './dispatch-s4-fixtures.js';

const roundsOf = (t: TestApp, taskId: string) =>
  rows<{ id: string; mode: string; status: string; close_reason: string | null; round_no: number }>(
    t.db,
    `SELECT id, mode, status, close_reason, round_no FROM task_offers WHERE task_id = $1 ORDER BY round_no`,
    [taskId],
  );
const recipientsOf = (t: TestApp, offerId: string) =>
  rows<{ user_id: string; eligible_as: string }>(
    t.db,
    `SELECT user_id, eligible_as FROM offer_recipients WHERE offer_id = $1 ORDER BY user_id`,
    [offerId],
  );
const byUser = <T extends { user_id: string }>(xs: T[]) =>
  [...xs].sort((a, b) => (a.user_id < b.user_id ? -1 : 1));
const taskStatus = async (t: TestApp, id: string) =>
  (await one<{ status: string }>(t.db, `SELECT status FROM tasks WHERE id = $1`, [id])).status;

describe('PNT-052 — single-offer timers (job.offer_remind, job.offer_expire)', () => {
  let t: TestApp;
  let worker: OutboxDispatcher;
  beforeEach(async () => {
    t = await createS2App();
    worker = s4Worker(t);
    await threeDrivers(t);
  });
  afterEach(async () => t.close());

  it('one reminder at 15 s, the accept at 31 s still wins, the timers are then no-ops', async () => {
    const r = await requestedTicket(t);
    const offer = (await liveOffer(t.db, U.DRV3))!;
    expect(offer.task_id).toBe(r.retrieveTaskId);
    t.clock.advanceSeconds(14);
    await worker.drain();
    expect((await outboxEvents(t.db, 'offer.reminded')).length).toBe(0);
    t.clock.advanceSeconds(1);
    await worker.drain();
    expect((await outboxEvents(t.db, 'offer.reminded')).map((e) => e.payload.payload)).toEqual([
      { offer_id: offer.id, task_id: r.retrieveTaskId, mode: 'single', recipient_ids: [U.DRV3] },
    ]);
    // reminded_at is descriptive: no version bump (10 §2.7), so job.offer_expire still applies
    expect(
      await one(t.db, `SELECT version, reminded_at IS NOT NULL AS r FROM task_offers WHERE id = $1`, [
        offer.id,
      ]),
    ).toEqual({ version: 1, r: true });
    t.clock.advanceSeconds(16); // 31 s after the round
    expect(ok(await accept(t, 'DRV3', offer.id)).result).toBe('accepted');
    t.clock.advanceSeconds(5);
    await worker.drain();
    expect((await outboxEvents(t.db, 'offer.expired')).length).toBe(0);
    expect((await outboxEvents(t.db, 'offer.reminded')).length).toBe(1);
    await expectConsistent(t.db);
  });

  it('expiry exactly at expires_at + 1.5 s: the silent driver rotates, the next idle driver gets round 2; then OFFER_EXPIRED', async () => {
    const r = await requestedTicket(t);
    const first = (await liveOffer(t.db, U.DRV3))!;
    t.clock.advanceSeconds(31.4);
    await worker.drain();
    expect((await one(t.db, `SELECT status FROM task_offers WHERE id = $1`, [first.id])).status).toBe(
      'active',
    );
    t.clock.advanceSeconds(0.1); // 31.5 s
    await worker.drain();
    expect(await roundsOf(t, r.retrieveTaskId)).toEqual([
      expect.objectContaining({ id: first.id, status: 'expired', close_reason: 'expired', round_no: 1 }),
      expect.objectContaining({ mode: 'single', status: 'active', round_no: 2 }),
    ]);
    expect((await liveOffer(t.db, U.DRV2))?.task_id).toBe(r.retrieveTaskId);
    t.clock.advanceSeconds(0.5);
    expect(err(await accept(t, 'DRV3', first.id), 'OFFER_EXPIRED', 410)).toEqual({ offer_id: first.id });
    await expectConsistent(t.db);
  });
});

describe('PNT-053 — broadcast mode', () => {
  let t: TestApp;
  let worker: OutboxDispatcher;
  beforeEach(async () => {
    t = await createS2App();
    worker = s4Worker(t);
  });
  afterEach(async () => t.close());

  it('no untried idle driver: one broadcast to every on-duty driver of the pool (break and other pools excluded), eligible_as by state, one reminder', async () => {
    for (const d of ['DRV1', 'DRV2', 'DRV3', 'DRV4', 'DRV7']) ok(await startDuty(t, d), 201);
    const p = await parkedPaperTicket(t, 'DRV1');
    ok(await brk(t, 'DRV4', true));
    await newDraft(t, 'DRV2');
    await newDraft(t, 'DRV3');
    const ws = await captureRealtime(t);
    const req = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    const single = (await liveOffer(t.db, U.DRV1))!; // the only idle driver
    expect(single.task_id).toBe(req.task.id);
    t.clock.advanceSeconds(32); // silent: expired, DRV1 tried → broadcast (10 §8.3)
    await worker.drain();
    const live = (await roundsOf(t, req.task.id)).at(-1)!;
    expect(live).toMatchObject({ mode: 'broadcast', status: 'active', round_no: 2 });
    expect(await recipientsOf(t, live.id)).toEqual(
      byUser([
        { user_id: U.DRV1, eligible_as: 'accept' },
        { user_id: U.DRV2, eligible_as: 'reserve_next' },
        { user_id: U.DRV3, eligible_as: 'reserve_next' },
      ]),
    );
    expect(await taskStatus(t, req.task.id)).toBe('broadcast');
    const opened = (await outboxEvents(t.db, 'task.broadcast_opened')).map((e) => e.payload.payload);
    expect(opened).toEqual([
      expect.objectContaining({
        task_id: req.task.id,
        offer_id: live.id,
        round_no: 2,
        recipients: byUser([
          { user_id: U.DRV1, eligible_as: 'accept' },
          { user_id: U.DRV2, eligible_as: 'reserve_next' },
          { user_id: U.DRV3, eligible_as: 'reserve_next' },
        ]),
      }),
    ]);
    // ws task.broadcast: one card per recipient with his own eligibility (07 §4.3)
    await ws.settle();
    const cards = ws.of('task.broadcast');
    expect(cards.map((c) => [c.rooms[0], c.message.data.eligible_as]).sort()).toEqual(
      [
        [`user:${U.DRV1}`, 'accept'],
        [`user:${U.DRV2}`, 'reserve_next'],
        [`user:${U.DRV3}`, 'reserve_next'],
      ].sort(),
    );
    expect(cards.find((c) => c.rooms[0] === `user:${U.DRV2}`)!.message.data).toMatchObject({
      cause: 'task.broadcast_opened',
      offer_id: live.id,
      task_id: req.task.id,
      mode: 'broadcast',
      expires_at: null,
      can_accept: false,
      can_reserve_next: true,
      safety_note_ar: expect.any(String),
      ticket: { display_number: p.displayNumber },
    });
    expect(ws.all.some((m) => m.rooms.includes(`user:${U.DRV4}`) || m.rooms.includes(`user:${U.DRV7}`))).toBe(
      false,
    );
    // a single reminder at +30 s of the broadcast to those who can act; none later
    t.clock.advanceSeconds(30);
    await worker.drain();
    t.clock.advanceSeconds(90);
    await worker.drain();
    const reminders = (await outboxEvents(t.db, 'offer.reminded')).map((e) => e.payload.payload);
    expect(reminders.filter((x) => x.offer_id === live.id)).toEqual([
      {
        offer_id: live.id,
        task_id: req.task.id,
        mode: 'broadcast',
        recipient_ids: [U.DRV1, U.DRV2, U.DRV3].sort(),
      },
    ]);
    await expectConsistent(t.db);
    await ws.stop();
  });

  it('task.claimed reaches the pool drivers and the supervisors; the winner gets his TaskCard first', async () => {
    for (const d of ['DRV1', 'DRV2']) ok(await startDuty(t, d), 201);
    const p = await parkedPaperTicket(t, 'DRV1');
    await newDraft(t, 'DRV1');
    await newDraft(t, 'DRV2');
    const req = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    expect(req.task.status).toBe('broadcast');
    const offerId = (await liveOffer(t.db, U.DRV2))!.id;
    const ws = await captureRealtime(t);
    expect(ok(await accept(t, 'DRV2', offerId)).result).toBe('assigned_waiting');
    await ws.settle();
    const claimed = ws.of('task.claimed');
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.rooms).toEqual([`pool:${POOL_R}:drivers`, `venue:${RMS}:supervisors`]);
    expect(claimed[0]!.message.data).toMatchObject({
      cause: 'task.claimed',
      task_id: req.task.id,
      offer_ids: [offerId],
      result: 'assigned_waiting',
      claimed_by: { id: U.DRV2, full_name: expect.any(String) },
    });
    const winner = ws.of('task.updated', `user:${U.DRV2}`);
    expect(winner).toHaveLength(1);
    expect(winner[0]!.message.data).toMatchObject({
      cause: 'task.claimed',
      task: { id: req.task.id, status: 'assigned_waiting' },
      ticket: { id: p.ticketId },
      key_slot: { id: p.slotId },
    });
    expect(ws.all.indexOf(winner[0]!)).toBeLessThan(ws.all.indexOf(claimed[0]!));
    // a late accept from the other device of the loser: TASK_ALREADY_CLAIMED
    err(await accept(t, 'DRV1', offerId), 'TASK_ALREADY_CLAIMED', 409);
    await expectConsistent(t.db);
    await ws.stop();
  });

  it('an available driver holding a newer single accepts an older broadcast: the single is revoked and requeued in the same episode', async () => {
    await threeDrivers(t); // DRV3 longest idle, then DRV2, then DRV1
    const older = await requestedTicket(t, 'DRV1'); // single to DRV3
    ok(await accept(t, 'DRV3', (await liveOffer(t.db, U.DRV3))!.id));
    const newer = await requestedTicket(t, 'DRV1'); // single to DRV2
    expect((await liveOffer(t.db, U.DRV2))?.task_id).toBe(newer.retrieveTaskId);
    await newDraft(t, 'DRV1'); // DRV1 can only reserve: somebody who can act is not blocked
    // the older request goes back to the queue with its priority: a broadcast (DRV2 = accept)
    ok(await reassign(t, 'SUP-R', older.retrieveTaskId, { reason: 'السائق متأخر', target_driver_id: null }));
    const b = (await roundsOf(t, older.retrieveTaskId)).at(-1)!;
    expect(b).toMatchObject({ mode: 'broadcast', status: 'active' });
    expect(await recipientsOf(t, b.id)).toContainEqual({ user_id: U.DRV2, eligible_as: 'accept' });
    expect(ok(await accept(t, 'DRV2', b.id)).result).toBe('accepted');
    expect((await roundsOf(t, newer.retrieveTaskId))[0]).toMatchObject({
      mode: 'single',
      status: 'revoked',
      close_reason: 'recipient_unavailable',
    });
    // same episode (DRV2 stays tried for it); the pass gave it to DRV3, available again
    expect((await liveOffer(t.db, U.DRV3))?.task_id).toBe(newer.retrieveTaskId);
    await expectConsistent(t.db);
  });

  it('a broadcast whose recipients all left stays a broadcast with no_drivers_on_duty; a new driver turns it into a single round', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    const p = await parkedPaperTicket(t, 'DRV1');
    const req = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    t.clock.advanceSeconds(32);
    await worker.drain(); // single expired → broadcast to DRV1 (tried)
    const b = (await roundsOf(t, req.task.id)).at(-1)!;
    expect(b).toMatchObject({ mode: 'broadcast', status: 'active' });
    ok(await brk(t, 'DRV1', true));
    expect(await taskStatus(t, req.task.id)).toBe('broadcast'); // no broadcast → queued
    expect((await one(t.db, `SELECT status FROM task_offers WHERE id = $1`, [b.id])).status).toBe('active');
    expect(
      await one(t.db, `SELECT status, details FROM alerts WHERE dedupe_key = $1`, [
        `no_drivers_on_duty:${POOL_R}`,
      ]),
    ).toMatchObject({ status: 'open', details: { reason: 'all_on_break', open_requests: 1 } });
    ok(await brk(t, 'DRV1', false)); // back, but tried: still the broadcast
    expect(await taskStatus(t, req.task.id)).toBe('broadcast');
    ok(await startDuty(t, 'DRV2'), 201); // untried and available: converted (10 §4.5)
    expect((await roundsOf(t, req.task.id)).find((x) => x.id === b.id)).toMatchObject({
      status: 'revoked',
      close_reason: 'converted_to_single',
    });
    expect((await liveOffer(t.db, U.DRV2))?.task_id).toBe(req.task.id);
    expect(err(await accept(t, 'DRV1', b.id), 'OFFER_REVOKED', 410).close_reason).toBe('converted_to_single');
    await expectConsistent(t.db);
  });

  it('R-3: a newer request stays queued while everybody who can act is held by an older broadcast; offered once it is claimed (10 §4.8)', async () => {
    for (const d of ['DRV1', 'DRV2']) ok(await startDuty(t, d), 201);
    const p1 = await parkedPaperTicket(t, 'DRV1');
    const p2 = await parkedPaperTicket(t, 'DRV1');
    await newDraft(t, 'DRV2'); // can only reserve
    const t1 = ok(await requestRetrieval(t, 'SUP-R', p1.ticketId), 201);
    t.clock.advanceSeconds(32);
    await worker.drain(); // DRV1 silent → broadcast to DRV1 (accept, tried) and DRV2 (reserve_next)
    expect(await taskStatus(t, t1.task.id)).toBe('broadcast');
    const t2 = ok(await requestRetrieval(t, 'SUP-R', p2.ticketId), 201);
    expect(t2.task.status).toBe('queued');
    expect((await roundsOf(t, t2.task.id)).length).toBe(0);
    // DRV2 reserves T1 as his next task → T2 can now be offered to DRV1 alone
    ok(await accept(t, 'DRV2', (await liveOffer(t.db, U.DRV2))!.id));
    const single = (await liveOffer(t.db, U.DRV1))!;
    expect(single.task_id).toBe(t2.task.id);
    expect((await roundsOf(t, t2.task.id))[0]).toMatchObject({ mode: 'single', status: 'active' });
    await expectConsistent(t.db);
  });

  it('everybody busy with a next task: a view-only broadcast; a driver coming on duty converts the oldest and extends the next', async () => {
    for (const d of ['DRV1', 'DRV2']) ok(await startDuty(t, d), 201);
    const p1 = await parkedPaperTicket(t, 'DRV1');
    const p2 = await parkedPaperTicket(t, 'DRV1');
    const p3 = await parkedPaperTicket(t, 'DRV1');
    const p4 = await parkedPaperTicket(t, 'DRV1');
    await newDraft(t, 'DRV1');
    await newDraft(t, 'DRV2');
    const t1 = ok(await requestRetrieval(t, 'SUP-R', p1.ticketId), 201);
    ok(await accept(t, 'DRV1', (await liveOffer(t.db, U.DRV1))!.id)); // DRV1 busy_with_next
    const t2 = ok(await requestRetrieval(t, 'SUP-R', p2.ticketId), 201);
    expect(t2.task.status).toBe('broadcast');
    ok(await accept(t, 'DRV2', (await liveOffer(t.db, U.DRV2))!.id)); // DRV2 busy_with_next
    expect(await taskStatus(t, t1.task.id)).toBe('assigned_waiting');
    // nobody can act: the round still opens, view-only for everybody (10 §4.8, third example)
    const t3 = ok(await requestRetrieval(t, 'SUP-R', p3.ticketId), 201);
    const t4 = ok(await requestRetrieval(t, 'SUP-R', p4.ticketId), 201);
    expect([t3.task.status, t4.task.status]).toEqual(['broadcast', 'broadcast']);
    const b3 = (await roundsOf(t, t3.task.id)).at(-1)!;
    const b4 = (await roundsOf(t, t4.task.id)).at(-1)!;
    expect(await recipientsOf(t, b3.id)).toEqual(
      byUser([
        { user_id: U.DRV1, eligible_as: 'view_only' },
        { user_id: U.DRV2, eligible_as: 'view_only' },
      ]),
    );
    err(await accept(t, 'DRV1', b3.id), 'NEXT_TASK_ALREADY_RESERVED', 409);
    // DRV3 comes on duty: T3 (oldest open) becomes a single round for him, T4's broadcast is extended
    const ws = await captureRealtime(t);
    ok(await startDuty(t, 'DRV3'), 201);
    expect((await liveSingle(t, 'DRV3'))?.task_id).toBe(t3.task.id);
    expect(await one(t.db, `SELECT status, close_reason FROM task_offers WHERE id = $1`, [b3.id])).toEqual({
      status: 'revoked',
      close_reason: 'converted_to_single',
    });
    const extended = (await outboxEvents(t.db, 'task.broadcast_extended')).map((e) => e.payload.payload);
    expect(extended).toEqual([
      { task_id: t4.task.id, offer_id: b4.id, added: [{ user_id: U.DRV3, eligible_as: 'accept' }] },
    ]);
    await ws.settle();
    expect(ws.of('task.broadcast', `user:${U.DRV3}`).map((m) => m.message.data.cause)).toEqual([
      'task.broadcast_extended',
    ]);
    expect(ws.of('task.offered', `user:${U.DRV3}`)[0]!.message.data).toMatchObject({
      task_id: t3.task.id,
      mode: 'single',
      eligible_as: 'accept',
      can_accept: true,
    });
    // the older live round blocks the newer one for him (priority guard)
    expect(err(await accept(t, 'DRV3', b4.id), 'OLDER_REQUEST_PENDING', 409).older_task_id).toBe(t3.task.id);
    await expectConsistent(t.db);
    await ws.stop();
  });
});
