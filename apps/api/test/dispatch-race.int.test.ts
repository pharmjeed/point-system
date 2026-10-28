import { createLogger, offerExpireHandler, runDispatchPass } from '@point/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  accept,
  createDrivers,
  createS2App,
  EVT_R1,
  expectConsistent,
  handover,
  keyPickup,
  liveOffer,
  markReady,
  newDraft,
  ok,
  one,
  outboxEvents,
  parkedPaperTicket,
  POOL_R,
  requestRetrieval,
  rows,
  startDuty,
  startRetrieval,
  U,
} from './dispatch-fixtures.js';
import { reassign, twoLiveBroadcastsForDrv1 } from './dispatch-s4-fixtures.js';

/**
 * PNT-063 — the race suite (17 race designs, 10 §14.3): real PostgreSQL 16, the real API, separate connections,
 * `Promise.all` with random 0–20 ms delays. `RACE_ITERATIONS` repeats each scenario (default 3; the nightly loop
 * `pnpm test:race` runs the whole file `RACE_LOOPS` times in a row, 50 by default) and the 10 §14.1 invariants are
 * checked after every iteration. `PRIORITY_ITERATIONS` (default 100) drives the AC-17 scenario.
 */
const ITERATIONS = Math.max(1, Number(process.env.RACE_ITERATIONS ?? 3));
const PRIORITY_ITERATIONS = Math.max(1, Number(process.env.PRIORITY_ITERATIONS ?? 100));
const jitter = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 21)));
const later = async <T>(f: () => Promise<T>) => {
  await jitter();
  return f();
};
const codes = (xs: { status: number; body: any }[]) =>
  xs.map((x) => (x.status === 200 ? 'OK' : x.body?.error?.code));

describe('PNT-063 — parallel accepts of one broadcast (AC-04): exactly one winner', () => {
  let t: TestApp;
  let extra: string[] = [];
  beforeAll(async () => {
    t = await createS2App();
    extra = await createDrivers(t.db, 6);
    for (const d of ['DRV1', 'DRV2', 'DRV3', 'DRV4', 'DRV5', 'DRV6', ...extra])
      ok(await startDuty(t, d), 201);
  });
  afterAll(async () => t.close());

  it(`12 drivers (10 accept + 2 reserve_next) × ${ITERATIONS}: one 200, eleven TASK_ALREADY_CLAIMED, one task.claimed`, async () => {
    const drivers = ['DRV1', 'DRV2', 'DRV3', 'DRV4', 'DRV5', 'DRV6', ...extra];
    for (let i = 0; i < ITERATIONS; i++) {
      // everybody idle drivers tried once → the request is a broadcast to all twelve
      const p = await parkedPaperTicket(t, 'DRV1');
      const two = [await newDraft(t, 'DRV5'), await newDraft(t, 'DRV6')];
      const req = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
      // turn the single round into a broadcast the way the engine does after silence: expire it via the timer body
      for (
        let k = 0;
        k < 10 &&
        (await one(t.db, `SELECT status FROM tasks WHERE id = $1`, [req.task.id])).status === 'offered';
        k++
      ) {
        t.clock.advanceSeconds(32);
        await t.db.transaction(async (tx) => runDispatchPass(tx, POOL_R, 'sweep'));
      }
      const b = await one<{ id: string }>(
        t.db,
        `SELECT id FROM task_offers WHERE task_id = $1 AND status = 'active' AND mode = 'broadcast'`,
        [req.task.id],
      );
      const recipients = await rows(t.db, `SELECT user_id FROM offer_recipients WHERE offer_id = $1`, [b.id]);
      expect(recipients.length).toBe(12);
      const before = (await outboxEvents(t.db, 'task.claimed')).length;
      const res = await Promise.all(drivers.map((d) => later(() => accept(t, d, b.id))));
      const c = codes(res);
      expect(c.filter((x) => x === 'OK')).toHaveLength(1);
      expect(c.filter((x) => x === 'TASK_ALREADY_CLAIMED')).toHaveLength(11);
      expect((await outboxEvents(t.db, 'task.claimed')).length).toBe(before + 1);
      await expectConsistent(t.db);
      // clean up: discard the two drafts, finish the retrieval so the next iteration starts idle
      for (const [k, d] of two.entries())
        ok(
          await t.command('post', `/v1/tickets/${d.ticketId}/discard-draft`, {
            as: k === 0 ? 'DRV5' : 'DRV6',
            body: {},
          }),
        );
      const winner = drivers[c.indexOf('OK')]!;
      const task = await one(t.db, `SELECT * FROM tasks WHERE id = $1`, [req.task.id]);
      if (task.status === 'assigned_waiting') continue; // reserved by a busy driver: promoted when he finishes
      ok(await keyPickup(t, winner, req.task.id, p.slotId));
      ok(await startRetrieval(t, winner, req.task.id));
      ok(await markReady(t, winner, req.task.id));
      ok(
        await handover(t, winner, p.ticketId, {
          verification: { method: 'paper_stub', paper_serial: p.serial },
        }),
      );
    }
  });
});

describe('PNT-063 — the same driver: intake vs accept, accept vs expiry, double handover', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
    ok(await startDuty(t, 'DRV2'), 201);
  });
  afterAll(async () => t.close());

  it(`intake vs accept of his single round × ${ITERATIONS}: never two movements`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const p = await parkedPaperTicket(t, 'DRV2');
      const req = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
      const offer = (await liveOffer(t.db, U.DRV1)) ?? (await liveOffer(t.db, U.DRV2));
      const who = (await liveOffer(t.db, U.DRV1)) ? 'DRV1' : 'DRV2';
      const [intake, acc] = await Promise.all([
        later(() => t.command('post', '/v1/tickets', { as: who, body: { event_id: EVT_R1 } })),
        later(() => accept(t, who, offer!.id)),
      ]);
      const outcome = [intake.status, acc.status === 200 ? acc.body.data.result : acc.body.error.code];
      expect([
        [201, 'OFFER_REVOKED'],
        [409, 'accepted'],
        [201, 'assigned_waiting'],
      ]).toContainEqual(outcome);
      const movements = await rows(
        t.db,
        `SELECT id FROM tasks WHERE assignee_id = $1 AND status IN ('accepted','in_progress')`,
        [(U as Record<string, string>)[who]],
      );
      expect(movements.length).toBe(1);
      await expectConsistent(t.db);
      // clean up
      if (intake.status === 201)
        ok(
          await t.command('post', `/v1/tickets/${intake.body.data.ticket.id}/discard-draft`, {
            as: who,
            body: {},
          }),
        );
      const task = await one(t.db, `SELECT * FROM tasks WHERE id = $1`, [req.task.id]);
      if (task.assignee_id) {
        const holder = task.assignee_id === U.DRV1 ? 'DRV1' : 'DRV2';
        ok(await keyPickup(t, holder, task.id, p.slotId));
        ok(await startRetrieval(t, holder, task.id));
        ok(await markReady(t, holder, task.id));
        ok(
          await handover(t, holder, p.ticketId, {
            verification: { method: 'paper_stub', paper_serial: p.serial },
          }),
        );
      } else {
        ok(
          await t.command('post', `/v1/retrieval-cycles/${req.cycle.id}/cancel`, {
            as: 'SUP-R',
            body: { reason: 'تنظيف الاختبار' },
          }),
        );
      }
    }
  });

  it(`accept vs job.offer_expire around the deadline × ${ITERATIONS}: accepted or OFFER_EXPIRED, never both`, async () => {
    const logger = createLogger({ level: 'silent' });
    for (let i = 0; i < ITERATIONS; i++) {
      const p = await parkedPaperTicket(t, 'DRV2');
      const req = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
      const holder = (await liveOffer(t.db, U.DRV1)) ? 'DRV1' : 'DRV2';
      const offer = (await liveOffer(t.db, (U as Record<string, string>)[holder]!))!;
      // the deadline is expires_at + 1.5 s = 31.5 s: either side of it, the worker and the accept race on the locks
      t.clock.advanceSeconds(31.3 + Math.random() * 0.4);
      const row = await one(t.db, `SELECT * FROM outbox_events WHERE dedupe_key = $1`, [
        `offer_expire:${offer.id}`,
      ]);
      const [acc] = await Promise.all([
        later(() => accept(t, holder, offer.id)),
        later(() =>
          t.db.transaction(async (tx) => {
            await offerExpireHandler.handle({
              row,
              tx,
              db: t.db,
              clock: t.clock,
              logger,
              renewLease: async () => {},
            });
          }),
        ),
      ]);
      const status = (await one(t.db, `SELECT status FROM task_offers WHERE id = $1`, [offer.id])).status;
      if (acc.status === 200) expect(status).toBe('accepted');
      else {
        expect(acc.body.error.code).toBe('OFFER_EXPIRED');
        expect(status).toBe('expired');
      }
      await expectConsistent(t.db);
      // clean up
      const task = await one(t.db, `SELECT * FROM tasks WHERE id = $1`, [req.task.id]);
      if (task.status === 'accepted' || task.status === 'assigned_waiting') {
        const h = task.assignee_id === U.DRV1 ? 'DRV1' : 'DRV2';
        ok(await reassign(t, 'SUP-R', task.id, { reason: 'تنظيف الاختبار', target_driver_id: null }));
        void h;
      }
      ok(
        await t.command('post', `/v1/retrieval-cycles/${req.cycle.id}/cancel`, {
          as: 'SUP-R',
          body: { reason: 'تنظيف الاختبار' },
        }),
      );
      t.clock.advanceSeconds(1);
    }
  });

  it(`double handover × ${ITERATIONS}: one delivery, the other TICKET_CLOSED`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const p = await parkedPaperTicket(t, 'DRV2');
      const req = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
      const holder = (await liveOffer(t.db, U.DRV1)) ? 'DRV1' : 'DRV2';
      ok(await accept(t, holder, (await liveOffer(t.db, (U as Record<string, string>)[holder]!))!.id));
      ok(await keyPickup(t, holder, req.task.id, p.slotId));
      ok(await startRetrieval(t, holder, req.task.id));
      ok(await markReady(t, holder, req.task.id));
      const body = { verification: { method: 'paper_stub', paper_serial: p.serial } };
      const res = await Promise.all([
        later(() => handover(t, holder, p.ticketId, body)),
        later(() => handover(t, holder, p.ticketId, body)),
      ]);
      expect(codes(res).sort()).toEqual(['OK', 'TICKET_CLOSED']);
      expect(
        (await outboxEvents(t.db, 'ticket.delivered')).filter(
          (e) => e.payload.payload.ticket.ticket_id === p.ticketId,
        ),
      ).toHaveLength(1);
      await expectConsistent(t.db);
    }
  });
});

describe('PNT-063 — supervisor reassignment vs the driver accept', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createS2App();
    for (const d of ['DRV1', 'DRV2', 'DRV3']) ok(await startDuty(t, d), 201);
  });
  afterAll(async () => t.close());

  it(`reassign to another driver vs accept × ${ITERATIONS}: one owner, the loser gets a clean code`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const p = await parkedPaperTicket(t, 'DRV3');
      const req = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
      const holderId = (
        await one(
          t.db,
          `SELECT r.user_id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id WHERE o.task_id = $1 AND o.status = 'active'`,
          [req.task.id],
        )
      ).user_id;
      const holder = Object.entries(U).find(([, v]) => v === holderId)![0];
      const other = ['DRV1', 'DRV2', 'DRV3'].find(
        (d) => d !== holder && (U as Record<string, string>)[d] !== holderId,
      )!;
      const offer = (await liveOffer(t.db, holderId))!;
      const [acc, re] = await Promise.all([
        later(() => accept(t, holder, offer.id)),
        later(() =>
          reassign(t, 'SUP-R', req.task.id, {
            reason: 'اختبار السباق',
            target_driver_id: (U as Record<string, string>)[other],
          }),
        ),
      ]);
      const task = await one(t.db, `SELECT status, assignee_id FROM tasks WHERE id = $1`, [req.task.id]);
      expect(task.assignee_id).not.toBeNull();
      if (re.status === 200) expect(task.assignee_id).toBe((U as Record<string, string>)[other]);
      if (acc.status !== 200)
        expect(['OFFER_REVOKED', 'TASK_ALREADY_CLAIMED']).toContain(acc.body.error.code);
      if (re.status !== 200)
        expect([
          'INVALID_STATE_TRANSITION',
          'DRIVER_NOT_AVAILABLE',
          'NEXT_TASK_ALREADY_RESERVED',
          'OLDER_REQUEST_PENDING',
        ]).toContain(re.body.error.code);
      await expectConsistent(t.db);
      ok(
        await t.command('post', `/v1/retrieval-cycles/${req.cycle.id}/cancel`, {
          as: 'SUP-R',
          body: { reason: 'تنظيف الاختبار' },
        }),
      );
    }
  });
});

describe('PNT-063 / PNT-056 — the priority guard under concurrency (AC-17)', () => {
  let t: TestApp;
  let older: { taskId: string; offerId: string };
  let newer: { taskId: string; offerId: string };
  beforeAll(async () => {
    t = await createS2App();
    ({ older, newer } = await twoLiveBroadcastsForDrv1(t));
  });
  afterAll(async () => t.close());

  it(`${PRIORITY_ITERATIONS} rounds of 20 parallel accepts on the newer request while the older is actionable: none succeeds`, async () => {
    for (let i = 0; i < PRIORITY_ITERATIONS; i++) {
      const res = await Promise.all(
        Array.from({ length: 20 }, () => later(() => accept(t, 'DRV1', newer.offerId))),
      );
      expect(new Set(codes(res))).toEqual(new Set(['OLDER_REQUEST_PENDING']));
    }
    expect(await one(t.db, `SELECT status, assignee_id FROM tasks WHERE id = $1`, [newer.taskId])).toEqual({
      status: 'broadcast',
      assignee_id: null,
    });
    // the older one is still the driver's to take
    expect(ok(await accept(t, 'DRV1', older.offerId)).result).toBe('assigned_waiting');
    await expectConsistent(t.db);
  });
});
