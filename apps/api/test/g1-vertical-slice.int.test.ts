import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  accept,
  addPhotos,
  completeParking,
  createS2App,
  EVT_R1,
  expectConsistent,
  handover,
  keyPickup,
  liveOffer,
  markReady,
  ok,
  one,
  PAPER_DRAFT,
  patchIntake,
  requestRetrieval,
  rows,
  slot,
  spot,
  startDuty,
  startIntake,
  startRetrieval,
  submitIntake,
  U,
} from './dispatch-fixtures.js';

/**
 * G1 (17; AC-19): one driver takes in and parks a paper ticket, the supervisor asks for the car on behalf of
 * the customer, a second driver accepts, picks the key up, brings the car and hands it over against the stub.
 * Every actor is kept in its own column, the custody chain is complete and each command wrote an audit row.
 */
describe('G1 — paper vertical slice through the API', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createS2App();
  });
  afterAll(async () => t.close());

  it('intake → park → request on behalf → accept → key pickup → start → ready → handover', async () => {
    // DRV2 starts first: he is the longest idle when the request arrives
    ok(await startDuty(t, 'DRV2'), 201);
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV1'), 201);
    await expectConsistent(t.db);

    const created = ok(await startIntake(t, 'DRV1', { event_id: EVT_R1, channel: 'paper' }), 201);
    const ticketId: string = created.ticket.id;
    const parkTaskId: string = created.task.id;
    expect(created.driver_state).toBe('intake_parking');
    expect(created.ticket.status).toBe('received');
    await expectConsistent(t.db);

    t.clock.advanceSeconds(1);
    const patched = ok(
      await patchIntake(t, 'DRV1', ticketId, {
        expected_version: created.ticket.version,
        ...PAPER_DRAFT('A-0457', 'K-73'),
      }),
    );
    expect(patched.plate).toMatchObject({ digits: '1234', letters_ar: 'ب ح د', letters_en: 'B J D' });
    await addPhotos(t.db, ticketId, U.DRV1);
    const submitted = ok(await submitIntake(t, 'DRV1', ticketId, { expected_version: patched.version }));
    expect(submitted).toMatchObject({ status: 'parking', inspection_status: 'complete' });
    await expectConsistent(t.db);

    t.clock.advanceSeconds(1);
    const parked = ok(
      await completeParking(t, 'DRV1', parkTaskId, { parking_spot_id: spot('A-01'), key_slot_id: slot(1) }),
    );
    expect(parked.ticket.status).toBe('parked');
    expect(parked.driver.driver_state).toBe('available');
    await expectConsistent(t.db);

    t.clock.advanceSeconds(60);
    const requested = ok(await requestRetrieval(t, 'SUP-R', ticketId), 201);
    expect(requested.cycle).toMatchObject({ request_source: 'staff', requested_early: false, cycle_no: 1 });
    // DEC-08: the pass ran in the same transaction — a single offer to the longest idle driver (DRV2)
    expect(requested.task.status).toBe('offered');
    const offer = await liveOffer(t.db, U.DRV2);
    expect(offer?.task_id).toBe(requested.task.id);
    expect(await liveOffer(t.db, U.DRV1)).toBeNull();
    await expectConsistent(t.db);

    t.clock.advanceSeconds(1);
    const accepted = ok(await accept(t, 'DRV2', offer!.id));
    expect(accepted).toMatchObject({ result: 'accepted', driver_state: 'retrieving' });
    expect(accepted.ticket.status).toBe('assigned');
    await expectConsistent(t.db);

    const retrieveTaskId: string = requested.task.id;
    t.clock.advanceSeconds(1);
    const picked = ok(await keyPickup(t, 'DRV2', retrieveTaskId, slot(1)));
    expect(picked.task.key_picked_up_at).not.toBeNull();
    t.clock.advanceSeconds(1);
    const started = ok(await startRetrieval(t, 'DRV2', retrieveTaskId));
    expect(started.task.status).toBe('in_progress');
    expect(started.ticket.status).toBe('retrieving');
    t.clock.advanceSeconds(1);
    const ready = ok(await markReady(t, 'DRV2', retrieveTaskId));
    expect(ready.ticket.status).toBe('ready');
    await expectConsistent(t.db);

    t.clock.advanceSeconds(1);
    const done = ok(
      await handover(t, 'DRV2', ticketId, { verification: { method: 'paper_stub', paper_serial: 'a-0457' } }),
    );
    expect(done.ticket.status).toBe('delivered');
    expect(done.cycle).toMatchObject({ outcome: 'delivered', delivered_by: U.DRV2, retrieved_by: U.DRV2 });
    expect(done.driver.driver_state).toBe('available');
    await expectConsistent(t.db);

    // every actor in its own column (AC-19)
    const ticket = await one(t.db, `SELECT * FROM tickets WHERE id = $1`, [ticketId]);
    expect(ticket).toMatchObject({
      created_by: U.DRV1,
      parked_by: U.DRV1,
      retrieved_by: U.DRV2,
      delivered_by: U.DRV2,
      status: 'delivered',
      vehicle_holder_type: 'customer',
      key_holder_type: 'customer',
      active_cycle_id: null,
    });
    const cycle = await one(t.db, `SELECT * FROM retrieval_cycles WHERE ticket_id = $1`, [ticketId]);
    expect(cycle).toMatchObject({
      accepted_by: U.DRV2,
      retrieved_by: U.DRV2,
      delivered_by: U.DRV2,
      requested_by_user_id: U['SUP-R'],
      handover_method: 'paper_stub',
      outcome: 'delivered',
    });

    // the full custody chain, in order
    const chain = await rows(
      t.db,
      `SELECT subject, from_holder_type AS f, from_holder_id AS fid, to_holder_type AS t, to_holder_id AS tid, reason
         FROM custody_events WHERE ticket_id = $1 ORDER BY occurred_at, subject DESC`,
      [ticketId],
    );
    const vehicle = chain.filter((c) => c.subject === 'vehicle').map((c) => [c.f, c.t, c.reason]);
    const key = chain.filter((c) => c.subject === 'key').map((c) => [c.f, c.t, c.reason]);
    expect(vehicle).toEqual([
      ['customer', 'driver', 'intake'],
      ['driver', 'spot', 'parked'],
      ['spot', 'driver', 'retrieval_start'],
      ['driver', 'customer', 'handover'],
    ]);
    expect(key).toEqual([
      ['customer', 'driver', 'intake'],
      ['driver', 'key_slot', 'key_deposited'],
      ['key_slot', 'driver', 'key_pickup'],
      ['driver', 'customer', 'handover'],
    ]);
    const holders = chain.map((c) => [c.subject, c.reason, c.fid ?? c.tid]);
    expect(holders).toContainEqual(['vehicle', 'intake', U.DRV1]);
    expect(holders).toContainEqual(['vehicle', 'retrieval_start', spot('A-01')]);
    expect(holders).toContainEqual(['key', 'key_pickup', slot(1)]);

    // one audit row per command
    const actions = (
      await rows<{ action: string; n: number }>(
        t.db,
        `SELECT action, count(*)::int AS n FROM audit_log WHERE action <> 'auth.self' GROUP BY action`,
      )
    ).reduce<Record<string, number>>((m, r) => ({ ...m, [r.action]: r.n }), {});
    expect(actions).toEqual({
      'duty.self': 2,
      'ticket.intake': 3, // start, PATCH, submit
      'task.execute': 4, // complete-parking, key-pickup, start-retrieval, ready
      'retrieval.request_on_behalf': 1,
      'offer.accept': 1,
      'handover.verify': 1,
    });

    // the timeline carries the domain events of the ticket
    const types = (
      await rows<{ type: string }>(t.db, `SELECT type FROM ticket_events WHERE ticket_id = $1 ORDER BY id`, [
        ticketId,
      ])
    ).map((r) => r.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'ticket.created',
        'task.created',
        'ticket.intake_submitted',
        'ticket.parked',
        'task.completed',
        'ticket.retrieval_requested',
        'task.offered',
        'task.claimed',
        'ticket.assigned',
        'task.key_picked_up',
        'task.started',
        'ticket.retrieving',
        'ticket.ready',
        'handover.completed',
        'ticket.delivered',
      ]),
    );
  });
});
