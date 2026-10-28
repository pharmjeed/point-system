import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  auditCount,
  createS2App,
  err,
  EVT_R1,
  EVT_R2,
  expectConsistent,
  ok,
  one,
  outboxEvents,
  paperTicketInParking,
  parkedPaperTicket,
  rows,
  startDuty,
  U,
} from './dispatch-fixtures.js';
import {
  CASH,
  cashHandover,
  deliver,
  deliveredWith,
  FEE,
  lylSupervisor,
  pay,
  POS,
  readyTicket,
  reverse,
  settlement,
  waive,
} from './payments-fixtures.js';

/** PNT-081 (13 §6, §7; PAY-TC-12 … PAY-TC-15): the supervisor's waiver and the reversal with or without replacement. */

const DUMMY = '00000000-0000-4000-8000-0000deadbeef';
const REASON = 'العميل رفض الدفع';

const ticketMoney = (t: TestApp, id: string) =>
  one(
    t.db,
    `SELECT status, payment_status, payment_waived_by, payment_waiver_reason, payment_waived_at, version
       FROM tickets WHERE id = $1`,
    [id],
  );

describe('PNT-081 — POST /v1/tickets/{ticketId}/payment-waiver (13 §6)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
  });
  afterEach(async () => t.close());

  it('REASON_REQUIRED / PERMISSION_DENIED / waived, and the handover then needs no payment (PAY-TC-12)', async () => {
    const r = await readyTicket(t, 'DRV1');
    for (const body of [{}, { reason: '   ' }, { reason: 'خط' }])
      expect(err(await waive(t, 'SUP-R', r.ticketId, body), 'REASON_REQUIRED', 422)).toEqual({
        field: 'reason',
        min_length: 3,
      });
    // canon §10: the waiver is the supervisor's (not the driver's, the administrator's or the owner's)
    for (const as of ['DRV1', 'ADM1', 'OWN1'])
      err(await waive(t, as, r.ticketId, { reason: REASON }), 'PERMISSION_DENIED', 403);

    t.clock.advanceSeconds(2);
    const detail = ok(await waive(t, 'SUP-R', r.ticketId, { reason: `  ${REASON} ` }));
    expect(detail).toMatchObject({ id: r.ticketId, payment_status: 'waived', version: r.version + 1 });
    expect(await ticketMoney(t, r.ticketId)).toMatchObject({
      payment_status: 'waived',
      payment_waived_by: U['SUP-R'],
      payment_waiver_reason: REASON,
      payment_waived_at: t.clock.now(),
    });
    expect((await outboxEvents(t.db, 'payment.waived')).map((e) => e.payload.payload)).toEqual([
      { ticket_id: r.ticketId, amount_halalas: FEE, waived_by: U['SUP-R'], reason: REASON },
    ]);
    const a = await one(
      t.db,
      `SELECT reason, before, after, metadata FROM audit_log WHERE action = 'payment.waive' AND entity_id = $1`,
      [r.ticketId],
    );
    expect(a).toMatchObject({
      reason: REASON,
      before: { payment_status: 'due' },
      after: { payment_status: 'waived' },
      metadata: { operation: 'POST /v1/tickets/{ticketId}/payment-waiver', amount_halalas: FEE },
    });
    expect(a.metadata.self_approved).toBeUndefined();

    const done = ok(await deliver(t, 'DRV1', r));
    expect(done.ticket).toMatchObject({ status: 'delivered', payment_status: 'waived' });
    expect(done.payment).toBeNull();
    await expectConsistent(t.db);
  });

  it('PAYMENT_ALREADY_RECORDED on a collected ticket; INVALID_STATE_TRANSITION when waived or not required', async () => {
    const collected = await deliveredWith(t, 'DRV1', CASH);
    expect(
      err(await waive(t, 'SUP-R', collected.ticketId, { reason: REASON }), 'PAYMENT_ALREADY_RECORDED', 409),
    ).toEqual({
      payment_id: collected.paymentId,
      method: 'cash',
      collected_by: U.DRV1,
    });

    const r = await readyTicket(t, 'DRV1');
    ok(await waive(t, 'SUP-R', r.ticketId, { reason: REASON }));
    expect(
      err(await waive(t, 'SUP-R', r.ticketId, { reason: REASON }), 'INVALID_STATE_TRANSITION', 409),
    ).toMatchObject({
      entity_type: 'ticket',
      entity_id: r.ticketId,
      current_status: 'waived',
      allowed_from: ['due'],
      reason: 'payment_waived',
    });
    ok(await deliver(t, 'DRV1', r));

    const included = await parkedPaperTicket(t, 'DRV1', { eventId: EVT_R1 });
    expect(
      err(await waive(t, 'SUP-R', included.ticketId, { reason: REASON }), 'INVALID_STATE_TRANSITION', 409),
    ).toMatchObject({ current_status: 'not_required', reason: 'payment_not_required' });
    expect(await auditCount(t.db, 'payment.waive')).toBe(1);
  });

  it('TICKET_NOT_FOUND outside the scope or unknown; TICKET_CLOSED on a voided ticket', async () => {
    const d = await paperTicketInParking(t, 'DRV1', { eventId: EVT_R2 });
    const lyl = await lylSupervisor(t);
    err(await waive(t, lyl, d.ticketId, { reason: REASON }), 'TICKET_NOT_FOUND', 404);
    err(await waive(t, 'SUP-R', DUMMY, { reason: REASON }), 'TICKET_NOT_FOUND', 404);
    err(await waive(t, 'SUP-R', 'not-a-uuid', { reason: REASON }), 'TICKET_NOT_FOUND', 404);

    ok(
      await t.command('post', `/v1/tickets/${d.ticketId}/void`, {
        as: 'SUP-R',
        body: { reason: 'تسجيل خاطئ', custody_returned_to_customer: true },
      }),
    );
    expect(err(await waive(t, 'SUP-R', d.ticketId, { reason: REASON }), 'TICKET_CLOSED', 409)).toEqual({
      ticket_status: 'voided',
    });
    expect(await auditCount(t.db, 'payment.waive')).toBe(0);
  });
});

describe('PNT-081 — POST /v1/payments/{paymentId}/reverse (13 §7)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
  });
  afterEach(async () => t.close());

  it('without replacement on an open ticket: due again, then a second record (PAY-TC-13)', async () => {
    const r = await readyTicket(t, 'DRV1');
    const p = ok(await pay(t, 'DRV1', r.ticketId, CASH), 201).payment;
    t.clock.advanceSeconds(4);
    const res = ok(await reverse(t, 'SUP-R', p.id, { reason: 'سُجل خطأ' }));
    expect(res.replacement).toBeNull();
    expect(res.reversed).toMatchObject({
      id: p.id,
      status: 'reversed',
      reversed_at: t.clock.now().toISOString(),
      reversed_by: { id: U['SUP-R'] },
      reversal_reason: 'سُجل خطأ',
    });
    expect(await ticketMoney(t, r.ticketId)).toMatchObject({
      status: 'ready',
      payment_status: 'due',
      version: r.version + 2,
    });
    expect((await outboxEvents(t.db, 'payment.reversed')).map((e) => e.payload.payload)).toEqual([
      {
        payment_id: p.id,
        ticket_id: r.ticketId,
        method: 'cash',
        amount_halalas: FEE,
        reversed_by: U['SUP-R'],
        reason: 'سُجل خطأ',
        with_replacement: false,
        replacement_payment_id: null,
        after_cash_handover: false,
        ticket_delivered: false,
        incident_id: null,
      },
    ]);
    expect(await auditCount(t.db, 'payment.reverse', p.id)).toBe(1);
    expect(await rows(t.db, `SELECT id FROM incidents`)).toEqual([]); // the ticket is open: no incident (13 §7.1)

    // collected again with a new record (the unique index only covers `recorded`)
    const second = ok(await pay(t, 'DRV1', r.ticketId, POS()), 201).payment;
    expect(
      await rows(t.db, `SELECT id, status FROM payments WHERE ticket_id = $1 ORDER BY created_at, id`, [
        r.ticketId,
      ]),
    ).toEqual(
      expect.arrayContaining([
        { id: p.id, status: 'reversed' },
        { id: second.id, status: 'recorded' },
      ]),
    );
    ok(await deliver(t, 'DRV1', r));
    await expectConsistent(t.db);
  });

  it('REASON_REQUIRED, PERMISSION_DENIED, PAYMENT_ALREADY_REVERSED (PAY-TC-15), RESOURCE_NOT_FOUND outside the scope', async () => {
    const a = await deliveredWith(t, 'DRV1', CASH);
    for (const body of [{}, { reason: '' }, { reason: 'ab' }])
      expect(err(await reverse(t, 'SUP-R', a.paymentId, body), 'REASON_REQUIRED', 422)).toEqual({
        field: 'reason',
        min_length: 3,
      });
    for (const as of ['DRV1', 'OWN1'])
      err(await reverse(t, as, a.paymentId, { reason: 'خطأ' }), 'PERMISSION_DENIED', 403);
    const lyl = await lylSupervisor(t);
    expect(err(await reverse(t, lyl, a.paymentId, { reason: 'خطأ' }), 'RESOURCE_NOT_FOUND', 404)).toEqual({
      resource: 'payment',
    });
    err(await reverse(t, 'SUP-R', DUMMY, { reason: 'خطأ' }), 'RESOURCE_NOT_FOUND', 404);
    err(await reverse(t, 'SUP-R', 'nope', { reason: 'خطأ' }), 'RESOURCE_NOT_FOUND', 404);

    // the administrator reverses too (canon §10); a second reversal is refused
    const first = ok(await reverse(t, 'ADM1', a.paymentId, { reason: 'عملية ملغاة' }));
    expect(
      err(await reverse(t, 'SUP-R', a.paymentId, { reason: 'مرة ثانية' }), 'PAYMENT_ALREADY_REVERSED', 409),
    ).toEqual({
      payment_id: a.paymentId,
      reversed_at: first.reversed.reversed_at,
    });
    expect(await auditCount(t.db, 'payment.reverse')).toBe(1);
  });

  it('with a replacement (cash → pos) after the cash handover: stays collected, adjusted difference 0 (PAY-TC-14)', async () => {
    const a = await deliveredWith(t, 'DRV1', CASH);
    const original = await one(t.db, `SELECT * FROM payments WHERE id = $1`, [a.paymentId]);
    // the customer actually paid by card: the driver hands over no cash (difference −20.00 and an incident)
    const h = ok(
      await cashHandover(t, 'SUP-R', { event_id: EVT_R2, driver_id: U.DRV1, amount_halalas: 0 }),
      201,
    );
    expect(h).toMatchObject({ expected_halalas: FEE, difference_halalas: -FEE, payment_ids: [a.paymentId] });
    expect(h.incident_id).toEqual(expect.any(String));

    t.clock.advanceSeconds(60);
    const res = ok(
      await reverse(t, 'SUP-R', a.paymentId, {
        reason: 'سُجل نقدًا والعميل دفع بالشبكة',
        replacement: POS('ap-4821'),
      }),
    );
    expect(res.reversed).toMatchObject({ id: a.paymentId, status: 'reversed', cash_handover_id: h.id });
    expect(res.replacement).toMatchObject({
      ticket_id: a.ticketId,
      cycle_id: original.cycle_id,
      method: 'pos',
      pos_reference: 'AP4821',
      amount_halalas: FEE,
      status: 'recorded',
      collected_by: { id: U.DRV1 },
      collected_at: new Date(original.collected_at).toISOString(),
      cash_handover_id: null,
    });
    expect(await ticketMoney(t, a.ticketId)).toMatchObject({
      payment_status: 'collected',
      version: a.version + 1,
    });
    const [reversed] = (await outboxEvents(t.db, 'payment.reversed')).map((e) => e.payload.payload);
    expect(reversed).toMatchObject({
      with_replacement: true,
      replacement_payment_id: res.replacement.id,
      after_cash_handover: true,
      ticket_delivered: true,
      incident_id: null,
    });
    const recorded = (await outboxEvents(t.db, 'payment.recorded')).map((e) => e.payload.payload);
    expect(recorded.at(-1)).toEqual({
      ticket_id: a.ticketId,
      payment_id: res.replacement.id,
      cycle_id: original.cycle_id,
      method: 'pos',
      amount_halalas: FEE,
      collected_by: U.DRV1,
      source: 'replacement',
      replaces_payment_id: a.paymentId,
    });
    // two audit rows: the reversal and the replacement's record
    expect(await auditCount(t.db, 'payment.reverse', a.paymentId)).toBe(1);
    expect(await auditCount(t.db, 'payment.record', res.replacement.id)).toBe(1);

    const s = await settlement(t, 'SUP-R', EVT_R2);
    expect(s.drivers).toEqual([
      {
        driver: { id: U.DRV1, employee_code: 'D-0001', full_name: 'سائق 1' },
        cash: {
          count: 0,
          collected_halalas: 0,
          handed_over_halalas: 0,
          outstanding_halalas: 0,
          difference_adjusted_halalas: 0,
        },
        pos: { count: 1, halalas: FEE },
      },
    ]);
    expect(s.amounts).toMatchObject({
      collected_halalas: FEE,
      by_method: { cash: { count: 0, halalas: 0 }, pos: { count: 1, halalas: FEE } },
      reversed: { count: 1, halalas: FEE },
    });
    expect(s.discrepancies).toEqual([
      {
        type: 'cash_difference',
        driver_id: U.DRV1,
        ticket_id: null,
        cash_handover_id: h.id,
        difference_halalas: -FEE,
        incident_id: h.incident_id,
      },
    ]);
    expect(s.close_blockers).toEqual({ unsettled_payments: [], cash_outstanding: [], payment_integrity: [] });
    expect(s.integrity).toEqual({ ok: true, violations: [] });
    await expectConsistent(t.db);
  });

  it('without replacement on a delivered ticket: due, a payment_discrepancy incident, unsettled until waived', async () => {
    const a = await deliveredWith(t, 'DRV1', POS());
    const res = ok(await reverse(t, 'SUP-R', a.paymentId, { reason: 'عملية الشبكة أُلغيت' }));
    expect(res.replacement).toBeNull();
    expect(await ticketMoney(t, a.ticketId)).toMatchObject({ status: 'delivered', payment_status: 'due' });
    const incident = await one(t.db, `SELECT * FROM incidents WHERE ticket_id = $1`, [a.ticketId]);
    expect(incident).toMatchObject({
      type: 'payment_discrepancy',
      status: 'open',
      severity: 'medium',
      event_id: EVT_R2,
      opened_by: U['SUP-R'],
    });
    expect(incident.description).toContain('20.00');
    expect((await outboxEvents(t.db, 'incident.opened')).map((e) => e.payload.payload)).toEqual([
      {
        incident_id: incident.id,
        type: 'payment_discrepancy',
        status: 'open',
        severity: 'medium',
        ticket_id: a.ticketId,
        auto_created: true,
      },
    ]);
    expect((await outboxEvents(t.db, 'payment.reversed'))[0].payload.payload).toMatchObject({
      ticket_delivered: true,
      incident_id: incident.id,
    });

    let s = await settlement(t, 'SUP-R', EVT_R2);
    expect(s.close_blockers.unsettled_payments).toEqual([
      expect.objectContaining({ id: a.ticketId, status: 'delivered', payment_status: 'due' }),
    ]);
    expect(s.discrepancies).toEqual([
      {
        type: 'delivered_due',
        driver_id: null,
        ticket_id: a.ticketId,
        cash_handover_id: null,
        difference_halalas: null,
        incident_id: incident.id,
      },
      {
        type: 'reversed_without_replacement',
        driver_id: U.DRV1,
        ticket_id: a.ticketId,
        cash_handover_id: null,
        difference_halalas: null,
        incident_id: incident.id,
      },
    ]);
    // 13 §6: a delivered ticket that became due is settled by a waiver
    ok(await waive(t, 'SUP-R', a.ticketId, { reason: 'تعويض عن الخدمة' }));
    s = await settlement(t, 'SUP-R', EVT_R2);
    expect(s.close_blockers.unsettled_payments).toEqual([]);
    expect(s.amounts).toMatchObject({ waived_halalas: FEE, due_halalas: 0, collected_halalas: 0 });
  });

  it('replacement rules: no_change, the 13 §5.2 checks with the replacement. prefix, a corrected reference', async () => {
    const a = await deliveredWith(t, 'DRV1', CASH);
    const rev = (replacement: unknown) => reverse(t, 'SUP-R', a.paymentId, { reason: 'تصحيح', replacement });
    expect(err(await rev(CASH), 'VALIDATION_FAILED', 422).fields).toEqual([
      { field: 'replacement', issue: 'no_change' },
    ]);
    expect(
      err(
        await rev({ method: 'pos', amount_halalas: 1500, pos_reference: 'X1' }),
        'PAYMENT_AMOUNT_MISMATCH',
        422,
      ),
    ).toEqual({
      expected_halalas: FEE,
      received_halalas: 1500,
    });
    expect(err(await rev(POS('4111-1111-1111-1111')), 'VALIDATION_FAILED', 422).fields).toEqual([
      { field: 'replacement.pos_reference', issue: 'looks_like_card_number' },
    ]);
    const ev = await one(t.db, `SELECT version FROM events WHERE id = $1`, [EVT_R2]);
    ok(
      await t.command('patch', `/v1/events/${EVT_R2}`, {
        as: 'SUP-R',
        body: { expected_version: ev.version, allowed_payment_methods: ['cash'] },
      }),
    );
    expect(err(await rev(POS()), 'PAYMENT_METHOD_NOT_ALLOWED', 422)).toEqual({ allowed_methods: ['cash'] });
    expect(await rows(t.db, `SELECT status FROM payments WHERE ticket_id = $1`, [a.ticketId])).toEqual([
      { status: 'recorded' },
    ]);
    expect(await auditCount(t.db, 'payment.reverse')).toBe(0);
  });

  it('a wrong POS reference is corrected by a replacement with the same method', async () => {
    const a = await deliveredWith(t, 'DRV1', POS('AP1'));
    const res = ok(
      await reverse(t, 'SUP-R', a.paymentId, { reason: 'رقم إيصال خطأ', replacement: POS('AP2') }),
    );
    expect(res.replacement).toMatchObject({ method: 'pos', pos_reference: 'AP2', status: 'recorded' });
    expect(
      err(
        await reverse(t, 'SUP-R', res.replacement.id, { reason: 'تصحيح', replacement: POS('ap 2') }),
        'VALIDATION_FAILED',
        422,
      ).fields,
    ).toEqual([{ field: 'replacement', issue: 'no_change' }]);
  });

  it('INVALID_STATE_TRANSITION payment_integrity when a recorded payment sits on a ticket that is not collected', async () => {
    const a = await deliveredWith(t, 'DRV1', CASH);
    // a state the commands never produce (13 §11.3 b), forced for the test
    await t.db.query(
      `UPDATE tickets SET payment_status = 'waived', payment_waived_at = now(), payment_waived_by = $2,
              payment_waiver_reason = 'forced' WHERE id = $1`,
      [a.ticketId, U['SUP-R']],
    );
    expect(
      err(await reverse(t, 'SUP-R', a.paymentId, { reason: 'تصحيح' }), 'INVALID_STATE_TRANSITION', 409),
    ).toMatchObject({
      current_status: 'waived',
      allowed_from: ['collected'],
      reason: 'payment_integrity',
    });
    const s = await settlement(t, 'SUP-R', EVT_R2);
    expect(s.integrity.ok).toBe(false);
    expect(s.close_blockers.payment_integrity).toEqual([
      { check: 'payment_without_collected', entity_id: a.paymentId },
    ]);
  });
});

describe('PNT-081 — a driving supervisor approving his own work is flagged (09 §10 rule 2)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'SUP-RD'), 201);
  });
  afterEach(async () => t.close());

  it('waiver of a ticket he hands over and reversal of his own collection carry self_approved', async () => {
    const a = await readyTicket(t, 'SUP-RD');
    ok(await waive(t, 'SUP-RD', a.ticketId, { reason: REASON }));
    ok(await deliver(t, 'SUP-RD', a));
    const b = await deliveredWith(t, 'SUP-RD', CASH);
    ok(await reverse(t, 'SUP-RD', b.paymentId, { reason: 'تصحيح', replacement: POS() }));
    const meta = await rows(
      t.db,
      `SELECT action, metadata->>'self_approved' AS self FROM audit_log
        WHERE action IN ('payment.waive','payment.reverse') ORDER BY id`,
    );
    expect(meta).toEqual([
      { action: 'payment.waive', self: 'true' },
      { action: 'payment.reverse', self: 'true' },
    ]);
    // his cash is handed to another supervisor, never to himself
    expect(
      err(
        await cashHandover(t, 'SUP-RD', { event_id: EVT_R2, driver_id: U['SUP-RD'], amount_halalas: 0 }),
        'PERMISSION_DENIED',
        403,
      ),
    ).toEqual({ permission: 'cash.handover_confirm', reason: 'self_handover' });
  });
});
