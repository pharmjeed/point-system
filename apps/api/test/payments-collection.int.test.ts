import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newKey, type TestApp } from './harness.js';
import {
  accept,
  auditCount,
  createS2App,
  err,
  EVT_R1,
  EVT_R2,
  expectConsistent,
  liveOffer,
  ok,
  one,
  outboxEvents,
  parkedPaperTicket,
  requestRetrieval,
  rows,
  startDuty,
  U,
} from './dispatch-fixtures.js';
import { CASH, deliver, FEE, pay, POS, readyTicket, settlement } from './payments-fixtures.js';

/**
 * PNT-080 (13 §5; PAY-TC-01 … PAY-TC-11): the collection of a per_vehicle fee, separately in `ready`
 * (`POST /v1/tickets/{ticketId}/payments`) or inside the handover, through the real S2 routes.
 */

const attemptsOf = (t: TestApp, ticketId: string) =>
  rows(t.db, `SELECT id FROM ticket_events WHERE ticket_id = $1 AND type = 'handover.code_attempt_failed'`, [
    ticketId,
  ]);

const paymentsOf = (t: TestApp, ticketId: string) =>
  rows(t.db, `SELECT * FROM payments WHERE ticket_id = $1 ORDER BY created_at, id`, [ticketId]);

async function cashOnly(t: TestApp) {
  const ev = await one(t.db, `SELECT version FROM events WHERE id = $1`, [EVT_R2]);
  ok(
    await t.command('patch', `/v1/events/${EVT_R2}`, {
      as: 'SUP-R',
      body: { expected_version: ev.version, allowed_payment_methods: ['cash'] },
    }),
  );
}

describe('PNT-080 — POST /v1/tickets/{ticketId}/payments (13 §5.4)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
  });
  afterEach(async () => t.close());

  it('records the fee in ready: 201 {payment, ticket}, collected + version, event, timeline and audit', async () => {
    const r = await readyTicket(t, 'DRV1');
    t.clock.advanceSeconds(5);
    const res = ok(await pay(t, 'DRV1', r.ticketId, CASH), 201);
    expect(res.payment).toMatchObject({
      ticket_id: r.ticketId,
      cycle_id: r.cycleId,
      event_id: EVT_R2,
      method: 'cash',
      amount_halalas: FEE,
      currency: 'SAR',
      pos_reference: null,
      status: 'recorded',
      collected_by: { id: U.DRV1, employee_code: 'D-0001' },
      collected_at: t.clock.now().toISOString(),
      reversed_at: null,
      cash_handover_id: null,
    });
    expect(res.ticket).toMatchObject({
      id: r.ticketId,
      status: 'ready',
      payment_status: 'collected',
      version: r.version + 1,
    });
    // only the money state moved: the task and the ticket keep their statuses
    expect((await one(t.db, `SELECT status FROM tasks WHERE id = $1`, [r.retrieveTaskId])).status).toBe(
      'in_progress',
    );
    expect((await outboxEvents(t.db, 'payment.recorded')).map((e) => e.payload.payload)).toEqual([
      {
        ticket_id: r.ticketId,
        payment_id: res.payment.id,
        cycle_id: r.cycleId,
        method: 'cash',
        amount_halalas: FEE,
        collected_by: U.DRV1,
        source: 'separate',
      },
    ]);
    expect(
      await rows(t.db, `SELECT type FROM ticket_events WHERE ticket_id = $1 AND type = 'payment.recorded'`, [
        r.ticketId,
      ]),
    ).toHaveLength(1);
    expect(await auditCount(t.db, 'payment.record', res.payment.id)).toBe(1);
    await expectConsistent(t.db);
  });

  it('pos: the reference is normalized before the checks and the storage (13 §5.6)', async () => {
    const r = await readyTicket(t, 'DRV1');
    const res = ok(await pay(t, 'DRV1', r.ticketId, POS(' ap-48 21 ')), 201);
    expect(res.payment).toMatchObject({ method: 'pos', pos_reference: 'AP4821' });
    expect((await paymentsOf(t, r.ticketId)).map((p) => p.pos_reference)).toEqual(['AP4821']);
  });

  it('PAYMENT_AMOUNT_MISMATCH and PAYMENT_METHOD_NOT_ALLOWED (PAY-TC-04, PAY-TC-05) — nothing written', async () => {
    const r = await readyTicket(t, 'DRV1');
    expect(
      err(
        await pay(t, 'DRV1', r.ticketId, { method: 'cash', amount_halalas: 1500 }),
        'PAYMENT_AMOUNT_MISMATCH',
        422,
      ),
    ).toEqual({
      expected_halalas: FEE,
      received_halalas: 1500,
    });
    expect(
      err(
        await pay(t, 'DRV1', r.ticketId, { method: 'cash', amount_halalas: 2500 }),
        'PAYMENT_AMOUNT_MISMATCH',
        422,
      ),
    ).toMatchObject({
      received_halalas: 2500,
    });
    // the event's methods are read at collection time (13 §3)
    await cashOnly(t);
    expect(err(await pay(t, 'DRV1', r.ticketId, POS()), 'PAYMENT_METHOD_NOT_ALLOWED', 422)).toEqual({
      allowed_methods: ['cash'],
    });
    expect(await paymentsOf(t, r.ticketId)).toEqual([]);
    expect(
      (await one(t.db, `SELECT payment_status FROM tickets WHERE id = $1`, [r.ticketId])).payment_status,
    ).toBe('due');
  });

  it('pos_reference: card-like numbers (also Arabic-Indic), cash with a reference, bad characters → VALIDATION_FAILED', async () => {
    const r = await readyTicket(t, 'DRV1');
    const fields = async (body: unknown) =>
      err(await pay(t, 'DRV1', r.ticketId, body), 'VALIDATION_FAILED', 422).fields;
    expect(await fields(POS('4111 1111 1111 1111'))).toEqual([
      { field: 'pos_reference', issue: 'looks_like_card_number' },
    ]);
    expect(await fields(POS('٤١١١-١١١١-١١١١-١١١١'))).toEqual([
      { field: 'pos_reference', issue: 'looks_like_card_number' },
    ]);
    expect(await fields({ ...CASH, pos_reference: 'AP4821' })).toEqual([
      { field: 'pos_reference', issue: 'not_applicable' },
    ]);
    expect(await fields(POS('AB#12'))).toEqual([{ field: 'pos_reference', issue: 'invalid_format' }]);
    expect(await paymentsOf(t, r.ticketId)).toEqual([]);
    // PAY-TC-06: the schema refuses the normalized number even when written directly (ck_payments_no_pan)
    await expect(
      t.db.query(
        `INSERT INTO payments (org_id, venue_id, event_id, ticket_id, method, amount_halalas, pos_reference, collected_by)
         SELECT org_id, venue_id, event_id, id, 'pos', fee_halalas, '4111111111111111', $2 FROM tickets WHERE id = $1`,
        [r.ticketId, U.DRV1],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'ck_payments_no_pan' });
  });

  it('PAYMENT_ALREADY_RECORDED on a second collection; the same key replays the first answer (PAY-TC-10)', async () => {
    const r = await readyTicket(t, 'DRV1');
    const key = newKey();
    const first = await pay(t, 'DRV1', r.ticketId, CASH, key);
    const replay = await pay(t, 'DRV1', r.ticketId, CASH, key);
    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(first.body.data);
    expect(err(await pay(t, 'DRV1', r.ticketId, POS()), 'PAYMENT_ALREADY_RECORDED', 409)).toEqual({
      payment_id: first.body.data.payment.id,
      method: 'cash',
      collected_by: U.DRV1,
    });
    expect(await paymentsOf(t, r.ticketId)).toHaveLength(1);
    expect(await auditCount(t.db, 'payment.record')).toBe(1);
  });

  it('two collections at once with different keys: one 201, the other PAYMENT_ALREADY_RECORDED (PAY-TC-11)', async () => {
    const r = await readyTicket(t, 'DRV1');
    const res = await Promise.all([pay(t, 'DRV1', r.ticketId, CASH), pay(t, 'DRV1', r.ticketId, POS())]);
    expect(res.map((x) => x.status).sort()).toEqual([201, 409]);
    expect(res.find((x) => x.status === 409)!.body.error.code).toBe('PAYMENT_ALREADY_RECORDED');
    expect(await paymentsOf(t, r.ticketId)).toHaveLength(1);
    await expectConsistent(t.db);
  });

  it('NOT_TASK_ASSIGNEE for another driver of the venue; TICKET_NOT_FOUND outside the venue or unknown', async () => {
    const r = await readyTicket(t, 'DRV1');
    expect(err(await pay(t, 'DRV2', r.ticketId, CASH), 'NOT_TASK_ASSIGNEE', 403)).toEqual({
      task_id: r.retrieveTaskId,
    });
    err(await pay(t, 'DRV7', r.ticketId, CASH), 'TICKET_NOT_FOUND', 404); // LYL driver
    err(await pay(t, 'DRV1', '00000000-0000-4000-8000-0000deadbeef', CASH), 'TICKET_NOT_FOUND', 404);
    err(await pay(t, 'DRV1', 'not-a-uuid', CASH), 'TICKET_NOT_FOUND', 404);
    // a supervisor without can_drive does not hold payment.record (canon §10)
    err(await pay(t, 'SUP-R', r.ticketId, CASH), 'PERMISSION_DENIED', 403);
    expect(await paymentsOf(t, r.ticketId)).toEqual([]);
  });

  it('INVALID_STATE_TRANSITION outside ready (parked, assigned) and payment_not_required on an included event', async () => {
    const parked = await parkedPaperTicket(t, 'DRV1', { eventId: EVT_R2 });
    expect(err(await pay(t, 'DRV1', parked.ticketId, CASH), 'INVALID_STATE_TRANSITION', 409)).toMatchObject({
      entity_type: 'ticket',
      entity_id: parked.ticketId,
      current_status: 'parked',
      allowed_from: ['ready'],
      command: 'POST /v1/tickets/{ticketId}/payments',
    });
    const req = ok(await requestRetrieval(t, 'SUP-R', parked.ticketId), 201);
    ok(await accept(t, 'DRV1', (await liveOffer(t.db, U.DRV1))!.id));
    expect(err(await pay(t, 'DRV1', parked.ticketId, CASH), 'INVALID_STATE_TRANSITION', 409)).toMatchObject({
      current_status: 'assigned',
      allowed_from: ['ready'],
    });
    expect(req.task.id).toBeTruthy();

    const other = await createS2App();
    try {
      ok(await startDuty(other, 'DRV1'), 201);
      const included = await readyTicket(other, 'DRV1', { eventId: EVT_R1 });
      expect(
        err(await pay(other, 'DRV1', included.ticketId, CASH), 'INVALID_STATE_TRANSITION', 409),
      ).toMatchObject({
        entity_id: included.ticketId,
        current_status: 'not_required',
        allowed_from: ['due'],
        reason: 'payment_not_required',
      });
    } finally {
      await other.close();
    }
  });
});

describe('PNT-080 — the collection inside the handover (13 §5.3, TT-18)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
  });
  afterEach(async () => t.close());

  it('PAYMENT_PENDING without payment: nothing written, no attempt counted (PAY-TC-03)', async () => {
    const r = await readyTicket(t, 'DRV1');
    expect(err(await deliver(t, 'DRV1', r), 'PAYMENT_PENDING', 409)).toEqual({
      amount_halalas: FEE,
      allowed_methods: ['cash', 'pos'],
    });
    expect(await attemptsOf(t, r.ticketId)).toEqual([]);
    expect(await one(t.db, `SELECT status, payment_status FROM tickets WHERE id = $1`, [r.ticketId])).toEqual(
      {
        status: 'ready',
        payment_status: 'due',
      },
    );
  });

  it('the money checks come before the stub: a wrong amount or method never consumes an attempt (PAY-TC-04/05)', async () => {
    const r = await readyTicket(t, 'DRV1');
    const wrongStub = (payment: unknown) =>
      t.command('post', `/v1/tickets/${r.ticketId}/handover`, {
        as: 'DRV1',
        body: { verification: { method: 'paper_stub', paper_serial: 'WRONG-1' }, payment },
      });
    expect(
      err(await wrongStub({ method: 'cash', amount_halalas: 1500 }), 'PAYMENT_AMOUNT_MISMATCH', 422),
    ).toEqual({
      expected_halalas: FEE,
      received_halalas: 1500,
    });
    expect(err(await wrongStub(POS('4111111111111111')), 'VALIDATION_FAILED', 422).fields).toEqual([
      { field: 'payment.pos_reference', issue: 'looks_like_card_number' },
    ]);
    await cashOnly(t);
    expect(err(await wrongStub(POS()), 'PAYMENT_METHOD_NOT_ALLOWED', 422)).toEqual({
      allowed_methods: ['cash'],
    });
    expect(await attemptsOf(t, r.ticketId)).toEqual([]);
    // a correct payment with a wrong stub: the attempt is counted, the payment is not written
    err(await wrongStub(CASH), 'PAPER_STUB_MISMATCH', 422);
    expect(await attemptsOf(t, r.ticketId)).toHaveLength(1);
    expect(await paymentsOf(t, r.ticketId)).toEqual([]);
  });

  it('collects cash inline: recorded (source handover), collected then delivered, both audit rows (PAY-TC-08)', async () => {
    const r = await readyTicket(t, 'DRV1');
    t.clock.advanceSeconds(3);
    const done = ok(await deliver(t, 'DRV1', r, CASH));
    expect(done.ticket).toMatchObject({ status: 'delivered', payment_status: 'collected' });
    expect(done.payment).toMatchObject({
      ticket_id: r.ticketId,
      cycle_id: r.cycleId,
      method: 'cash',
      amount_halalas: FEE,
      status: 'recorded',
      collected_by: { id: U.DRV1 },
      collected_at: t.clock.now().toISOString(),
    });
    const [p] = await paymentsOf(t, r.ticketId);
    expect(p).toMatchObject({
      id: done.payment.id,
      collected_by: U.DRV1,
      status: 'recorded',
      cash_handover_id: null,
    });
    expect((await outboxEvents(t.db, 'payment.recorded')).map((e) => e.payload.payload)).toEqual([
      {
        ticket_id: r.ticketId,
        payment_id: done.payment.id,
        cycle_id: r.cycleId,
        method: 'cash',
        amount_halalas: FEE,
        collected_by: U.DRV1,
        source: 'handover',
      },
    ]);
    expect(await auditCount(t.db, 'payment.record', done.payment.id)).toBe(1);
    expect(await auditCount(t.db, 'handover.verify', r.ticketId)).toBe(1);
    // payment.recorded precedes ticket.delivered on the ticket timeline
    const timeline = (
      await rows(t.db, `SELECT type FROM ticket_events WHERE ticket_id = $1 ORDER BY id`, [r.ticketId])
    ).map((e) => e.type);
    expect(timeline.indexOf('payment.recorded')).toBeGreaterThan(-1);
    expect(timeline.indexOf('payment.recorded')).toBeLessThan(timeline.indexOf('ticket.delivered'));
    await expectConsistent(t.db);
  });

  it('a separate collection, then the handover without payment; with a payment it is PAYMENT_ALREADY_RECORDED', async () => {
    const a = await readyTicket(t, 'DRV1');
    const paid = ok(await pay(t, 'DRV1', a.ticketId, POS()), 201);
    expect(err(await deliver(t, 'DRV1', a, CASH), 'PAYMENT_ALREADY_RECORDED', 409)).toEqual({
      payment_id: paid.payment.id,
      method: 'pos',
      collected_by: U.DRV1,
    });
    const done = ok(await deliver(t, 'DRV1', a));
    expect(done.payment).toBeNull();
    expect(done.ticket).toMatchObject({ status: 'delivered', payment_status: 'collected' });
    expect(await paymentsOf(t, a.ticketId)).toHaveLength(1);
    await expectConsistent(t.db);
  });

  it('an included event: no payment needed (PAY-TC-01); a payment in the body is VALIDATION_FAILED not_applicable', async () => {
    const r = await readyTicket(t, 'DRV1', { eventId: EVT_R1 });
    expect(err(await deliver(t, 'DRV1', r, CASH), 'VALIDATION_FAILED', 422).fields).toEqual([
      { field: 'payment', issue: 'not_applicable' },
    ]);
    const done = ok(await deliver(t, 'DRV1', r));
    expect(done.payment).toBeNull();
    expect(done.ticket).toMatchObject({ status: 'delivered', payment_status: 'not_required' });
    expect(await one(t.db, `SELECT fee_halalas FROM tickets WHERE id = $1`, [r.ticketId])).toEqual({
      fee_halalas: 0,
    });
  });
});

describe('PNT-078 + PNT-080 — the collection inside the exceptional handover (13 §8.4, TT-19)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
  });
  afterEach(async () => t.close());

  const OP = 'POST /v1/tickets/{ticketId}/handover-exception';
  const exception = (ticketId: string, payment?: unknown, as = 'SUP-R') =>
    t.command('post', `/v1/tickets/${ticketId}/handover-exception`, {
      as,
      body: {
        reason: 'فقد العميل الكعب',
        identity_checks: { plate_confirmed: true, vehicle_description_confirmed: true },
        ...(payment === undefined ? {} : { payment }),
      },
    });
  const nothingWritten = async (ticketId: string) => {
    expect(await paymentsOf(t, ticketId)).toEqual([]);
    expect(await one(t.db, `SELECT status, payment_status FROM tickets WHERE id = $1`, [ticketId])).toEqual({
      status: 'ready',
      payment_status: 'due',
    });
    expect(await rows(t.db, `SELECT id FROM incidents WHERE ticket_id = $1`, [ticketId])).toEqual([]);
  };

  it('PAY-TC-22: PAYMENT_PENDING without payment; the 13 §5.2 rules and the collector before any effect; the cash stays with the driver', async () => {
    const r = await readyTicket(t, 'DRV1');
    expect(err(await exception(r.ticketId), 'PAYMENT_PENDING', 409)).toEqual({
      amount_halalas: FEE,
      allowed_methods: ['cash', 'pos'],
    });
    expect(
      err(
        await exception(r.ticketId, { method: 'cash', amount_halalas: 1500, collected_by: U.DRV1 }),
        'PAYMENT_AMOUNT_MISMATCH',
        422,
      ),
    ).toEqual({ expected_halalas: FEE, received_halalas: 1500 });
    expect(
      err(
        await exception(r.ticketId, { ...POS('4111111111111111'), collected_by: U.DRV1 }),
        'VALIDATION_FAILED',
        422,
      ).fields,
    ).toEqual([{ field: 'payment.pos_reference', issue: 'looks_like_card_number' }]);
    // a collector who is neither the assignee nor the approving supervisor (13 §8.4)
    expect(
      err(await exception(r.ticketId, { ...CASH, collected_by: U.DRV2 }), 'VALIDATION_FAILED', 422).fields,
    ).toEqual([{ field: 'payment.collected_by', issue: 'not_eligible' }]);
    await cashOnly(t);
    expect(
      err(await exception(r.ticketId, { ...POS(), collected_by: U.DRV1 }), 'PAYMENT_METHOD_NOT_ALLOWED', 422),
    ).toEqual({ allowed_methods: ['cash'] });
    await nothingWritten(r.ticketId);

    t.clock.advanceSeconds(4);
    const done = ok(await exception(r.ticketId, { ...CASH, collected_by: U.DRV1 }));
    expect(done.ticket).toMatchObject({ status: 'delivered', payment_status: 'collected' });
    expect(done.payment).toMatchObject({
      ticket_id: r.ticketId,
      cycle_id: r.cycleId,
      method: 'cash',
      amount_halalas: FEE,
      status: 'recorded',
      collected_by: { id: U.DRV1 },
      collected_at: t.clock.now().toISOString(),
    });
    expect(await paymentsOf(t, r.ticketId)).toEqual([
      expect.objectContaining({ id: done.payment.id, collected_by: U.DRV1, status: 'recorded' }),
    ]);
    expect((await outboxEvents(t.db, 'payment.recorded')).map((e) => e.payload.payload)).toEqual([
      {
        ticket_id: r.ticketId,
        payment_id: done.payment.id,
        cycle_id: r.cycleId,
        method: 'cash',
        amount_halalas: FEE,
        collected_by: U.DRV1,
        source: 'exception',
      },
    ]);
    // the supervisor approved and recorded; the money is the driver's (13 §8.4 audit)
    const audit = await one(
      t.db,
      `SELECT actor_id, request_id, metadata FROM audit_log WHERE action = 'payment.record' AND entity_id = $1`,
      [done.payment.id],
    );
    expect(audit.actor_id).toBe(U['SUP-R']);
    expect(audit.request_id).toEqual(expect.any(String));
    expect(audit.request_id).not.toBe('');
    expect(audit.metadata).toMatchObject({ operation: OP, collected_by: U.DRV1, source: 'exception' });
    expect(await auditCount(t.db, 'handover.exception', r.ticketId)).toBe(1);
    // the incident of TT-19 is opened by the command itself
    expect((await outboxEvents(t.db, 'incident.opened')).map((e) => e.payload.payload.auto_created)).toEqual([
      true,
    ]);
    // PAY-TC-22: the cash is in the driver's custody until he hands it over (13 §9)
    const s = await settlement(t, 'SUP-R', EVT_R2);
    const of = (id: string) => s.drivers.find((d: { driver: { id: string } }) => d.driver.id === id);
    expect(of(U.DRV1).cash).toMatchObject({
      count: 1,
      collected_halalas: FEE,
      handed_over_halalas: 0,
      outstanding_halalas: FEE,
    });
    expect(of(U['SUP-R'])).toBeUndefined();
    await expectConsistent(t.db);
  });

  it('a collected ticket refuses a second payment; the approving supervisor may be the collector; an included event takes none', async () => {
    const a = await readyTicket(t, 'DRV1');
    const paid = ok(await pay(t, 'DRV1', a.ticketId, POS()), 201);
    expect(
      err(await exception(a.ticketId, { ...CASH, collected_by: U.DRV1 }), 'PAYMENT_ALREADY_RECORDED', 409),
    ).toEqual({
      payment_id: paid.payment.id,
      method: 'pos',
      collected_by: U.DRV1,
    });
    const first = ok(await exception(a.ticketId));
    expect(first.payment).toBeNull();
    expect(first.ticket).toMatchObject({ status: 'delivered', payment_status: 'collected' });

    const b = await readyTicket(t, 'DRV1');
    const done = ok(await exception(b.ticketId, { ...CASH, collected_by: U['SUP-R'] }));
    expect(done.payment).toMatchObject({ collected_by: { id: U['SUP-R'] }, status: 'recorded' });
    expect((await outboxEvents(t.db, 'payment.recorded')).at(-1).payload.payload).toMatchObject({
      payment_id: done.payment.id,
      collected_by: U['SUP-R'],
      source: 'exception',
    });

    const c = await readyTicket(t, 'DRV1', { eventId: EVT_R1 });
    expect(
      err(await exception(c.ticketId, { ...CASH, collected_by: U.DRV1 }), 'VALIDATION_FAILED', 422).fields,
    ).toEqual([{ field: 'payment', issue: 'not_applicable' }]);
    expect(ok(await exception(c.ticketId)).ticket).toMatchObject({
      status: 'delivered',
      payment_status: 'not_required',
    });
    await expectConsistent(t.db);
  });
});
