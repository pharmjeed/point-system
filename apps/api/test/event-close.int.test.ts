import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  accept,
  auditCount,
  createS2App,
  err,
  EVT_L1,
  EVT_R1,
  EVT_R2,
  expectConsistent,
  keyPickup,
  liveOffer,
  markReady,
  ok,
  one,
  outboxEvents,
  parkedPaperTicket,
  requestRetrieval,
  rows,
  startDuty,
  startIntake,
  startRetrieval,
  U,
} from './dispatch-fixtures.js';
import {
  CASH,
  cashHandover,
  closeEvent,
  deliver,
  deliveredWith,
  FEE,
  POS,
  readyTicket,
  reverse,
  settlement,
  startClosing,
  waive,
  type ReadyTicket,
} from './payments-fixtures.js';

/**
 * PNT-087 (11 §6.4, 13 §12, S-10): start-closing, the reconciliation and the close with `close_summary`.
 * The full-event scenario ends with no open custody, amounts that match the collections, and the event closed.
 */

const reconciliation = async (t: TestApp, as: string, eventId: string) =>
  ok(await t.get(`/v1/events/${eventId}/reconciliation`, as));

const eventRow = (t: TestApp, id: string) =>
  one(
    t.db,
    `SELECT status, version, closing_started_at, closed_at, closed_by, close_summary FROM events WHERE id = $1`,
    [id],
  );

/** The retrieval of a parked ticket by DRV1 (the only available driver) up to its handover with `payment`. */
async function retrieveAndDeliver(
  t: TestApp,
  p: { ticketId: string; slotId: string; serial: string },
  payment: unknown = CASH,
  requested = false,
) {
  if (!requested) ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
  const offer = (await liveOffer(t.db, U.DRV1))!;
  ok(await accept(t, 'DRV1', offer.id));
  ok(await keyPickup(t, 'DRV1', offer.task_id, p.slotId));
  ok(await startRetrieval(t, 'DRV1', offer.task_id));
  ok(await markReady(t, 'DRV1', offer.task_id));
  return ok(await deliver(t, 'DRV1', p as ReadyTicket, payment));
}

describe('PNT-087 — POST /v1/events/{eventId}/start-closing (11 §6.4)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
  });
  afterEach(async () => t.close());

  it('open → closing: event.closing_started and audit; intake stops (EVENT_NOT_OPEN), retrievals and money go on', async () => {
    const p = await parkedPaperTicket(t, 'DRV1', { eventId: EVT_R2 });
    const before = await eventRow(t, EVT_R2);
    t.clock.advanceSeconds(10);
    const ev = ok(await startClosing(t, 'SUP-R', EVT_R2, { expected_version: before.version }));
    expect(ev).toMatchObject({
      id: EVT_R2,
      status: 'closing',
      version: before.version + 1,
      closing_started_at: t.clock.now().toISOString(),
      closed_at: null,
    });
    expect((await outboxEvents(t.db, 'event.closing_started')).map((e) => e.payload.payload)).toEqual([
      { event_id: EVT_R2, status: 'closing', by: U['SUP-R'] },
    ]);
    expect(await auditCount(t.db, 'event.manage', EVT_R2)).toBe(1);

    expect(err(await startIntake(t, 'DRV1', { event_id: EVT_R2 }), 'EVENT_NOT_OPEN', 409)).toMatchObject({
      event_id: EVT_R2,
      event_status: 'closing',
    });
    // 13 §12: during closing the retrievals, the handovers and the money commands continue
    const done = await retrieveAndDeliver(t, p, CASH);
    expect(done.ticket).toMatchObject({ status: 'delivered', payment_status: 'collected' });
    ok(await cashHandover(t, 'SUP-R', { event_id: EVT_R2, driver_id: U.DRV1, amount_halalas: FEE }), 201);
    await expectConsistent(t.db);
  });

  it('INVALID_STATE_TRANSITION, VERSION_CONFLICT, RESOURCE_NOT_FOUND and the role matrix', async () => {
    const v = (await eventRow(t, EVT_R2)).version;
    expect(
      err(await startClosing(t, 'SUP-R', EVT_R2, { expected_version: v + 5 }), 'VERSION_CONFLICT', 409),
    ).toMatchObject({
      current_version: v,
    });
    ok(await startClosing(t, 'SUP-R', EVT_R2));
    expect(err(await startClosing(t, 'SUP-R', EVT_R2), 'INVALID_STATE_TRANSITION', 409)).toMatchObject({
      entity_type: 'event',
      current_status: 'closing',
      allowed_from: ['open'],
    });
    expect(err(await startClosing(t, 'SUP-R', EVT_L1), 'RESOURCE_NOT_FOUND', 404)).toEqual({
      resource: 'event',
    });
    err(await startClosing(t, 'DRV1', EVT_R1), 'PERMISSION_DENIED', 403);
    err(await startClosing(t, 'SUP-R', EVT_R1, { foo: 1 }), 'VALIDATION_FAILED', 422);
    // the reopen of the venues-events module still applies: closing → open
    ok(await t.command('post', `/v1/events/${EVT_R2}/open`, { as: 'SUP-R', body: {} }));
    expect((await eventRow(t, EVT_R2)).status).toBe('open');
  });
});

describe('PNT-087 — GET /v1/events/{eventId}/reconciliation and POST /v1/events/{eventId}/close', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
  });
  afterEach(async () => t.close());

  it('full event: every blocker listed, EVENT_CLOSE_BLOCKED with the same lists, then cleared and closed', async () => {
    // a parked (key on the board), c parked then requested while DRV1 is busy, d cash not handed over,
    // e card payment reversed after delivery (due + incident), b ready with DRV1 (car and key with him)
    const a = await parkedPaperTicket(t, 'DRV1', { eventId: EVT_R2 });
    const c = await parkedPaperTicket(t, 'DRV1', { eventId: EVT_R2 });
    const d = await deliveredWith(t, 'DRV1', CASH);
    const e = await deliveredWith(t, 'DRV1', POS());
    ok(await reverse(t, 'SUP-R', e.paymentId, { reason: 'عملية الشبكة أُلغيت' }));
    const b = await readyTicket(t, 'DRV1');
    const queued = ok(await requestRetrieval(t, 'SUP-R', c.ticketId), 201);
    expect(queued.task.status).toBe('queued');
    t.clock.advanceSeconds(90);

    err(await closeEvent(t, 'SUP-R', EVT_R2), 'INVALID_STATE_TRANSITION', 409); // still open
    ok(await startClosing(t, 'SUP-R', EVT_R2));

    const r = await reconciliation(t, 'SUP-R', EVT_R2);
    const ids = (list: { id: string }[]) => list.map((x) => x.id);
    expect(r.can_close).toBe(false);
    expect(ids(r.blockers.open_tickets)).toEqual([a.ticketId, c.ticketId, b.ticketId]);
    expect(ids(r.blockers.keys_not_in_slots)).toEqual([b.ticketId]);
    expect(r.blockers.open_requests).toEqual([
      expect.objectContaining({
        task_id: queued.task.id,
        ticket: expect.objectContaining({ id: c.ticketId }),
        status: 'queued',
        waiting_seconds: 90,
        offer: null,
      }),
    ]);
    expect(ids(r.blockers.open_tasks)).toEqual([b.retrieveTaskId]);
    expect(ids(r.blockers.unsettled_payments)).toEqual([e.ticketId]);
    expect(r.blockers.cash_outstanding).toEqual([
      { driver: { id: U.DRV1, employee_code: 'D-0001', full_name: 'سائق 1' }, amount_halalas: FEE },
    ]);
    expect(r.blockers.payment_integrity).toEqual([]);
    const incident = await one(t.db, `SELECT id FROM incidents WHERE ticket_id = $1`, [e.ticketId]);
    expect(ids(r.warnings.open_incidents)).toEqual([incident.id]);
    expect(r.warnings).toMatchObject({ failed_messages: [], cash_discrepancies: [] });

    // the reference SQL of the blockers (PNT-087 AC2)
    const openIds = (
      await rows(
        t.db,
        `SELECT id FROM tickets WHERE event_id = $1 AND status NOT IN ('delivered','voided') ORDER BY display_number`,
        [EVT_R2],
      )
    ).map((x) => x.id);
    expect(ids(r.blockers.open_tickets)).toEqual(openIds);
    const openTasks = (
      await rows(
        t.db,
        `SELECT id, type, status FROM tasks WHERE event_id = $1 AND status NOT IN ('completed','canceled') ORDER BY priority_at, seq`,
        [EVT_R2],
      )
    ).map((x) => x.id);
    expect(
      [
        ...r.blockers.open_requests.map((x: { task_id: string }) => x.task_id),
        ...ids(r.blockers.open_tasks),
      ].sort(),
    ).toEqual([...openTasks].sort());

    // the close answers with exactly the reconciliation's blockers
    const blocked = err(await closeEvent(t, 'SUP-R', EVT_R2, { note: 'محاولة' }), 'EVENT_CLOSE_BLOCKED', 409);
    expect(blocked).toEqual({ blockers: r.blockers });
    expect((await eventRow(t, EVT_R2)).status).toBe('closing');

    // clear everything: hand b over, the pass offers c to DRV1, then a; waive e; hand the cash over
    ok(await deliver(t, 'DRV1', b, CASH));
    await retrieveAndDeliver(t, c, CASH, true);
    await retrieveAndDeliver(t, a, POS('RC77'));
    ok(await waive(t, 'SUP-R', e.ticketId, { reason: 'تعويض عن الخدمة' }));
    const h = ok(
      await cashHandover(t, 'SUP-R', { event_id: EVT_R2, driver_id: U.DRV1, amount_halalas: 3 * FEE }),
      201,
    );
    expect(h).toMatchObject({ expected_halalas: 3 * FEE, difference_halalas: 0 });

    const clear = await reconciliation(t, 'SUP-R', EVT_R2);
    expect(clear.can_close).toBe(true);
    expect(Object.values(clear.blockers).every((l) => (l as unknown[]).length === 0)).toBe(true);
    expect(ids(clear.warnings.open_incidents)).toEqual([incident.id]); // warnings never block

    t.clock.advanceSeconds(30);
    const before = await eventRow(t, EVT_R2);
    const closed = ok(
      await closeEvent(t, 'SUP-R', EVT_R2, { expected_version: before.version, note: '  انتهى الحفل ' }),
    );
    expect(closed).toMatchObject({
      id: EVT_R2,
      status: 'closed',
      closed_at: t.clock.now().toISOString(),
      version: before.version + 1,
    });
    const row = await eventRow(t, EVT_R2);
    expect(row).toMatchObject({ status: 'closed', closed_by: U['SUP-R'], closed_at: t.clock.now() });
    const s = await settlement(t, 'SUP-R', EVT_R2);
    expect(row.close_summary).toEqual({
      closed_at: t.clock.now().toISOString(),
      closed_by: U['SUP-R'],
      note: 'انتهى الحفل',
      tickets: s.tickets,
      finance: { currency: 'SAR', amounts: s.amounts, drivers: s.drivers, discrepancies: s.discrepancies },
      warnings: { open_incidents: [incident.id], failed_messages: 0, cash_discrepancies: [] },
    });
    expect(closed.close_summary).toEqual(row.close_summary);
    expect((await outboxEvents(t.db, 'event.closed')).map((x) => x.payload.payload)).toEqual([
      { event_id: EVT_R2, status: 'closed', by: U['SUP-R'] },
    ]);
    const audit = await one(
      t.db,
      `SELECT reason, before, after, metadata FROM audit_log
        WHERE action = 'event.manage' AND entity_id = $1 AND metadata->>'command' = 'POST /v1/events/{eventId}/close'`,
      [EVT_R2],
    );
    expect(audit).toMatchObject({
      reason: 'انتهى الحفل',
      before: { status: 'closing' },
      after: { status: 'closed' },
      metadata: { tickets_total: 5, collected_halalas: 4 * FEE, open_incidents: 1 },
    });

    // G4 shape: no open custody, the amounts match the collections, the event closed
    expect(
      await rows(
        t.db,
        `SELECT id FROM tickets WHERE event_id = $1
            AND (status NOT IN ('delivered','voided') OR vehicle_holder_type <> 'customer' OR key_holder_type <> 'customer')`,
        [EVT_R2],
      ),
    ).toEqual([]);
    const sums = await one(
      t.db,
      `SELECT coalesce(sum(amount_halalas) FILTER (WHERE status = 'recorded'), 0)::int AS recorded,
              coalesce(sum(amount_halalas) FILTER (WHERE status = 'recorded' AND method = 'cash'), 0)::int AS cash
         FROM payments WHERE event_id = $1`,
      [EVT_R2],
    );
    expect(s.amounts.collected_halalas).toBe(sums.recorded);
    expect(s.drivers[0].cash).toMatchObject({
      collected_halalas: sums.cash,
      handed_over_halalas: sums.cash,
      outstanding_halalas: 0,
    });
    expect(s.amounts.billable_halalas).toBe(
      s.amounts.collected_halalas + s.amounts.waived_halalas + s.amounts.due_halalas,
    );
    expect(s.integrity.ok).toBe(true);
    await expectConsistent(t.db);

    // a second close, start-closing and every money command after the close (PAY-TC-20)
    expect(err(await closeEvent(t, 'SUP-R', EVT_R2), 'EVENT_ALREADY_CLOSED', 409)).toEqual({
      event_id: EVT_R2,
      current_status: 'closed',
    });
    err(await startClosing(t, 'SUP-R', EVT_R2), 'EVENT_ALREADY_CLOSED', 409);
    err(await waive(t, 'SUP-R', e.ticketId, { reason: 'بعد الإغلاق' }), 'EVENT_ALREADY_CLOSED', 409);
    err(await reverse(t, 'SUP-R', d.paymentId, { reason: 'بعد الإغلاق' }), 'EVENT_ALREADY_CLOSED', 409);
    err(
      await cashHandover(t, 'SUP-R', { event_id: EVT_R2, driver_id: U.DRV1, amount_halalas: 100 }),
      'EVENT_ALREADY_CLOSED',
      409,
    );
    expect(await auditCount(t.db, 'payment.reverse')).toBe(1);
  });

  it('cash with a driver blocks the close until it is handed over (PAY-TC-18)', async () => {
    await deliveredWith(t, 'DRV1', CASH);
    ok(await startClosing(t, 'SUP-R', EVT_R2));
    const blocked = err(await closeEvent(t, 'SUP-R', EVT_R2), 'EVENT_CLOSE_BLOCKED', 409);
    expect(blocked.blockers).toMatchObject({
      open_tickets: [],
      unsettled_payments: [],
      cash_outstanding: [{ driver: { id: U.DRV1 }, amount_halalas: FEE }],
    });
    ok(await cashHandover(t, 'SUP-R', { event_id: EVT_R2, driver_id: U.DRV1, amount_halalas: FEE }), 201);
    expect(ok(await closeEvent(t, 'SUP-R', EVT_R2)).status).toBe('closed');
  });

  it('a delivered ticket due after a reversal blocks the close until waived (PAY-TC-19)', async () => {
    const e = await deliveredWith(t, 'DRV1', POS());
    ok(await reverse(t, 'SUP-R', e.paymentId, { reason: 'عملية لم تكتمل' }));
    ok(await startClosing(t, 'SUP-R', EVT_R2));
    const blocked = err(await closeEvent(t, 'SUP-R', EVT_R2), 'EVENT_CLOSE_BLOCKED', 409);
    expect(blocked.blockers.unsettled_payments.map((x: { id: string }) => x.id)).toEqual([e.ticketId]);
    expect(blocked.blockers.cash_outstanding).toEqual([]);
    ok(await waive(t, 'SUP-R', e.ticketId, { reason: 'العميل لم يدفع' }));
    const closed = ok(await closeEvent(t, 'SUP-R', EVT_R2));
    expect(closed.close_summary.finance.discrepancies).toEqual([
      expect.objectContaining({ type: 'reversed_without_replacement', ticket_id: e.ticketId }),
    ]);
  });

  it('a close racing a cash handover never closes with cash outstanding (L2 FOR NO KEY UPDATE vs FOR SHARE)', async () => {
    await deliveredWith(t, 'DRV1', CASH);
    ok(await startClosing(t, 'SUP-R', EVT_R2));
    const [h, c] = await Promise.all([
      cashHandover(t, 'SUP-RL', { event_id: EVT_R2, driver_id: U.DRV1, amount_halalas: FEE }),
      closeEvent(t, 'SUP-R', EVT_R2),
    ]);
    // either the handover committed first and the close (waiting on L2) saw the cash handed over, or the close
    // read first, was blocked by cash_outstanding and rolled back, and the handover then went through
    expect(h.status).toBe(201);
    const status = (await eventRow(t, EVT_R2)).status;
    if (c.status === 200) expect(status).toBe('closed');
    else {
      expect(c.body.error.code).toBe('EVENT_CLOSE_BLOCKED');
      expect(status).toBe('closing');
    }
    expect(await rows(t.db, `SELECT id FROM cash_handovers WHERE event_id = $1`, [EVT_R2])).toHaveLength(1);
  });

  it('VERSION_CONFLICT, INVALID_STATE_TRANSITION, scope 404 and the role matrix of close and reconciliation', async () => {
    ok(await startClosing(t, 'SUP-R', EVT_R1));
    const v = (await eventRow(t, EVT_R1)).version;
    expect(
      err(await closeEvent(t, 'SUP-R', EVT_R1, { expected_version: v - 1 }), 'VERSION_CONFLICT', 409),
    ).toMatchObject({
      entity: 'event',
      current_version: v,
    });
    expect(err(await closeEvent(t, 'SUP-R', EVT_R2), 'INVALID_STATE_TRANSITION', 409)).toMatchObject({
      current_status: 'open',
      allowed_from: ['closing'],
    });
    expect(err(await closeEvent(t, 'SUP-R', EVT_L1), 'RESOURCE_NOT_FOUND', 404)).toEqual({
      resource: 'event',
    });
    expect(
      err(await t.get(`/v1/events/${EVT_L1}/reconciliation`, 'SUP-R'), 'RESOURCE_NOT_FOUND', 404),
    ).toEqual({
      resource: 'event',
    });
    err(await t.get(`/v1/events/x/reconciliation`, 'SUP-R'), 'RESOURCE_NOT_FOUND', 404);
    err(await t.get(`/v1/events/${EVT_R1}/reconciliation`, 'DRV1'), 'PERMISSION_DENIED', 403);
    err(await closeEvent(t, 'DRV1', EVT_R1), 'PERMISSION_DENIED', 403);
    err(await closeEvent(t, 'SUP-R', EVT_R1, { note: 'x'.repeat(501) }), 'VALIDATION_FAILED', 422);
    // an empty event closes; the administrator and the owner may close too (event.manage)
    const empty = await reconciliation(t, 'ADM1', EVT_R1);
    expect(empty.can_close).toBe(true);
    const closed = ok(await closeEvent(t, 'OWN1', EVT_R1, { expected_version: v }));
    expect(closed.close_summary).toMatchObject({
      closed_by: U.OWN1,
      note: null,
      tickets: { total: 0, delivered: 0, open: 0, voided: 0 },
    });
  });
});
