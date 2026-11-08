import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  accept,
  addPhotos,
  completeParking,
  createS2App,
  err,
  EVT_L1,
  expectConsistent,
  keyPickup,
  liveOffer,
  newDraft,
  nextSlot,
  nextSpot,
  ok,
  one,
  outboxEvents,
  PAPER_DRAFT,
  paperTicketInParking,
  parkedPaperTicket,
  patchIntake,
  requestRetrieval,
  rows,
  startDuty,
  startRetrieval,
  submitIntake,
  U,
} from './dispatch-fixtures.js';
import { auditRows, deliveredTicket, DUMMY } from './supervisor-fixtures.js';

let serial = 900;
/** A paper ticket submitted with two of the four required photos: `parking`, inspection `incomplete`, alert raised. */
async function incompleteTicket(t: TestApp, as: string) {
  const d = await newDraft(t, as);
  const p = ok(
    await patchIntake(t, as, d.ticketId, {
      expected_version: d.version,
      ...PAPER_DRAFT(`IE-${serial}`, `IK-${serial++}`),
    }),
  );
  await addPhotos(t.db, d.ticketId, (U as Record<string, string>)[as] ?? as, ['photo_front', 'photo_rear']);
  const s = ok(
    await submitIntake(t, as, d.ticketId, {
      expected_version: p.version,
      acknowledge_incomplete_inspection: true,
    }),
  );
  expect(s.inspection_status).toBe('incomplete');
  return d;
}

describe('PNT-079 — POST /v1/tickets/{ticketId}/inspection-exception', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
    ok(await startDuty(t, 'SUP-RD'), 201);
    ok(await startDuty(t, 'DRV7'), 201);
  });
  afterEach(async () => t.close());

  const approve = (as: string, ticketId: string, body: unknown) =>
    t.command('post', `/v1/tickets/${ticketId}/inspection-exception`, { as, body });

  it('incomplete → exception_approved: event, alert resolved, audit with the missing photos; self_approved flagged', async () => {
    const d = await incompleteTicket(t, 'DRV1');
    const alert = await one(t.db, `SELECT id FROM alerts WHERE dedupe_key = $1 AND status = 'open'`, [
      `inspection_incomplete:${d.ticketId}`,
    ]);
    const r = ok(await approve('SUP-R', d.ticketId, { reason: 'الصور تعذر رفعها، تحقق المشرف ميدانيًا' }));
    expect(r).toMatchObject({ id: d.ticketId, inspection_status: 'exception_approved', status: 'parking' });
    const [ev] = await outboxEvents(t.db, 'ticket.inspection_exception_approved');
    expect(ev.payload.payload).toEqual({
      ticket: { ticket_id: d.ticketId, display_number: d.displayNumber, ticket_version: r.version },
      approved_by: U['SUP-R'],
      reason: 'الصور تعذر رفعها، تحقق المشرف ميدانيًا',
      missing_photos_count: 2,
    });
    expect(await one(t.db, `SELECT status, resolved_by FROM alerts WHERE id = $1`, [alert.id])).toEqual({
      status: 'resolved',
      resolved_by: null,
    });
    expect((await outboxEvents(t.db, 'alert.resolved')).map((e) => e.payload.payload.alert_id)).toContain(
      alert.id,
    );
    const [a] = await auditRows(t, 'ticket.inspection_exception', d.ticketId);
    expect(a).toMatchObject({ actor_id: U['SUP-R'], reason: 'الصور تعذر رفعها، تحقق المشرف ميدانيًا' });
    expect(a.metadata).toMatchObject({ missing_photos: ['photo_left', 'photo_right'], self_approved: false });
    expect(a.before).toEqual({ inspection_status: 'incomplete' });
    expect(a.after).toEqual({ inspection_status: 'exception_approved' });

    // a driving supervisor approving his own intake: allowed with a reason, flagged for review (09 §10 rule 2)
    const own = await incompleteTicket(t, 'SUP-RD');
    ok(await approve('SUP-RD', own.ticketId, { reason: 'اعتماد ذاتي موثق' }));
    expect((await auditRows(t, 'ticket.inspection_exception', own.ticketId))[0].metadata.self_approved).toBe(
      true,
    );
  });

  it('refusals: reason, permission, scope, state', async () => {
    const d = await incompleteTicket(t, 'DRV1');
    expect(err(await approve('SUP-R', d.ticketId, {}), 'REASON_REQUIRED', 422)).toEqual({
      field: 'reason',
      min_length: 3,
    });
    err(await approve('SUP-R', d.ticketId, { reason: 'اب' }), 'REASON_REQUIRED', 422);
    err(await approve('DRV1', d.ticketId, { reason: 'السائق' }), 'PERMISSION_DENIED', 403);
    err(await approve('ADM1', d.ticketId, { reason: 'الإدارة' }), 'PERMISSION_DENIED', 403); // 09 §10: not the admin
    err(await approve('SUP-R', DUMMY, { reason: 'غير موجودة' }), 'TICKET_NOT_FOUND', 404);
    const lyl = await newDraft(t, 'DRV7', EVT_L1);
    err(await approve('SUP-R', lyl.ticketId, { reason: 'خارج النطاق' }), 'TICKET_NOT_FOUND', 404);
    // a complete inspection, an already approved one
    const complete = await paperTicketInParking(t, 'SUP-RD');
    expect(
      err(await approve('SUP-R', complete.ticketId, { reason: 'مكتمل' }), 'INVALID_STATE_TRANSITION', 409),
    ).toMatchObject({
      entity_type: 'ticket',
      entity_id: complete.ticketId,
      current_status: 'parking',
      command: 'POST /v1/tickets/{ticketId}/inspection-exception',
      reason: 'inspection_not_incomplete',
    });
    ok(await approve('SUP-R', d.ticketId, { reason: 'اعتماد أول' }));
    expect(
      err(await approve('SUP-R', d.ticketId, { reason: 'اعتماد ثانٍ' }), 'INVALID_STATE_TRANSITION', 409)
        .reason,
    ).toBe('inspection_not_incomplete');
    ok(await completeParking(t, 'DRV1', d.taskId, { parking_spot_id: nextSpot(), key_slot_id: nextSlot() }));
    // a closed ticket
    const v = await incompleteTicket(t, 'DRV1');
    ok(
      await t.command('post', `/v1/tickets/${v.ticketId}/void`, {
        as: 'SUP-R',
        body: { reason: 'إلغاء', custody_returned_to_customer: true },
      }),
    );
    expect(
      err(await approve('SUP-R', v.ticketId, { reason: 'بعد الإلغاء' }), 'INVALID_STATE_TRANSITION', 409),
    ).toMatchObject({
      current_status: 'voided',
      reason: 'ticket_closed',
    });
  });
});

describe('PNT-079 — POST /v1/tickets/{ticketId}/custody-transfers', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV2'), 201);
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV3'), 201);
    ok(await startDuty(t, 'DRV7'), 201);
  });
  afterEach(async () => t.close());

  const transfer = (as: string, ticketId: string, body: Record<string, unknown>) =>
    t.command('post', `/v1/tickets/${ticketId}/custody-transfers`, {
      as,
      body: { reason: 'تسليم رسمي موثق', ...body },
    });
  const holders = (ticketId: string) =>
    one(
      t.db,
      `SELECT status, vehicle_holder_type, vehicle_holder_id, key_holder_type, key_holder_id, current_spot_id, current_key_slot_id
         FROM tickets WHERE id = $1`,
      [ticketId],
    );
  const state = async (user: string) =>
    (await one(t.db, `SELECT driver_state FROM v_driver_state WHERE user_id = $1`, [user])).driver_state;

  it('201 CustodyEvent; the task stays with its driver when the item goes to a supervisor; a later command of the previous holder is CUSTODY_HOLDER_MISMATCH', async () => {
    const d = await paperTicketInParking(t, 'DRV1');
    const res = await transfer('SUP-R', d.ticketId, {
      subject: 'key',
      to_holder_type: 'supervisor',
      to_holder_id: U['SUP-R'],
    });
    const ce = ok(res, 201);
    expect(ce).toMatchObject({
      ticket_id: d.ticketId,
      subject: 'key',
      from_holder_type: 'driver',
      from_holder_id: U.DRV1,
      to_holder_type: 'supervisor',
      to_holder_id: U['SUP-R'],
      reason: 'official_transfer',
      task_id: d.taskId,
      actor: { id: U['SUP-R'], full_name: expect.any(String) },
      note: 'تسليم رسمي موثق',
      occurred_at: t.clock.now().toISOString(),
    });
    expect(await holders(d.ticketId)).toMatchObject({
      key_holder_type: 'supervisor',
      key_holder_id: U['SUP-R'],
    });
    expect((await outboxEvents(t.db, 'custody.changed')).at(-1).payload.payload).toMatchObject({
      custody_event_id: ce.id,
      subject: 'key',
      reason: 'official_transfer',
      from: { type: 'driver', id: U.DRV1 },
      to: { type: 'supervisor', id: U['SUP-R'] },
    });
    expect(await one(t.db, `SELECT assignee_id FROM tasks WHERE id = $1`, [d.taskId])).toEqual({
      assignee_id: U.DRV1,
    });
    // PNT-079 AC: the previous holder's later command
    expect(
      err(
        await completeParking(t, 'DRV1', d.taskId, { parking_spot_id: nextSpot(), key_slot_id: nextSlot() }),
        'CUSTODY_HOLDER_MISMATCH',
        409,
      ),
    ).toEqual({ subject: 'key', current_holder_type: 'supervisor' });
    // the same holder again
    expect(
      err(
        await transfer('SUP-R', d.ticketId, {
          subject: 'key',
          to_holder_type: 'supervisor',
          to_holder_id: U['SUP-R'],
        }),
        'CUSTODY_HOLDER_MISMATCH',
        409,
      ),
    ).toEqual({ subject: 'key', current_holder_type: 'supervisor' });
    const [a] = await auditRows(t, 'ticket.custody_transfer', d.ticketId);
    expect(a).toMatchObject({ actor_id: U['SUP-R'], reason: 'تسليم رسمي موثق' });
    expect(a.before).toEqual({ subject: 'key', holder_type: 'driver', holder_id: U.DRV1 });
    expect(a.after).toEqual({ subject: 'key', holder_type: 'supervisor', holder_id: U['SUP-R'] });
    // the key back to the driver: he completes the parking
    ok(
      await transfer('SUP-R', d.ticketId, { subject: 'key', to_holder_type: 'driver', to_holder_id: U.DRV1 }),
      201,
    );
    ok(await completeParking(t, 'DRV1', d.taskId, { parking_spot_id: nextSpot(), key_slot_id: nextSlot() }));
    await expectConsistent(t.db);
  });

  it('the task follows the item to another driver (task.reassigned, custody_transfer); the previous driver is settled', async () => {
    const d = await paperTicketInParking(t, 'DRV1');
    expect(await state(U.DRV1)).toBe('intake_parking');
    expect(await state(U.DRV3)).toBe('available');
    ok(
      await transfer('SUP-R', d.ticketId, {
        subject: 'vehicle',
        to_holder_type: 'driver',
        to_holder_id: U.DRV3,
      }),
      201,
    );
    expect(await one(t.db, `SELECT assignee_id, status FROM tasks WHERE id = $1`, [d.taskId])).toEqual({
      assignee_id: U.DRV3,
      status: 'in_progress',
    });
    const [ev] = await outboxEvents(t.db, 'task.reassigned');
    expect(ev.payload.payload).toMatchObject({
      task_id: d.taskId,
      ticket_id: d.ticketId,
      from_assignee_id: U.DRV1,
      to_assignee_id: U.DRV3,
      result_status: 'in_progress',
      trigger: 'custody_transfer',
      priority_override: false,
    });
    expect(await state(U.DRV1)).toBe('available');
    expect(await state(U.DRV3)).toBe('intake_parking');
    const avail = (await outboxEvents(t.db, 'driver.availability_changed')).map(
      (e) => e.payload.payload.user_id,
    );
    expect(avail).toEqual(expect.arrayContaining([U.DRV1, U.DRV3]));
    expect((await auditRows(t, 'ticket.custody_transfer', d.ticketId))[0].metadata).toMatchObject({
      task_moved: { from_assignee_id: U.DRV1, to_assignee_id: U.DRV3 },
      settled: 'available',
    });
    // the key follows; the new assignee completes the parking
    ok(
      await transfer('SUP-R', d.ticketId, { subject: 'key', to_holder_type: 'driver', to_holder_id: U.DRV3 }),
      201,
    );
    expect(await outboxEvents(t.db, 'task.reassigned')).toHaveLength(1);
    err(
      await completeParking(t, 'DRV1', d.taskId, { parking_spot_id: nextSpot(), key_slot_id: nextSlot() }),
      'NOT_TASK_ASSIGNEE',
      403,
    );
    ok(await completeParking(t, 'DRV3', d.taskId, { parking_spot_id: nextSpot(), key_slot_id: nextSlot() }));
    await expectConsistent(t.db);
  });

  it('MOVEMENT_IN_PROGRESS when the new driver already moves a vehicle; drivers off duty or unknown users are refused', async () => {
    const d = await paperTicketInParking(t, 'DRV1');
    const busy = await newDraft(t, 'DRV2'); // DRV2 has an active park task
    expect(
      err(
        await transfer('SUP-R', d.ticketId, {
          subject: 'vehicle',
          to_holder_type: 'driver',
          to_holder_id: U.DRV2,
        }),
        'MOVEMENT_IN_PROGRESS',
        409,
      ),
    ).toEqual({ active_task_id: busy.taskId });
    expect(
      err(
        await transfer('SUP-R', d.ticketId, {
          subject: 'vehicle',
          to_holder_type: 'driver',
          to_holder_id: U.DRV4,
        }),
        'VALIDATION_FAILED',
        422,
      ).fields,
    ).toEqual([{ field: 'to_holder_id', issue: 'driver_not_on_duty' }]);
    expect(
      err(
        await transfer('SUP-R', d.ticketId, {
          subject: 'vehicle',
          to_holder_type: 'driver',
          to_holder_id: U.DRV7,
        }),
        'VALIDATION_FAILED',
        422,
      ).fields,
    ).toEqual([{ field: 'to_holder_id', issue: 'driver_not_on_duty' }]); // on duty in another pool
    expect(
      err(
        await transfer('SUP-R', d.ticketId, {
          subject: 'vehicle',
          to_holder_type: 'driver',
          to_holder_id: U['SUP-R'],
        }),
        'VALIDATION_FAILED',
        422,
      ).fields,
    ).toEqual([{ field: 'to_holder_id', issue: 'not_a_driver' }]);
    expect(
      err(
        await transfer('SUP-R', d.ticketId, {
          subject: 'vehicle',
          to_holder_type: 'driver',
          to_holder_id: DUMMY,
        }),
        'RESOURCE_NOT_FOUND',
        404,
      ),
    ).toEqual({ resource: 'user' });
    expect(
      err(
        await transfer('SUP-R', d.ticketId, {
          subject: 'key',
          to_holder_type: 'supervisor',
          to_holder_id: U.DRV2,
        }),
        'VALIDATION_FAILED',
        422,
      ).fields,
    ).toEqual([{ field: 'to_holder_id', issue: 'not_eligible' }]);
    // nothing changed
    expect(await holders(d.ticketId)).toMatchObject({ vehicle_holder_id: U.DRV1, key_holder_id: U.DRV1 });
  });

  it('spot and slot targets: allocations released with official_transfer; PARKING_SPOT_OCCUPIED / KEY_SLOT_OCCUPIED; a parked vehicle stays in a spot', async () => {
    const a = await parkedPaperTicket(t, 'DRV1');
    const b = await parkedPaperTicket(t, 'DRV1');
    expect(
      err(
        await transfer('SUP-R', a.ticketId, {
          subject: 'vehicle',
          to_holder_type: 'spot',
          to_holder_id: b.spotId,
        }),
        'PARKING_SPOT_OCCUPIED',
        409,
      ),
    ).toEqual({ parking_spot_id: b.spotId });
    expect(
      err(
        await transfer('SUP-R', a.ticketId, {
          subject: 'key',
          to_holder_type: 'key_slot',
          to_holder_id: b.slotId,
        }),
        'KEY_SLOT_OCCUPIED',
        409,
      ),
    ).toEqual({ key_slot_id: b.slotId });
    expect(
      err(
        await transfer('SUP-R', a.ticketId, {
          subject: 'vehicle',
          to_holder_type: 'driver',
          to_holder_id: U.DRV3,
        }),
        'VALIDATION_FAILED',
        422,
      ).fields,
    ).toEqual([{ field: 'to_holder_type', issue: 'parked_vehicle_spot_or_unknown' }]);
    const spot2 = nextSpot();
    const slot2 = nextSlot();
    ok(
      await transfer('SUP-R', a.ticketId, {
        subject: 'vehicle',
        to_holder_type: 'spot',
        to_holder_id: spot2,
      }),
      201,
    );
    ok(
      await transfer('SUP-R', a.ticketId, {
        subject: 'key',
        to_holder_type: 'key_slot',
        to_holder_id: slot2,
      }),
      201,
    );
    expect(await holders(a.ticketId)).toMatchObject({
      status: 'parked',
      vehicle_holder_type: 'spot',
      vehicle_holder_id: spot2,
      current_spot_id: spot2,
      key_holder_type: 'key_slot',
      key_holder_id: slot2,
      current_key_slot_id: slot2,
    });
    expect(
      await rows(
        t.db,
        `SELECT parking_spot_id, release_reason FROM spot_allocations WHERE ticket_id = $1 ORDER BY allocated_at, released_at NULLS LAST`,
        [a.ticketId],
      ),
    ).toEqual([
      { parking_spot_id: a.spotId, release_reason: 'official_transfer' },
      { parking_spot_id: spot2, release_reason: null },
    ]);
    expect(
      await rows(
        t.db,
        `SELECT key_slot_id, release_reason FROM key_slot_allocations WHERE ticket_id = $1 ORDER BY released_at NULLS LAST`,
        [a.ticketId],
      ),
    ).toEqual([
      { key_slot_id: a.slotId, release_reason: 'official_transfer' },
      { key_slot_id: slot2, release_reason: null },
    ]);
    // the freed spot and slot can be used again
    ok(
      await transfer('SUP-R', b.ticketId, {
        subject: 'vehicle',
        to_holder_type: 'spot',
        to_holder_id: a.spotId,
      }),
      201,
    );
    ok(
      await transfer('SUP-R', b.ticketId, {
        subject: 'key',
        to_holder_type: 'key_slot',
        to_holder_id: a.slotId,
      }),
      201,
    );
    // an unknown spot, a spot of another venue
    expect(
      err(
        await transfer('SUP-R', a.ticketId, {
          subject: 'vehicle',
          to_holder_type: 'spot',
          to_holder_id: DUMMY,
        }),
        'RESOURCE_NOT_FOUND',
        404,
      ),
    ).toEqual({ resource: 'parking_spot' });
    await expectConsistent(t.db);
  });

  it('key with holder unknown reaches the assignee of an accepted retrieval (S2 DEC-PROPOSED-20): picked up, he starts', async () => {
    const p = await parkedPaperTicket(t, 'DRV2');
    ok(await transfer('SUP-R', p.ticketId, { subject: 'key', to_holder_type: 'unknown' }), 201);
    expect(await holders(p.ticketId)).toMatchObject({
      key_holder_type: 'unknown',
      key_holder_id: null,
      current_key_slot_id: null,
    });
    t.clock.advanceSeconds(1);
    const r = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    const offer = (await liveOffer(t.db, U.DRV1))!;
    ok(await accept(t, 'DRV1', offer.id));
    expect(err(await keyPickup(t, 'DRV1', r.task.id, p.slotId), 'CUSTODY_HOLDER_MISMATCH', 409)).toEqual({
      subject: 'key',
      current_holder_type: 'unknown',
    });
    err(await startRetrieval(t, 'DRV1', r.task.id), 'KEY_NOT_PICKED_UP', 409);
    ok(
      await transfer('SUP-R', p.ticketId, { subject: 'key', to_holder_type: 'driver', to_holder_id: U.DRV1 }),
      201,
    );
    expect(
      (await one(t.db, `SELECT key_picked_up_at, assignee_id FROM tasks WHERE id = $1`, [
        r.task.id,
      ])) as unknown,
    ).toEqual({
      key_picked_up_at: t.clock.now(),
      assignee_id: U.DRV1,
    });
    expect((await outboxEvents(t.db, 'task.key_picked_up')).at(-1).payload.payload).toEqual({
      task_id: r.task.id,
      ticket_id: p.ticketId,
      assignee_id: U.DRV1,
      key_slot_id: null,
    });
    ok(await startRetrieval(t, 'DRV1', r.task.id));
    await expectConsistent(t.db);
  });

  it('key with holder unknown handed to another driver: the accepted retrieval follows him, picked up (task.reassigned + task.key_picked_up)', async () => {
    const p = await parkedPaperTicket(t, 'DRV2');
    ok(await transfer('SUP-R', p.ticketId, { subject: 'key', to_holder_type: 'unknown' }), 201);
    t.clock.advanceSeconds(1);
    const r = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    const offer = (await liveOffer(t.db, U.DRV1))!;
    ok(await accept(t, 'DRV1', offer.id));
    t.clock.advanceSeconds(2);
    ok(
      await transfer('SUP-R', p.ticketId, { subject: 'key', to_holder_type: 'driver', to_holder_id: U.DRV3 }),
      201,
    );
    expect(
      (await one(t.db, `SELECT status, key_picked_up_at, assignee_id FROM tasks WHERE id = $1`, [
        r.task.id,
      ])) as unknown,
    ).toEqual({ status: 'accepted', key_picked_up_at: t.clock.now(), assignee_id: U.DRV3 });
    expect((await outboxEvents(t.db, 'task.reassigned')).at(-1).payload.payload).toMatchObject({
      task_id: r.task.id,
      from_assignee_id: U.DRV1,
      to_assignee_id: U.DRV3,
      from_status: 'accepted',
      trigger: 'custody_transfer',
    });
    expect((await outboxEvents(t.db, 'task.key_picked_up')).map((e) => e.payload.payload)).toEqual([
      { task_id: r.task.id, ticket_id: p.ticketId, assignee_id: U.DRV3, key_slot_id: null },
    ]);
    expect(await state(U.DRV1)).toBe('available');
    ok(await startRetrieval(t, 'DRV3', r.task.id));
    await expectConsistent(t.db);
  });

  it('validation, permission, closed and unknown tickets', async () => {
    const d = await paperTicketInParking(t, 'DRV1');
    expect(
      err(
        await t.command('post', `/v1/tickets/${d.ticketId}/custody-transfers`, {
          as: 'SUP-R',
          body: { subject: 'key', to_holder_type: 'unknown' },
        }),
        'REASON_REQUIRED',
        422,
      ),
    ).toEqual({
      field: 'reason',
      min_length: 3,
    });
    const fieldOf = async (body: Record<string, unknown>) =>
      err(await transfer('SUP-R', d.ticketId, body), 'VALIDATION_FAILED', 422).fields;
    expect(await fieldOf({ subject: 'key', to_holder_type: 'spot', to_holder_id: nextSpot() })).toEqual([
      { field: 'to_holder_type', issue: 'not_allowed_for_subject' },
    ]);
    expect(
      await fieldOf({ subject: 'vehicle', to_holder_type: 'key_slot', to_holder_id: nextSlot() }),
    ).toEqual([{ field: 'to_holder_type', issue: 'not_allowed_for_subject' }]);
    expect(await fieldOf({ subject: 'vehicle', to_holder_type: 'customer' })).toEqual([
      { field: 'to_holder_type', issue: 'use_handover' },
    ]);
    expect(await fieldOf({ subject: 'vehicle', to_holder_type: 'driver' })).toEqual([
      { field: 'to_holder_id', issue: 'required' },
    ]);
    expect(await fieldOf({ subject: 'vehicle', to_holder_type: 'unknown', to_holder_id: U.DRV1 })).toEqual([
      { field: 'to_holder_id', issue: 'not_allowed' },
    ]);
    err(
      await transfer('SUP-R', d.ticketId, { subject: 'car', to_holder_type: 'unknown' }),
      'VALIDATION_FAILED',
      422,
    );
    for (const who of ['DRV1', 'ADM1', 'OWN1'])
      err(
        await transfer(who, d.ticketId, { subject: 'key', to_holder_type: 'unknown' }),
        'PERMISSION_DENIED',
        403,
      );
    err(
      await transfer('SUP-R', DUMMY, { subject: 'key', to_holder_type: 'unknown' }),
      'TICKET_NOT_FOUND',
      404,
    );
    const lyl = await newDraft(t, 'DRV7', EVT_L1);
    err(
      await transfer('SUP-R', lyl.ticketId, { subject: 'key', to_holder_type: 'unknown' }),
      'TICKET_NOT_FOUND',
      404,
    );
    const delivered = await deliveredTicket(t, { parker: 'DRV3', driver: 'DRV2' });
    expect(
      err(
        await transfer('SUP-R', delivered.ticketId, { subject: 'key', to_holder_type: 'unknown' }),
        'TICKET_CLOSED',
        409,
      ),
    ).toEqual({
      ticket_status: 'delivered',
    });
  });
});
