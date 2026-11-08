import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  auditCount,
  createS2App,
  err,
  EVT_L1,
  EVT_R2,
  expectConsistent,
  ok,
  one,
  outboxEvents,
  paperTicketInParking,
  parkedPaperTicket,
  RMS,
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
  onBreak,
  POS,
  readyTicket,
  reverse,
  settlement,
  waive,
} from './payments-fixtures.js';

/**
 * PNT-082 (13 §9 … §11; PAY-TC-16, PAY-TC-17, PAY-TC-23, PAY-TC-25): the cash a driver hands over to a
 * supervisor, the stored difference and its incident, and the event settlement against the reference SQL.
 */

const DUMMY = '00000000-0000-4000-8000-0000deadbeef';
const linkedTo = (t: TestApp, paymentIds: string[]) =>
  rows(t.db, `SELECT id, cash_handover_id FROM payments WHERE id = ANY($1::uuid[]) ORDER BY id`, [
    paymentIds,
  ]);

describe('PNT-082 — POST /v1/cash-handovers (13 §10)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
  });
  afterEach(async () => t.close());

  it('expected = the recorded cash not handed over; payments linked, event, audit; a later handover links the rest', async () => {
    const a = await deliveredWith(t, 'DRV1', CASH);
    const b = await deliveredWith(t, 'DRV1', CASH);
    const c = await deliveredWith(t, 'DRV1', POS()); // a card payment is never cash to hand over
    t.clock.advanceSeconds(30);
    const h = ok(
      await cashHandover(t, 'SUP-R', {
        event_id: EVT_R2,
        driver_id: U.DRV1,
        amount_halalas: 2 * FEE,
        note: ' تسليم منتصف الحفل ',
      }),
      201,
    );
    expect(h).toMatchObject({
      event_id: EVT_R2,
      venue_id: RMS,
      driver: { id: U.DRV1, employee_code: 'D-0001' },
      received_by: { id: U['SUP-R'] },
      amount_halalas: 2 * FEE,
      expected_halalas: 2 * FEE,
      difference_halalas: 0,
      note: 'تسليم منتصف الحفل',
      handed_at: t.clock.now().toISOString(),
      incident_id: null,
    });
    expect([...h.payment_ids].sort()).toEqual([a.paymentId, b.paymentId].sort());
    expect(
      (await linkedTo(t, [a.paymentId, b.paymentId, c.paymentId])).map((p) => p.cash_handover_id),
    ).toEqual([a.paymentId, b.paymentId, c.paymentId].sort().map((id) => (id === c.paymentId ? null : h.id)));
    expect((await outboxEvents(t.db, 'cash.handover_recorded')).map((e) => e.payload.payload)).toEqual([
      {
        cash_handover_id: h.id,
        event_id: EVT_R2,
        driver_id: U.DRV1,
        received_by: U['SUP-R'],
        amount_halalas: 2 * FEE,
        expected_halalas: 2 * FEE,
        difference_halalas: 0,
        linked_payments_count: 2,
        incident_id: null,
      },
    ]);
    const audit = await one(
      t.db,
      `SELECT after, venue_id FROM audit_log WHERE action = 'cash.handover_confirm' AND entity_id = $1`,
      [h.id],
    );
    expect(audit).toEqual({
      after: { driver_id: U.DRV1, amount_halalas: 2 * FEE, expected_halalas: 2 * FEE },
      venue_id: RMS,
    });
    expect(await rows(t.db, `SELECT id FROM incidents`)).toEqual([]);

    // a second handover (end of the event, received by the administrator) links only the new collection
    const d = await deliveredWith(t, 'DRV1', CASH);
    const h2 = ok(
      await cashHandover(t, 'ADM1', { event_id: EVT_R2, driver_id: U.DRV1, amount_halalas: FEE }),
      201,
    );
    expect(h2).toMatchObject({ expected_halalas: FEE, difference_halalas: 0, payment_ids: [d.paymentId] });
    const s = await settlement(t, 'SUP-R', EVT_R2);
    expect(s.drivers[0].cash).toEqual({
      count: 3,
      collected_halalas: 3 * FEE,
      handed_over_halalas: 3 * FEE,
      outstanding_halalas: 0,
      difference_adjusted_halalas: 0,
    });
    expect(s.cash_handovers.map((x: { id: string }) => x.id)).toEqual([h.id, h2.id]);
  });

  it('a shortfall: negative difference stored and a payment_discrepancy incident opened (PAY-TC-16)', async () => {
    const a = await deliveredWith(t, 'DRV1', CASH);
    const h = ok(
      await cashHandover(t, 'SUP-R', { event_id: EVT_R2, driver_id: U.DRV1, amount_halalas: 1500 }),
      201,
    );
    expect(h).toMatchObject({ expected_halalas: FEE, amount_halalas: 1500, difference_halalas: -500 });
    const incident = await one(t.db, `SELECT * FROM incidents WHERE id = $1`, [h.incident_id]);
    expect(incident).toMatchObject({
      type: 'payment_discrepancy',
      status: 'open',
      severity: 'medium',
      venue_id: RMS,
      event_id: EVT_R2,
      ticket_id: null,
      opened_by: U['SUP-R'],
    });
    for (const amount of ['20.00', '15.00', '-5.00']) expect(incident.description).toContain(amount);
    expect((await outboxEvents(t.db, 'incident.opened')).map((e) => e.payload.payload)).toEqual([
      {
        incident_id: h.incident_id,
        type: 'payment_discrepancy',
        status: 'open',
        severity: 'medium',
        ticket_id: null,
        auto_created: true,
      },
    ]);
    expect((await outboxEvents(t.db, 'cash.handover_recorded'))[0].payload.payload).toMatchObject({
      difference_halalas: -500,
      incident_id: h.incident_id,
    });
    const s = await settlement(t, 'SUP-R', EVT_R2);
    expect(s.discrepancies).toEqual([
      {
        type: 'cash_difference',
        driver_id: U.DRV1,
        ticket_id: null,
        cash_handover_id: h.id,
        difference_halalas: -500,
        incident_id: h.incident_id,
      },
    ]);
    expect(s.drivers[0].cash).toMatchObject({ outstanding_halalas: 0, difference_adjusted_halalas: -500 });
    expect(s.cash_handovers[0]).toMatchObject({
      id: h.id,
      incident_id: h.incident_id,
      payment_ids: [a.paymentId],
    });
  });

  it('two handovers at once for the same driver never link a payment twice (PAY-TC-17)', async () => {
    const a = await deliveredWith(t, 'DRV1', CASH);
    const res = await Promise.all([
      cashHandover(t, 'SUP-R', { event_id: EVT_R2, driver_id: U.DRV1, amount_halalas: FEE }),
      cashHandover(t, 'SUP-RL', { event_id: EVT_R2, driver_id: U.DRV1, amount_halalas: FEE }),
    ]);
    expect(res.map((r) => r.status)).toEqual([201, 201]);
    const [x, y] = res.map((r) => r.body.data).sort((p, q) => q.expected_halalas - p.expected_halalas);
    expect(x).toMatchObject({ expected_halalas: FEE, difference_halalas: 0, payment_ids: [a.paymentId] });
    // the later one saw the payment already linked: nothing expected, the counted cash is a surplus
    expect(y).toMatchObject({ expected_halalas: 0, difference_halalas: FEE, payment_ids: [] });
    expect(y.incident_id).toEqual(expect.any(String));
    expect(await linkedTo(t, [a.paymentId])).toEqual([{ id: a.paymentId, cash_handover_id: x.id }]);
  });

  it('nothing_to_hand_over, self_handover (PAY-TC-25), out-of-scope event or driver, and the role matrix', async () => {
    expect(
      err(
        await cashHandover(t, 'SUP-R', { event_id: EVT_R2, driver_id: U.DRV2, amount_halalas: 0 }),
        'VALIDATION_FAILED',
        422,
      ).fields,
    ).toEqual([{ field: 'amount_halalas', issue: 'nothing_to_hand_over' }]);
    // DEC-PROPOSED-1: 08 / 09 / the constraint map — PERMISSION_DENIED with reason self_handover
    expect(
      err(
        await cashHandover(t, 'SUP-RD', { event_id: EVT_R2, driver_id: U['SUP-RD'], amount_halalas: 0 }),
        'PERMISSION_DENIED',
        403,
      ),
    ).toEqual({ permission: 'cash.handover_confirm', reason: 'self_handover' });
    expect(
      err(
        await cashHandover(t, 'SUP-R', { event_id: EVT_L1, driver_id: U.DRV7, amount_halalas: 100 }),
        'RESOURCE_NOT_FOUND',
        404,
      ),
    ).toEqual({ resource: 'event' });
    err(
      await cashHandover(t, 'SUP-R', { event_id: DUMMY, driver_id: U.DRV1, amount_halalas: 100 }),
      'RESOURCE_NOT_FOUND',
      404,
    );
    expect(
      err(
        await cashHandover(t, 'SUP-R', { event_id: EVT_R2, driver_id: DUMMY, amount_halalas: 100 }),
        'RESOURCE_NOT_FOUND',
        404,
      ),
    ).toEqual({ resource: 'driver' });
    expect(
      err(
        await cashHandover(t, 'SUP-R', { event_id: 'x', driver_id: U.DRV1, amount_halalas: -1 }),
        'VALIDATION_FAILED',
        422,
      )
        .fields.map((f: { field: string }) => f.field)
        .sort(),
    ).toEqual(['amount_halalas', 'event_id']);
    for (const as of ['DRV1', 'OWN1'])
      err(
        await cashHandover(t, as, { event_id: EVT_R2, driver_id: U.DRV2, amount_halalas: 100 }),
        'PERMISSION_DENIED',
        403,
      );
    expect(await auditCount(t.db, 'cash.handover_confirm')).toBe(0);
  });

  it('INVALID_STATE_TRANSITION on a draft event', async () => {
    const draft = ok(
      await t.command('post', `/v1/venues/${RMS}/events`, {
        as: 'SUP-R',
        body: {
          name_ar: 'حفل مسودة',
          event_date: '2026-11-02',
          pricing_mode: 'per_vehicle',
          fee_halalas: FEE,
        },
      }),
      201,
    );
    expect(
      err(
        await cashHandover(t, 'SUP-R', { event_id: draft.id, driver_id: U.DRV1, amount_halalas: 100 }),
        'INVALID_STATE_TRANSITION',
        409,
      ),
    ).toMatchObject({ entity_type: 'event', current_status: 'draft', allowed_from: ['open', 'closing'] });
  });
});

describe('PNT-082 — GET /v1/events/{eventId}/settlement (13 §11)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
  });
  afterEach(async () => t.close());

  it('matches the reference SQL of 13 §11.4: billable = collected + waived + due, totals = recorded (PAY-TC-23)', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    ok(await startDuty(t, 'DRV2'), 201);
    ok(await onBreak(t, 'DRV2', true));
    // DRV1: cash, pos, cash reversed after delivery (then waived), one ticket still parked; one voided intake
    const t1 = await deliveredWith(t, 'DRV1', CASH);
    const t2 = await deliveredWith(t, 'DRV1', POS());
    const t3 = await deliveredWith(t, 'DRV1', CASH);
    ok(await reverse(t, 'SUP-R', t3.paymentId, { reason: 'عملية لم تتم' }));
    ok(await waive(t, 'SUP-R', t3.ticketId, { reason: 'مجاملة للعميل' }));
    const t4 = await parkedPaperTicket(t, 'DRV1', { eventId: EVT_R2 });
    const t7 = await paperTicketInParking(t, 'DRV1', { eventId: EVT_R2 });
    ok(
      await t.command('post', `/v1/tickets/${t7.ticketId}/void`, {
        as: 'SUP-R',
        body: { reason: 'تسجيل خاطئ', custody_returned_to_customer: true },
      }),
    );
    ok(await cashHandover(t, 'SUP-R', { event_id: EVT_R2, driver_id: U.DRV1, amount_halalas: FEE }), 201);
    // DRV2: one cash delivery (not handed over), one waived at ready
    ok(await onBreak(t, 'DRV1', true));
    ok(await onBreak(t, 'DRV2', false));
    const t5 = await deliveredWith(t, 'DRV2', CASH);
    const t6 = await readyTicket(t, 'DRV2');
    ok(await waive(t, 'SUP-R', t6.ticketId, { reason: 'خدمة مجاملة' }));
    ok(await deliver(t, 'DRV2', t6));
    await expectConsistent(t.db);

    const s = await settlement(t, 'SUP-R', EVT_R2);
    // the reference queries, verbatim from 13 §11.4
    const ref = await one(
      t.db,
      `SELECT count(*)::int AS tickets_total,
              count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
              count(*) FILTER (WHERE status <> 'delivered')::int AS open,
              count(*) FILTER (WHERE payment_status = 'due')::int AS due_count,
              coalesce(sum(fee_halalas) FILTER (WHERE payment_status = 'due'), 0)::int AS due_halalas,
              count(*) FILTER (WHERE payment_status = 'collected')::int AS collected_count,
              count(*) FILTER (WHERE payment_status = 'waived')::int AS waived_count,
              coalesce(sum(fee_halalas) FILTER (WHERE payment_status = 'waived'), 0)::int AS waived_halalas,
              coalesce(sum(fee_halalas) FILTER (WHERE payment_status IN ('due','collected','waived')), 0)::int AS billable_halalas
         FROM tickets WHERE event_id = $1 AND status <> 'voided'`,
      [EVT_R2],
    );
    const byMethod = await rows(
      t.db,
      `SELECT method, count(*)::int AS count, sum(amount_halalas)::int AS halalas
         FROM payments WHERE event_id = $1 AND status = 'recorded' GROUP BY method ORDER BY method`,
      [EVT_R2],
    );
    const perDriver = await rows(
      t.db,
      `SELECT p.collected_by AS driver_id,
              count(*) FILTER (WHERE p.method = 'cash')::int AS cash_count,
              coalesce(sum(p.amount_halalas) FILTER (WHERE p.method = 'cash'), 0)::int AS cash_collected,
              coalesce(sum(p.amount_halalas) FILTER (WHERE p.method = 'cash' AND p.cash_handover_id IS NULL), 0)::int AS cash_outstanding,
              count(*) FILTER (WHERE p.method = 'pos')::int AS pos_count,
              coalesce(sum(p.amount_halalas) FILTER (WHERE p.method = 'pos'), 0)::int AS pos_collected
         FROM payments p WHERE p.event_id = $1 AND p.status = 'recorded' GROUP BY p.collected_by`,
      [EVT_R2],
    );

    expect(s.tickets).toEqual({
      total: ref.tickets_total,
      delivered: ref.delivered,
      open: ref.open,
      voided: 1,
      by_payment_status: {
        not_required: 0,
        due: ref.due_count,
        collected: ref.collected_count,
        waived: ref.waived_count,
      },
    });
    expect(s.tickets).toMatchObject({ total: 6, delivered: 5, open: 1 });
    const method = (m: string) => byMethod.find((x) => x.method === m) ?? { count: 0, halalas: 0 };
    expect(s.amounts).toEqual({
      billable_halalas: ref.billable_halalas,
      collected_halalas: method('cash').halalas + method('pos').halalas,
      waived_halalas: ref.waived_halalas,
      due_halalas: ref.due_halalas,
      by_method: {
        cash: { count: method('cash').count, halalas: method('cash').halalas },
        pos: { count: method('pos').count, halalas: method('pos').halalas },
      },
      reversed: { count: 1, halalas: FEE },
    });
    // 13 §11.2: billable = collected + waived + due
    expect(s.amounts.billable_halalas).toBe(
      s.amounts.collected_halalas + s.amounts.waived_halalas + s.amounts.due_halalas,
    );
    expect(s.amounts).toMatchObject({
      billable_halalas: 6 * FEE,
      collected_halalas: 3 * FEE,
      waived_halalas: 2 * FEE,
      due_halalas: FEE,
    });

    expect(s.drivers.map((d: { driver: { id: string } }) => d.driver.id)).toEqual([U.DRV1, U.DRV2]);
    for (const d of s.drivers) {
      const r = perDriver.find((x) => x.driver_id === d.driver.id)!;
      expect(d.cash).toMatchObject({
        count: r.cash_count,
        collected_halalas: r.cash_collected,
        outstanding_halalas: r.cash_outstanding,
      });
      expect(d.pos).toEqual({ count: r.pos_count, halalas: r.pos_collected });
    }
    expect(s.drivers[0].cash).toMatchObject({ handed_over_halalas: FEE, difference_adjusted_halalas: 0 });
    expect(s.drivers[1].cash).toMatchObject({ handed_over_halalas: 0, outstanding_halalas: FEE });

    expect(s.close_blockers).toEqual({
      unsettled_payments: [],
      cash_outstanding: [{ driver: s.drivers[1].driver, amount_halalas: FEE }],
      payment_integrity: [],
    });
    expect(s.integrity).toEqual({ ok: true, violations: [] });
    expect(s.discrepancies).toEqual([
      expect.objectContaining({
        type: 'reversed_without_replacement',
        ticket_id: t3.ticketId,
        driver_id: U.DRV1,
      }),
    ]);
    expect(s.event).toEqual({
      id: EVT_R2,
      name_ar: 'حفل تجريبي — ريماس 2',
      status: 'open',
      pricing_mode: 'per_vehicle',
      fee_halalas: FEE,
      allowed_payment_methods: ['cash', 'pos'],
    });
    expect([t1, t2, t4, t5].every((x) => x.ticketId)).toBe(true);
  });

  it('scope: another venue’s event is 404 for the supervisor; drivers have no report.read', async () => {
    expect(err(await t.get(`/v1/events/${EVT_L1}/settlement`, 'SUP-R'), 'RESOURCE_NOT_FOUND', 404)).toEqual({
      resource: 'event',
    });
    err(await t.get(`/v1/events/not-a-uuid/settlement`, 'SUP-R'), 'RESOURCE_NOT_FOUND', 404);
    err(await t.get(`/v1/events/${EVT_R2}/settlement`, 'DRV1'), 'PERMISSION_DENIED', 403);
    const owner = await settlement(t, 'OWN1', EVT_L1);
    expect(owner.tickets.total).toBe(0);
    expect((await settlement(t, 'SUP-RL', EVT_L1)).event.id).toBe(EVT_L1);
  });
});
