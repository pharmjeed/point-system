import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OutboxDispatcher } from '@point/server';
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
  parkedPaperTicket,
  requestRetrieval,
  rows,
  slot,
  startDuty,
  startRetrieval,
  U,
} from './dispatch-fixtures.js';
import {
  brk,
  cancelCycle,
  captureRealtime,
  linkWhatsapp,
  reassign,
  releaseCustody,
  repark,
  requestedTicket,
  s4Worker,
  threeDrivers,
  whatsappNotifications,
} from './dispatch-s4-fixtures.js';

const DUMMY = '00000000-0000-4000-8000-0000deadbeef';
const taskRow = (t: TestApp, id: string) => one(t.db, `SELECT * FROM tasks WHERE id = $1`, [id]);
const ticketRow = (t: TestApp, id: string) => one(t.db, `SELECT * FROM tickets WHERE id = $1`, [id]);
const custodyCount = async (t: TestApp, ticketId: string) =>
  (
    await one<{ n: number }>(t.db, `SELECT count(*)::int AS n FROM custody_events WHERE ticket_id = $1`, [
      ticketId,
    ])
  ).n;

/** DRV3 accepted the retrieval of a ticket parked by DRV1 (DRV2 idle). */
async function acceptedByDrv3(t: TestApp) {
  const r = await requestedTicket(t, 'DRV1');
  ok(await accept(t, 'DRV3', (await liveOffer(t.db, U.DRV3))!.id));
  return r;
}

describe('PNT-058 — POST /v1/tasks/{taskId}/reassign', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    await threeDrivers(t);
  });
  afterEach(async () => t.close());

  it('to the queue: task.withdrawn, a new episode with the original priority and its escalation, the previous driver settled, audit with the reason', async () => {
    const r = await acceptedByDrv3(t);
    const before = await taskRow(t, r.retrieveTaskId);
    const ws = await captureRealtime(t);
    t.clock.advanceSeconds(20);
    const res = ok(
      await reassign(t, 'SUP-R', r.retrieveTaskId, { reason: 'السائق متأخر', target_driver_id: null }),
    );
    expect(res.ticket.status).toBe('requested');
    const after = await taskRow(t, r.retrieveTaskId);
    expect(after.priority_at).toEqual(before.priority_at);
    expect(after.queued_at).toEqual(t.clock.now());
    expect(after.assignee_id).toBeNull();
    // the pass offered it to the longest idle untried driver: DRV2 (DRV3 is a previous acceptor)
    expect((await liveOffer(t.db, U.DRV2))?.task_id).toBe(r.retrieveTaskId);
    expect((await outboxEvents(t.db, 'task.withdrawn')).map((e) => e.payload.payload)).toEqual([
      expect.objectContaining({
        task_id: r.retrieveTaskId,
        from_assignee_id: U.DRV3,
        previous_status: 'accepted',
        reason: 'السائق متأخر',
        trigger: 'supervisor',
        key_was_picked_up: false,
      }),
    ]);
    const timers = await rows(
      t.db,
      `SELECT dedupe_key, available_at FROM outbox_events WHERE type = 'job.escalate_unaccepted' ORDER BY seq`,
    );
    expect(timers.at(-1)!.dedupe_key).toBe(
      `escalate_unaccepted:${r.retrieveTaskId}:${t.clock.now().getTime()}`,
    );
    // DRV3 is available again and sees the task left him
    expect(
      (
        await one(
          t.db,
          `SELECT available_since FROM duty_sessions WHERE user_id = $1 AND status = 'on_duty'`,
          [U.DRV3],
        )
      ).available_since,
    ).toEqual(t.clock.now());
    await ws.settle();
    const toPrevious = ws.of('task.updated', `user:${U.DRV3}`);
    expect(toPrevious[0]!.message.data).toMatchObject({
      cause: 'task.withdrawn',
      id: r.retrieveTaskId,
      assignee: null,
    });
    const audit = await one(t.db, `SELECT reason, metadata FROM audit_log WHERE action = 'task.reassign'`);
    expect(audit).toMatchObject({
      reason: 'السائق متأخر',
      metadata: {
        target: 'queue',
        previous_assignee_id: U.DRV3,
        operation: 'POST /v1/tasks/{taskId}/reassign',
      },
    });
    await expectConsistent(t.db);
    await ws.stop();
  });

  it('to a driver: available → accepted (the previous driver settled); busy → assigned_waiting; the live round is revoked (reassigned)', async () => {
    const r = await requestedTicket(t, 'DRV1'); // single to DRV3
    const single = (await liveOffer(t.db, U.DRV3))!;
    const res = ok(
      await reassign(t, 'SUP-R', r.retrieveTaskId, { reason: 'أقرب للموقف', target_driver_id: U.DRV2 }),
    );
    expect(res.task).toMatchObject({ status: 'accepted', assignee: { id: U.DRV2 } });
    expect(res.ticket.status).toBe('assigned');
    expect(
      await one(t.db, `SELECT status, close_reason FROM task_offers WHERE id = $1`, [single.id]),
    ).toEqual({
      status: 'revoked',
      close_reason: 'reassigned',
    });
    expect((await outboxEvents(t.db, 'ticket.assigned')).at(-1)!.payload.payload).toMatchObject({
      assignee_id: U.DRV2,
      via: 'supervisor',
    });
    // a busy target gets it as his next task
    await newDraft(t, 'DRV1');
    const res2 = ok(
      await reassign(t, 'SUP-R', r.retrieveTaskId, { reason: 'إعادة توزيع', target_driver_id: U.DRV1 }),
    );
    expect(res2.task).toMatchObject({ status: 'assigned_waiting', assignee: { id: U.DRV1 } });
    expect(res2.ticket.status).toBe('assigned_waiting');
    // DRV2 lost his current task: available again
    expect(
      (
        await one(
          t.db,
          `SELECT available_since FROM duty_sessions WHERE user_id = $1 AND status = 'on_duty'`,
          [U.DRV2],
        )
      ).available_since,
    ).toEqual(t.clock.now());
    expect((await outboxEvents(t.db, 'task.reassigned')).map((e) => e.payload.payload)).toEqual([
      expect.objectContaining({ from_assignee_id: null, to_assignee_id: U.DRV2, result_status: 'accepted' }),
      expect.objectContaining({
        from_assignee_id: U.DRV2,
        to_assignee_id: U.DRV1,
        result_status: 'assigned_waiting',
      }),
    ]);
    expect(await auditCount(t.db, 'task.reassign', r.retrieveTaskId)).toBe(2);
    await expectConsistent(t.db);
  });

  it('REASSIGN_BLOCKED_MOVEMENT after the start; CUSTODY_RELEASE_REQUIRED with the key; REASON_REQUIRED; target errors', async () => {
    const r = await acceptedByDrv3(t);
    expect(
      err(await reassign(t, 'SUP-R', r.retrieveTaskId, { target_driver_id: null }), 'REASON_REQUIRED', 422),
    ).toEqual({
      field: 'reason',
      min_length: 3,
    });
    err(
      await reassign(t, 'SUP-R', r.retrieveTaskId, { reason: 'ab', target_driver_id: null }),
      'REASON_REQUIRED',
      422,
    );
    err(
      await reassign(t, 'DRV2', r.retrieveTaskId, { reason: 'سبب كاف', target_driver_id: null }),
      'PERMISSION_DENIED',
      403,
    );
    err(
      await reassign(t, 'SUP-R', DUMMY, { reason: 'سبب كاف', target_driver_id: null }),
      'RESOURCE_NOT_FOUND',
      404,
    );
    // target on break → DRIVER_NOT_AVAILABLE; off duty → DUTY_REQUIRED; another pool → DUTY_REQUIRED
    ok(await brk(t, 'DRV2', true));
    err(
      await reassign(t, 'SUP-R', r.retrieveTaskId, { reason: 'سبب كاف', target_driver_id: U.DRV2 }),
      'DRIVER_NOT_AVAILABLE',
      409,
    );
    err(
      await reassign(t, 'SUP-R', r.retrieveTaskId, { reason: 'سبب كاف', target_driver_id: U.DRV5 }),
      'DUTY_REQUIRED',
      409,
    );
    ok(await startDuty(t, 'DRV7'), 201);
    err(
      await reassign(t, 'SUP-R', r.retrieveTaskId, { reason: 'سبب كاف', target_driver_id: U.DRV7 }),
      'DUTY_REQUIRED',
      409,
    );
    // key picked up: release first
    ok(await keyPickup(t, 'DRV3', r.retrieveTaskId, r.slotId));
    expect(
      err(
        await reassign(t, 'SUP-R', r.retrieveTaskId, { reason: 'سبب كاف', target_driver_id: null }),
        'CUSTODY_RELEASE_REQUIRED',
        409,
      ),
    ).toEqual({ task_id: r.retrieveTaskId, key_holder_id: U.DRV3 });
    ok(await startRetrieval(t, 'DRV3', r.retrieveTaskId));
    expect(
      err(
        await reassign(t, 'SUP-R', r.retrieveTaskId, { reason: 'سبب كاف', target_driver_id: null }),
        'REASSIGN_BLOCKED_MOVEMENT',
        409,
      ),
    ).toEqual({ task_id: r.retrieveTaskId, started_at: t.clock.now().toISOString() });
    err(
      await reassign(t, 'SUP-R', r.retrieveTaskId, {
        reason: 'سبب كاف',
        target_driver_id: null,
        expected_version: 1,
      }),
      'VERSION_CONFLICT',
      409,
    );
  });

  it('NEXT_TASK_ALREADY_RESERVED for a target busy with a next task; a queued request cannot go "to the queue"', async () => {
    const r = await requestedTicket(t, 'DRV1'); // single to DRV3
    ok(await accept(t, 'DRV3', (await liveOffer(t.db, U.DRV3))!.id));
    const r2 = await requestedTicket(t, 'DRV1'); // single to DRV2
    await newDraft(t, 'DRV1');
    ok(await reassign(t, 'SUP-R', r2.retrieveTaskId, { reason: 'إعادة توزيع', target_driver_id: U.DRV1 }));
    const r3 = await (async () => {
      ok(await startDuty(t, 'DRV4'), 201);
      return requestedTicket(t, 'DRV4');
    })();
    expect(
      err(
        await reassign(t, 'SUP-R', r3.retrieveTaskId, { reason: 'إعادة توزيع', target_driver_id: U.DRV1 }),
        'NEXT_TASK_ALREADY_RESERVED',
        409,
      ),
    ).toEqual({ next_task_id: r2.retrieveTaskId });
    expect(
      err(
        await reassign(t, 'SUP-R', r3.retrieveTaskId, { reason: 'إعادة توزيع', target_driver_id: null }),
        'INVALID_STATE_TRANSITION',
        409,
      ).reason,
    ).toBe('already_in_queue');
    void r;
  });
});

describe('PNT-058 — POST /v1/tasks/{taskId}/release-custody', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    await threeDrivers(t);
  });
  afterEach(async () => t.close());

  it('the key back in a slot (withdrawal_release), key_picked_up_at cleared, the task stays his; then the withdrawal is allowed', async () => {
    const r = await acceptedByDrv3(t);
    ok(await keyPickup(t, 'DRV3', r.retrieveTaskId, r.slotId));
    err(
      await releaseCustody(t, 'DRV2', r.retrieveTaskId, { key_slot_id: r.slotId, reason: 'إعادة المفتاح' }),
      'NOT_TASK_ASSIGNEE',
      403,
    );
    const occupied = await parkedPaperTicket(t, 'DRV1');
    err(
      await releaseCustody(t, 'SUP-R', r.retrieveTaskId, {
        key_slot_id: occupied.slotId,
        reason: 'إعادة المفتاح',
      }),
      'KEY_SLOT_OCCUPIED',
      409,
    );
    err(
      await releaseCustody(t, 'SUP-R', r.retrieveTaskId, { key_slot_id: r.slotId }),
      'REASON_REQUIRED',
      422,
    );
    const ws = await captureRealtime(t);
    const res = ok(
      await releaseCustody(t, 'DRV3', r.retrieveTaskId, { key_slot_id: slot(55), reason: 'سحب المهمة' }),
    );
    expect(res).toMatchObject({
      id: r.retrieveTaskId,
      status: 'accepted',
      key_picked_up_at: null,
      assignee: { id: U.DRV3 },
    });
    expect(await ticketRow(t, r.ticketId)).toMatchObject({
      key_holder_type: 'key_slot',
      key_holder_id: slot(55),
      current_key_slot_id: slot(55),
    });
    expect(
      await one(
        t.db,
        `SELECT subject, from_holder_type, from_holder_id, to_holder_type, to_holder_id, task_id, actor_id
           FROM custody_events WHERE ticket_id = $1 AND reason = 'withdrawal_release'`,
        [r.ticketId],
      ),
    ).toEqual({
      subject: 'key',
      from_holder_type: 'driver',
      from_holder_id: U.DRV3,
      to_holder_type: 'key_slot',
      to_holder_id: slot(55),
      task_id: r.retrieveTaskId,
      actor_id: U.DRV3,
    });
    expect(
      (
        await one(
          t.db,
          `SELECT count(*)::int AS n FROM key_slot_allocations WHERE key_slot_id = $1 AND released_at IS NULL`,
          [slot(55)],
        )
      ).n,
    ).toBe(1);
    expect(await auditCount(t.db, 'task.release_custody', r.retrieveTaskId)).toBe(1);
    await ws.settle();
    expect(ws.of('task.updated', `user:${U.DRV3}`)[0]!.message.data).toMatchObject({
      cause: 'custody.changed',
      task: { id: r.retrieveTaskId, key_picked_up_at: null },
      key_slot: { id: slot(55) },
    });
    // the driver keeps the task and his availability; now the withdrawal works
    expect((await taskRow(t, r.retrieveTaskId)).assignee_id).toBe(U.DRV3);
    ok(await reassign(t, 'SUP-R', r.retrieveTaskId, { reason: 'السائق متأخر', target_driver_id: null }));
    err(
      await releaseCustody(t, 'SUP-R', r.retrieveTaskId, { key_slot_id: slot(56), reason: 'مرة ثانية' }),
      'INVALID_STATE_TRANSITION',
      409,
    );
    await expectConsistent(t.db);
    await ws.stop();
  });
});

describe('PNT-059 — POST /v1/retrieval-cycles/{cycleId}/cancel', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    await threeDrivers(t);
  });
  afterEach(async () => t.close());

  it('requested: a driver on duty cancels (customer_field_cancel) — round revoked, cycle canceled, ticket parked, W-07 when told', async () => {
    const p = await parkedPaperTicket(t, 'DRV1');
    await linkWhatsapp(t, p.ticketId);
    const req = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    const offer = (await liveOffer(t.db, U.DRV3))!;
    const res = ok(await cancelCycle(t, 'DRV1', req.cycle.id));
    expect(res.ticket.status).toBe('parked');
    expect(res.cycle).toMatchObject({ id: req.cycle.id, outcome: 'canceled' });
    expect(res.repark_task).toBeNull();
    expect(await one(t.db, `SELECT status, close_reason FROM task_offers WHERE id = $1`, [offer.id])).toEqual(
      {
        status: 'revoked',
        close_reason: 'task_canceled',
      },
    );
    expect(await taskRow(t, req.task.id)).toMatchObject({
      status: 'canceled',
      cancel_reason: 'customer_field_cancel',
    });
    expect((await whatsappNotifications(t, p.ticketId)).map((n) => n.purpose)).toEqual(['W-02', 'W-07']);
    // the next request is a new cycle (cycle_no + 1)
    const again = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    expect(again.cycle.cycle_no).toBe(2);
    await expectConsistent(t.db);
  });

  it('after assignment a driver gets INVALID_STATE_TRANSITION (driver_cancel_after_assignment); the supervisor cancels and the driver is settled', async () => {
    const r = await acceptedByDrv3(t);
    err(await cancelCycle(t, 'DRV5', r.cycleId), 'DUTY_REQUIRED', 409); // a driver of the venue, off duty
    expect(err(await cancelCycle(t, 'DRV1', r.cycleId), 'INVALID_STATE_TRANSITION', 409).reason).toBe(
      'driver_cancel_after_assignment',
    );
    err(await cancelCycle(t, 'DRV3', r.cycleId, 'x'), 'REASON_REQUIRED', 422);
    ok(await keyPickup(t, 'DRV3', r.retrieveTaskId, r.slotId));
    err(await cancelCycle(t, 'SUP-R', r.cycleId), 'CUSTODY_RELEASE_REQUIRED', 409);
    ok(await releaseCustody(t, 'DRV3', r.retrieveTaskId, { key_slot_id: r.slotId, reason: 'إلغاء الطلب' }));
    const res = ok(await cancelCycle(t, 'SUP-R', r.cycleId));
    expect(res.ticket.status).toBe('parked');
    expect(await taskRow(t, r.retrieveTaskId)).toMatchObject({
      status: 'canceled',
      cancel_reason: 'supervisor_cancel',
    });
    expect(
      (
        await one(
          t.db,
          `SELECT available_since FROM duty_sessions WHERE user_id = $1 AND status = 'on_duty'`,
          [U.DRV3],
        )
      ).available_since,
    ).toEqual(t.clock.now());
    expect(await auditCount(t.db, 'retrieval.cancel', r.cycleId)).toBe(1);
    err(await cancelCycle(t, 'SUP-R', r.cycleId), 'INVALID_STATE_TRANSITION', 409);
    err(await cancelCycle(t, 'SUP-R', DUMMY), 'RESOURCE_NOT_FOUND', 404);
    ok(await startDuty(t, 'DRV7'), 201);
    err(await cancelCycle(t, 'DRV7', r.cycleId), 'RESOURCE_NOT_FOUND', 404);
    await expectConsistent(t.db);
  });

  it('AC-11 / TT-20b: cancel after the start → repark for the same driver, no release, no custody event, code revoked, W-07 only', async () => {
    const p = await parkedPaperTicket(t, 'DRV1');
    await linkWhatsapp(t, p.ticketId);
    t.clock.advanceSeconds(1);
    const req = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    ok(await accept(t, 'DRV3', (await liveOffer(t.db, U.DRV3))!.id));
    const r = { ...p, retrieveTaskId: req.task.id as string, cycleId: req.cycle.id as string };
    ok(await keyPickup(t, 'DRV3', r.retrieveTaskId, r.slotId));
    ok(await startRetrieval(t, 'DRV3', r.retrieveTaskId));
    // a live handover code (PNT-047 issues it at ready; here an equivalent row)
    await t.db.query(
      `INSERT INTO claim_codes (org_id, ticket_id, cycle_id, code_hash, code_ciphertext, expires_at)
       SELECT org_id, id, $2, 'h', 'c', now() + interval '1 hour' FROM tickets WHERE id = $1`,
      [r.ticketId, r.cycleId],
    );
    const custodyBefore = await custodyCount(t, r.ticketId);
    err(await cancelCycle(t, 'DRV3', r.cycleId), 'INVALID_STATE_TRANSITION', 409);
    const res = ok(await cancelCycle(t, 'SUP-R', r.cycleId, 'العميل غادر'));
    expect(res.ticket.status).toBe('reparking');
    expect(res.cycle).toMatchObject({ outcome: 'canceled' });
    expect(res.repark_task).toMatchObject({
      type: 'repark',
      status: 'in_progress',
      assignee: { id: U.DRV3 },
    });
    expect(await taskRow(t, r.retrieveTaskId)).toMatchObject({
      status: 'canceled',
      cancel_reason: 'supervisor_cancel',
    });
    expect(
      (
        await one(
          t.db,
          `SELECT available_since FROM duty_sessions WHERE user_id = $1 AND status = 'on_duty'`,
          [U.DRV3],
        )
      ).available_since,
    ).toBeNull();
    expect(await custodyCount(t, r.ticketId)).toBe(custodyBefore);
    expect(await ticketRow(t, r.ticketId)).toMatchObject({
      vehicle_holder_type: 'driver',
      vehicle_holder_id: U.DRV3,
      key_holder_type: 'driver',
      key_holder_id: U.DRV3,
      active_cycle_id: null,
    });
    expect(
      await one(
        t.db,
        `SELECT revoked_at IS NOT NULL AS r, revoke_reason, code_ciphertext FROM claim_codes WHERE cycle_id = $1`,
        [r.cycleId],
      ),
    ).toEqual({ r: true, revoke_reason: 'canceled', code_ciphertext: null });
    expect((await outboxEvents(t.db, 'ticket.reparking')).map((e) => e.payload.payload)).toEqual([
      expect.objectContaining({
        closed_cycle_id: r.cycleId,
        assignee_id: U.DRV3,
        cause: 'supervisor_cancel',
      }),
    ]);
    const sent = (await whatsappNotifications(t, r.ticketId)).map((n) => n.purpose);
    expect(sent).toEqual(['W-02', 'W-04', 'W-07']); // W-07 only, never W-08 (DEC-42)
    // the driver parks it again: only then available, no message to the customer
    const done = ok(
      await completeParking(t, 'DRV3', res.repark_task.id, {
        parking_spot_id: nextSpot(),
        key_slot_id: nextSlot(),
      }),
    );
    expect(done.ticket.status).toBe('parked');
    expect(done.driver.driver_state).toBe('available');
    expect((await whatsappNotifications(t, r.ticketId)).map((n) => n.purpose)).toEqual(sent);
    await expectConsistent(t.db);
  });
});

describe('PNT-061 — ready not collected and POST /v1/tickets/{ticketId}/repark', () => {
  let t: TestApp;
  let worker: OutboxDispatcher;
  beforeEach(async () => {
    t = await createS2App();
    worker = s4Worker(t);
    await threeDrivers(t);
  });
  afterEach(async () => t.close());

  async function readyByDrv3() {
    const r = await acceptedByDrv3(t);
    ok(await keyPickup(t, 'DRV3', r.retrieveTaskId, r.slotId));
    ok(await startRetrieval(t, 'DRV3', r.retrieveTaskId));
    ok(await markReady(t, 'DRV3', r.retrieveTaskId));
    return r;
  }

  it('ready_not_collected after 10 min; repark: cycle reparked with its times kept, repark task for the holder, W-08, incident; the next request is cycle 2', async () => {
    const r = await readyByDrv3();
    await linkWhatsapp(t, r.ticketId);
    err(await repark(t, 'SUP-R', r.ticketId, {}), 'REASON_REQUIRED', 422);
    t.clock.advanceSeconds(599);
    await worker.drain();
    expect((await rows(t.db, `SELECT 1 FROM alerts WHERE type = 'ready_not_collected'`)).length).toBe(0);
    t.clock.advanceSeconds(1);
    await worker.drain();
    const alert = await one(t.db, `SELECT * FROM alerts WHERE dedupe_key = $1`, [
      `ready_not_collected:${r.cycleId}`,
    ]);
    expect(alert).toMatchObject({
      severity: 'warning',
      status: 'open',
      ticket_id: r.ticketId,
      user_id: U.DRV3,
    });
    const cycleBefore = await one(t.db, `SELECT * FROM retrieval_cycles WHERE id = $1`, [r.cycleId]);
    err(
      await repark(t, 'SUP-R', r.ticketId, { reason: 'العميل لم يحضر', expected_version: 1 }),
      'VERSION_CONFLICT',
      409,
    );
    const res = ok(await repark(t, 'SUP-R', r.ticketId, { reason: 'العميل لم يحضر' }));
    expect(res.ticket).toMatchObject({ id: r.ticketId, status: 'reparking' });
    expect(res.task).toMatchObject({ type: 'repark', status: 'in_progress', assignee: { id: U.DRV3 } });
    const cycle = await one(t.db, `SELECT * FROM retrieval_cycles WHERE id = $1`, [r.cycleId]);
    expect(cycle).toMatchObject({
      outcome: 'reparked',
      reparked_at: t.clock.now(),
      closed_at: t.clock.now(),
      requested_at: cycleBefore.requested_at,
      started_at: cycleBefore.started_at,
      ready_at: cycleBefore.ready_at,
      canceled_at: null,
    });
    expect(await taskRow(t, r.retrieveTaskId)).toMatchObject({
      status: 'canceled',
      cancel_reason: 'repark_customer_absent',
    });
    expect((await one(t.db, `SELECT status FROM alerts WHERE id = $1`, [alert.id])).status).toBe('resolved');
    expect((await whatsappNotifications(t, r.ticketId)).map((n) => n.purpose)).toEqual(['W-08']);
    expect(
      await one(t.db, `SELECT type, status, ticket_id FROM incidents WHERE ticket_id = $1`, [r.ticketId]),
    ).toEqual({
      type: 'customer_absent',
      status: 'resolved',
      ticket_id: r.ticketId,
    });
    err(await repark(t, 'SUP-R', r.ticketId, { reason: 'مرة ثانية' }), 'INVALID_STATE_TRANSITION', 409);
    // complete-parking of the repark: parked, no message; the next request opens cycle_no 2
    ok(
      await completeParking(t, 'DRV3', res.task.id, { parking_spot_id: nextSpot(), key_slot_id: nextSlot() }),
    );
    expect((await whatsappNotifications(t, r.ticketId)).map((n) => n.purpose)).toEqual(['W-08']);
    const again = ok(await requestRetrieval(t, 'SUP-R', r.ticketId), 201);
    expect(again.cycle.cycle_no).toBe(2);
    await expectConsistent(t.db);
  });

  it('repark: INVALID_STATE_TRANSITION from a non-ready ticket; TICKET_NOT_FOUND; supervisor only', async () => {
    const r = await acceptedByDrv3(t);
    err(await repark(t, 'SUP-R', r.ticketId), 'INVALID_STATE_TRANSITION', 409);
    err(await repark(t, 'SUP-R', DUMMY), 'TICKET_NOT_FOUND', 404);
    err(await repark(t, 'DRV3', r.ticketId), 'PERMISSION_DENIED', 403);
  });

  it('CUSTODY_HOLDER_MISMATCH when the key or the vehicle is not with the task driver: release-custody, cancel after the start and repark change nothing', async () => {
    const r = await acceptedByDrv3(t);
    ok(await keyPickup(t, 'DRV3', r.retrieveTaskId, r.slotId));
    // a split custody (only a formal custody transfer of one item, PNT-083, could leave it so)
    const holders = (sql: string, id: string) => t.db.query(sql, [r.ticketId, id]);
    await holders(`UPDATE tickets SET key_holder_id = $2 WHERE id = $1`, U.DRV2);
    expect(
      err(
        await releaseCustody(t, 'DRV3', r.retrieveTaskId, { key_slot_id: slot(55), reason: 'إعادة المفتاح' }),
        'CUSTODY_HOLDER_MISMATCH',
        409,
      ),
    ).toEqual({ subject: 'key', current_holder_type: 'driver' });
    await holders(`UPDATE tickets SET key_holder_id = $2 WHERE id = $1`, U.DRV3);
    ok(await startRetrieval(t, 'DRV3', r.retrieveTaskId));
    await holders(`UPDATE tickets SET vehicle_holder_id = $2 WHERE id = $1`, U.DRV2);
    expect(err(await cancelCycle(t, 'SUP-R', r.cycleId), 'CUSTODY_HOLDER_MISMATCH', 409)).toEqual({
      subject: 'vehicle',
      current_holder_type: 'driver',
    });
    await holders(`UPDATE tickets SET vehicle_holder_id = $2 WHERE id = $1`, U.DRV3);
    ok(await markReady(t, 'DRV3', r.retrieveTaskId));
    await holders(
      `UPDATE tickets SET key_holder_type = 'key_slot', key_holder_id = $2 WHERE id = $1`,
      slot(55),
    );
    expect(
      err(await repark(t, 'SUP-R', r.ticketId, { reason: 'العميل لم يحضر' }), 'CUSTODY_HOLDER_MISMATCH', 409),
    ).toEqual({ subject: 'key', current_holder_type: 'key_slot' });
    expect(await taskRow(t, r.retrieveTaskId)).toMatchObject({ status: 'in_progress', assignee_id: U.DRV3 });
    expect(await ticketRow(t, r.ticketId)).toMatchObject({ status: 'ready', active_cycle_id: r.cycleId });
    expect(await auditCount(t.db, 'ticket.repark', r.ticketId)).toBe(0);
    expect(await auditCount(t.db, 'retrieval.cancel', r.cycleId)).toBe(0);
  });

  it('the delivered ticket resolves ready_not_collected; a stale ready check is a no-op', async () => {
    const r = await readyByDrv3();
    ok(
      await handover(t, 'DRV3', r.ticketId, {
        verification: { method: 'paper_stub', paper_serial: r.serial },
      }),
    );
    t.clock.advanceSeconds(700);
    await worker.drain();
    expect((await rows(t.db, `SELECT 1 FROM alerts WHERE type = 'ready_not_collected'`)).length).toBe(0);
    await expectConsistent(t.db);
  });
});
