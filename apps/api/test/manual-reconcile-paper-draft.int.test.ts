import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  createS2App,
  err,
  EVT_R1,
  EVT_R2,
  expectConsistent,
  newDraft,
  nextSlot,
  nextSpot,
  ok,
  one,
  outboxEvents,
  PAPER_DRAFT,
  patchIntake,
  rows,
  startDuty,
  startIntake,
  U,
} from './dispatch-fixtures.js';
import { auditRows } from './supervisor-fixtures.js';

/**
 * docs/runbooks/paper-fallback.md §5.3 (DEC-PROPOSED-3 in docs/progress/notes/owner-docs.md): a vehicle taken in on
 * paper during a full outage has no ticket. After the return it is re-entered as a paper draft (POST /v1/tickets, then
 * PATCH /intake with the stub of the paper log, never «إتمام التسجيل») and reconciled from `received` to its true state
 * with POST /v1/tickets/{ticketId}/manual-reconcile (PNT-085, 11 TT-22). manual-reconcile.int.test.ts covers
 * parking → parked and draft → voided; these are the draft paths the outage procedure and the rehearsal (TC-038) rely on.
 */
describe('an outage intake re-entered as a paper draft, then reconciled (paper-fallback §5.3)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV2'), 201);
  });
  afterEach(async () => t.close());

  const REASON = 'انقطاع النظام — مطابقة السجل الورقي';
  const reconcile = (as: string, ticketId: string, body: Record<string, unknown>) =>
    t.command('post', `/v1/tickets/${ticketId}/manual-reconcile`, { as, body: { reason: REASON, ...body } });

  /** D-05 with the stub, plate, make and color from the paper log; the intake is not submitted. */
  async function paperDraft(as: string, eventId: string, serial: string, digits: string) {
    const d = await newDraft(t, as, eventId);
    const p = ok(
      await patchIntake(t, as, d.ticketId, {
        expected_version: d.version,
        ...PAPER_DRAFT(serial, `K-${serial}`, digits),
      }),
    );
    expect(p).toMatchObject({ status: 'received', channel: 'paper', paper_serial: serial });
    return { ...d, version: p.version as number };
  }

  const custody = (ticketId: string) =>
    rows(
      t.db,
      `SELECT subject, reason, from_holder_type, to_holder_type, to_holder_id, actor_id, note, occurred_at
         FROM custody_events WHERE ticket_id = $1 ORDER BY occurred_at, reason DESC, subject DESC`,
      [ticketId],
    );
  const ticketEventTypes = async (ticketId: string) =>
    (await rows(t.db, `SELECT type FROM ticket_events WHERE ticket_id = $1 ORDER BY id`, [ticketId])).map(
      (e) => e.type as string,
    );
  const driverState = async (userId: string) =>
    (await one(t.db, `SELECT driver_state FROM v_driver_state WHERE user_id = $1`, [userId])).driver_state;

  it('received → parked: intake custody at re-entry by the re-entering driver, only the reconcile carries the paper ref; no submit, no parked event; the driver is free', async () => {
    const reentry = t.clock.now().toISOString();
    const d = await paperDraft('DRV1', EVT_R1, 'OUT-501', '5011');
    expect(await driverState(U.DRV1)).toBe('intake_parking'); // one draft per driver at a time
    t.clock.advanceSeconds(90);
    const at = t.clock.now().toISOString();
    const spot = nextSpot();
    const slot = nextSlot();

    const res = ok(
      await reconcile('SUP-R', d.ticketId, {
        target_status: 'parked',
        evidence: { paper_log_ref: 'P01-R03', note: 'P01-R02 استلام 21:42 بالسائق 0042، P01-R03 صف' },
        parking_spot_id: spot,
        key_slot_id: slot,
        expected_version: d.version,
      }),
    );
    expect(res).toMatchObject({ id: d.ticketId, status: 'parked', current_spot: { id: spot } });
    expect(res.vehicle_holder).toMatchObject({ type: 'spot', id: spot });
    expect(res.key_holder).toMatchObject({ type: 'key_slot', id: slot });
    expect(
      await one(
        t.db,
        `SELECT parked_by, parked_at, submitted_at, current_key_slot_id, inspection_status FROM tickets WHERE id = $1`,
        [d.ticketId],
      ),
    ).toEqual({
      parked_by: U.DRV1, // the re-entering driver (owner of the canceled park task), not the supervisor
      parked_at: new Date(at),
      submitted_at: new Date(at),
      current_key_slot_id: slot,
      inspection_status: 'pending', // no intake inspection was submitted
    });

    // the intake move is stamped at re-entry by the re-entering driver; the only other move is the reconcile
    expect(await custody(d.ticketId)).toEqual([
      expect.objectContaining({
        subject: 'vehicle',
        reason: 'intake',
        from_holder_type: 'customer',
        to_holder_type: 'driver',
        actor_id: U.DRV1,
        note: null,
        occurred_at: new Date(reentry),
      }),
      expect.objectContaining({
        subject: 'key',
        reason: 'intake',
        actor_id: U.DRV1,
        occurred_at: new Date(reentry),
      }),
      expect.objectContaining({
        subject: 'vehicle',
        reason: 'manual_reconcile',
        from_holder_type: 'driver',
        to_holder_type: 'spot',
        to_holder_id: spot,
        actor_id: U['SUP-R'],
        note: 'P01-R03',
        occurred_at: new Date(at),
      }),
      expect.objectContaining({
        subject: 'key',
        reason: 'manual_reconcile',
        from_holder_type: 'driver',
        to_holder_type: 'key_slot',
        to_holder_id: slot,
        note: 'P01-R03',
      }),
    ]);
    expect(
      await one(t.db, `SELECT status, cancel_reason, canceled_by FROM tasks WHERE id = $1`, [d.taskId]),
    ).toEqual({ status: 'canceled', cancel_reason: 'manual_reconcile', canceled_by: U['SUP-R'] });

    // no intermediate state: no submit, no parked event, no inspection alert, no message
    const types = await ticketEventTypes(d.ticketId);
    expect(types).not.toContain('ticket.intake_submitted');
    expect(types).not.toContain('ticket.parked');
    expect(types.slice(-4)).toEqual([
      'task.canceled',
      'custody.changed',
      'custody.changed',
      'ticket.manually_reconciled',
    ]);
    expect((await outboxEvents(t.db, 'ticket.parked')).length).toBe(0);
    expect(
      await one(t.db, `SELECT count(*)::int AS n FROM vehicle_inspections WHERE ticket_id = $1`, [
        d.ticketId,
      ]),
    ).toEqual({ n: 0 });
    expect(
      await one(
        t.db,
        `SELECT count(*)::int AS n FROM alerts WHERE ticket_id = $1 AND type = 'inspection_incomplete'`,
        [d.ticketId],
      ),
    ).toEqual({ n: 0 });
    expect(
      await one(t.db, `SELECT count(*)::int AS n FROM notifications WHERE ticket_id = $1`, [d.ticketId]),
    ).toEqual({ n: 0 });

    // the driver is free for the next draft; one audit row with the evidence
    expect(await driverState(U.DRV1)).toBe('available');
    const [a] = await auditRows(t, 'ticket.manual_reconcile', d.ticketId);
    expect(a).toMatchObject({ actor_id: U['SUP-R'], reason: REASON });
    expect(a.before).toMatchObject({ status: 'received', vehicle_holder_type: 'driver' });
    expect(a.after).toMatchObject({
      status: 'parked',
      vehicle_holder_type: 'spot',
      key_holder_type: 'key_slot',
    });
    expect(a.metadata).toMatchObject({
      paper_log_ref: 'P01-R03',
      evidence_note: 'P01-R02 استلام 21:42 بالسائق 0042، P01-R03 صف',
      canceled_task_id: d.taskId,
      closed_cycle_id: null,
      settled: 'available',
    });
    await expectConsistent(t.db);
  });

  it('received → delivered with the documented collection: PAYMENT_PENDING first; the payment for the paper collector, delivered_by = the reconciling account, no cycle and no message; the stub stays in use', async () => {
    const d = await paperDraft('DRV2', EVT_R2, 'OUT-502', '5022'); // per_vehicle 2000
    t.clock.advanceSeconds(60);
    const evidence = {
      paper_log_ref: 'P02-R07',
      note: 'P01-R05 استلام بالسائق 0043، P02-R07 تسليم بالكعب بالسائق 0041',
    };
    expect(
      err(
        await reconcile('SUP-R', d.ticketId, { target_status: 'delivered', evidence }),
        'PAYMENT_PENDING',
        409,
      ),
    ).toEqual({ amount_halalas: 2000, allowed_methods: expect.any(Array) });

    const res = ok(
      await reconcile('SUP-R', d.ticketId, {
        target_status: 'delivered',
        evidence,
        payment: { method: 'cash', amount_halalas: 2000, collected_by: U.DRV1 }, // who collected, from the log
        expected_version: d.version,
      }),
    );
    expect(res).toMatchObject({ status: 'delivered', delivered_at: t.clock.now().toISOString() });
    // no retrieval cycle on a draft: the delivery is credited to the account that reconciled, the real deliverer
    // stays in evidence.note
    expect(res.delivered_by).toMatchObject({ id: U['SUP-R'] });
    expect(await rows(t.db, `SELECT id FROM retrieval_cycles WHERE ticket_id = $1`, [d.ticketId])).toEqual(
      [],
    );
    expect(
      await one(
        t.db,
        `SELECT payment_status, delivered_by, vehicle_holder_type, key_holder_type FROM tickets WHERE id = $1`,
        [d.ticketId],
      ),
    ).toEqual({
      payment_status: 'collected',
      delivered_by: U['SUP-R'],
      vehicle_holder_type: 'customer',
      key_holder_type: 'customer',
    });
    const p = await one(
      t.db,
      `SELECT id, method, amount_halalas, collected_by, status, cycle_id FROM payments WHERE ticket_id = $1`,
      [d.ticketId],
    );
    expect(p).toMatchObject({
      method: 'cash',
      amount_halalas: 2000,
      collected_by: U.DRV1,
      status: 'recorded',
      cycle_id: null,
    });
    expect(
      (await outboxEvents(t.db, 'payment.recorded'))
        .map((e) => e.payload.payload)
        .filter((e) => e.ticket_id === d.ticketId),
    ).toEqual([
      {
        payment_id: p.id,
        ticket_id: d.ticketId,
        // 11 `PaymentRecorded` (DEC-285): `cycle_id: UUID | null` — a paper draft has no retrieval cycle
        cycle_id: null,
        method: 'cash',
        amount_halalas: 2000,
        collected_by: U.DRV1,
        source: 'reconcile',
      },
    ]);
    expect((await auditRows(t, 'payment.record', p.id))[0].metadata).toMatchObject({
      collected_by: U.DRV1,
      source: 'reconcile',
    });

    expect(
      (await custody(d.ticketId)).map((c) => [
        c.subject,
        c.reason,
        c.from_holder_type,
        c.to_holder_type,
        c.note,
      ]),
    ).toEqual([
      ['vehicle', 'intake', 'customer', 'driver', null],
      ['key', 'intake', 'customer', 'driver', null],
      ['vehicle', 'manual_reconcile', 'driver', 'customer', 'P02-R07'],
      ['key', 'manual_reconcile', 'driver', 'customer', 'P02-R07'],
    ]);
    const types = await ticketEventTypes(d.ticketId);
    expect(types).not.toContain('ticket.delivered');
    expect(types.at(-1)).toBe('ticket.manually_reconciled');
    expect((await outboxEvents(t.db, 'ticket.delivered')).length).toBe(0);
    expect(
      await one(t.db, `SELECT count(*)::int AS n FROM notifications WHERE ticket_id = $1`, [d.ticketId]),
    ).toEqual({ n: 0 });
    expect(await driverState(U.DRV2)).toBe('available');

    // the stub of a delivered ticket stays taken in its event: a second re-entry of the same line is refused
    const again = await newDraft(t, 'DRV2', EVT_R2);
    expect(
      err(
        await patchIntake(t, 'DRV2', again.ticketId, {
          expected_version: again.version,
          ...PAPER_DRAFT('OUT-502', 'K-OUT-502-B', '5022'),
        }),
        'PAPER_SERIAL_IN_USE',
        409,
      ),
    ).toEqual({ field: 'paper_serial' });
    await expectConsistent(t.db);
  });

  it('no draft while the event is closing (EVENT_NOT_OPEN); reopening it (POST /v1/events/{eventId}/open) lets the re-entry go on', async () => {
    const version = async () =>
      (await one(t.db, `SELECT version FROM events WHERE id = $1`, [EVT_R1])).version as number;
    ok(
      await t.command('post', `/v1/events/${EVT_R1}/start-closing`, {
        as: 'SUP-R',
        body: { expected_version: await version() },
      }),
    );
    err(await startIntake(t, 'DRV1', { event_id: EVT_R1 }), 'EVENT_NOT_OPEN', 409);
    ok(
      await t.command('post', `/v1/events/${EVT_R1}/open`, {
        as: 'SUP-R',
        body: { expected_version: await version() },
      }),
    );
    const d = await paperDraft('DRV1', EVT_R1, 'OUT-503', '5033');
    ok(
      await reconcile('SUP-R', d.ticketId, {
        target_status: 'parked',
        evidence: { paper_log_ref: 'P03-R01' },
        parking_spot_id: nextSpot(),
        key_slot_id: nextSlot(),
      }),
    );
    await expectConsistent(t.db);
  });
});
