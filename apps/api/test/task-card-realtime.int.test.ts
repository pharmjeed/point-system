import { rooms } from '@point/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  createS2App,
  err,
  keyPickup,
  nextSlot,
  nextSpot,
  ok,
  one,
  RMS,
  startDuty,
  U,
} from './dispatch-fixtures.js';
import { captureRealtime } from './dispatch-s4-fixtures.js';
import { CASH, FEE, pay, readyTicket, reverse, waive } from './payments-fixtures.js';
import { assignedRetrieval } from './supervisor-fixtures.js';

/**
 * realtime:RT-2 — the assignee's TaskCard shows ticket-derived fields (key_slot, parking, payment_due, 09 §5.1).
 * A supervisor command that changes them without touching the task (an official slot → slot / spot → spot
 * transfer, a fee waiver) bumps the task version and republishes the TaskCard to the assignee, so D-10 / D-11
 * never act on a stale key slot or fee (07 §4.3, §4.5: only a newer version is applied).
 */
describe('TaskCard republished when the assignee card changes without a task event (RT-2)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV2'), 201);
  });
  afterEach(async () => t.close());

  const transfer = (ticketId: string, body: Record<string, unknown>) =>
    t.command('post', `/v1/tickets/${ticketId}/custody-transfers`, {
      as: 'SUP-R',
      body: { reason: 'نقل رسمي للخانة', ...body },
    });
  const taskVersion = async (taskId: string) =>
    (await one(t.db, `SELECT version FROM tasks WHERE id = $1`, [taskId])).version as number;

  it('slot → slot of the key of an accepted retrieval: a newer TaskCard with the new key slot to the assignee, the Task to the supervisors', async () => {
    const a = await assignedRetrieval(t, { parker: 'DRV2', driver: 'DRV1' });
    const before = await taskVersion(a.retrieveTaskId);
    const s2 = nextSlot();
    const rt = await captureRealtime(t);
    try {
      ok(await transfer(a.ticketId, { subject: 'key', to_holder_type: 'key_slot', to_holder_id: s2 }), 201);
      await rt.settle();
      expect(await taskVersion(a.retrieveTaskId)).toBe(before + 1);
      const cards = rt
        .of('task.updated', rooms.user(U.DRV1))
        .filter((m) => m.message.data.task?.id === a.retrieveTaskId);
      expect(cards).toHaveLength(1);
      expect(cards[0]!.message.aggregate).toEqual({
        type: 'task',
        id: a.retrieveTaskId,
        version: before + 1,
      });
      expect(cards[0]!.message.data).toMatchObject({
        cause: 'custody.changed',
        task: { id: a.retrieveTaskId, version: before + 1, status: 'accepted' },
        key_slot: { id: s2 },
      });
      const views = rt
        .of('task.updated', rooms.venueSupervisors(RMS))
        .filter((m) => m.message.data.id === a.retrieveTaskId);
      expect(views.map((m) => m.message.data.version)).toEqual([before + 1]);
      expect(views[0]!.message.data).not.toHaveProperty('key_slot');
      // the snapshot agrees, and the pickup at the new slot works (the old one is CUSTODY_HOLDER_MISMATCH)
      const home = ok(await t.get('/v1/me/home', 'DRV1'));
      expect(home.current_task).toMatchObject({ task: { version: before + 1 }, key_slot: { id: s2 } });
      err(await keyPickup(t, 'DRV1', a.retrieveTaskId, a.slotId), 'CUSTODY_HOLDER_MISMATCH', 409);
      ok(await keyPickup(t, 'DRV1', a.retrieveTaskId, s2));
    } finally {
      await rt.stop();
    }
  });

  it('the picked-up key handed to a supervisor: the pickup is reset, a newer TaskCard with key_picked_up_at null to the assignee', async () => {
    const a = await assignedRetrieval(t, { parker: 'DRV2', driver: 'DRV1' });
    ok(await keyPickup(t, 'DRV1', a.retrieveTaskId, a.slotId));
    const before = await taskVersion(a.retrieveTaskId);
    const rt = await captureRealtime(t);
    try {
      ok(
        await transfer(a.ticketId, { subject: 'key', to_holder_type: 'supervisor', to_holder_id: U['SUP-R'] }),
        201,
      );
      await rt.settle();
      expect(await taskVersion(a.retrieveTaskId)).toBe(before + 1);
      const cards = rt
        .of('task.updated', rooms.user(U.DRV1))
        .filter((m) => m.message.data.task?.id === a.retrieveTaskId);
      expect(cards).toHaveLength(1);
      expect(cards[0]!.message.aggregate).toEqual({ type: 'task', id: a.retrieveTaskId, version: before + 1 });
      expect(cards[0]!.message.data).toMatchObject({
        cause: 'custody.changed',
        task: { id: a.retrieveTaskId, version: before + 1, status: 'accepted', key_picked_up_at: null },
      });
      const views = rt
        .of('task.updated', rooms.venueSupervisors(RMS))
        .filter((m) => m.message.data.id === a.retrieveTaskId);
      expect(views.map((m) => m.message.data.version)).toEqual([before + 1]);
      const home = ok(await t.get('/v1/me/home', 'DRV1'));
      expect(home.current_task).toMatchObject({ task: { version: before + 1, key_picked_up_at: null } });
    } finally {
      await rt.stop();
    }
  });

  it('a key moved between two supervisors (no driver, no slot): no TaskCard is republished', async () => {
    const a = await assignedRetrieval(t, { parker: 'DRV2', driver: 'DRV1' });
    ok(await transfer(a.ticketId, { subject: 'key', to_holder_type: 'supervisor', to_holder_id: U['SUP-R'] }), 201);
    const rt = await captureRealtime(t);
    try {
      ok(await transfer(a.ticketId, { subject: 'key', to_holder_type: 'unknown' }), 201);
      await rt.settle();
      const cards = rt
        .of('task.updated', rooms.user(U.DRV1))
        .filter((m) => m.message.data.task?.id === a.retrieveTaskId);
      expect(cards).toHaveLength(0);
    } finally {
      await rt.stop();
    }
  });

  it('spot → spot of the vehicle of an accepted retrieval: the TaskCard carries the new spot', async () => {
    const a = await assignedRetrieval(t, { parker: 'DRV2', driver: 'DRV1' });
    const before = await taskVersion(a.retrieveTaskId);
    const spot = nextSpot();
    const rt = await captureRealtime(t);
    try {
      ok(await transfer(a.ticketId, { subject: 'vehicle', to_holder_type: 'spot', to_holder_id: spot }), 201);
      await rt.settle();
      const cards = rt
        .of('task.updated', rooms.user(U.DRV1))
        .filter((m) => m.message.data.task?.id === a.retrieveTaskId);
      expect(cards).toHaveLength(1);
      expect(cards[0]!.message.data).toMatchObject({
        cause: 'custody.changed',
        task: { version: before + 1 },
        parking: { spot_label: expect.any(String) },
      });
      const label = (await one(t.db, `SELECT label FROM parking_spots WHERE id = $1`, [spot])).label;
      expect(cards[0]!.message.data.parking.spot_label).toBe(label);
    } finally {
      await rt.stop();
    }
  });
});

describe('TaskCard republished after a fee waiver (RT-2)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201); // the only driver: the retrieval is offered to him
  });
  afterEach(async () => t.close());
  const taskVersion = async (taskId: string) =>
    (await one(t.db, `SELECT version FROM tasks WHERE id = $1`, [taskId])).version as number;

  it('a fee waiver while the driver is at the handover (D-11): a newer TaskCard with payment_due null', async () => {
    const r = await readyTicket(t, 'DRV1');
    const home0 = ok(await t.get('/v1/me/home', 'DRV1'));
    expect(home0.current_task.payment_due).toMatchObject({ amount_halalas: FEE });
    const before = await taskVersion(r.retrieveTaskId);
    const rt = await captureRealtime(t);
    try {
      ok(await waive(t, 'SUP-R', r.ticketId, { reason: 'ضيف العريس' }));
      await rt.settle();
      expect(await taskVersion(r.retrieveTaskId)).toBe(before + 1);
      const cards = rt
        .of('task.updated', rooms.user(U.DRV1))
        .filter((m) => m.message.data.task?.id === r.retrieveTaskId);
      expect(cards).toHaveLength(1);
      expect(cards[0]!.message.data).toMatchObject({
        cause: 'payment.waived',
        task: { version: before + 1, status: 'in_progress' },
        payment_due: null,
      });
      const home = ok(await t.get('/v1/me/home', 'DRV1'));
      expect(home.current_task).toMatchObject({ task: { version: before + 1 }, payment_due: null });
    } finally {
      await rt.stop();
    }
  });

  it('a reversal without replacement on the open ticket: the fee is due again, a newer TaskCard carries payment_due', async () => {
    const r = await readyTicket(t, 'DRV1');
    const paid = ok(await pay(t, 'DRV1', r.ticketId, CASH), 201).payment;
    expect(ok(await t.get('/v1/me/home', 'DRV1')).current_task.payment_due).toBeNull();
    const before = await taskVersion(r.retrieveTaskId);
    const rt = await captureRealtime(t);
    try {
      ok(await reverse(t, 'SUP-R', paid.id, { reason: 'سُجل خطأ' }));
      await rt.settle();
      const cards = rt
        .of('task.updated', rooms.user(U.DRV1))
        .filter((m) => m.message.data.task?.id === r.retrieveTaskId);
      expect(cards).toHaveLength(1);
      expect(cards[0]!.message.data).toMatchObject({
        cause: 'payment.reversed',
        task: { version: before + 1 },
        payment_due: { amount_halalas: FEE },
      });
    } finally {
      await rt.stop();
    }
  });
});
