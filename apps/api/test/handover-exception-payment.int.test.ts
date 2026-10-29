import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import { createS2App, err, ok, one, outboxEvents, rows, startDuty, U } from './dispatch-fixtures.js';
import { CASH, cashHandover, FEE, readyTicket, settlement, type ReadyTicket } from './payments-fixtures.js';
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
      `SELECT action, actor_id, metadata FROM audit_log WHERE action IN ('handover.exception','payment.record') ORDER BY id`,
    );
    expect(audit.map((a) => [a.action, a.actor_id])).toEqual(
      expect.arrayContaining([
        ['payment.record', U['SUP-R']],
        ['handover.exception', U['SUP-R']],
      ]),
    );
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

  it('another collector, a wrong amount or method: refused before any effect (the code, the task and the ticket untouched)', async () => {
    const r = await readyTicket(t, 'DRV1');
    const before = await one(t.db, `SELECT status, version, payment_status FROM tickets WHERE id = $1`, [
      r.ticketId,
    ]);
    expect(
      err(await exception(t, r, { ...CASH, collected_by: U.DRV2 }), 'VALIDATION_FAILED', 422).fields,
    ).toEqual([{ field: 'payment.collected_by', issue: 'not_eligible' }]);
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
});
