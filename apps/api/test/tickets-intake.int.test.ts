import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  accept,
  addPhotos,
  auditCount,
  createDrivers,
  createS2App,
  err,
  EVT_L1,
  EVT_R1,
  EVT_R2,
  expectConsistent,
  liveOffer,
  newDraft,
  ok,
  one,
  outboxEvents,
  PAPER_DRAFT,
  parkedPaperTicket,
  patchIntake,
  requestRetrieval,
  rows,
  startDuty,
  startIntake,
  submitIntake,
  U,
} from './dispatch-fixtures.js';
import { approveWaTemplates } from './wa-templates-fixture.js';

const DUMMY = '00000000-0000-4000-8000-0000deadbeef';
const brk = (t: TestApp, as: string, active: boolean) =>
  t.command('post', '/v1/me/duty/break', { as, body: { active } });

describe('PNT-025 — POST /v1/tickets (StartIntake)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
  });
  afterEach(async () => t.close());

  it('creates the received ticket, the park task in progress and the intake custody in one transaction', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    const before = await one(t.db, `SELECT next_display_number, version FROM events WHERE id = $1`, [EVT_R1]);
    const d = ok(await startIntake(t, 'DRV1', { event_id: EVT_R1, channel: 'paper' }), 201);
    expect(d.driver_state).toBe('intake_parking');
    expect(d.ticket).toMatchObject({
      status: 'received',
      channel: 'paper',
      event_id: EVT_R1,
      display_number: before.next_display_number,
      payment_status: 'not_required',
      projection: 'full',
      vehicle_holder: { type: 'driver', id: U.DRV1 },
      key_holder: { type: 'driver', id: U.DRV1 },
    });
    expect(d.task).toMatchObject({
      type: 'park',
      status: 'in_progress',
      ticket_id: d.ticket.id,
      assignee: { id: U.DRV1 },
      accepted_at: t.clock.now().toISOString(),
      started_at: t.clock.now().toISOString(),
    });
    // the counter does not bump the event version (10 §2.7)
    expect(
      await one(t.db, `SELECT next_display_number, version FROM events WHERE id = $1`, [EVT_R1]),
    ).toEqual({
      next_display_number: before.next_display_number + 1,
      version: before.version,
    });
    const state = await one(
      t.db,
      `SELECT driver_state, available_since FROM v_driver_state WHERE user_id = $1`,
      [U.DRV1],
    );
    expect(state).toEqual({ driver_state: 'intake_parking', available_since: null });
    const custody = await rows(
      t.db,
      `SELECT subject, from_holder_type, to_holder_type, to_holder_id, reason, task_id FROM custody_events WHERE ticket_id = $1 ORDER BY subject DESC`,
      [d.ticket.id],
    );
    expect(custody).toEqual([
      {
        subject: 'vehicle',
        from_holder_type: 'customer',
        to_holder_type: 'driver',
        to_holder_id: U.DRV1,
        reason: 'intake',
        task_id: d.task.id,
      },
      {
        subject: 'key',
        from_holder_type: 'customer',
        to_holder_type: 'driver',
        to_holder_id: U.DRV1,
        reason: 'intake',
        task_id: d.task.id,
      },
    ]);
    const timeline = (
      await rows(t.db, `SELECT type FROM ticket_events WHERE ticket_id = $1 ORDER BY id`, [d.ticket.id])
    ).map((r) => r.type);
    expect(timeline).toEqual(['ticket.created', 'task.created', 'custody.changed', 'custody.changed']);
    const created = (await outboxEvents(t.db, 'ticket.created')).map((e) => e.payload.payload);
    expect(created).toEqual([
      {
        ticket: { ticket_id: d.ticket.id, display_number: d.ticket.display_number, ticket_version: 1 },
        created_by: U.DRV1,
        park_task_id: d.task.id,
      },
    ]);
    expect(await auditCount(t.db, 'ticket.intake', d.ticket.id)).toBe(1);
    await expectConsistent(t.db);
  });

  it('DEC-43: the fee snapshot is taken at creation and does not follow later event changes', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    ok(await startDuty(t, 'DRV2'), 201);
    const paid = ok(await startIntake(t, 'DRV1', { event_id: EVT_R2 }), 201);
    // the creator sees the payment status; the amount is for the handover assignee and staff (09 §5.1)
    expect(paid.ticket).toMatchObject({ payment_status: 'due' });
    expect(paid.ticket.fee_halalas).toBeUndefined();
    const free = ok(await startIntake(t, 'DRV2', { event_id: EVT_R1 }), 201);
    expect(free.ticket).toMatchObject({ payment_status: 'not_required' });
    expect(await one(t.db, `SELECT fee_halalas FROM tickets WHERE id = $1`, [free.ticket.id])).toEqual({
      fee_halalas: 0,
    });
    expect((ok(await t.get(`/v1/tickets/${paid.ticket.id}`, 'SUP-R')) as any).fee_halalas).toBe(2000);
    await t.db.query(`UPDATE events SET fee_halalas = 3500 WHERE id = $1`, [EVT_R2]);
    expect(
      await one(t.db, `SELECT fee_halalas, payment_status FROM tickets WHERE id = $1`, [paid.ticket.id]),
    ).toEqual({
      fee_halalas: 2000,
      payment_status: 'due',
    });
  });

  it('DEC-37: several open events need event_id; a single open event is taken automatically', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    expect(err(await startIntake(t, 'DRV1', {}), 'VALIDATION_FAILED', 422)).toEqual({
      fields: [{ field: 'event_id', issue: 'required_multiple_open_events' }],
    });
    await t.db.query(`UPDATE events SET status = 'closing', closing_started_at = now() WHERE id = $1`, [
      EVT_R2,
    ]);
    const d = ok(await startIntake(t, 'DRV1', {}), 201);
    expect(d.ticket.event_id).toBe(EVT_R1);
  });

  it('EVENT_NOT_OPEN for a closing event or when no event is open; another venue’s event is not found', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    await t.db.query(`UPDATE events SET status = 'closing', closing_started_at = now() WHERE id = $1`, [
      EVT_R2,
    ]);
    expect(err(await startIntake(t, 'DRV1', { event_id: EVT_R2 }), 'EVENT_NOT_OPEN', 409)).toEqual({
      event_id: EVT_R2,
      event_status: 'closing',
    });
    expect(err(await startIntake(t, 'DRV1', { event_id: EVT_L1 }), 'RESOURCE_NOT_FOUND', 404)).toEqual({
      resource: 'event',
    });
    await t.db.query(`UPDATE events SET status = 'closing', closing_started_at = now() WHERE id = $1`, [
      EVT_R1,
    ]);
    err(await startIntake(t, 'DRV1', {}), 'EVENT_NOT_OPEN', 409);
  });

  it('DUTY_REQUIRED off duty, DRIVER_ON_BREAK on a break, MOVEMENT_IN_PROGRESS with an active movement', async () => {
    err(await startIntake(t, 'DRV1'), 'DUTY_REQUIRED', 409);
    ok(await startDuty(t, 'DRV1'), 201);
    ok(await brk(t, 'DRV1', true));
    err(await startIntake(t, 'DRV1'), 'DRIVER_ON_BREAK', 409);
    ok(await brk(t, 'DRV1', false));
    const d = await newDraft(t, 'DRV1');
    expect(err(await startIntake(t, 'DRV1'), 'MOVEMENT_IN_PROGRESS', 409)).toEqual({
      active_task_id: d.taskId,
    });
    // the database backstop maps to the same code (uq_tasks_active_movement_driver, 08 §5)
    await expectConsistent(t.db);
  });

  it('fifty parallel intakes by fifty drivers get fifty unique consecutive numbers', async () => {
    const drivers = await createDrivers(t.db, 50);
    for (const d of drivers) ok(await startDuty(t, d), 201);
    const first = (await one(t.db, `SELECT next_display_number FROM events WHERE id = $1`, [EVT_R1]))
      .next_display_number;
    const results = await Promise.all(drivers.map((d) => startIntake(t, d, { event_id: EVT_R1 })));
    expect(results.map((r) => r.status)).toEqual(drivers.map(() => 201));
    const numbers = results.map((r) => r.body.data.ticket.display_number as number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 50 }, (_, i) => first + i));
    expect(
      (await one(t.db, `SELECT next_display_number FROM events WHERE id = $1`, [EVT_R1])).next_display_number,
    ).toBe(first + 50);
    await expectConsistent(t.db);
  });

  it('intake and accept by the same driver race on the pool lock: exactly one of them succeeds', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    t.clock.advanceSeconds(1);
    ok(await startDuty(t, 'DRV2'), 201);
    const parked = await parkedPaperTicket(t, 'DRV2');
    t.clock.advanceSeconds(1);
    ok(await requestRetrieval(t, 'SUP-R', parked.ticketId), 201);
    const offer = (await liveOffer(t.db, U.DRV1))!;
    expect(offer).not.toBeNull();
    const [a, b] = await Promise.all([accept(t, 'DRV1', offer.id), startIntake(t, 'DRV1')]);
    const winners = [a, b].filter((r) => r.status < 300);
    expect(winners).toHaveLength(1);
    if (a.status < 300) expect(b.body.error.code).toBe('MOVEMENT_IN_PROGRESS');
    else expect(a.body.error.code).toBe('OFFER_REVOKED');
    const movements = await one(
      t.db,
      `SELECT count(*)::int AS n FROM tasks WHERE assignee_id = $1 AND status IN ('accepted','in_progress')`,
      [U.DRV1],
    );
    expect(movements.n).toBe(1);
    await expectConsistent(t.db);
  });

  it('sequentially: intake first revokes the single offer (OFFER_REVOKED); accept first blocks the intake', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    t.clock.advanceSeconds(1);
    ok(await startDuty(t, 'DRV2'), 201);
    const p1 = await parkedPaperTicket(t, 'DRV2');
    t.clock.advanceSeconds(1);
    ok(await requestRetrieval(t, 'SUP-R', p1.ticketId), 201);
    const offer = (await liveOffer(t.db, U.DRV1))!;
    await newDraft(t, 'DRV1');
    expect(err(await accept(t, 'DRV1', offer.id), 'OFFER_REVOKED', 410)).toMatchObject({
      offer_id: offer.id,
      close_reason: 'recipient_unavailable',
    });
    // the revoked task went to DRV2 (DRV1 was tried in this episode)
    const offer2 = (await liveOffer(t.db, U.DRV2))!;
    expect(offer2.task_id).toBe(offer.task_id);
    ok(await accept(t, 'DRV2', offer2.id));
    expect(err(await startIntake(t, 'DRV2'), 'MOVEMENT_IN_PROGRESS', 409).active_task_id).toBe(offer.task_id);
    await expectConsistent(t.db);
  });
});

describe('PNT-026 — PATCH /v1/tickets/{ticketId}/intake', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
  });
  afterEach(async () => t.close());

  it('normalizes the Saudi plate (letters → Latin, Arabic-Indic digits) and the phone (E.164)', async () => {
    const d = await newDraft(t, 'DRV1');
    const r = ok(
      await patchIntake(t, 'DRV1', d.ticketId, {
        expected_version: d.version,
        plate: { digits: '١٢٣٤', letters_ar: 'أ ح ى' },
        vehicle: { make: ' تويوتا ', color: 'أبيض' },
        customer_phone: '0551234567',
        consent: { method: 'verbal_staff_confirmed', confirmed: true },
        notes: 'خدش في الباب',
        damage_marks: [{ area: 'front_left', note: 'خدش خفيف' }],
      }),
    );
    expect(r.plate).toEqual({
      country: 'SA',
      digits: '1234',
      letters_ar: 'ا ح ى',
      letters_en: 'A J V',
      raw: null,
      display: '1234 ا ح ى',
    });
    expect(r.vehicle_detail).toMatchObject({ make: 'تويوتا', color: 'أبيض' });
    expect(r.customer).toEqual({ phone_masked: '05•••••567', opted_out: false });
    expect(r.damage_marks).toEqual([{ area: 'front_left', note: 'خدش خفيف' }]);
    expect(r.version).toBe(d.version + 1);
    const c = await one(
      t.db,
      `SELECT c.phone_e164, cc.method, cc.captured_by FROM tickets t JOIN customers c ON c.id = t.customer_id
         JOIN customer_consents cc ON cc.ticket_id = t.id WHERE t.id = $1`,
      [d.ticketId],
    );
    expect(c).toEqual({ phone_e164: '+966551234567', method: 'verbal_staff_confirmed', captured_by: U.DRV1 });
    // another number revokes the consent given for the previous one
    ok(
      await patchIntake(t, 'DRV1', d.ticketId, {
        expected_version: r.version,
        customer_phone: '+966551112222',
      }),
    );
    const consents = await rows(
      t.db,
      `SELECT revoked_at IS NOT NULL AS revoked, revoke_source FROM customer_consents WHERE ticket_id = $1`,
      [d.ticketId],
    );
    expect(consents).toEqual([{ revoked: true, revoke_source: 'staff' }]);
    expect(await auditCount(t.db, 'ticket.intake', d.ticketId)).toBe(3);
  });

  it('PLATE_INVALID with field and reason (digits / letters / mapping / raw)', async () => {
    const d = await newDraft(t, 'DRV1');
    const p = (plate: Record<string, string>) =>
      patchIntake(t, 'DRV1', d.ticketId, { expected_version: d.version, plate });
    expect(err(await p({ digits: '12345', letters_ar: 'ب ح د' }), 'PLATE_INVALID', 422)).toEqual({
      field: 'plate.digits',
      reason: 'digits',
    });
    expect(err(await p({ digits: '12', letters_ar: 'ب ح' }), 'PLATE_INVALID').reason).toBe('letters');
    expect(err(await p({ digits: '12', letters_ar: 'ب ح خ' }), 'PLATE_INVALID').reason).toBe('letters');
    expect(
      err(await p({ digits: '12', letters_ar: 'ب ح د', letters_en: 'B H D' }), 'PLATE_INVALID').reason,
    ).toBe('mapping');
    expect(err(await p({ country: 'AE' }), 'PLATE_INVALID')).toEqual({ field: 'plate.raw', reason: 'raw' });
    const ae = ok(await p({ country: 'AE', raw: 'dubai a 12345' }));
    expect(ae.plate).toMatchObject({ country: 'AE', raw: 'DUBAI A 12345', display: 'DUBAI A 12345' });
  });

  it('PHONE_INVALID; consent needs a phone (VALIDATION_FAILED)', async () => {
    const d = await newDraft(t, 'DRV1');
    expect(
      err(
        await patchIntake(t, 'DRV1', d.ticketId, { expected_version: d.version, customer_phone: '12345' }),
        'PHONE_INVALID',
        422,
      ),
    ).toEqual({
      field: 'customer_phone',
    });
    err(
      await patchIntake(t, 'DRV1', d.ticketId, {
        expected_version: d.version,
        consent: { method: 'verbal_staff_confirmed', confirmed: true },
      }),
      'VALIDATION_FAILED',
      422,
    );
    err(
      await patchIntake(t, 'DRV1', d.ticketId, { expected_version: d.version, event_id: EVT_R2 }),
      'VALIDATION_FAILED',
      422,
    );
  });

  it('KEY_TAG_IN_USE on another open ticket; PAPER_SERIAL_IN_USE in the same event', async () => {
    ok(await startDuty(t, 'DRV2'), 201);
    const a = await newDraft(t, 'DRV1');
    const b = await newDraft(t, 'DRV2');
    ok(
      await patchIntake(t, 'DRV1', a.ticketId, {
        expected_version: a.version,
        key_tag: 'k-73',
        paper_serial: 's-1',
      }),
    );
    expect(
      err(
        await patchIntake(t, 'DRV2', b.ticketId, { expected_version: b.version, key_tag: 'K-73' }),
        'KEY_TAG_IN_USE',
        409,
      ),
    ).toEqual({
      field: 'key_tag',
      conflicting_display_number: a.displayNumber,
    });
    expect(
      err(
        await patchIntake(t, 'DRV2', b.ticketId, { expected_version: b.version, paper_serial: 'S-1' }),
        'PAPER_SERIAL_IN_USE',
        409,
      ),
    ).toEqual({
      field: 'paper_serial',
    });
  });

  it('VERSION_CONFLICT for a stale expected_version', async () => {
    const d = await newDraft(t, 'DRV1');
    ok(await patchIntake(t, 'DRV1', d.ticketId, { expected_version: d.version, key_tag: 'K-1' }));
    expect(
      err(
        await patchIntake(t, 'DRV1', d.ticketId, { expected_version: d.version, key_tag: 'K-2' }),
        'VERSION_CONFLICT',
        409,
      ),
    ).toEqual({
      entity: 'ticket',
      id: d.ticketId,
      current_version: d.version + 1,
    });
  });

  it('the creator only (PERMISSION_DENIED); out of scope or unknown → TICKET_NOT_FOUND; off duty → DUTY_REQUIRED', async () => {
    const d = await newDraft(t, 'DRV1');
    ok(await startDuty(t, 'DRV2'), 201);
    expect(
      err(
        await patchIntake(t, 'DRV2', d.ticketId, { expected_version: d.version, key_tag: 'X' }),
        'PERMISSION_DENIED',
        403,
      ),
    ).toEqual({
      permission: 'ticket.intake',
      reason: 'not_ticket_creator',
    });
    ok(await startDuty(t, 'DRV7'), 201); // LYL
    err(
      await patchIntake(t, 'DRV7', d.ticketId, { expected_version: d.version, key_tag: 'X' }),
      'TICKET_NOT_FOUND',
      404,
    );
    err(await patchIntake(t, 'DRV1', DUMMY, { expected_version: 1 }), 'TICKET_NOT_FOUND', 404);
    err(await patchIntake(t, 'DRV1', 'not-a-uuid', { expected_version: 1 }), 'TICKET_NOT_FOUND', 404);
    err(
      await patchIntake(t, 'DRV3', d.ticketId, { expected_version: d.version, key_tag: 'X' }),
      'DUTY_REQUIRED',
      409,
    );
    // 07 §1.10: scope is checked before the duty conditions (an off-duty LYL driver learns nothing)
    err(
      await patchIntake(t, 'DRV8', d.ticketId, { expected_version: d.version, key_tag: 'X' }),
      'TICKET_NOT_FOUND',
      404,
    );
  });

  it('DEC-40: during parking only {channel: paper, paper_serial} for a ticket not linked', async () => {
    const d = await newDraft(t, 'DRV1');
    const filled = ok(
      await patchIntake(t, 'DRV1', d.ticketId, {
        expected_version: d.version,
        ...PAPER_DRAFT('S-9', 'K-9'),
        channel: 'whatsapp',
        paper_serial: null,
        customer_phone: '0551234567',
        consent: { method: 'verbal_staff_confirmed', confirmed: true },
      }),
    );
    await addPhotos(t.db, d.ticketId, U.DRV1);
    await approveWaTemplates(t.db); // the direct link at submit needs an approved W-01 (PNT-043)
    const parking = ok(await submitIntake(t, 'DRV1', d.ticketId, { expected_version: filled.version }));
    expect(parking).toMatchObject({ status: 'parking', channel: 'whatsapp', wa_link_status: 'pending_send' });
    // a live QR link code of this ticket (issued by the whatsapp module)
    await t.db.query(
      `INSERT INTO link_codes (org_id, ticket_id, code, status, created_by, expires_at) SELECT org_id, id, 'ABCDEF', 'active', $2, now() + interval '10 minutes' FROM tickets WHERE id = $1`,
      [d.ticketId, U.DRV1],
    );
    const before = await one(t.db, `SELECT link_version, version FROM tickets WHERE id = $1`, [d.ticketId]);
    expect(
      err(
        await patchIntake(t, 'DRV1', d.ticketId, {
          expected_version: before.version,
          channel: 'paper',
          paper_serial: 'S-9',
          key_tag: 'K-10',
        }),
        'INVALID_STATE_TRANSITION',
        409,
      ),
    ).toMatchObject({
      entity_type: 'ticket',
      current_status: 'parking',
      reason: 'only_paper_conversion_in_parking',
    });
    const converted = ok(
      await patchIntake(t, 'DRV1', d.ticketId, {
        expected_version: before.version,
        channel: 'paper',
        paper_serial: 's-9',
      }),
    );
    expect(converted).toMatchObject({ channel: 'paper', paper_serial: 'S-9', wa_link_status: 'none' });
    expect(await one(t.db, `SELECT link_version FROM tickets WHERE id = $1`, [d.ticketId])).toEqual({
      link_version: before.link_version + 1,
    });
    expect(
      await one(t.db, `SELECT status, revoke_reason FROM link_codes WHERE ticket_id = $1`, [d.ticketId]),
    ).toEqual({
      status: 'revoked',
      revoke_reason: 'channel_paper',
    });
    const ev = (await outboxEvents(t.db, 'ticket.wa_link_changed')).map((e) => e.payload.payload);
    expect(ev).toEqual([
      expect.objectContaining({ method: 'direct', to: 'pending_send', link_version: before.link_version }),
      expect.objectContaining({ method: 'channel_paper', to: 'none', link_version: before.link_version + 1 }),
    ]);
    // a second conversion, a linked ticket or a parked ticket are invalid transitions
    expect(
      err(
        await patchIntake(t, 'DRV1', d.ticketId, {
          expected_version: converted.version,
          channel: 'paper',
          paper_serial: 'S-8',
        }),
        'INVALID_STATE_TRANSITION',
      ).reason,
    ).toBe('already_paper');
  });

  it('DEC-40: a linked ticket cannot become paper; nothing is editable after parking', async () => {
    const d = await newDraft(t, 'DRV1');
    const filled = ok(
      await patchIntake(t, 'DRV1', d.ticketId, { expected_version: d.version, ...PAPER_DRAFT('S-7', 'K-7') }),
    );
    await addPhotos(t.db, d.ticketId, U.DRV1);
    ok(await submitIntake(t, 'DRV1', d.ticketId, { expected_version: filled.version }));
    await t.db.query(
      `UPDATE tickets SET channel = 'whatsapp', wa_link_status = 'linked', version = version + 1 WHERE id = $1`,
      [d.ticketId],
    );
    const v = (await one(t.db, `SELECT version FROM tickets WHERE id = $1`, [d.ticketId])).version;
    expect(
      err(
        await patchIntake(t, 'DRV1', d.ticketId, {
          expected_version: v,
          channel: 'paper',
          paper_serial: 'S-7',
        }),
        'INVALID_STATE_TRANSITION',
      ).reason,
    ).toBe('ticket_linked');
    await t.db.query(
      `UPDATE tickets SET status = 'voided', voided_at = now(), void_reason = 'test' WHERE id = $1`,
      [d.ticketId],
    );
    await t.db.query(`UPDATE tasks SET status = 'canceled', canceled_at = now() WHERE ticket_id = $1`, [
      d.ticketId,
    ]);
    expect(
      err(
        await patchIntake(t, 'DRV1', d.ticketId, { expected_version: v, key_tag: 'K-1' }),
        'INVALID_STATE_TRANSITION',
      ),
    ).toMatchObject({
      current_status: 'voided',
      allowed_from: ['received', 'parking'],
    });
  });
});

describe('PNT-025 AC — v_driver_state, fee and numbering stay consistent', () => {
  it('an unknown body field is VALIDATION_FAILED', async () => {
    const t = await createS2App();
    try {
      ok(await startDuty(t, 'DRV1'), 201);
      err(await startIntake(t, 'DRV1', { event_id: EVT_R1, plate: '1' }), 'VALIDATION_FAILED', 422);
    } finally {
      await t.close();
    }
  });
});
