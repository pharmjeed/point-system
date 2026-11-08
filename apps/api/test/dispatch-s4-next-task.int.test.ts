import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mapPgError, type OutboxDispatcher } from '@point/server';
import type { TestApp } from './harness.js';
import {
  accept,
  auditCount,
  completeParking,
  createS2App,
  err,
  expectConsistent,
  handover,
  keyPickup,
  liveOffer,
  markReady,
  newDraft,
  nextSlot,
  nextSpot,
  ok,
  one,
  outboxEvents,
  paperTicketInParking,
  parkedPaperTicket,
  POOL_R,
  requestRetrieval,
  rows,
  startDuty,
  startRetrieval,
  U,
} from './dispatch-fixtures.js';
import {
  captureRealtime,
  linkWhatsapp,
  reassign,
  s4Worker,
  twoLiveBroadcastsForDrv1,
  whatsappNotifications,
} from './dispatch-s4-fixtures.js';

const availableSince = async (t: TestApp, user: string) =>
  (
    await one<{ available_since: Date | null }>(
      t.db,
      `SELECT available_since FROM duty_sessions WHERE user_id = $1 AND status <> 'ended'`,
      [(U as Record<string, string>)[user]],
    )
  ).available_since;

describe('PNT-054 / PNT-055 — the next task and its promotion (AC-15)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
  });
  afterEach(async () => t.close());

  it('a busy driver reserves one next task (assigned_waiting + W-03); a second is NEXT_TASK_ALREADY_RESERVED; no start before the promotion; W-04 only at the real start', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    const a = await parkedPaperTicket(t, 'DRV1');
    const b = await parkedPaperTicket(t, 'DRV1');
    const draft = await paperTicketInParking(t, 'DRV1'); // DRV1 busy parking
    await linkWhatsapp(t, a.ticketId);
    const ra = ok(await requestRetrieval(t, 'SUP-R', a.ticketId), 201);
    expect(ra.task.status).toBe('broadcast');
    const res = ok(await accept(t, 'DRV1', (await liveOffer(t.db, U.DRV1))!.id));
    expect(res).toMatchObject({ result: 'assigned_waiting', driver_state: 'busy_with_next' });
    expect(res.ticket.status).toBe('assigned_waiting');
    // the next request is a view-only broadcast for him
    const rb = ok(await requestRetrieval(t, 'SUP-R', b.ticketId), 201);
    expect(rb.task.status).toBe('broadcast');
    const bOffer = (await liveOffer(t.db, U.DRV1))!;
    expect(bOffer.task_id).toBe(rb.task.id);
    expect(err(await accept(t, 'DRV1', bOffer.id), 'NEXT_TASK_ALREADY_RESERVED', 409)).toEqual({
      next_task_id: ra.task.id,
    });
    expect(err(await keyPickup(t, 'DRV1', ra.task.id, a.slotId), 'TASK_NOT_STARTABLE', 409).reason).toBe(
      'next_task_not_promoted',
    );
    err(await startRetrieval(t, 'DRV1', ra.task.id), 'TASK_NOT_STARTABLE', 409);
    expect((await whatsappNotifications(t, a.ticketId)).map((n) => n.purpose)).toEqual(['W-02', 'W-03']);
    // the reservation is watched (10 §5.3): at assigned_waiting_at + 300 s
    const timer = await one(
      t.db,
      `SELECT available_at, dedupe_key FROM outbox_events WHERE type = 'job.next_task_wait_check'`,
    );
    expect(new Date(timer.available_at).getTime() - t.clock.now().getTime()).toBe(300_000);
    // the parking completes: promotion in the same transaction, never available in between
    const done = ok(
      await completeParking(t, 'DRV1', draft.taskId, {
        parking_spot_id: nextSpot(),
        key_slot_id: nextSlot(),
      }),
    );
    expect(done.driver).toMatchObject({
      driver_state: 'retrieving',
      promoted_next_task: { task: { id: ra.task.id, status: 'accepted' } },
    });
    expect(await availableSince(t, 'DRV1')).toBeNull();
    expect((await outboxEvents(t.db, 'task.promoted')).map((e) => e.payload.payload)).toEqual([
      { task_id: ra.task.id, ticket_id: a.ticketId, assignee_id: U.DRV1, after_task_id: draft.taskId },
    ]);
    expect((await whatsappNotifications(t, a.ticketId)).map((n) => n.purpose)).toEqual(['W-02', 'W-03']);
    ok(await keyPickup(t, 'DRV1', ra.task.id, a.slotId));
    expect((await whatsappNotifications(t, a.ticketId)).map((n) => n.purpose)).toEqual(['W-02', 'W-03']);
    ok(await startRetrieval(t, 'DRV1', ra.task.id));
    expect((await whatsappNotifications(t, a.ticketId)).map((n) => n.purpose)).toEqual([
      'W-02',
      'W-03',
      'W-04',
    ]);
    await expectConsistent(t.db);
  });

  it('uq_tasks_next_per_driver is the last barrier and maps to NEXT_TASK_ALREADY_RESERVED (08 §5)', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    const a = await parkedPaperTicket(t, 'DRV1');
    const b = await parkedPaperTicket(t, 'DRV1');
    await newDraft(t, 'DRV1');
    ok(await requestRetrieval(t, 'SUP-R', a.ticketId), 201);
    ok(await accept(t, 'DRV1', (await liveOffer(t.db, U.DRV1))!.id)); // DRV1 reserves A
    const rb = ok(await requestRetrieval(t, 'SUP-R', b.ticketId), 201);
    // a code path that skipped the capacity check: the partial unique index refuses a second reservation
    const violation = await t.db
      .query(
        `UPDATE tasks SET status = 'assigned_waiting', assignee_id = $2, claimed_at = now(), assigned_waiting_at = now()
          WHERE id = $1`,
        [rb.task.id, U.DRV1],
      )
      .then(
        () => null,
        (e: { code?: string; constraint?: string }) => e,
      );
    expect(violation).toMatchObject({ code: '23505', constraint: 'uq_tasks_next_per_driver' });
    expect(mapPgError(violation!).error.code).toBe('NEXT_TASK_ALREADY_RESERVED');
  });

  it('a concurrent pass never sees the driver available between the end of his task and the promotion', async () => {
    for (const d of ['DRV1', 'DRV2']) ok(await startDuty(t, d), 201);
    const a = await parkedPaperTicket(t, 'DRV2');
    const b = await parkedPaperTicket(t, 'DRV2');
    const c = await parkedPaperTicket(t, 'DRV2');
    const ra = ok(await requestRetrieval(t, 'SUP-R', a.ticketId), 201);
    ok(await accept(t, 'DRV1', (await liveOffer(t.db, U.DRV1))!.id)); // DRV1 retrieves A
    await newDraft(t, 'DRV2');
    const rb = ok(await requestRetrieval(t, 'SUP-R', b.ticketId), 201);
    ok(await accept(t, 'DRV1', (await liveOffer(t.db, U.DRV1))!.id)); // and reserves B
    ok(await keyPickup(t, 'DRV1', ra.task.id, a.slotId));
    ok(await startRetrieval(t, 'DRV1', ra.task.id));
    ok(await markReady(t, 'DRV1', ra.task.id));
    // the handover (end + promotion) races a new request (whose pass looks for idle drivers)
    const [h, rc] = await Promise.all([
      handover(t, 'DRV1', a.ticketId, { verification: { method: 'paper_stub', paper_serial: a.serial } }),
      requestRetrieval(t, 'SUP-R', c.ticketId),
    ]);
    expect([h.status, rc.status]).toEqual([200, 201]);
    const singles = await rows(
      t.db,
      `SELECT r.user_id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id
        WHERE o.task_id = $1 AND o.mode = 'single'`,
      [rc.body.data.task.id],
    );
    expect(singles.map((s) => s.user_id)).not.toContain(U.DRV1);
    expect((await one(t.db, `SELECT status FROM tasks WHERE id = $1`, [rb.task.id])).status).toBe('accepted');
    expect(await availableSince(t, 'DRV1')).toBeNull();
    await expectConsistent(t.db);
  });
});

describe('PNT-056 — the priority guard (AC-17, functional part; the 100-iteration race is in dispatch-race)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
  });
  afterEach(async () => t.close());

  it('an older actionable round blocks the newer one for the same driver; a supervisor needs override_priority and is audited', async () => {
    const { older, newer } = await twoLiveBroadcastsForDrv1(t);
    expect(err(await accept(t, 'DRV1', newer.offerId), 'OLDER_REQUEST_PENDING', 409)).toEqual({
      older_task_id: older.taskId,
      older_offer_id: older.offerId,
    });
    expect(
      err(
        await reassign(t, 'SUP-R', newer.taskId, { reason: 'أقرب للموقف', target_driver_id: U.DRV1 }),
        'OLDER_REQUEST_PENDING',
        409,
      ).older_task_id,
    ).toBe(older.taskId);
    expect(await auditCount(t.db, 'dispatch.priority_override')).toBe(0);
    const r = ok(
      await reassign(t, 'SUP-R', newer.taskId, {
        reason: 'أقرب للموقف',
        target_driver_id: U.DRV1,
        override_priority: true,
      }),
    );
    expect(r.task).toMatchObject({ id: newer.taskId, status: 'assigned_waiting', assignee: { id: U.DRV1 } });
    expect(r.ticket.status).toBe('assigned_waiting');
    expect(await auditCount(t.db, 'dispatch.priority_override', newer.taskId)).toBe(1);
    const audit = await one(
      t.db,
      `SELECT reason, metadata FROM audit_log WHERE action = 'dispatch.priority_override'`,
    );
    expect(audit).toMatchObject({
      reason: 'أقرب للموقف',
      metadata: { older_task_id: older.taskId, target_driver_id: U.DRV1 },
    });
    expect((await outboxEvents(t.db, 'task.reassigned')).map((e) => e.payload.payload).at(-1)).toMatchObject({
      task_id: newer.taskId,
      to_assignee_id: U.DRV1,
      priority_override: true,
      trigger: 'reassign',
    });
    await expectConsistent(t.db);
  });

  it('an older request offered exclusively to someone else does not block the newer one (R-4)', async () => {
    ok(await startDuty(t, 'DRV3'), 201);
    t.clock.advanceSeconds(1);
    ok(await startDuty(t, 'DRV2'), 201);
    t.clock.advanceSeconds(1);
    ok(await startDuty(t, 'DRV1'), 201);
    const a = await parkedPaperTicket(t, 'DRV1');
    const b = await parkedPaperTicket(t, 'DRV1');
    ok(await t.command('post', '/v1/me/duty/end', { as: 'DRV1', body: {} }));
    const ra = ok(await requestRetrieval(t, 'SUP-R', a.ticketId), 201); // single to DRV3
    const rb = ok(await requestRetrieval(t, 'SUP-R', b.ticketId), 201); // single to DRV2
    expect((await liveOffer(t.db, U.DRV3))?.task_id).toBe(ra.task.id);
    expect((await liveOffer(t.db, U.DRV2))?.task_id).toBe(rb.task.id);
    expect(ok(await accept(t, 'DRV2', (await liveOffer(t.db, U.DRV2))!.id)).result).toBe('accepted');
    await expectConsistent(t.db);
  });

  it('an older request back in the queue without a round does not block either (EC-41: bounded inversion)', async () => {
    ok(await startDuty(t, 'DRV3'), 201);
    t.clock.advanceSeconds(1);
    ok(await startDuty(t, 'DRV1'), 201);
    const a = await parkedPaperTicket(t, 'DRV1');
    const c = await parkedPaperTicket(t, 'DRV1');
    const ra = ok(await requestRetrieval(t, 'SUP-R', a.ticketId), 201); // single to DRV3
    ok(await accept(t, 'DRV3', (await liveOffer(t.db, U.DRV3))!.id));
    const rc = ok(await requestRetrieval(t, 'SUP-R', c.ticketId), 201); // single to DRV1
    expect((await liveOffer(t.db, U.DRV1))?.task_id).toBe(rc.task.id);
    // A goes back to the queue with its older priority; DRV1 (the only one who could act) is held by C
    ok(await reassign(t, 'SUP-R', ra.task.id, { reason: 'السائق متأخر', target_driver_id: null }));
    expect((await one(t.db, `SELECT status FROM tasks WHERE id = $1`, [ra.task.id])).status).toBe('queued');
    expect(ok(await accept(t, 'DRV1', (await liveOffer(t.db, U.DRV1))!.id)).result).toBe('accepted');
    await expectConsistent(t.db);
  });
});

describe('PNT-057 — escalation and waiting alerts (server timers, no client connected)', () => {
  let t: TestApp;
  let worker: OutboxDispatcher;
  beforeEach(async () => {
    t = await createS2App();
    worker = s4Worker(t);
  });
  afterEach(async () => t.close());

  it('job.escalate_unaccepted at queued_at + 60 s: request_unaccepted (critical) once, task.escalated; the request stays; the claim resolves it', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    const p = await parkedPaperTicket(t, 'DRV1');
    await newDraft(t, 'DRV1');
    const req = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    expect(req.task.status).toBe('broadcast');
    t.clock.advanceSeconds(59);
    await worker.drain();
    expect((await rows(t.db, `SELECT 1 FROM alerts WHERE type = 'request_unaccepted'`)).length).toBe(0);
    t.clock.advanceSeconds(1);
    await worker.drain();
    const alert = await one(t.db, `SELECT * FROM alerts WHERE dedupe_key = $1`, [
      `request_unaccepted:${req.task.id}`,
    ]);
    expect(alert).toMatchObject({
      type: 'request_unaccepted',
      severity: 'critical',
      status: 'open',
      task_id: req.task.id,
      ticket_id: p.ticketId,
    });
    expect(alert.details).toMatchObject({ display_number: p.displayNumber, waited_s: 60, mode: 'broadcast' });
    expect((await outboxEvents(t.db, 'task.escalated')).map((e) => e.payload.payload)).toEqual([
      expect.objectContaining({
        task_id: req.task.id,
        waited_s: 60,
        on_duty_count: 1,
        mode_at_escalation: 'broadcast',
      }),
    ]);
    const task = await one(t.db, `SELECT status, escalated_at, version FROM tasks WHERE id = $1`, [
      req.task.id,
    ]);
    expect(task).toMatchObject({ status: 'broadcast', escalated_at: t.clock.now() });
    t.clock.advanceSeconds(120);
    await worker.drain();
    expect((await rows(t.db, `SELECT id FROM alerts WHERE type = 'request_unaccepted'`)).length).toBe(1);
    ok(await accept(t, 'DRV1', (await liveOffer(t.db, U.DRV1))!.id));
    expect(await one(t.db, `SELECT status, resolved_by FROM alerts WHERE id = $1`, [alert.id])).toEqual({
      status: 'resolved',
      resolved_by: null,
    });
    await expectConsistent(t.db);
  });

  it('a requeued task starts a new episode: the old timer is stale, the new one fires 60 s after the new queued_at', async () => {
    ok(await startDuty(t, 'DRV2'), 201);
    t.clock.advanceSeconds(1);
    ok(await startDuty(t, 'DRV1'), 201);
    const p = await parkedPaperTicket(t, 'DRV1');
    const req = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    ok(await accept(t, 'DRV2', (await liveOffer(t.db, U.DRV2))!.id));
    t.clock.advanceSeconds(30);
    ok(await reassign(t, 'SUP-R', req.task.id, { reason: 'السائق متأخر', target_driver_id: null }));
    expect(
      (
        await rows(
          t.db,
          `SELECT dedupe_key FROM outbox_events WHERE type = 'job.escalate_unaccepted' ORDER BY seq`,
        )
      ).length,
    ).toBe(2);
    t.clock.advanceSeconds(31); // 61 s after the first queued_at, 31 s after the second
    await worker.drain();
    expect((await rows(t.db, `SELECT 1 FROM alerts WHERE type = 'request_unaccepted'`)).length).toBe(0);
    t.clock.advanceSeconds(29);
    await worker.drain();
    expect((await rows(t.db, `SELECT 1 FROM alerts WHERE type = 'request_unaccepted'`)).length).toBe(1);
  });

  it('next_task_waiting_long after 300 s and idle_driver_while_next_waiting while a driver is idle; both resolved by the promotion', async () => {
    for (const d of ['DRV1', 'DRV2']) ok(await startDuty(t, d), 201);
    const p = await parkedPaperTicket(t, 'DRV2');
    const draft = await paperTicketInParking(t, 'DRV1');
    const d2 = await newDraft(t, 'DRV2');
    const req = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    ok(await accept(t, 'DRV1', (await liveOffer(t.db, U.DRV1))!.id)); // DRV1 reserves it
    // DRV2 discards his empty draft: available while the oldest request is reserved → advisory alert (10 §4.7)
    ok(await t.command('post', `/v1/tickets/${d2.ticketId}/discard-draft`, { as: 'DRV2', body: {} }));
    const idle = await one(t.db, `SELECT * FROM alerts WHERE dedupe_key = $1`, [
      `idle_driver_while_next_waiting:${req.task.id}`,
    ]);
    expect(idle).toMatchObject({ severity: 'warning', status: 'open', task_id: req.task.id });
    expect(idle.details).toMatchObject({ idle_driver_ids: [U.DRV2], reserved_by: U.DRV1 });
    t.clock.advanceSeconds(300);
    await worker.drain();
    const waiting = await one(t.db, `SELECT * FROM alerts WHERE dedupe_key = $1`, [
      `next_task_waiting_long:${req.task.id}`,
    ]);
    expect(waiting).toMatchObject({ severity: 'warning', status: 'open', user_id: U.DRV1 });
    // never reassigned silently
    expect(await one(t.db, `SELECT status, assignee_id FROM tasks WHERE id = $1`, [req.task.id])).toEqual({
      status: 'assigned_waiting',
      assignee_id: U.DRV1,
    });
    ok(
      await completeParking(t, 'DRV1', draft.taskId, {
        parking_spot_id: nextSpot(),
        key_slot_id: nextSlot(),
      }),
    );
    expect(
      (
        await rows(t.db, `SELECT dedupe_key, status FROM alerts WHERE task_id = $1 ORDER BY dedupe_key`, [
          req.task.id,
        ])
      ).map((a) => [a.dedupe_key.split(':')[0], a.status]),
    ).toEqual([
      ['idle_driver_while_next_waiting', 'resolved'],
      ['next_task_waiting_long', 'resolved'],
    ]);
    await expectConsistent(t.db);
  });

  it('no_drivers_on_duty immediately at the request, with ws alert.raised for the supervisors', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    const p = await parkedPaperTicket(t, 'DRV1');
    ok(await t.command('post', '/v1/me/duty/end', { as: 'DRV1', body: {} }));
    const ws = await captureRealtime(t);
    ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    expect(
      await one(t.db, `SELECT severity, status FROM alerts WHERE dedupe_key = $1`, [
        `no_drivers_on_duty:${POOL_R}`,
      ]),
    ).toEqual({ severity: 'critical', status: 'open' });
    await ws.settle();
    expect(ws.of('alert.raised').map((m) => m.message.data.type)).toEqual(['no_drivers_on_duty']);
    await ws.stop();
  });
});
