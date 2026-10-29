import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import { createS2App, err, ok, one, outboxEvents, rows, startDuty, U } from './dispatch-fixtures.js';
import {
  CASH,
  cashHandover,
  FEE,
  pay,
  readyTicket,
  settlement,
  waive,
  type ReadyTicket,
} from './payments-fixtures.js';
import { EVT_R2 } from './dispatch-fixtures.js';

/**
 * 13 §8.4 — the money of the supervisor's exceptional handover (found by the G4 run, PNT-093): the payment passes
 * the 13 §5.2 checks of the handover before any effect, is recorded with `source = exception`, and is collected by
 * the `collected_by` of the body — the assignee (the driver who took the cash and owes it at the cash handover,
 * 13 §10) or the approving supervisor himself; anybody else is refused.
 */
const exception = (t: TestApp, r: ReadyTicket, payment: unknown) =>
  t.command('post', `/v1/tickets/${r.ticketId}/handover-exception`, {
    as: 'SUP-R',
    body: {
      reason: 'فقد العميل الكعب الورقي',
      identity_checks: { plate_confirmed: true, vehicle_description_confirmed: true },
      payment,
    },
  });

describe('POST /v1/tickets/{ticketId}/handover-exception — the collection (13 §8.4)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
  });
  afterEach(async () => t.close());

  it('the cash taken by the driver is his (collected_by, source exception, owed at the cash handover)', async () => {
    const r = await readyTicket(t, 'DRV1');
    const res = ok(await exception(t, r, { ...CASH, collected_by: U.DRV1 }));
    expect(res.ticket).toMatchObject({ status: 'delivered', payment_status: 'collected' });
    expect(res.payment).toMatchObject({ method: 'cash', status: 'recorded', collected_by: { id: U.DRV1 } });
    const p = await one(t.db, `SELECT collected_by, cycle_id FROM payments WHERE ticket_id = $1`, [
      r.ticketId,
    ]);
    expect(p).toEqual({ collected_by: U.DRV1, cycle_id: r.cycleId });
    expect((await outboxEvents(t.db, 'payment.recorded')).map((e) => e.payload.payload)).toEqual([
      expect.objectContaining({ collected_by: U.DRV1, source: 'exception', amount_halalas: FEE }),
    ]);
    // 13 §8.4 audit: handover.exception, then payment.record by the supervisor with metadata.collected_by
    const audit = await rows(
      t.db,
      `SELECT action, actor_id, request_id, metadata FROM audit_log
        WHERE action IN ('handover.exception','payment.record') ORDER BY id`,
    );
    expect(audit.map((a) => [a.action, a.actor_id])).toEqual([
      ['handover.exception', U['SUP-R']],
      ['payment.record', U['SUP-R']],
    ]);
    expect(audit[1]!.request_id).toBe(audit[0]!.request_id);
    expect(audit.find((a) => a.action === 'payment.record')!.metadata).toMatchObject({
      collected_by: U.DRV1,
      source: 'exception',
    });
    // the driver owes the cash, not the supervisor
    const s = await settlement(t, 'SUP-R', EVT_R2);
    expect(s.drivers.map((d: { driver: { id: string } }) => d.driver.id)).toEqual([U.DRV1]);
    ok(await cashHandover(t, 'SUP-R', { event_id: EVT_R2, driver_id: U.DRV1, amount_halalas: FEE }), 201);
  });

  it('the supervisor who took the money himself is the collector', async () => {
    const r = await readyTicket(t, 'DRV1');
    const res = ok(
      await exception(t, r, {
        method: 'pos',
        amount_halalas: FEE,
        pos_reference: 'AP77',
        collected_by: U['SUP-R'],
      }),
    );
    expect(res.payment).toMatchObject({ method: 'pos', collected_by: { id: U['SUP-R'] } });
  });

  it('another collector, a wrong amount or a card number as reference: refused before any effect (the code, the task and the ticket untouched)', async () => {
    const r = await readyTicket(t, 'DRV1');
    const before = await one(t.db, `SELECT status, version, payment_status FROM tickets WHERE id = $1`, [
      r.ticketId,
    ]);
    expect(
      err(await exception(t, r, { ...CASH, collected_by: U.DRV2 }), 'VALIDATION_FAILED', 422).fields,
    ).toEqual([{ field: 'payment.collected_by', issue: 'not_collector' }]);
    err(
      await exception(t, r, { method: 'cash', amount_halalas: FEE - 500, collected_by: U.DRV1 }),
      'PAYMENT_AMOUNT_MISMATCH',
      422,
    );
    expect(
      err(
        await exception(t, r, {
          method: 'pos',
          amount_halalas: FEE,
          pos_reference: '4111111111111111',
          collected_by: U.DRV1,
        }),
        'VALIDATION_FAILED',
        422,
      ).fields,
    ).toEqual([{ field: 'payment.pos_reference', issue: 'looks_like_card_number' }]);
    expect(
      await one(t.db, `SELECT status, version, payment_status FROM tickets WHERE id = $1`, [r.ticketId]),
    ).toEqual(before);
    expect(await rows(t.db, `SELECT id FROM payments WHERE ticket_id = $1`, [r.ticketId])).toEqual([]);
    expect(await rows(t.db, `SELECT id FROM incidents WHERE ticket_id = $1`, [r.ticketId])).toEqual([]);
    // then the right one goes through
    ok(await exception(t, r, { ...CASH, collected_by: U.DRV1 }));
  });

  it('a method the event does not take: PAYMENT_METHOD_NOT_ALLOWED before any effect (13 §5.2, DEC-PROPOSED-2)', async () => {
    const r = await readyTicket(t, 'DRV1');
    // the POS terminal broke: the supervisor reduced the event to cash (13 §3, §17.2)
    const ev = await one(t.db, `SELECT version FROM events WHERE id = $1`, [EVT_R2]);
    ok(
      await t.command('patch', `/v1/events/${EVT_R2}`, {
        as: 'SUP-R',
        body: { expected_version: ev.version, allowed_payment_methods: ['cash'] },
      }),
    );
    const before = await one(t.db, `SELECT status, version, payment_status FROM tickets WHERE id = $1`, [
      r.ticketId,
    ]);
    expect(
      err(
        await exception(t, r, {
          method: 'pos',
          amount_halalas: FEE,
          pos_reference: 'AP5150',
          collected_by: U.DRV1,
        }),
        'PAYMENT_METHOD_NOT_ALLOWED',
        422,
      ),
    ).toEqual({ allowed_methods: ['cash'] });
    expect(
      await one(t.db, `SELECT status, version, payment_status FROM tickets WHERE id = $1`, [r.ticketId]),
    ).toEqual(before);
    expect(await rows(t.db, `SELECT id FROM payments WHERE ticket_id = $1`, [r.ticketId])).toEqual([]);
    expect(await rows(t.db, `SELECT id FROM incidents WHERE ticket_id = $1`, [r.ticketId])).toEqual([]);
    expect(
      await rows(t.db, `SELECT id FROM claim_codes WHERE ticket_id = $1 AND revoked_at IS NOT NULL`, [
        r.ticketId,
      ]),
    ).toEqual([]);
  });

  it('a ticket already collected (13 §17.11): a payment sent anyway is PAYMENT_ALREADY_RECORDED; the exception needs none', async () => {
    const r = await readyTicket(t, 'DRV1');
    // the driver collected separately in `ready`, then the code locked (13 §17.11)
    const paid = ok(await pay(t, 'DRV1', r.ticketId, CASH), 201);
    const before = await one(t.db, `SELECT status, version, payment_status FROM tickets WHERE id = $1`, [
      r.ticketId,
    ]);
    expect(before).toMatchObject({ status: 'ready', payment_status: 'collected' });
    // the same race as the plain handover (13 §15: no second collection): 409 with the recorded payment (refetch)
    expect(
      err(await exception(t, r, { ...CASH, collected_by: U.DRV1 }), 'PAYMENT_ALREADY_RECORDED', 409),
    ).toEqual({ payment_id: paid.payment.id, method: 'cash', collected_by: U.DRV1 });
    expect(
      await one(t.db, `SELECT status, version, payment_status FROM tickets WHERE id = $1`, [r.ticketId]),
    ).toEqual(before);
    expect(await rows(t.db, `SELECT id FROM payments WHERE ticket_id = $1`, [r.ticketId])).toHaveLength(1);
    expect(await rows(t.db, `SELECT id FROM incidents WHERE ticket_id = $1`, [r.ticketId])).toEqual([]);
    // without the payment object the exception goes through and keeps the separate collection
    const done = ok(await exception(t, r, undefined));
    expect(done.ticket).toMatchObject({ status: 'delivered', payment_status: 'collected' });
    expect(done.payment).toBeNull();
    expect(
      await rows(t.db, `SELECT id, collected_by FROM payments WHERE ticket_id = $1 AND status = 'recorded'`, [
        r.ticketId,
      ]),
    ).toEqual([{ id: paid.payment.id, collected_by: U.DRV1 }]);

    // a waived ticket takes no payment either (13 §15): VALIDATION_FAILED payment not_applicable
    const w = await readyTicket(t, 'DRV1');
    ok(await waive(t, 'SUP-R', w.ticketId, { reason: 'ضيف كبار الزوار على حساب المضيف' }));
    expect(
      err(await exception(t, w, { ...CASH, collected_by: U.DRV1 }), 'VALIDATION_FAILED', 422).fields,
    ).toEqual([{ field: 'payment', issue: 'not_applicable' }]);
    expect(ok(await exception(t, w, null)).ticket).toMatchObject({
      status: 'delivered',
      payment_status: 'waived',
    });
  });
});
