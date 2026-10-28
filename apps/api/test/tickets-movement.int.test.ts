import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  accept,
  createS2App,
  err,
  EVT_R2,
  expectConsistent,
  handover,
  keyPickup,
  liveOffer,
  markReady,
  newDraft,
  ok,
  one,
  openBroadcastBySql,
  outboxEvents,
  parkedPaperTicket,
  requestRetrieval,
  rows,
  slot,
  startDuty,
  startRetrieval,
  U,
} from './dispatch-fixtures.js';

const DUMMY = '00000000-0000-4000-8000-0000deadbeef';

/** DRV1 (longest idle) accepts the retrieval of a paper ticket parked by DRV2. */
async function assigned(t: TestApp, opts: { eventId?: string } = {}) {
  const p = await parkedPaperTicket(t, 'DRV2', opts);
  t.clock.advanceSeconds(1);
  const r = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
  const offer = (await liveOffer(t.db, U.DRV1))!;
  expect(offer.task_id).toBe(r.task.id);
  ok(await accept(t, 'DRV1', offer.id));
  return { ...p, retrieveTaskId: r.task.id as string, cycleId: r.cycle.id as string };
}

async function readyTicket(t: TestApp, opts: { eventId?: string } = {}) {
  const a = await assigned(t, opts);
  ok(await keyPickup(t, 'DRV1', a.retrieveTaskId, a.slotId));
  ok(await startRetrieval(t, 'DRV1', a.retrieveTaskId));
  ok(await markReady(t, 'DRV1', a.retrieveTaskId));
  return a;
}

describe('PNT-033 — key-pickup, start-retrieval, ready', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV2'), 201);
  });
  afterEach(async () => t.close());

  it('key-pickup: key slot → driver (key_pickup), allocation released, task.key_picked_up', async () => {
    const a = await assigned(t);
    t.clock.advanceSeconds(4);
    const card = ok(await keyPickup(t, 'DRV1', a.retrieveTaskId, a.slotId));
    expect(card.task).toMatchObject({
      id: a.retrieveTaskId,
      status: 'accepted',
      key_picked_up_at: t.clock.now().toISOString(),
    });
    expect(card.key_slot).toBeNull(); // the key left the board
    expect(card.parking).toMatchObject({ spot_label: expect.any(String), zone_name: expect.any(String) });
    expect(
      await one(
        t.db,
        `SELECT key_holder_type, key_holder_id, current_key_slot_id FROM tickets WHERE id = $1`,
        [a.ticketId],
      ),
    ).toEqual({
      key_holder_type: 'driver',
      key_holder_id: U.DRV1,
      current_key_slot_id: null,
    });
    expect(
      await one(t.db, `SELECT release_reason, released_by FROM key_slot_allocations WHERE ticket_id = $1`, [
        a.ticketId,
      ]),
    ).toEqual({
      release_reason: 'key_pickup',
      released_by: U.DRV1,
    });
    const c = await one(
      t.db,
      `SELECT from_holder_type, from_holder_id, to_holder_id FROM custody_events WHERE ticket_id = $1 AND reason = 'key_pickup'`,
      [a.ticketId],
    );
    expect(c).toEqual({ from_holder_type: 'key_slot', from_holder_id: a.slotId, to_holder_id: U.DRV1 });
    expect((await outboxEvents(t.db, 'task.key_picked_up')).map((e) => e.payload.payload)).toEqual([
      { task_id: a.retrieveTaskId, ticket_id: a.ticketId, assignee_id: U.DRV1, key_slot_id: a.slotId },
    ]);
    // a second pickup, another slot, another driver, a stale version or an unknown task are refused
    expect(
      err(await keyPickup(t, 'DRV1', a.retrieveTaskId, a.slotId), 'INVALID_STATE_TRANSITION', 409).reason,
    ).toBe('key_already_picked_up');
    err(await keyPickup(t, 'DRV2', a.retrieveTaskId, a.slotId), 'NOT_TASK_ASSIGNEE', 403);
    err(await keyPickup(t, 'DRV1', DUMMY, a.slotId), 'RESOURCE_NOT_FOUND', 404);
    err(
      await t.command('post', `/v1/tasks/${a.retrieveTaskId}/key-pickup`, {
        as: 'DRV1',
        body: { key_slot_id: a.slotId, expected_version: 1 },
      }),
      'VERSION_CONFLICT',
      409,
    );
    await expectConsistent(t.db);
  });

  it('key-pickup: CUSTODY_HOLDER_MISMATCH for another slot; TASK_NOT_STARTABLE for a next task; a park task is not a retrieval', async () => {
    const a = await assigned(t);
    expect(
      err(await keyPickup(t, 'DRV1', a.retrieveTaskId, slot(59)), 'CUSTODY_HOLDER_MISMATCH', 409),
    ).toEqual({
      subject: 'key',
      current_holder_type: 'key_slot',
    });
    // DRV1 reserves another retrieval as his next task (S4 broadcast reached by SQL)
    const p2 = await parkedPaperTicket(t, 'DRV2');
    ok(await t.command('post', '/v1/me/duty/break', { as: 'DRV2', body: { active: true } }));
    const r2 = ok(await requestRetrieval(t, 'SUP-R', p2.ticketId), 201);
    expect(r2.task.status).toBe('queued');
    const b = await openBroadcastBySql(t.db, r2.task.id);
    expect(ok(await accept(t, 'DRV1', b)).result).toBe('assigned_waiting');
    expect(err(await keyPickup(t, 'DRV1', r2.task.id, p2.slotId), 'TASK_NOT_STARTABLE', 409)).toEqual({
      task_status: 'assigned_waiting',
      reason: 'next_task_not_promoted',
    });
    err(await startRetrieval(t, 'DRV1', r2.task.id), 'TASK_NOT_STARTABLE', 409);
    ok(await t.command('post', '/v1/me/duty/break', { as: 'DRV2', body: { active: false } }));
    const d = await newDraft(t, 'DRV2');
    expect(err(await keyPickup(t, 'DRV2', d.taskId, slot(58)), 'INVALID_STATE_TRANSITION', 409).reason).toBe(
      'not_a_retrieve_task',
    );
  });

  it('start-retrieval: KEY_NOT_PICKED_UP first; then spot → driver, ticket retrieving and ticket.retrieving only now', async () => {
    const a = await assigned(t);
    expect(err(await startRetrieval(t, 'DRV1', a.retrieveTaskId), 'KEY_NOT_PICKED_UP', 409)).toEqual({
      task_id: a.retrieveTaskId,
    });
    ok(await keyPickup(t, 'DRV1', a.retrieveTaskId, a.slotId));
    expect((await outboxEvents(t.db, 'ticket.retrieving')).length).toBe(0);
    err(await startRetrieval(t, 'DRV2', a.retrieveTaskId), 'NOT_TASK_ASSIGNEE', 403);
    err(
      await t.command('post', `/v1/tasks/${a.retrieveTaskId}/start-retrieval`, {
        as: 'DRV1',
        body: { expected_version: 1 },
      }),
      'VERSION_CONFLICT',
      409,
    );
    t.clock.advanceSeconds(3);
    const card = ok(await startRetrieval(t, 'DRV1', a.retrieveTaskId));
    expect(card.task).toMatchObject({ status: 'in_progress', started_at: t.clock.now().toISOString() });
    expect(card.ticket.status).toBe('retrieving');
    expect(
      await one(
        t.db,
        `SELECT retrieved_by, vehicle_holder_type, vehicle_holder_id, current_spot_id FROM tickets WHERE id = $1`,
        [a.ticketId],
      ),
    ).toEqual({
      retrieved_by: U.DRV1,
      vehicle_holder_type: 'driver',
      vehicle_holder_id: U.DRV1,
      current_spot_id: null,
    });
    expect(
      await one(t.db, `SELECT release_reason FROM spot_allocations WHERE ticket_id = $1`, [a.ticketId]),
    ).toEqual({
      release_reason: 'retrieval_start',
    });
    expect(
      await one(t.db, `SELECT started_at, retrieved_by FROM retrieval_cycles WHERE id = $1`, [a.cycleId]),
    ).toEqual({
      started_at: t.clock.now(),
      retrieved_by: U.DRV1,
    });
    const c = await one(
      t.db,
      `SELECT from_holder_type, from_holder_id FROM custody_events WHERE ticket_id = $1 AND reason = 'retrieval_start'`,
      [a.ticketId],
    );
    expect(c).toEqual({ from_holder_type: 'spot', from_holder_id: a.spotId });
    expect((await outboxEvents(t.db, 'ticket.retrieving')).map((e) => e.payload.payload)).toEqual([
      expect.objectContaining({ cycle_id: a.cycleId, task_id: a.retrieveTaskId, retrieved_by: U.DRV1 }),
    ]);
    expect(
      err(await startRetrieval(t, 'DRV1', a.retrieveTaskId), 'INVALID_STATE_TRANSITION', 409),
    ).toMatchObject({
      current_status: 'in_progress',
      allowed_from: ['accepted'],
    });
    await expectConsistent(t.db);
  });

  it('ready: ticket ready (paper → expected method paper_stub), driver stays busy; wrong state, assignee or version refused', async () => {
    const a = await assigned(t);
    err(await markReady(t, 'DRV1', a.retrieveTaskId), 'INVALID_STATE_TRANSITION', 409);
    ok(await keyPickup(t, 'DRV1', a.retrieveTaskId, a.slotId));
    ok(await startRetrieval(t, 'DRV1', a.retrieveTaskId));
    err(await markReady(t, 'DRV2', a.retrieveTaskId), 'NOT_TASK_ASSIGNEE', 403);
    err(
      await t.command('post', `/v1/tasks/${a.retrieveTaskId}/ready`, {
        as: 'DRV1',
        body: { expected_version: 2 },
      }),
      'VERSION_CONFLICT',
      409,
    );
    t.clock.advanceSeconds(60);
    const card = ok(await markReady(t, 'DRV1', a.retrieveTaskId));
    expect(card.ticket.status).toBe('ready');
    expect(card.task.status).toBe('in_progress');
    expect(await one(t.db, `SELECT ready_at FROM retrieval_cycles WHERE id = $1`, [a.cycleId])).toEqual({
      ready_at: t.clock.now(),
    });
    expect((await outboxEvents(t.db, 'ticket.ready')).map((e) => e.payload.payload)).toEqual([
      expect.objectContaining({
        cycle_id: a.cycleId,
        task_id: a.retrieveTaskId,
        expected_method: 'paper_stub',
        claim_code_id: null,
      }),
    ]);
    expect(
      (await one(t.db, `SELECT driver_state FROM v_driver_state WHERE user_id = $1`, [U.DRV1])).driver_state,
    ).toBe('retrieving');
    err(await markReady(t, 'DRV1', a.retrieveTaskId), 'INVALID_STATE_TRANSITION', 409);
    await expectConsistent(t.db);
  });
});

describe('PNT-034 — POST /v1/tickets/{ticketId}/handover (paper stub)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV2'), 201);
  });
  afterEach(async () => t.close());

  it('delivers: custody to the customer, cycle closed delivered, task completed, driver available; second handover TICKET_CLOSED, same key replays', async () => {
    const a = await readyTicket(t);
    t.clock.advanceSeconds(20);
    const key = 'handover-replay-key-1';
    const first = await t.command('post', `/v1/tickets/${a.ticketId}/handover`, {
      as: 'DRV1',
      key,
      body: { verification: { method: 'paper_stub', paper_serial: ` ${a.serial.toLowerCase()} ` } },
    });
    const d = ok(first);
    expect(d.ticket).toMatchObject({ status: 'delivered' });
    expect(d.cycle).toMatchObject({ outcome: 'delivered', delivered_at: t.clock.now().toISOString() });
    expect(d.payment).toBeNull();
    expect(d.driver).toEqual({ driver_state: 'available', promoted_next_task: null });
    expect(await one(t.db, `SELECT status FROM tasks WHERE id = $1`, [a.retrieveTaskId])).toEqual({
      status: 'completed',
    });
    expect(
      await one(t.db, `SELECT handover_method, closed_at FROM retrieval_cycles WHERE id = $1`, [a.cycleId]),
    ).toEqual({
      handover_method: 'paper_stub',
      closed_at: t.clock.now(),
    });
    const handed = await rows(
      t.db,
      `SELECT subject, to_holder_type FROM custody_events WHERE ticket_id = $1 AND reason = 'handover' ORDER BY subject DESC`,
      [a.ticketId],
    );
    expect(handed).toEqual([
      { subject: 'vehicle', to_holder_type: 'customer' },
      { subject: 'key', to_holder_type: 'customer' },
    ]);
    expect(
      await one(t.db, `SELECT available_since FROM duty_sessions WHERE user_id = $1 AND status = 'on_duty'`, [
        U.DRV1,
      ]),
    ).toEqual({
      available_since: t.clock.now(),
    });
    expect((await outboxEvents(t.db, 'ticket.delivered')).map((e) => e.payload.payload)).toEqual([
      expect.objectContaining({
        cycle_id: a.cycleId,
        delivered_by: U.DRV1,
        method: 'paper_stub',
        payment_status: 'not_required',
      }),
    ]);
    const replay = await t.command('post', `/v1/tickets/${a.ticketId}/handover`, {
      as: 'DRV1',
      key,
      body: { verification: { method: 'paper_stub', paper_serial: ` ${a.serial.toLowerCase()} ` } },
    });
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);
    expect(
      err(
        await handover(t, 'DRV1', a.ticketId, {
          verification: { method: 'paper_stub', paper_serial: a.serial },
        }),
        'TICKET_CLOSED',
        409,
      ),
    ).toEqual({
      ticket_status: 'delivered',
    });
    await expectConsistent(t.db);
  });

  it('PAPER_STUB_MISMATCH counts attempts (kept, replay does not count twice); at the limit HANDOVER_CODE_LOCKED + alert', async () => {
    const a = await readyTicket(t);
    const wrong = { verification: { method: 'paper_stub', paper_serial: 'NOPE-1' } };
    const key = 'stub-attempt-key-1';
    const r1 = await t.command('post', `/v1/tickets/${a.ticketId}/handover`, {
      as: 'DRV1',
      key,
      body: wrong,
    });
    expect(err(r1, 'PAPER_STUB_MISMATCH', 422)).toEqual({ attempts_left: 4 });
    // the same request replayed returns the saved error and does not burn a second attempt
    const r1b = await t.command('post', `/v1/tickets/${a.ticketId}/handover`, {
      as: 'DRV1',
      key,
      body: wrong,
    });
    expect(r1b.body).toEqual(r1.body);
    for (const left of [3, 2, 1])
      expect(err(await handover(t, 'DRV1', a.ticketId, wrong), 'PAPER_STUB_MISMATCH').attempts_left).toBe(
        left,
      );
    const locked = err(await handover(t, 'DRV1', a.ticketId, wrong), 'HANDOVER_CODE_LOCKED', 423);
    expect(locked.locked_at).toBe(t.clock.now().toISOString());
    const alert = await one(
      t.db,
      `SELECT id, severity, status, ticket_id FROM alerts WHERE dedupe_key = $1`,
      [`handover_code_locked:${a.cycleId}`],
    );
    expect(alert).toMatchObject({ severity: 'critical', status: 'open', ticket_id: a.ticketId });
    expect(locked.alert_id).toBe(alert.id);
    // locked even for the right stub; attempts were committed despite the errors
    expect(
      err(
        await handover(t, 'DRV1', a.ticketId, {
          verification: { method: 'paper_stub', paper_serial: a.serial },
        }),
        'HANDOVER_CODE_LOCKED',
      ).alert_id,
    ).toBe(alert.id);
    expect(
      (
        await rows(
          t.db,
          `SELECT 1 FROM ticket_events WHERE ticket_id = $1 AND type = 'handover.code_attempt_failed'`,
          [a.ticketId],
        )
      ).length,
    ).toBe(5);
    expect((await outboxEvents(t.db, 'handover.code_locked')).length).toBe(1);
    expect(await one(t.db, `SELECT status FROM tickets WHERE id = $1`, [a.ticketId])).toEqual({
      status: 'ready',
    });
    await expectConsistent(t.db);
  });

  it('HANDOVER_NOT_READY, NOT_TASK_ASSIGNEE, VERSION_CONFLICT, CUSTODY_HOLDER_MISMATCH, TICKET_NOT_FOUND', async () => {
    const parked = await parkedPaperTicket(t, 'DRV2');
    const stub = { verification: { method: 'paper_stub', paper_serial: parked.serial } };
    expect(err(await handover(t, 'DRV1', parked.ticketId, stub), 'HANDOVER_NOT_READY', 409)).toEqual({
      ticket_status: 'parked',
    });
    t.clock.advanceSeconds(1);
    ok(await requestRetrieval(t, 'SUP-R', parked.ticketId), 201);
    const o = (await liveOffer(t.db, U.DRV1))!;
    ok(await accept(t, 'DRV1', o.id));
    ok(await keyPickup(t, 'DRV1', o.task_id, parked.slotId));
    ok(await startRetrieval(t, 'DRV1', o.task_id));
    expect(err(await handover(t, 'DRV1', parked.ticketId, stub), 'HANDOVER_NOT_READY', 409)).toEqual({
      ticket_status: 'retrieving',
    });
    ok(await markReady(t, 'DRV1', o.task_id));
    expect(err(await handover(t, 'DRV2', parked.ticketId, stub), 'NOT_TASK_ASSIGNEE', 403)).toEqual({
      task_id: o.task_id,
    });
    err(
      await handover(t, 'DRV1', parked.ticketId, { ...stub, expected_version: 1 }),
      'VERSION_CONFLICT',
      409,
    );
    await t.db.query(
      `UPDATE tickets SET vehicle_holder_type = 'supervisor', vehicle_holder_id = $2 WHERE id = $1`,
      [parked.ticketId, U['SUP-R']],
    );
    expect(err(await handover(t, 'DRV1', parked.ticketId, stub), 'CUSTODY_HOLDER_MISMATCH', 409)).toEqual({
      subject: 'vehicle',
      current_holder_type: 'supervisor',
    });
    err(await handover(t, 'DRV1', DUMMY, stub), 'TICKET_NOT_FOUND', 404);
  });

  it('PAYMENT_PENDING for a due ticket (inline collection: PNT-080 tests); a code or a payment that does not apply is VALIDATION_FAILED', async () => {
    const due = await readyTicket(t, { eventId: EVT_R2 });
    const stub = { verification: { method: 'paper_stub', paper_serial: due.serial } };
    expect(err(await handover(t, 'DRV1', due.ticketId, stub), 'PAYMENT_PENDING', 409)).toEqual({
      amount_halalas: 2000,
      allowed_methods: ['cash', 'pos'],
    });
    // PNT-080 collects inline; a wrong amount is refused by the payment gate, before the stub
    err(
      await handover(t, 'DRV1', due.ticketId, { ...stub, payment: { method: 'cash', amount_halalas: 1500 } }),
      'PAYMENT_AMOUNT_MISMATCH',
      422,
    );
    // no attempt was counted by the payment gate
    expect(
      (
        await rows(
          t.db,
          `SELECT 1 FROM ticket_events WHERE ticket_id = $1 AND type = 'handover.code_attempt_failed'`,
          [due.ticketId],
        )
      ).length,
    ).toBe(0);
    await t.db.query(
      `UPDATE tickets SET payment_status = 'waived', payment_waived_at = now(), payment_waiver_reason = 'ضيف' WHERE id = $1`,
      [due.ticketId],
    );
    expect(
      err(
        await handover(t, 'DRV1', due.ticketId, {
          ...stub,
          payment: { method: 'cash', amount_halalas: 2000 },
        }),
        'VALIDATION_FAILED',
        422,
      ).fields,
    ).toEqual([{ field: 'payment', issue: 'not_applicable' }]);
    expect(
      err(
        await handover(t, 'DRV1', due.ticketId, { verification: { method: 'code', code: '123456' } }),
        'VALIDATION_FAILED',
        422,
      ).fields,
    ).toEqual([{ field: 'verification.method', issue: 'not_applicable' }]);
    err(
      await handover(t, 'DRV1', due.ticketId, { verification: { method: 'code', code: '12' } }),
      'VALIDATION_FAILED',
      422,
    );
    ok(await handover(t, 'DRV1', due.ticketId, stub));
  });
});
