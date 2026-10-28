import { requestRetrievalForCustomer } from '@point/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  completeParking,
  createS2App,
  expectConsistent,
  liveOffer,
  newDraft,
  nextSlot,
  nextSpot,
  ok,
  one,
  outboxEvents,
  paperTicketInParking,
  parkedPaperTicket,
  rows,
  startDuty,
  U,
} from './dispatch-fixtures.js';
import { captureRealtime, linkWhatsapp, whatsappNotifications } from './dispatch-s4-fixtures.js';

/** The «طلب السيارة» button as the WhatsApp handler (PNT-045) calls it inside the inbound transaction. */
const press = (t: TestApp, ticketId: string, customerId: string) =>
  t.db.transaction((tx) => requestRetrievalForCustomer(tx, { ticketId, customerId }));

describe('PNT-060 — the early request while the vehicle is being parked (AC-05, DEC-13)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
  });
  afterEach(async () => t.close());

  it('a press during parking: no retrieve task, pending_retrieval_at set once, W-02 once; at parked: a cycle with the original time, requested_early, no second W-02', async () => {
    const d = await paperTicketInParking(t, 'DRV1');
    const customer = await linkWhatsapp(t, d.ticketId);
    const pressedAt = t.clock.now();
    const first = await press(t, d.ticketId, customer);
    expect(first).toEqual({
      kind: 'pending_early',
      ticketStatus: 'parking',
      pendingRetrievalAt: pressedAt.toISOString(),
    });
    expect(
      (await rows(t.db, `SELECT 1 FROM tasks WHERE ticket_id = $1 AND type = 'retrieve'`, [d.ticketId]))
        .length,
    ).toBe(0);
    expect(
      (await outboxEvents(t.db, 'ticket.retrieval_requested_early')).map((e) => e.payload.payload),
    ).toEqual([
      expect.objectContaining({
        pending_retrieval_at: pressedAt.toISOString(),
        request_source: 'whatsapp',
        requested_by_customer_id: customer,
        parking_task_assignee_id: U.DRV1,
        status_at_request: 'parking',
      }),
    ]);
    t.clock.advanceSeconds(20);
    const second = await press(t, d.ticketId, customer);
    expect(second).toMatchObject({ kind: 'already_pending', pendingRetrievalAt: pressedAt.toISOString() });
    expect(
      (await one(t.db, `SELECT pending_retrieval_at FROM tickets WHERE id = $1`, [d.ticketId]))
        .pending_retrieval_at,
    ).toEqual(pressedAt);
    expect((await whatsappNotifications(t, d.ticketId)).map((n) => n.purpose)).toEqual(['W-02']);
    // the parking completes: the cycle keeps the original time; the parking driver gets no preference but is the only one
    t.clock.advanceSeconds(60);
    ok(await completeParking(t, 'DRV1', d.taskId, { parking_spot_id: nextSpot(), key_slot_id: nextSlot() }));
    const cycle = await one(t.db, `SELECT * FROM retrieval_cycles WHERE ticket_id = $1`, [d.ticketId]);
    expect(cycle).toMatchObject({
      requested_at: pressedAt,
      requested_early: true,
      request_source: 'whatsapp',
      requested_by_customer_id: customer,
    });
    const task = await one(t.db, `SELECT * FROM tasks WHERE ticket_id = $1 AND type = 'retrieve'`, [
      d.ticketId,
    ]);
    expect(task.priority_at).toEqual(pressedAt);
    expect(task.queued_at).toEqual(t.clock.now()); // the escalation measures the time in the queue
    expect((await liveOffer(t.db, U.DRV1))?.task_id).toBe(task.id);
    expect((await whatsappNotifications(t, d.ticketId)).map((n) => n.purpose)).toEqual(['W-02']);
    expect(
      await one(t.db, `SELECT status, pending_retrieval_at FROM tickets WHERE id = $1`, [d.ticketId]),
    ).toEqual({
      status: 'requested',
      pending_retrieval_at: null,
    });
    await expectConsistent(t.db);
  });

  it('a press on a parked ticket creates the cycle and dispatches at once; an open cycle answers already_active; a closed ticket closed', async () => {
    const p = await parkedPaperTicket(t, 'DRV1');
    const customer = await linkWhatsapp(t, p.ticketId);
    const ws = await captureRealtime(t);
    const r = await press(t, p.ticketId, customer);
    expect(r).toMatchObject({ kind: 'created', ticketStatus: 'requested' });
    const cycle = await one(t.db, `SELECT * FROM retrieval_cycles WHERE ticket_id = $1`, [p.ticketId]);
    expect(cycle).toMatchObject({
      request_source: 'whatsapp',
      requested_early: false,
      requested_by_customer_id: customer,
    });
    expect((await liveOffer(t.db, U.DRV1))?.task_id).toBe((r as { taskId: string }).taskId);
    expect(await press(t, p.ticketId, customer)).toMatchObject({ kind: 'already_active', cycleId: cycle.id });
    expect((await whatsappNotifications(t, p.ticketId)).map((n) => n.purpose)).toEqual(['W-02']);
    await ws.settle();
    expect(ws.of('task.offered', `user:${U.DRV1}`)).toHaveLength(1);
    await ws.stop();
    await expectConsistent(t.db);
  });

  it('a closed ticket answers closed', async () => {
    const d = await newDraft(t, 'DRV1');
    ok(await t.command('post', `/v1/tickets/${d.ticketId}/discard-draft`, { as: 'DRV1', body: {} }));
    const customer = (
      await one<{ id: string }>(
        t.db,
        `INSERT INTO customers (org_id, phone_e164) SELECT org_id, '+966512345670' FROM tickets WHERE id = $1 RETURNING id`,
        [d.ticketId],
      )
    ).id;
    expect(await press(t, d.ticketId, customer)).toEqual({ kind: 'closed', ticketStatus: 'voided' });
  });
});
