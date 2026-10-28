import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OutboxDispatcher } from '@point/server';
import type { TestApp } from './harness.js';
import {
  accept,
  completeParking,
  createS2App,
  err,
  liveOffer,
  newDraft,
  nextSlot,
  nextSpot,
  ok,
  paperTicketInParking,
  parkedPaperTicket,
  POOL_R,
  requestRetrieval,
  RMS,
  startDuty,
  U,
} from './dispatch-fixtures.js';
import { brk, captureRealtime, s4Worker } from './dispatch-s4-fixtures.js';

/**
 * Realtime messages of the dispatch events (07 §4.3, 11 §9.2; DEC-41/DEC-48): what each committed transaction
 * publishes, to which rooms, with which payload — and nothing for a command that rolled back.
 */
describe('S4 — realtime publications of the dispatch engine', () => {
  let t: TestApp;
  let worker: OutboxDispatcher;
  beforeEach(async () => {
    t = await createS2App();
    worker = s4Worker(t);
  });
  afterEach(async () => t.close());

  it('duty start: driver.state_changed (DriverLive) to the driver and the venue supervisors', async () => {
    const ws = await captureRealtime(t);
    ok(await startDuty(t, 'DRV1'), 201);
    await ws.settle();
    const m = ws.of('driver.state_changed');
    expect(m).toHaveLength(1); // duty_started + availability_changed → one message per driver and transaction
    expect(m[0]!.rooms.sort()).toEqual([`user:${U.DRV1}`, `venue:${RMS}:supervisors`].sort());
    expect(m[0]!.message).toMatchObject({
      aggregate: { type: 'user', id: U.DRV1, version: null },
      venue_id: RMS,
      dispatch_pool_id: POOL_R,
      data: {
        driver: { id: U.DRV1, full_name: expect.any(String), employee_code: expect.any(String) },
        driver_state: 'available',
        connection_state: 'online',
        duty_session_id: expect.any(String),
        active_task_id: null,
        next_task_id: null,
      },
    });
    ok(await brk(t, 'DRV1', true));
    await ws.settle();
    expect(ws.of('driver.state_changed').at(-1)!.message.data).toMatchObject({
      cause: expect.stringMatching(/^driver\./),
      driver_state: 'on_break',
    });
    await ws.stop();
  });

  it('a single round: task.offered (OfferCard) to the recipient only, task.updated (Task) to the supervisors; reminder and close', async () => {
    ok(await startDuty(t, 'DRV2'), 201);
    t.clock.advanceSeconds(1);
    ok(await startDuty(t, 'DRV1'), 201);
    const p = await parkedPaperTicket(t, 'DRV1');
    const ws = await captureRealtime(t);
    const req = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    const offer = (await liveOffer(t.db, U.DRV2))!;
    await ws.settle();
    const offered = ws.of('task.offered');
    expect(offered).toHaveLength(1);
    expect(offered[0]!.rooms).toEqual([`user:${U.DRV2}`]);
    expect(offered[0]!.message).toMatchObject({
      aggregate: { type: 'task_offer', id: offer.id },
      data: {
        cause: 'task.offered',
        offer_id: offer.id,
        task_id: req.task.id,
        mode: 'single',
        eligible_as: 'accept',
        can_accept: true,
        can_reserve_next: false,
        safety_note_ar: null,
        server_time: t.clock.now().toISOString(),
        waiting_seconds: 0,
        ticket: { display_number: p.displayNumber, plate: expect.any(Object), vehicle: expect.any(Object) },
      },
    });
    expect(new Date(offered[0]!.message.data.expires_at).getTime() - t.clock.now().getTime()).toBe(30_000);
    const sup = ws.of('task.updated', `venue:${RMS}:supervisors`);
    expect(sup.at(-1)!.message.data).toMatchObject({ id: req.task.id, status: 'offered' });
    expect(sup.at(-1)!.message.data.parking).toBeUndefined(); // the supervisors' Task carries no spot or key slot
    // 15 s: one reminder to the recipient; 31.5 s: offer.closed (expired) then the next round
    ws.clear();
    t.clock.advanceSeconds(15);
    await worker.drain();
    await ws.settle();
    expect(ws.of('offer.reminder').map((m) => [m.rooms, m.message.data])).toEqual([
      [[`user:${U.DRV2}`], { cause: 'offer.reminded', offer_id: offer.id, task_id: req.task.id }],
    ]);
    ws.clear();
    t.clock.advanceSeconds(16.5);
    await worker.drain();
    await ws.settle();
    expect(ws.of('offer.closed').map((m) => [m.rooms, m.message.data])).toEqual([
      [
        [`user:${U.DRV2}`],
        { cause: 'offer.expired', offer_id: offer.id, task_id: req.task.id, close_reason: 'expired' },
      ],
    ]);
    expect(ws.of('task.offered', `user:${U.DRV1}`)).toHaveLength(1);
    await ws.stop();
  });

  it('a revoked round: offer.closed with the reason to every recipient; a refused command publishes nothing', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    const p = await parkedPaperTicket(t, 'DRV1');
    ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    const offer = (await liveOffer(t.db, U.DRV1))!;
    const ws = await captureRealtime(t);
    ok(await brk(t, 'DRV1', true)); // recipient_unavailable
    await ws.settle();
    expect(ws.of('offer.closed').map((m) => m.message.data)).toEqual([
      {
        cause: 'offer.revoked',
        offer_id: offer.id,
        task_id: offer.task_id,
        close_reason: 'recipient_unavailable',
      },
    ]);
    ws.clear();
    err(await accept(t, 'DRV1', offer.id), 'DRIVER_ON_BREAK', 409);
    await ws.settle();
    expect(ws.all).toEqual([]);
    await ws.stop();
  });

  it('task.promoted → task.updated (TaskCard, cause task.promoted) to the driver whose next task became current', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    const a = await parkedPaperTicket(t, 'DRV1');
    const draft = await paperTicketInParking(t, 'DRV1');
    const req = ok(await requestRetrieval(t, 'SUP-R', a.ticketId), 201);
    ok(await accept(t, 'DRV1', (await liveOffer(t.db, U.DRV1))!.id));
    const ws = await captureRealtime(t);
    ok(
      await completeParking(t, 'DRV1', draft.taskId, {
        parking_spot_id: nextSpot(),
        key_slot_id: nextSlot(),
      }),
    );
    await ws.settle();
    const promoted = ws
      .of('task.updated', `user:${U.DRV1}`)
      .find((m) => m.message.data.cause === 'task.promoted')!;
    expect(promoted.message.data).toMatchObject({
      task: { id: req.task.id, status: 'accepted' },
      key_slot: { id: a.slotId },
      parking: { spot_label: expect.any(String) },
    });
    expect(promoted.message.aggregate).toMatchObject({ type: 'task', id: req.task.id });
    await ws.stop();
  });

  it('busy drivers only: task.broadcast carries reserve_next and the safety note; on break nothing is sent to him', async () => {
    for (const d of ['DRV1', 'DRV2', 'DRV3']) ok(await startDuty(t, d), 201);
    const p = await parkedPaperTicket(t, 'DRV1');
    await newDraft(t, 'DRV1');
    await newDraft(t, 'DRV2');
    ok(await brk(t, 'DRV3', true));
    const ws = await captureRealtime(t);
    ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    await ws.settle();
    expect(
      ws
        .of('task.broadcast')
        .map((m) => m.rooms[0])
        .sort(),
    ).toEqual([`user:${U.DRV1}`, `user:${U.DRV2}`].sort());
    expect(ws.all.some((m) => m.rooms.includes(`user:${U.DRV3}`))).toBe(false);
    await ws.stop();
  });
});
