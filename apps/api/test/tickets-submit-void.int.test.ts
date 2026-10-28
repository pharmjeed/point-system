import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  addPhotos,
  auditCount,
  createS2App,
  err,
  EVT_L1,
  EVT_R2,
  expectConsistent,
  newDraft,
  ok,
  one,
  outboxEvents,
  PAPER_DRAFT,
  paperTicketInParking,
  parkedPaperTicket,
  patchIntake,
  rows,
  startDuty,
  startIntake,
  submitIntake,
  U,
} from './dispatch-fixtures.js';

const DUMMY = '00000000-0000-4000-8000-0000deadbeef';
const discard = (t: TestApp, as: string, id: string, body: Record<string, unknown> = {}) =>
  t.command('post', `/v1/tickets/${id}/discard-draft`, { as, body });
const voidT = (t: TestApp, as: string, id: string, body: Record<string, unknown>) =>
  t.command('post', `/v1/tickets/${id}/void`, { as, body });

describe('PNT-028 — POST /v1/tickets/{ticketId}/submit-intake', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
  });
  afterEach(async () => t.close());

  it('INTAKE_INCOMPLETE lists the missing fields (WhatsApp draft: phone; paper: the serial)', async () => {
    const d = await newDraft(t, 'DRV1');
    expect(
      err(
        await submitIntake(t, 'DRV1', d.ticketId, { expected_version: d.version }),
        'INTAKE_INCOMPLETE',
        422,
      ),
    ).toEqual({
      missing: ['plate', 'vehicle.make', 'vehicle.color', 'key_tag', 'customer_phone'],
    });
    const p = ok(
      await patchIntake(t, 'DRV1', d.ticketId, {
        expected_version: d.version,
        ...PAPER_DRAFT('S-1', 'K-1'),
        paper_serial: null,
      }),
    );
    expect(
      err(await submitIntake(t, 'DRV1', d.ticketId, { expected_version: p.version }), 'INTAKE_INCOMPLETE'),
    ).toEqual({
      missing: ['paper_serial'],
    });
  });

  it('CONSENT_REQUIRED for a direct WhatsApp link without consent; WA_CUSTOMER_OPTED_OUT for an opted-out customer', async () => {
    const d = await newDraft(t, 'DRV1');
    const p = ok(
      await patchIntake(t, 'DRV1', d.ticketId, {
        expected_version: d.version,
        ...PAPER_DRAFT('S-2', 'K-2'),
        channel: 'whatsapp',
        paper_serial: null,
        customer_phone: '0559876543',
      }),
    );
    expect(
      err(
        await submitIntake(t, 'DRV1', d.ticketId, { expected_version: p.version }),
        'CONSENT_REQUIRED',
        422,
      ),
    ).toEqual({
      field: 'consent',
    });
    const c = ok(
      await patchIntake(t, 'DRV1', d.ticketId, {
        expected_version: p.version,
        consent: { method: 'verbal_staff_confirmed', confirmed: true },
      }),
    );
    await t.db.query(`UPDATE customers SET wa_opted_out_at = now() WHERE phone_e164 = '+966559876543'`);
    err(
      await submitIntake(t, 'DRV1', d.ticketId, { expected_version: c.version }),
      'WA_CUSTOMER_OPTED_OUT',
      409,
    );
  });

  it('INSPECTION_INCOMPLETE lists missing kinds and failed uploads; acknowledged → incomplete + alert', async () => {
    const d = await newDraft(t, 'DRV1');
    const p = ok(
      await patchIntake(t, 'DRV1', d.ticketId, { expected_version: d.version, ...PAPER_DRAFT('S-3', 'K-3') }),
    );
    await addPhotos(t.db, d.ticketId, U.DRV1, ['photo_front', 'photo_rear']);
    await addPhotos(t.db, d.ticketId, U.DRV1, ['photo_left'], 'failed');
    const failed = await one(
      t.db,
      `SELECT id FROM media_assets WHERE ticket_id = $1 AND upload_status = 'failed'`,
      [d.ticketId],
    );
    expect(
      err(
        await submitIntake(t, 'DRV1', d.ticketId, { expected_version: p.version }),
        'INSPECTION_INCOMPLETE',
        409,
      ),
    ).toEqual({
      missing: ['photo_left', 'photo_right'],
      failed_media_ids: [failed.id],
    });
    const s = ok(
      await submitIntake(t, 'DRV1', d.ticketId, {
        expected_version: p.version,
        acknowledge_incomplete_inspection: true,
      }),
    );
    expect(s).toMatchObject({ status: 'parking', inspection_status: 'incomplete' });
    const alert = await one(
      t.db,
      `SELECT type, severity, status, ticket_id, details FROM alerts WHERE dedupe_key = $1`,
      [`inspection_incomplete:${d.ticketId}`],
    );
    expect(alert).toMatchObject({
      type: 'inspection_incomplete',
      severity: 'warning',
      status: 'open',
      ticket_id: d.ticketId,
    });
    expect(alert.details).toMatchObject({ missing: ['photo_left', 'photo_right'], missing_count: 2 });
    await expectConsistent(t.db);
  });

  it('success: parking, submitted_at, ticket_events, inspection record and media linked; fee unchanged', async () => {
    const d = await newDraft(t, 'DRV1', EVT_R2);
    const p = ok(
      await patchIntake(t, 'DRV1', d.ticketId, { expected_version: d.version, ...PAPER_DRAFT('S-4', 'K-4') }),
    );
    await addPhotos(t.db, d.ticketId, U.DRV1);
    t.clock.advanceSeconds(30);
    const s = ok(await submitIntake(t, 'DRV1', d.ticketId, { expected_version: p.version }));
    expect(s).toMatchObject({ status: 'parking', inspection_status: 'complete', payment_status: 'due' });
    expect(s.submitted_at).toBe(t.clock.now().toISOString());
    expect(await one(t.db, `SELECT fee_halalas FROM tickets WHERE id = $1`, [d.ticketId])).toEqual({
      fee_halalas: 2000,
    });
    const insp = await one(
      t.db,
      `SELECT id, kind, required_photos_ok FROM vehicle_inspections WHERE ticket_id = $1`,
      [d.ticketId],
    );
    expect(insp).toMatchObject({ kind: 'intake', required_photos_ok: true });
    const linked = await one(
      t.db,
      `SELECT count(*)::int AS n FROM media_assets WHERE ticket_id = $1 AND inspection_id = $2`,
      [d.ticketId, insp.id],
    );
    expect(linked.n).toBe(4);
    const ev = (await outboxEvents(t.db, 'ticket.intake_submitted')).map((e) => e.payload.payload);
    expect(ev).toEqual([
      {
        ticket: { ticket_id: d.ticketId, display_number: d.displayNumber, ticket_version: s.version },
        channel: 'paper',
        inspection_status: 'complete',
        payment_status: 'due',
        wa_link_status: 'none',
      },
    ]);
    const timeline = (
      await rows(t.db, `SELECT type FROM ticket_events WHERE ticket_id = $1 ORDER BY id`, [d.ticketId])
    ).map((r) => r.type);
    expect(timeline).toContain('ticket.intake_submitted');
  });

  it('VERSION_CONFLICT, INVALID_STATE_TRANSITION (already submitted), TICKET_NOT_FOUND, PERMISSION_DENIED', async () => {
    const d = await paperTicketInParking(t, 'DRV1');
    err(
      await submitIntake(t, 'DRV1', d.ticketId, { expected_version: d.version - 1 }),
      'VERSION_CONFLICT',
      409,
    );
    expect(
      err(
        await submitIntake(t, 'DRV1', d.ticketId, { expected_version: d.version }),
        'INVALID_STATE_TRANSITION',
        409,
      ),
    ).toMatchObject({
      current_status: 'parking',
      allowed_from: ['received'],
      command: 'POST /v1/tickets/{ticketId}/submit-intake',
    });
    err(await submitIntake(t, 'DRV1', DUMMY, { expected_version: 1 }), 'TICKET_NOT_FOUND', 404);
    ok(await startDuty(t, 'DRV2'), 201);
    const other = await newDraft(t, 'DRV2');
    err(
      await submitIntake(t, 'DRV1', other.ticketId, { expected_version: other.version }),
      'PERMISSION_DENIED',
      403,
    );
    err(await submitIntake(t, 'DRV1', other.ticketId, {}), 'VALIDATION_FAILED', 422);
  });
});

describe('PNT-029 — discard-draft and void', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
  });
  afterEach(async () => t.close());

  it('discard an empty draft: voided (empty_draft), park task canceled, custody back to the customer, driver available', async () => {
    const d = await newDraft(t, 'DRV1');
    t.clock.advanceSeconds(20);
    const r = ok(await discard(t, 'DRV1', d.ticketId));
    expect(r).toEqual({ driver_state: 'available', promoted_next_task: null });
    expect(
      await one(
        t.db,
        `SELECT status, void_reason, voided_by, vehicle_holder_type, key_holder_type FROM tickets WHERE id = $1`,
        [d.ticketId],
      ),
    ).toEqual({
      status: 'voided',
      void_reason: 'empty_draft',
      voided_by: U.DRV1,
      vehicle_holder_type: 'customer',
      key_holder_type: 'customer',
    });
    expect(await one(t.db, `SELECT status, cancel_reason FROM tasks WHERE id = $1`, [d.taskId])).toEqual({
      status: 'canceled',
      cancel_reason: 'draft_discarded',
    });
    const back = await rows(
      t.db,
      `SELECT subject, from_holder_type, to_holder_type, reason FROM custody_events WHERE ticket_id = $1 AND reason = 'correction' ORDER BY subject DESC`,
      [d.ticketId],
    );
    expect(back).toEqual([
      { subject: 'vehicle', from_holder_type: 'driver', to_holder_type: 'customer', reason: 'correction' },
      { subject: 'key', from_holder_type: 'driver', to_holder_type: 'customer', reason: 'correction' },
    ]);
    expect(
      await one(t.db, `SELECT available_since FROM duty_sessions WHERE user_id = $1 AND status <> 'ended'`, [
        U.DRV1,
      ]),
    ).toEqual({
      available_since: t.clock.now(),
    });
    expect((await outboxEvents(t.db, 'ticket.voided')).map((e) => e.payload.payload.via)).toEqual([
      'discard_draft',
    ]);
    // the number of a voided draft is never reused
    const next = ok(await startIntake(t, 'DRV1'), 201);
    expect(next.ticket.display_number).toBe(d.displayNumber + 1);
    expect(await auditCount(t.db, 'ticket.discard_empty_draft', d.ticketId)).toBe(1);
    await expectConsistent(t.db);
  });

  it('DRAFT_HAS_DATA lists the fields and raises draft_abandoned (kept although the command fails)', async () => {
    const d = await newDraft(t, 'DRV1');
    const p = ok(
      await patchIntake(t, 'DRV1', d.ticketId, {
        expected_version: d.version,
        key_tag: 'K-77',
        plate: { digits: '77', letters_ar: 'ب ب ب' },
      }),
    );
    await addPhotos(t.db, d.ticketId, U.DRV1, ['photo_front']);
    expect(
      err(await discard(t, 'DRV1', d.ticketId, { expected_version: p.version }), 'DRAFT_HAS_DATA', 409),
    ).toEqual({
      fields_present: ['plate', 'key_tag', 'photos'],
    });
    const alert = await one(t.db, `SELECT type, severity, status FROM alerts WHERE dedupe_key = $1`, [
      `draft_abandoned:${d.ticketId}`,
    ]);
    expect(alert).toEqual({ type: 'draft_abandoned', severity: 'warning', status: 'open' });
    expect(await one(t.db, `SELECT status FROM tickets WHERE id = $1`, [d.ticketId])).toEqual({
      status: 'received',
    });
    expect(
      (await one(t.db, `SELECT driver_state FROM v_driver_state WHERE user_id = $1`, [U.DRV1])).driver_state,
    ).toBe('intake_parking');
    // the driver finishes the draft instead: leaving `received` resolves the alert (11 §6.10, 14 §8)
    const full = ok(
      await patchIntake(t, 'DRV1', d.ticketId, {
        expected_version: p.version,
        ...PAPER_DRAFT('S-77', 'K-77'),
      }),
    );
    await addPhotos(t.db, d.ticketId, U.DRV1);
    ok(await submitIntake(t, 'DRV1', d.ticketId, { expected_version: full.version }));
    expect(
      await one(t.db, `SELECT status, resolved_by, resolution_note FROM alerts WHERE dedupe_key = $1`, [
        `draft_abandoned:${d.ticketId}`,
      ]),
    ).toEqual({ status: 'resolved', resolved_by: null, resolution_note: 'intake_submitted' });
    await expectConsistent(t.db);
  });

  it('discard: INVALID_STATE_TRANSITION after submit, VERSION_CONFLICT, TICKET_NOT_FOUND, PERMISSION_DENIED', async () => {
    const d = await paperTicketInParking(t, 'DRV1');
    expect(err(await discard(t, 'DRV1', d.ticketId), 'INVALID_STATE_TRANSITION', 409)).toMatchObject({
      current_status: 'parking',
    });
    ok(await startDuty(t, 'DRV2'), 201);
    const other = await newDraft(t, 'DRV2');
    err(
      await discard(t, 'DRV2', other.ticketId, { expected_version: other.version + 3 }),
      'VERSION_CONFLICT',
      409,
    );
    err(await discard(t, 'DRV1', other.ticketId), 'PERMISSION_DENIED', 403);
    err(await discard(t, 'DRV1', DUMMY), 'TICKET_NOT_FOUND', 404);
    // ticket.discard_empty_draft belongs to drivers only (canon §10)
    err(await discard(t, 'SUP-R', other.ticketId), 'PERMISSION_DENIED', 403);
  });

  it('void: REASON_REQUIRED, CUSTODY_OPEN until custody is confirmed, then voided with the driver released', async () => {
    const d = await paperTicketInParking(t, 'DRV1');
    expect(
      err(
        await voidT(t, 'SUP-R', d.ticketId, { custody_returned_to_customer: true }),
        'REASON_REQUIRED',
        422,
      ),
    ).toEqual({
      field: 'reason',
      min_length: 3,
    });
    err(
      await voidT(t, 'SUP-R', d.ticketId, { reason: 'خط', custody_returned_to_customer: true }),
      'REASON_REQUIRED',
      422,
    );
    expect(
      err(
        await voidT(t, 'SUP-R', d.ticketId, { reason: 'تسجيل خاطئ', custody_returned_to_customer: false }),
        'CUSTODY_OPEN',
        409,
      ),
    ).toEqual({
      items: [
        { type: 'vehicle', holder_type: 'driver', ticket_id: d.ticketId, display_number: d.displayNumber },
        { type: 'key', holder_type: 'driver', ticket_id: d.ticketId, display_number: d.displayNumber },
      ],
    });
    // the driver stays busy until the supervisor's approval
    expect(
      (await one(t.db, `SELECT driver_state FROM v_driver_state WHERE user_id = $1`, [U.DRV1])).driver_state,
    ).toBe('intake_parking');
    await t.db.query(
      `INSERT INTO alerts (org_id, venue_id, type, severity, dedupe_key) SELECT org_id, venue_id, 'draft_abandoned', 'warning', 'draft_abandoned:' || id FROM tickets WHERE id = $1`,
      [d.ticketId],
    );
    const v = ok(
      await voidT(t, 'SUP-R', d.ticketId, { reason: 'تسجيل خاطئ', custody_returned_to_customer: true }),
    );
    expect(v).toMatchObject({ status: 'voided', void_reason: 'تسجيل خاطئ', projection: 'full' });
    expect(
      await one(t.db, `SELECT status, cancel_reason, canceled_by FROM tasks WHERE id = $1`, [d.taskId]),
    ).toEqual({
      status: 'canceled',
      cancel_reason: 'ticket_voided',
      canceled_by: U['SUP-R'],
    });
    expect(
      await one(t.db, `SELECT status, resolved_by FROM alerts WHERE dedupe_key = $1`, [
        `draft_abandoned:${d.ticketId}`,
      ]),
    ).toEqual({
      status: 'resolved',
      resolved_by: null,
    });
    expect(
      (await one(t.db, `SELECT driver_state FROM v_driver_state WHERE user_id = $1`, [U.DRV1])).driver_state,
    ).toBe('available');
    const audit = await one(
      t.db,
      `SELECT reason FROM audit_log WHERE action = 'ticket.void' AND entity_id = $1`,
      [d.ticketId],
    );
    expect(audit.reason).toBe('تسجيل خاطئ');
    await expectConsistent(t.db);
  });

  it('void: INVALID_STATE_TRANSITION after parked (DEC-45), VERSION_CONFLICT, TICKET_NOT_FOUND out of scope', async () => {
    const p = await parkedPaperTicket(t, 'DRV1');
    expect(
      err(
        await voidT(t, 'SUP-R', p.ticketId, { reason: 'خطأ في التسجيل', custody_returned_to_customer: true }),
        'INVALID_STATE_TRANSITION',
        409,
      ),
    ).toMatchObject({
      current_status: 'parked',
      allowed_from: ['received', 'parking'],
    });
    const d = await newDraft(t, 'DRV1');
    err(
      await voidT(t, 'SUP-R', d.ticketId, {
        reason: 'خطأ في التسجيل',
        custody_returned_to_customer: true,
        expected_version: 9,
      }),
      'VERSION_CONFLICT',
      409,
    );
    ok(await startDuty(t, 'DRV7'), 201);
    const lyl = await newDraft(t, 'DRV7', EVT_L1);
    err(
      await voidT(t, 'SUP-R', lyl.ticketId, { reason: 'خطأ في التسجيل', custody_returned_to_customer: true }),
      'TICKET_NOT_FOUND',
      404,
    );
    err(
      await voidT(t, 'DRV1', d.ticketId, { reason: 'خطأ في التسجيل', custody_returned_to_customer: true }),
      'PERMISSION_DENIED',
      403,
    );
  });
});
