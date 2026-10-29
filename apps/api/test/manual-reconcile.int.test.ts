import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  createS2App,
  err,
  EVT_L1,
  EVT_R2,
  expectConsistent,
  newDraft,
  nextSlot,
  nextSpot,
  ok,
  one,
  openBroadcastBySql,
  outboxEvents,
  paperTicketInParking,
  parkedPaperTicket,
  requestRetrieval,
  RMS,
  rows,
  startDuty,
  U,
} from './dispatch-fixtures.js';
import {
  assignedRetrieval,
  auditRows,
  deliveredTicket,
  DUMMY,
  ORG,
  readyRetrieval,
  whatsappTicket,
} from './supervisor-fixtures.js';

const EVIDENCE = { paper_log_ref: 'سجل-17', note: 'السجل الورقي للبوابة' };

/** PNT-085 — POST /v1/tickets/{ticketId}/manual-reconcile (11 TT-22, 13 §8.5). */
describe('manual reconcile after an outage', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV2'), 201);
    ok(await startDuty(t, 'DRV7'), 201);
  });
  afterEach(async () => t.close());

  const reconcile = (as: string, ticketId: string, body: Record<string, unknown>) =>
    t.command('post', `/v1/tickets/${ticketId}/manual-reconcile`, {
      as,
      body: { reason: 'مطابقة بعد انقطاع النظام', evidence: EVIDENCE, ...body },
    });
  const ticketEvents = (ticketId: string) =>
    rows(t.db, `SELECT type, data FROM ticket_events WHERE ticket_id = $1 ORDER BY id`, [ticketId]);

  /** A linked WhatsApp ticket (the W-01 flow is the whatsapp module's; set here as it leaves it). */
  async function linkedTicket() {
    const w = await whatsappTicket(t, 'DRV2', { park: true });
    await t.db.query(`UPDATE tickets SET wa_link_status = 'linked' WHERE id = $1`, [w.ticketId]);
    return w;
  }

  it('a retrieval in progress reconciled to delivered: no customer message, custody_events manual_reconcile, the driver released, audit', async () => {
    const w = await linkedTicket();
    t.clock.advanceSeconds(1);
    const r = ok(await requestRetrieval(t, 'SUP-R', w.ticketId), 201);
    // the W-02 planned before the outage is still pending (no worker ran)
    const w02 = await one(
      t.db,
      `SELECT id, purpose, status FROM notifications WHERE ticket_id = $1 AND purpose = 'W-02'`,
      [w.ticketId],
    );
    expect(w02).toMatchObject({ purpose: 'W-02', status: 'pending' });
    const offer = await one(
      t.db,
      `SELECT o.id FROM task_offers o WHERE o.task_id = $1 AND o.status = 'active'`,
      [r.task.id],
    );
    ok(await t.command('post', `/v1/task-offers/${offer.id}/accept`, { as: 'DRV1', body: {} }));
    const accepted = await one(t.db, `SELECT status FROM tasks WHERE id = $1`, [r.task.id]);
    expect(accepted.status).toBe('accepted');
    const before = await one(t.db, `SELECT count(*)::int AS n FROM notifications WHERE channel = 'whatsapp'`);
    t.clock.advanceSeconds(1800);

    const res = ok(await reconcile('SUP-R', w.ticketId, { target_status: 'delivered' }));
    expect(res).toMatchObject({
      id: w.ticketId,
      status: 'delivered',
      delivered_at: t.clock.now().toISOString(),
    });
    expect(res.delivered_by).toMatchObject({ id: U.DRV1 });
    // task canceled (manual_reconcile), cycle closed as delivered by manual_reconcile, ticket fields
    expect(
      await one(t.db, `SELECT status, cancel_reason, canceled_by FROM tasks WHERE id = $1`, [r.task.id]),
    ).toEqual({
      status: 'canceled',
      cancel_reason: 'manual_reconcile',
      canceled_by: U['SUP-R'],
    });
    expect(
      await one(
        t.db,
        `SELECT outcome, handover_method, delivered_by, closed_at IS NOT NULL AS closed FROM retrieval_cycles WHERE id = $1`,
        [r.cycle.id],
      ),
    ).toEqual({
      outcome: 'delivered',
      handover_method: 'manual_reconcile',
      delivered_by: U.DRV1,
      closed: true,
    });
    expect(
      await one(
        t.db,
        `SELECT vehicle_holder_type, key_holder_type, active_cycle_id, current_spot_id, current_key_slot_id FROM tickets WHERE id = $1`,
        [w.ticketId],
      ),
    ).toEqual({
      vehicle_holder_type: 'customer',
      key_holder_type: 'customer',
      active_cycle_id: null,
      current_spot_id: null,
      current_key_slot_id: null,
    });
    // AC: custody_events with reason manual_reconcile
    expect(
      await rows(
        t.db,
        `SELECT subject, from_holder_type, to_holder_type, note FROM custody_events WHERE ticket_id = $1 AND reason = 'manual_reconcile' ORDER BY subject DESC`,
        [w.ticketId],
      ),
    ).toEqual([
      { subject: 'vehicle', from_holder_type: 'spot', to_holder_type: 'customer', note: 'سجل-17' },
      { subject: 'key', from_holder_type: 'key_slot', to_holder_type: 'customer', note: 'سجل-17' },
    ]);
    expect(
      await rows(
        t.db,
        `SELECT release_reason FROM spot_allocations WHERE ticket_id = $1 AND released_at IS NOT NULL`,
        [w.ticketId],
      ),
    ).toEqual([{ release_reason: 'manual_reconcile' }]);
    // AC: no outbound message for an intermediate state — the stale W-02 is skipped, nothing new is planned
    expect(
      await one(t.db, `SELECT status, skipped_reason FROM notifications WHERE id = $1`, [w02.id]),
    ).toEqual({
      status: 'skipped',
      skipped_reason: 'superseded',
    });
    expect(
      await one(t.db, `SELECT count(*)::int AS n FROM notifications WHERE channel = 'whatsapp'`),
    ).toEqual(before);
    expect(
      await one(
        t.db,
        `SELECT count(*)::int AS n FROM whatsapp_messages WHERE ticket_id = $1 AND direction = 'outbound'`,
        [w.ticketId],
      ),
    ).toEqual({ n: 0 });
    // only ticket.manually_reconciled (data.manual = true): no ticket.delivered
    const evs = await ticketEvents(w.ticketId);
    const types = evs.map((e) => e.type);
    expect(types).not.toContain('ticket.delivered');
    expect(types.slice(-4)).toEqual([
      'task.canceled',
      'custody.changed',
      'custody.changed',
      'ticket.manually_reconciled',
    ]);
    expect(evs.at(-1)!.data).toMatchObject({
      previous_status: 'assigned',
      target_status: 'delivered',
      reconciled_by: U['SUP-R'],
      paper_log_ref: 'سجل-17',
      manual: true,
    });
    expect((await outboxEvents(t.db, 'ticket.delivered')).length).toBe(0);
    // the driver of the canceled movement is released
    expect(
      (await one(t.db, `SELECT driver_state FROM v_driver_state WHERE user_id = $1`, [U.DRV1])).driver_state,
    ).toBe('available');
    // AC: one audit row with the evidence and the states
    const [a] = await auditRows(t, 'ticket.manual_reconcile', w.ticketId);
    expect(a).toMatchObject({ actor_id: U['SUP-R'], reason: 'مطابقة بعد انقطاع النظام' });
    expect(a.before).toMatchObject({ status: 'assigned' });
    expect(a.after).toMatchObject({ status: 'delivered' });
    expect(a.metadata).toMatchObject({
      paper_log_ref: 'سجل-17',
      evidence_note: 'السجل الورقي للبوابة',
      canceled_task_id: r.task.id,
      closed_cycle_id: r.cycle.id,
      skipped_notifications: 2, // the direct link's pending W-01 (PNT-043) and the W-02
      settled: 'available',
    });
    await expectConsistent(t.db);
  });

  it('a ready vehicle reconciled to parked: the code is revoked and purged, spot and slot from the log, unknown when not recorded', async () => {
    const a = await readyRetrieval(t);
    // a live handover code as PNT-047 leaves it at ready (hash + the only encrypted copy)
    const code = await one(
      t.db,
      `INSERT INTO claim_codes (org_id, ticket_id, cycle_id, code_hash, code_ciphertext, expires_at)
       VALUES ($1, $2, $3, 'h', 'ciphertext', now() + interval '30 minutes') RETURNING id`,
      [ORG, a.ticketId, a.cycleId],
    );
    const spot = nextSpot();
    const res = ok(
      await reconcile('SUP-R', a.ticketId, {
        target_status: 'parked',
        parking_spot_id: spot,
        spot_note: 'قرب البوابة',
      }),
    );
    expect(res).toMatchObject({
      status: 'parked',
      current_spot: { id: spot },
      current_spot_note: 'قرب البوابة',
      current_key_slot: null,
    });
    expect(res.vehicle_holder).toMatchObject({ type: 'spot', id: spot });
    expect(res.key_holder).toMatchObject({ type: 'unknown', id: null });
    expect(
      await one(
        t.db,
        `SELECT revoked_at IS NOT NULL AS revoked, revoke_reason, code_ciphertext FROM claim_codes WHERE id = $1`,
        [code.id],
      ),
    ).toEqual({
      revoked: true,
      revoke_reason: 'canceled',
      code_ciphertext: null,
    });
    expect(
      await one(t.db, `SELECT outcome, cancel_reason FROM retrieval_cycles WHERE id = $1`, [a.cycleId]),
    ).toEqual({
      outcome: 'canceled',
      cancel_reason: 'manual_reconcile',
    });
    expect(
      await rows(
        t.db,
        `SELECT parking_spot_id FROM spot_allocations WHERE ticket_id = $1 AND released_at IS NULL`,
        [a.ticketId],
      ),
    ).toEqual([{ parking_spot_id: spot }]);
    expect(
      (await auditRows(t, 'ticket.manual_reconcile', a.ticketId))[0].metadata.handover_claims_revoked,
    ).toEqual([code.id]);
    expect(
      (await one(t.db, `SELECT driver_state FROM v_driver_state WHERE user_id = $1`, [U.DRV1])).driver_state,
    ).toBe('available');
    await expectConsistent(t.db);
  });

  it('a reserved next task reconciled away: canceled, its driver stays on his current movement', async () => {
    const a = await assignedRetrieval(t); // DRV1 moves the first vehicle
    const second = await parkedPaperTicket(t, 'DRV2');
    ok(await t.command('post', '/v1/me/duty/break', { as: 'DRV2', body: { active: true } }));
    t.clock.advanceSeconds(1);
    const r2 = ok(await requestRetrieval(t, 'SUP-R', second.ticketId), 201);
    const bc = await openBroadcastBySql(t.db, r2.task.id);
    expect(ok(await t.command('post', `/v1/task-offers/${bc}/accept`, { as: 'DRV1', body: {} })).result).toBe(
      'assigned_waiting',
    );
    const before = (await outboxEvents(t.db, 'driver.availability_changed')).length;
    ok(await reconcile('SUP-R', second.ticketId, { target_status: 'parked', parking_spot_id: nextSpot() }));
    expect(await one(t.db, `SELECT status, cancel_reason FROM tasks WHERE id = $1`, [r2.task.id])).toEqual({
      status: 'canceled',
      cancel_reason: 'manual_reconcile',
    });
    expect(
      await one(
        t.db,
        `SELECT driver_state, active_task_id, next_task_id FROM v_driver_state WHERE user_id = $1`,
        [U.DRV1],
      ),
    ).toEqual({
      driver_state: 'retrieving',
      active_task_id: a.retrieveTaskId,
      next_task_id: null,
    });
    const after = await outboxEvents(t.db, 'driver.availability_changed');
    expect(after.slice(before).map((e) => e.payload.payload)).toEqual([
      expect.objectContaining({ user_id: U.DRV1, driver_state: 'retrieving', next_task_id: null }),
    ]);
    await expectConsistent(t.db);
  });

  it('a draft or a parking ticket reconciled: the early request kept while parking is not replayed; voided', async () => {
    const p = await paperTicketInParking(t, 'DRV1');
    await t.db.query(
      `UPDATE tickets SET pending_retrieval_at = now(), pending_retrieval_source = 'whatsapp' WHERE id = $1`,
      [p.ticketId],
    );
    const slotId = nextSlot();
    ok(await reconcile('SUP-R', p.ticketId, { target_status: 'parked', key_slot_id: slotId }));
    expect(
      await one(
        t.db,
        `SELECT status, pending_retrieval_at, vehicle_holder_type, key_holder_type, parked_by FROM tickets WHERE id = $1`,
        [p.ticketId],
      ),
    ).toEqual({
      status: 'parked',
      pending_retrieval_at: null,
      vehicle_holder_type: 'unknown',
      key_holder_type: 'key_slot',
      parked_by: U.DRV1,
    });
    expect(await rows(t.db, `SELECT id FROM retrieval_cycles WHERE ticket_id = $1`, [p.ticketId])).toEqual(
      [],
    ); // nothing deferred ran
    expect(await one(t.db, `SELECT status, cancel_reason FROM tasks WHERE id = $1`, [p.taskId])).toEqual({
      status: 'canceled',
      cancel_reason: 'manual_reconcile',
    });
    const d = await newDraft(t, 'DRV1');
    ok(await reconcile('ADM1', d.ticketId, { target_status: 'voided' }));
    expect(
      await one(t.db, `SELECT status, voided_by, void_reason FROM tickets WHERE id = $1`, [d.ticketId]),
    ).toEqual({
      status: 'voided',
      voided_by: U.ADM1,
      void_reason: 'مطابقة بعد انقطاع النظام',
    });
    expect((await outboxEvents(t.db, 'ticket.voided')).length).toBe(0);
    await expectConsistent(t.db);
  });

  it('payment is never invented (13 §8.5): PAYMENT_PENDING, the documented collection with its collector, the payment rules', async () => {
    const a = await assignedRetrieval(t, { eventId: EVT_R2 }); // per_vehicle 2000
    expect(
      err(await reconcile('SUP-R', a.ticketId, { target_status: 'delivered' }), 'PAYMENT_PENDING', 409),
    ).toEqual({
      amount_halalas: 2000,
      allowed_methods: expect.any(Array),
    });
    const pay = (p: Record<string, unknown>) => ({
      method: 'cash',
      amount_halalas: 2000,
      collected_by: U.DRV1,
      ...p,
    });
    expect(
      err(
        await reconcile('SUP-R', a.ticketId, {
          target_status: 'delivered',
          payment: pay({ amount_halalas: 1500 }),
        }),
        'PAYMENT_AMOUNT_MISMATCH',
        422,
      ),
    ).toEqual({ expected_halalas: 2000, received_halalas: 1500 });
    const posRef = async (ref: string) =>
      err(
        await reconcile('SUP-R', a.ticketId, {
          target_status: 'delivered',
          payment: pay({ method: 'pos', pos_reference: ref }),
        }),
        'VALIDATION_FAILED',
        422,
      ).fields;
    expect(await posRef('4111 1111-1111 1111')).toEqual([
      { field: 'payment.pos_reference', issue: 'looks_like_card_number' },
    ]);
    expect(await posRef('AB#1')).toEqual([{ field: 'payment.pos_reference', issue: 'invalid_format' }]);
    await t.db.query(`UPDATE events SET allowed_payment_methods = '{cash}' WHERE id = $1`, [EVT_R2]);
    expect(
      err(
        await reconcile('SUP-R', a.ticketId, { target_status: 'delivered', payment: pay({ method: 'pos' }) }),
        'PAYMENT_METHOD_NOT_ALLOWED',
        422,
      ),
    ).toEqual({ allowed_methods: ['cash'] });
    await t.db.query(`UPDATE events SET allowed_payment_methods = '{cash,pos}' WHERE id = $1`, [EVT_R2]);
    expect(
      err(
        await reconcile('SUP-R', a.ticketId, {
          target_status: 'delivered',
          payment: pay({ pos_reference: 'A1' }),
        }),
        'VALIDATION_FAILED',
        422,
      ).fields,
    ).toEqual([{ field: 'payment.pos_reference', issue: 'not_applicable' }]);
    expect(
      err(
        await reconcile('SUP-R', a.ticketId, {
          target_status: 'delivered',
          payment: pay({ collected_by: DUMMY }),
        }),
        'RESOURCE_NOT_FOUND',
        404,
      ),
    ).toEqual({ resource: 'user' });
    expect(
      err(
        await reconcile('SUP-R', a.ticketId, { target_status: 'parked', payment: pay({}) }),
        'VALIDATION_FAILED',
        422,
      ).fields,
    ).toEqual([{ field: 'payment', issue: 'not_applicable' }]);

    ok(
      await reconcile('SUP-R', a.ticketId, {
        target_status: 'delivered',
        payment: pay({ method: 'pos', pos_reference: 'ab-12 34' }),
      }),
    );
    const p = await one(
      t.db,
      `SELECT id, method, amount_halalas, pos_reference, collected_by, status, cycle_id FROM payments WHERE ticket_id = $1`,
      [a.ticketId],
    );
    expect(p).toMatchObject({
      method: 'pos',
      pos_reference: 'AB1234', // 13 §5.6 normalization
      amount_halalas: 2000,
      collected_by: U.DRV1,
      status: 'recorded',
      cycle_id: a.cycleId,
    });
    expect(
      (await one(t.db, `SELECT payment_status FROM tickets WHERE id = $1`, [a.ticketId])).payment_status,
    ).toBe('collected');
    expect((await outboxEvents(t.db, 'payment.recorded')).map((e) => e.payload.payload)).toEqual([
      {
        payment_id: p.id,
        ticket_id: a.ticketId,
        cycle_id: a.cycleId, // 11 §8.7 PaymentRecorded, as the row (DEC-285)
        method: 'pos',
        amount_halalas: 2000,
        collected_by: U.DRV1,
        source: 'reconcile',
      },
    ]);
    const [audit] = await auditRows(t, 'payment.record', p.id);
    expect(audit).toMatchObject({ actor_id: U['SUP-R'], entity_type: 'payment' });
    expect(audit.metadata).toMatchObject({
      collected_by: U.DRV1,
      source: 'reconcile',
      ticket_id: a.ticketId,
    });
  });

  it('a collected ticket: PAYMENT_ALREADY_RECORDED with the recorded payment (13 §16), never voided; delivered without payment', async () => {
    const r = await readyRetrieval(t, { eventId: EVT_R2 }); // per_vehicle 2000, DRV1 at the handover point
    const paid = ok(
      await t.command('post', `/v1/tickets/${r.ticketId}/payments`, {
        as: r.driver,
        body: { method: 'cash', amount_halalas: 2000 },
      }),
      201,
    );
    expect(
      err(
        await reconcile('SUP-R', r.ticketId, {
          target_status: 'delivered',
          payment: { method: 'cash', amount_halalas: 2000, collected_by: U.DRV1 },
        }),
        'PAYMENT_ALREADY_RECORDED',
        409,
      ),
    ).toEqual({ payment_id: paid.payment.id, method: 'cash', collected_by: U.DRV1 });
    expect(
      err(await reconcile('SUP-R', r.ticketId, { target_status: 'voided' }), 'INVALID_STATE_TRANSITION', 409),
    ).toMatchObject({ reason: 'payment_recorded' });
    ok(await reconcile('SUP-R', r.ticketId, { target_status: 'delivered' }));
    expect(await one(t.db, `SELECT status, payment_status FROM tickets WHERE id = $1`, [r.ticketId])).toEqual(
      { status: 'delivered', payment_status: 'collected' },
    );
    expect(await rows(t.db, `SELECT id FROM payments WHERE ticket_id = $1`, [r.ticketId])).toHaveLength(1);
    await expectConsistent(t.db);
  });

  it('refusals: occupied spot or slot, version, closed tickets, reason, evidence, scope, permissions', async () => {
    const delivered = await deliveredTicket(t);
    const a = await parkedPaperTicket(t, 'DRV1');
    const b = await parkedPaperTicket(t, 'DRV1');
    expect(
      err(
        await reconcile('SUP-R', a.ticketId, { target_status: 'parked', parking_spot_id: b.spotId }),
        'PARKING_SPOT_OCCUPIED',
        409,
      ),
    ).toEqual({
      parking_spot_id: b.spotId,
    });
    expect(
      err(
        await reconcile('SUP-R', a.ticketId, { target_status: 'parked', key_slot_id: b.slotId }),
        'KEY_SLOT_OCCUPIED',
        409,
      ),
    ).toEqual({
      key_slot_id: b.slotId,
    });
    expect(
      err(
        await reconcile('SUP-R', a.ticketId, { target_status: 'parked', expected_version: 1 }),
        'VERSION_CONFLICT',
        409,
      ),
    ).toMatchObject({
      entity: 'ticket',
      id: a.ticketId,
    });
    // its own spot and slot: kept as they are (a correction of the same state)
    ok(
      await reconcile('SUP-R', a.ticketId, {
        target_status: 'parked',
        parking_spot_id: a.spotId,
        key_slot_id: a.slotId,
        expected_version: a.version,
      }),
    );
    expect(
      await one(t.db, `SELECT count(*)::int AS n FROM spot_allocations WHERE ticket_id = $1`, [a.ticketId]),
    ).toEqual({ n: 1 });
    // spot fields only for parked
    expect(
      err(
        await reconcile('SUP-R', b.ticketId, { target_status: 'voided', parking_spot_id: nextSpot() }),
        'VALIDATION_FAILED',
        422,
      ).fields,
    ).toEqual([{ field: 'parking_spot_id', issue: 'not_allowed_for_target' }]);
    // a closed ticket
    expect(
      err(
        await reconcile('SUP-R', delivered.ticketId, { target_status: 'parked' }),
        'INVALID_STATE_TRANSITION',
        409,
      ),
    ).toMatchObject({
      entity_type: 'ticket',
      current_status: 'delivered',
      command: 'POST /v1/tickets/{ticketId}/manual-reconcile',
      reason: 'ticket_closed',
    });
    // reason and evidence
    expect(
      err(
        await t.command('post', `/v1/tickets/${b.ticketId}/manual-reconcile`, {
          as: 'SUP-R',
          body: { target_status: 'parked', evidence: EVIDENCE },
        }),
        'REASON_REQUIRED',
        422,
      ),
    ).toEqual({ field: 'reason', min_length: 3 });
    err(
      await t.command('post', `/v1/tickets/${b.ticketId}/manual-reconcile`, {
        as: 'SUP-R',
        body: { target_status: 'parked', reason: 'دون دليل' },
      }),
      'VALIDATION_FAILED',
      422,
    );
    err(
      await reconcile('SUP-R', b.ticketId, { target_status: 'parked', evidence: { paper_log_ref: ' ' } }),
      'VALIDATION_FAILED',
      422,
    );
    err(await reconcile('SUP-R', b.ticketId, { target_status: 'requested' }), 'VALIDATION_FAILED', 422);
    // scope and permissions (canon §10: supervisor and admin)
    err(await reconcile('SUP-R', DUMMY, { target_status: 'parked' }), 'TICKET_NOT_FOUND', 404);
    const lyl = await newDraft(t, 'DRV7', EVT_L1);
    err(await reconcile('SUP-R', lyl.ticketId, { target_status: 'voided' }), 'TICKET_NOT_FOUND', 404);
    err(await reconcile('DRV1', b.ticketId, { target_status: 'parked' }), 'PERMISSION_DENIED', 403);
    err(await reconcile('OWN1', b.ticketId, { target_status: 'parked' }), 'PERMISSION_DENIED', 403);
    // an incident that belongs to another ticket
    const other = ok(
      await t.command('post', '/v1/incidents', {
        as: 'SUP-R',
        body: { venue_id: RMS, ticket_id: a.ticketId, type: 'other', description: 'واقعة أخرى' },
      }),
      201,
    ).id;
    expect(
      err(
        await reconcile('SUP-R', b.ticketId, { target_status: 'parked', incident_id: other }),
        'VALIDATION_FAILED',
        422,
      ).fields,
    ).toEqual([{ field: 'incident_id', issue: 'ticket_mismatch' }]);
    expect(
      err(
        await reconcile('SUP-R', b.ticketId, { target_status: 'parked', incident_id: DUMMY }),
        'RESOURCE_NOT_FOUND',
        404,
      ),
    ).toEqual({
      resource: 'incident',
    });
  });
});
