import { seedSpotId } from '@point/db/seed';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  accept,
  auditCount,
  completeParking,
  createS2App,
  err,
  expectConsistent,
  liveOffer,
  newDraft,
  ok,
  one,
  outboxEvents,
  paperTicketInParking,
  parkedPaperTicket,
  POOL_R,
  requestRetrieval,
  RMS,
  rows,
  slot,
  spot,
  startDuty,
  U,
} from './dispatch-fixtures.js';
import { holdRowLock, waitForLockWaiters } from './dispatch-locks.js';

const DUMMY = '00000000-0000-4000-8000-0000deadbeef';
const brk = (t: TestApp, as: string, active: boolean) =>
  t.command('post', '/v1/me/duty/break', { as, body: { active } });
const setVenueSettings = (t: TestApp, settings: object) =>
  t.db.query(`UPDATE venues SET settings = $2 WHERE id = $1`, [RMS, JSON.stringify(settings)]);

describe('PNT-030 — POST /v1/tasks/{taskId}/complete-parking', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
  });
  afterEach(async () => t.close());

  it('parks: allocations, custody to the spot and the key slot, task completed, driver available, events, audit', async () => {
    const d = await paperTicketInParking(t, 'DRV1');
    t.clock.advanceSeconds(90);
    const r = ok(
      await completeParking(t, 'DRV1', d.taskId, { parking_spot_id: spot('B-07'), key_slot_id: slot(12) }),
    );
    expect(r.ticket).toMatchObject({
      status: 'parked',
      parked_at: t.clock.now().toISOString(),
      pending_retrieval_at: null,
    });
    expect(r.task).toMatchObject({ status: 'completed', completed_at: t.clock.now().toISOString() });
    expect(r.driver).toEqual({ driver_state: 'available', promoted_next_task: null });
    expect(
      await one(
        t.db,
        `SELECT parked_by, current_spot_id, current_key_slot_id, vehicle_holder_type, vehicle_holder_id, key_holder_type, key_holder_id FROM tickets WHERE id = $1`,
        [d.ticketId],
      ),
    ).toEqual({
      parked_by: U.DRV1,
      current_spot_id: spot('B-07'),
      current_key_slot_id: slot(12),
      vehicle_holder_type: 'spot',
      vehicle_holder_id: spot('B-07'),
      key_holder_type: 'key_slot',
      key_holder_id: slot(12),
    });
    expect(
      await one(
        t.db,
        `SELECT count(*)::int AS n FROM spot_allocations WHERE ticket_id = $1 AND released_at IS NULL`,
        [d.ticketId],
      ),
    ).toEqual({ n: 1 });
    expect(
      await one(
        t.db,
        `SELECT count(*)::int AS n FROM key_slot_allocations WHERE ticket_id = $1 AND released_at IS NULL`,
        [d.ticketId],
      ),
    ).toEqual({ n: 1 });
    const custody = await rows(
      t.db,
      `SELECT subject, from_holder_type, to_holder_type, to_holder_id, reason FROM custody_events WHERE ticket_id = $1 AND reason IN ('parked','key_deposited') ORDER BY subject DESC`,
      [d.ticketId],
    );
    expect(custody).toEqual([
      {
        subject: 'vehicle',
        from_holder_type: 'driver',
        to_holder_type: 'spot',
        to_holder_id: spot('B-07'),
        reason: 'parked',
      },
      {
        subject: 'key',
        from_holder_type: 'driver',
        to_holder_type: 'key_slot',
        to_holder_id: slot(12),
        reason: 'key_deposited',
      },
    ]);
    expect(
      await one(t.db, `SELECT available_since FROM duty_sessions WHERE user_id = $1 AND status = 'on_duty'`, [
        U.DRV1,
      ]),
    ).toEqual({
      available_since: t.clock.now(),
    });
    const parked = (await outboxEvents(t.db, 'ticket.parked')).map((e) => e.payload.payload);
    expect(parked).toEqual([
      expect.objectContaining({
        task_id: d.taskId,
        task_type: 'park',
        parking_spot_id: spot('B-07'),
        has_spot_note: false,
        key_slot_id: slot(12),
        parked_by: U.DRV1,
      }),
    ]);
    expect(await auditCount(t.db, 'task.execute', d.taskId)).toBe(1);
    await expectConsistent(t.db);
  });

  it('PARKING_SPOT_OCCUPIED and KEY_SLOT_OCCUPIED name the occupied place', async () => {
    ok(await startDuty(t, 'DRV2'), 201);
    const a = await parkedPaperTicket(t, 'DRV1');
    const b = await paperTicketInParking(t, 'DRV2');
    expect(
      err(
        await completeParking(t, 'DRV2', b.taskId, { parking_spot_id: a.spotId, key_slot_id: slot(50) }),
        'PARKING_SPOT_OCCUPIED',
        409,
      ),
    ).toEqual({
      parking_spot_id: a.spotId,
    });
    expect(
      err(
        await completeParking(t, 'DRV2', b.taskId, { parking_spot_id: spot('B-30'), key_slot_id: a.slotId }),
        'KEY_SLOT_OCCUPIED',
        409,
      ),
    ).toEqual({
      key_slot_id: a.slotId,
    });
    // nothing was kept from the refused attempts
    expect(
      await one(t.db, `SELECT count(*)::int AS n FROM spot_allocations WHERE ticket_id = $1`, [b.ticketId]),
    ).toEqual({ n: 0 });
    await expectConsistent(t.db);
  });

  it('NOT_TASK_ASSIGNEE, VERSION_CONFLICT, RESOURCE_NOT_FOUND, INVALID_STATE_TRANSITION', async () => {
    ok(await startDuty(t, 'DRV2'), 201);
    const d = await paperTicketInParking(t, 'DRV1');
    expect(
      err(
        await completeParking(t, 'DRV2', d.taskId, { parking_spot_id: spot('A-20'), key_slot_id: slot(20) }),
        'NOT_TASK_ASSIGNEE',
        403,
      ),
    ).toEqual({
      task_id: d.taskId,
    });
    expect(
      err(
        await completeParking(t, 'DRV1', d.taskId, {
          parking_spot_id: spot('A-20'),
          key_slot_id: slot(20),
          expected_version: 99,
        }),
        'VERSION_CONFLICT',
        409,
      ),
    ).toMatchObject({ entity: 'task', id: d.taskId });
    expect(
      err(
        await completeParking(t, 'DRV1', DUMMY, { parking_spot_id: spot('A-20'), key_slot_id: slot(20) }),
        'RESOURCE_NOT_FOUND',
        404,
      ),
    ).toEqual({
      resource: 'task',
    });
    expect(
      err(
        await completeParking(t, 'DRV1', d.taskId, {
          parking_spot_id: seedSpotId('P1-01'),
          key_slot_id: slot(20),
        }),
        'RESOURCE_NOT_FOUND',
        404,
      ),
    ).toEqual({ resource: 'parking_spot' });
    const draft = await newDraft(t, 'DRV2');
    expect(
      err(
        await completeParking(t, 'DRV2', draft.taskId, {
          parking_spot_id: spot('A-21'),
          key_slot_id: slot(21),
        }),
        'INVALID_STATE_TRANSITION',
        409,
      ),
    ).toMatchObject({
      entity_type: 'ticket',
      current_status: 'received',
      reason: 'intake_not_submitted',
    });
    ok(await completeParking(t, 'DRV1', d.taskId, { parking_spot_id: spot('A-20'), key_slot_id: slot(20) }));
    expect(
      err(
        await completeParking(t, 'DRV1', d.taskId, { parking_spot_id: spot('A-22'), key_slot_id: slot(22) }),
        'INVALID_STATE_TRANSITION',
        409,
      ),
    ).toMatchObject({
      entity_type: 'task',
      current_status: 'completed',
    });
  });

  it('CUSTODY_HOLDER_MISMATCH when the actor does not hold the vehicle or the key', async () => {
    const d = await paperTicketInParking(t, 'DRV1');
    await t.db.query(`UPDATE tickets SET key_holder_type = 'supervisor', key_holder_id = $2 WHERE id = $1`, [
      d.ticketId,
      U['SUP-R'],
    ]);
    expect(
      err(
        await completeParking(t, 'DRV1', d.taskId, { parking_spot_id: spot('A-25'), key_slot_id: slot(25) }),
        'CUSTODY_HOLDER_MISMATCH',
        409,
      ),
    ).toEqual({
      subject: 'key',
      current_holder_type: 'supervisor',
    });
  });

  it('an inactive spot, zone, slot or board is refused; a deactivation in flight serializes with the allocation (FOR SHARE)', async () => {
    const d = await paperTicketInParking(t, 'DRV1');
    const { zone_id } = await one(t.db, `SELECT zone_id FROM parking_spots WHERE id = $1`, [spot('A-27')]);
    const { key_board_id } = await one(t.db, `SELECT key_board_id FROM key_slots WHERE id = $1`, [slot(27)]);
    const park = () =>
      completeParking(t, 'DRV1', d.taskId, { parking_spot_id: spot('A-27'), key_slot_id: slot(27) });
    const cases: [string, string, string, string][] = [
      ['parking_spots', spot('A-27'), 'parking_spot_id', 'inactive'],
      ['parking_zones', zone_id, 'parking_spot_id', 'zone_inactive'],
      ['key_slots', slot(27), 'key_slot_id', 'inactive'],
      ['key_boards', key_board_id, 'key_slot_id', 'board_inactive'],
    ];
    for (const [table, id, field, issue] of cases) {
      await t.db.query(`UPDATE ${table} SET status = 'inactive' WHERE id = $1`, [id]);
      expect(err(await park(), 'VALIDATION_FAILED', 422)).toEqual({ fields: [{ field, issue }] });
      await t.db.query(`UPDATE ${table} SET status = 'active' WHERE id = $1`, [id]);
    }

    // PATCH parking-spots takes the spot FOR NO KEY UPDATE before deactivating it: the allocation waits on its
    // FOR SHARE read and then sees the committed deactivation
    const held = await holdRowLock(t, 'parking_spots', spot('A-28'));
    const pending = completeParking(t, 'DRV1', d.taskId, {
      parking_spot_id: spot('A-28'),
      key_slot_id: slot(28),
    });
    await waitForLockWaiters(t, 1);
    await held.query(`UPDATE parking_spots SET status = 'inactive' WHERE id = $1`, [spot('A-28')]);
    await held.release();
    expect(err(await pending, 'VALIDATION_FAILED', 422)).toEqual({
      fields: [{ field: 'parking_spot_id', issue: 'inactive' }],
    });
    expect(
      (
        await one(t.db, `SELECT count(*)::int AS n FROM spot_allocations WHERE parking_spot_id = $1`, [
          spot('A-28'),
        ])
      ).n,
    ).toBe(0);
    ok(await park());
    await expectConsistent(t.db);
  });

  it('parking.mode and keys.require_slot drive the required inputs (VALIDATION_FAILED)', async () => {
    const d = await paperTicketInParking(t, 'DRV1');
    expect(err(await completeParking(t, 'DRV1', d.taskId, {}), 'VALIDATION_FAILED', 422)).toEqual({
      fields: [
        { field: 'parking_spot_id', issue: 'spot_or_note_required' },
        { field: 'key_slot_id', issue: 'required' },
      ],
    });
    await setVenueSettings(t, { parking: { mode: 'assigned_spots' } });
    expect(
      err(
        await completeParking(t, 'DRV1', d.taskId, { spot_note: 'خلف القاعة', key_slot_id: slot(30) }),
        'VALIDATION_FAILED',
      ).fields,
    ).toEqual([{ field: 'parking_spot_id', issue: 'required' }]);
    await setVenueSettings(t, { parking: { mode: 'free_text' }, keys: { require_slot: false } });
    expect(
      err(await completeParking(t, 'DRV1', d.taskId, { parking_spot_id: spot('A-26') }), 'VALIDATION_FAILED')
        .fields,
    ).toEqual([
      { field: 'spot_note', issue: 'required' },
      { field: 'parking_spot_id', issue: 'not_allowed_in_mode' },
    ]);
    // free text and no key slot: the vehicle is at a described spot, the key holder unknown
    ok(await completeParking(t, 'DRV1', d.taskId, { spot_note: 'الصف الثالث خلف القاعة' }));
    expect(
      await one(
        t.db,
        `SELECT vehicle_holder_type, vehicle_holder_id, key_holder_type, current_spot_note FROM tickets WHERE id = $1`,
        [d.ticketId],
      ),
    ).toEqual({
      vehicle_holder_type: 'spot',
      vehicle_holder_id: null,
      key_holder_type: 'unknown',
      current_spot_note: 'الصف الثالث خلف القاعة',
    });
    const key = await one(
      t.db,
      `SELECT to_holder_type FROM custody_events WHERE ticket_id = $1 AND subject = 'key' AND reason = 'key_deposited'`,
      [d.ticketId],
    );
    expect(key.to_holder_type).toBe('unknown');
    await expectConsistent(t.db);
  });

  it('DEC-13: an early request becomes a cycle at parked with the original request time', async () => {
    const d = await paperTicketInParking(t, 'DRV1');
    const pressedAt = t.clock.now();
    const cus = await one(
      t.db,
      `INSERT INTO customers (org_id, phone_e164) SELECT org_id, '+966551230000' FROM tickets WHERE id = $1 RETURNING id`,
      [d.ticketId],
    );
    await t.db.query(
      `UPDATE tickets SET customer_id = $2, pending_retrieval_at = $3, pending_retrieval_source = 'whatsapp' WHERE id = $1`,
      [d.ticketId, cus.id, pressedAt],
    );
    t.clock.advanceSeconds(120);
    const r = ok(
      await completeParking(t, 'DRV1', d.taskId, { parking_spot_id: spot('A-28'), key_slot_id: slot(28) }),
    );
    expect(r.ticket).toMatchObject({ status: 'requested', pending_retrieval_at: null });
    const cycle = await one(t.db, `SELECT * FROM retrieval_cycles WHERE ticket_id = $1`, [d.ticketId]);
    expect(cycle).toMatchObject({
      requested_at: pressedAt,
      requested_early: true,
      request_source: 'whatsapp',
      requested_by_customer_id: cus.id,
    });
    const task = await one(t.db, `SELECT priority_at, queued_at, status FROM tasks WHERE cycle_id = $1`, [
      cycle.id,
    ]);
    expect(task.priority_at).toEqual(pressedAt);
    expect(task.queued_at).toEqual(t.clock.now());
    // no preference for the parking driver, but he is the only one available: the pass offers it to him
    expect(task.status).toBe('offered');
    const types = (
      await rows(t.db, `SELECT type FROM ticket_events WHERE ticket_id = $1 ORDER BY id`, [d.ticketId])
    ).map((x) => x.type);
    expect(types.indexOf('ticket.parked')).toBeLessThan(types.indexOf('ticket.retrieval_requested'));
    await expectConsistent(t.db);
  });

  it('a reserved next task is promoted in the same transaction (never available in between)', async () => {
    const parkedByOther = await (async () => {
      ok(await startDuty(t, 'DRV2'), 201);
      return parkedPaperTicket(t, 'DRV2');
    })();
    ok(await brk(t, 'DRV2', true)); // nobody is idle
    const d = await paperTicketInParking(t, 'DRV1');
    const req = ok(await requestRetrieval(t, 'SUP-R', parkedByOther.ticketId), 201);
    expect(req.task.status).toBe('broadcast'); // PNT-053: nobody idle → a broadcast DRV1 may reserve
    const offerId = (await liveOffer(t.db, U.DRV1))!.id;
    const res = ok(await accept(t, 'DRV1', offerId));
    expect(res).toMatchObject({ result: 'assigned_waiting', driver_state: 'busy_with_next' });
    const r = ok(
      await completeParking(t, 'DRV1', d.taskId, { parking_spot_id: spot('A-29'), key_slot_id: slot(29) }),
    );
    expect(r.driver.driver_state).toBe('retrieving');
    expect(r.driver.promoted_next_task.task).toMatchObject({ id: req.task.id, status: 'accepted' });
    expect(r.driver.promoted_next_task.key_slot).toMatchObject({ id: parkedByOther.slotId });
    expect(await one(t.db, `SELECT status FROM tickets WHERE id = $1`, [parkedByOther.ticketId])).toEqual({
      status: 'assigned',
    });
    expect(
      await one(t.db, `SELECT available_since FROM duty_sessions WHERE user_id = $1 AND status = 'on_duty'`, [
        U.DRV1,
      ]),
    ).toEqual({
      available_since: null,
    });
    expect((await outboxEvents(t.db, 'task.promoted')).map((e) => e.payload.payload)).toEqual([
      {
        task_id: req.task.id,
        ticket_id: parkedByOther.ticketId,
        assignee_id: U.DRV1,
        after_task_id: d.taskId,
      },
    ]);
    await expectConsistent(t.db);
  });
});

describe('PNT-031 — POST /v1/tickets/{ticketId}/retrievals', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
  });
  afterEach(async () => t.close());

  it('a supervisor asks on behalf: cycle (staff, reason), retrieve task with priority_at = requested_at, immediate pass', async () => {
    const p = await parkedPaperTicket(t, 'DRV1');
    t.clock.advanceSeconds(300);
    const r = ok(await requestRetrieval(t, 'SUP-R', p.ticketId, 'العميل عند المدخل'), 201);
    expect(r.ticket).toMatchObject({
      id: p.ticketId,
      status: 'requested',
      requested_at: t.clock.now().toISOString(),
    });
    expect(r.cycle).toMatchObject({
      request_source: 'staff',
      request_reason: 'العميل عند المدخل',
      requested_early: false,
      cycle_no: 1,
    });
    expect(r.task).toMatchObject({
      type: 'retrieve',
      priority_at: t.clock.now().toISOString(),
      cycle_id: r.cycle.id,
    });
    expect(r.task.status).toBe('offered'); // DRV1 is the longest idle (and only) driver
    expect((await liveOffer(t.db, U.DRV1))?.task_id).toBe(r.task.id);
    const audit = await one(
      t.db,
      `SELECT reason FROM audit_log WHERE action = 'retrieval.request_on_behalf'`,
    );
    expect(audit.reason).toBe('العميل عند المدخل');
    const ev = (await outboxEvents(t.db, 'ticket.retrieval_requested')).map((e) => e.payload.payload);
    expect(ev).toEqual([
      expect.objectContaining({
        cycle_id: r.cycle.id,
        task_id: r.task.id,
        request_source: 'staff',
        requested_early: false,
      }),
    ]);
    await expectConsistent(t.db);
  });

  it('a driver on duty may ask too; off duty DUTY_REQUIRED, on a break DRIVER_ON_BREAK', async () => {
    const p = await parkedPaperTicket(t, 'DRV1');
    err(await requestRetrieval(t, 'DRV2', p.ticketId), 'DUTY_REQUIRED', 409);
    ok(await startDuty(t, 'DRV2'), 201);
    ok(await brk(t, 'DRV2', true));
    err(await requestRetrieval(t, 'DRV2', p.ticketId), 'DRIVER_ON_BREAK', 409);
    ok(await brk(t, 'DRV2', false));
    ok(await requestRetrieval(t, 'DRV2', p.ticketId), 201);
  });

  it('REASON_REQUIRED, TICKET_NOT_PARKED, RETRIEVAL_ALREADY_ACTIVE, TICKET_CLOSED, TICKET_NOT_FOUND', async () => {
    const d = await paperTicketInParking(t, 'DRV1');
    expect(
      err(
        await t.command('post', `/v1/tickets/${d.ticketId}/retrievals`, { as: 'SUP-R', body: {} }),
        'REASON_REQUIRED',
        422,
      ),
    ).toEqual({
      field: 'reason',
      min_length: 3,
    });
    expect(err(await requestRetrieval(t, 'SUP-R', d.ticketId), 'TICKET_NOT_PARKED', 409)).toEqual({
      ticket_status: 'parking',
    });
    ok(await startDuty(t, 'DRV2'), 201);
    const p = await parkedPaperTicket(t, 'DRV2');
    const first = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    expect(err(await requestRetrieval(t, 'SUP-R', p.ticketId), 'RETRIEVAL_ALREADY_ACTIVE', 409)).toEqual({
      cycle_id: first.cycle.id,
      ticket_status: 'requested',
    });
    await t.db.query(
      `UPDATE tickets SET status = 'voided', voided_at = now(), void_reason = 'x' WHERE id = $1`,
      [d.ticketId],
    );
    await t.db.query(`UPDATE tasks SET status = 'canceled', canceled_at = now() WHERE id = $1`, [d.taskId]);
    expect(err(await requestRetrieval(t, 'SUP-R', d.ticketId), 'TICKET_CLOSED', 409)).toEqual({
      ticket_status: 'voided',
    });
    err(await requestRetrieval(t, 'SUP-R', DUMMY), 'TICKET_NOT_FOUND', 404);
    err(await requestRetrieval(t, 'SUP-RL', DUMMY), 'TICKET_NOT_FOUND', 404);
  });

  it('no driver on duty: no_drivers_on_duty alert (critical), resolved by the first duty start which gets the offer', async () => {
    const p = await parkedPaperTicket(t, 'DRV1');
    ok(await t.command('post', '/v1/me/duty/end', { as: 'DRV1', body: {} }));
    const r = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    expect(r.task.status).toBe('queued');
    const alert = await one(
      t.db,
      `SELECT severity, status, dispatch_pool_id, details FROM alerts WHERE dedupe_key = $1`,
      [`no_drivers_on_duty:${POOL_R}`],
    );
    expect(alert).toMatchObject({ severity: 'critical', status: 'open', dispatch_pool_id: POOL_R });
    expect(alert.details).toMatchObject({ reason: 'none_on_duty', open_requests: 1 });
    ok(await startDuty(t, 'DRV3'), 201);
    expect(
      (await one(t.db, `SELECT status FROM alerts WHERE dedupe_key = $1`, [`no_drivers_on_duty:${POOL_R}`]))
        .status,
    ).toBe('resolved');
    expect((await liveOffer(t.db, U.DRV3))?.task_id).toBe(r.task.id);
    await expectConsistent(t.db);
  });
});
