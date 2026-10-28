import { SEED_IDS } from '@point/db/seed';
import { dispatchJobs } from '@point/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  accept,
  addPhotos,
  completeParking,
  createS2App,
  err,
  EVT_L1,
  EVT_R1,
  EVT_R2,
  expectConsistent,
  handover,
  keyPickup,
  liveOffer,
  markReady,
  newDraft,
  ok,
  one,
  openBroadcastBySql,
  PAPER_DRAFT,
  parkedPaperTicket,
  patchIntake,
  POOL_R,
  requestRetrieval,
  RMS,
  rows,
  startDuty,
  startRetrieval,
  submitIntake,
  U,
} from './dispatch-fixtures.js';
import {
  assignedRetrieval,
  DUMMY,
  ORG,
  raise,
  readyRetrieval,
  supervisorWorker,
} from './supervisor-fixtures.js';

const CHANNEL = SEED_IDS.whatsappChannel;
const board = (t: TestApp, eventId: string = EVT_R1, as: string = 'SUP-R') =>
  t.get(`/v1/events/${eventId}/operations`, as);

/** mulberry32: a seeded PRNG so a failing sequence can be replayed. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** The reference of PNT-074 AC1: every board section recomputed with plain SQL over the tables. */
async function reference(t: TestApp, eventId: string) {
  const now = t.clock.now();
  const secs = (d: Date | null) =>
    d ? Math.max(0, Math.floor((now.getTime() - new Date(d).getTime()) / 1000)) : null;
  const tickets = await one(
    t.db,
    `SELECT count(*) FILTER (WHERE status IN ('requested','assigned','assigned_waiting','retrieving'))::int AS open_requests,
            count(*) FILTER (WHERE status = 'parked')::int AS vehicles_parked,
            count(*) FILTER (WHERE status = 'ready')::int AS ready_waiting
       FROM tickets WHERE event_id = $1`,
    [eventId],
  );
  const oldest = await one(
    t.db,
    `SELECT min(priority_at) AS m FROM tasks WHERE event_id = $1 AND type = 'retrieve' AND status IN ('queued','offered','broadcast')`,
    [eventId],
  );
  const acc = await one(
    t.db,
    `SELECT avg(EXTRACT(EPOCH FROM (claimed_at - queued_at))) AS a FROM tasks
      WHERE event_id = $1 AND type = 'retrieve' AND claimed_at > $2 AND claimed_at <= $3 AND queued_at IS NOT NULL`,
    [eventId, new Date(now.getTime() - 30 * 60_000), now],
  );
  const drivers = await rows(
    t.db,
    `SELECT ds.user_id,
            CASE WHEN ds.status = 'on_break' THEN 'on_break'
                 WHEN EXISTS (SELECT 1 FROM tasks k WHERE k.assignee_id = ds.user_id AND k.status IN ('accepted','in_progress'))
                  AND EXISTS (SELECT 1 FROM tasks k WHERE k.assignee_id = ds.user_id AND k.status = 'assigned_waiting') THEN 'busy_with_next'
                 WHEN EXISTS (SELECT 1 FROM tasks k WHERE k.assignee_id = ds.user_id AND k.status IN ('accepted','in_progress') AND k.type <> 'retrieve') THEN 'intake_parking'
                 WHEN EXISTS (SELECT 1 FROM tasks k WHERE k.assignee_id = ds.user_id AND k.status IN ('accepted','in_progress')) THEN 'retrieving'
                 ELSE 'available' END AS driver_state
       FROM duty_sessions ds WHERE ds.dispatch_pool_id = $1 AND ds.status <> 'ended' ORDER BY ds.user_id`,
    [POOL_R],
  );
  const queue = await rows(
    t.db,
    `SELECT k.id, k.status, k.queued_at, k.escalated_at, k.assigned_waiting_at, c.requested_at
       FROM tasks k JOIN retrieval_cycles c ON c.id = k.cycle_id
      WHERE k.event_id = $1 AND k.type = 'retrieve' AND k.status IN ('queued','offered','broadcast','assigned_waiting')
      ORDER BY k.priority_at, k.seq`,
    [eventId],
  );
  const tasksIn = (statuses: string[]) =>
    rows(
      t.db,
      `SELECT id FROM tasks WHERE event_id = $1 AND status = ANY($2::text[]) ORDER BY priority_at, seq`,
      [eventId, statuses],
    ).then((r) => r.map((x) => x.id));
  const count = (states: string[]) => drivers.filter((d) => states.includes(d.driver_state)).length;
  return {
    kpis: {
      open_requests: tickets.open_requests,
      oldest_wait_seconds: secs(oldest.m),
      avg_accept_seconds_30m: acc.a == null ? null : Math.round(Number(acc.a) * 10) / 10,
      drivers_available: count(['available']),
      drivers_busy: count(['intake_parking', 'retrieving', 'busy_with_next']),
      drivers_on_break: count(['on_break']),
      drivers_on_duty: drivers.length,
      vehicles_parked: tickets.vehicles_parked,
      ready_waiting: tickets.ready_waiting,
    },
    queue: queue.map((q) => ({
      task_id: q.id,
      status: q.status,
      waiting_seconds: secs(q.requested_at),
      badges:
        q.status === 'assigned_waiting'
          ? secs(q.assigned_waiting_at)! >= 300
            ? ['long_wait']
            : []
          : q.escalated_at || secs(q.queued_at)! >= 60
            ? ['late']
            : [],
    })),
    active: await tasksIn(['accepted', 'in_progress']),
    next: await tasksIn(['assigned_waiting']),
    drivers: Object.fromEntries(drivers.map((d) => [d.user_id, d.driver_state])),
  };
}

function project(b: any) {
  return {
    kpis: b.kpis,
    queue: b.queue.map((q: any) => ({
      task_id: q.task_id,
      status: q.status,
      waiting_seconds: q.waiting_seconds,
      badges: q.badges,
    })),
    active: b.active_tasks.map((c: any) => c.task.id),
    next: b.next_tasks.map((c: any) => c.task.id),
    drivers: Object.fromEntries(b.drivers.map((d: any) => [d.driver.id, d.driver_state])),
  };
}

describe('PNT-074 — GET /v1/events/{eventId}/operations', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
  });
  afterEach(async () => t.close());

  it('AC1: the board equals a reference SQL query after 200 random operations', async () => {
    const drivers = ['DRV1', 'DRV2', 'DRV3', 'DRV4', 'DRV5', 'DRV6'];
    for (const d of drivers) {
      ok(await startDuty(t, d), 201);
      t.clock.advanceSeconds(3);
    }
    const worker = supervisorWorker(t, { handlers: dispatchJobs() });
    const rnd = prng(0x5eed074);
    const pick = <T>(xs: T[]): T | undefined => (xs.length ? xs[Math.floor(rnd() * xs.length)] : undefined);
    const idOf = (key: string) => (U as Record<string, string>)[key]!;
    const keyOf = (id: string) => drivers.find((d) => idOf(d) === id)!;
    let serial = 1;
    const counts: Record<string, number> = {};

    const freeSpot = async () =>
      (
        await one(
          t.db,
          `SELECT s.id FROM parking_spots s WHERE s.venue_id = $1 AND s.status = 'active'
              AND NOT EXISTS (SELECT 1 FROM spot_allocations a WHERE a.parking_spot_id = s.id AND a.released_at IS NULL)
            ORDER BY s.label LIMIT 1`,
          [RMS],
        )
      ).id;
    const freeSlot = async () =>
      (
        await one(
          t.db,
          `SELECT k.id FROM key_slots k WHERE k.venue_id = $1 AND k.status = 'active'
              AND NOT EXISTS (SELECT 1 FROM key_slot_allocations a WHERE a.key_slot_id = k.id AND a.released_at IS NULL)
            ORDER BY k.label LIMIT 1`,
          [RMS],
        )
      ).id;
    const states = async () =>
      Object.fromEntries(
        (
          await rows(
            t.db,
            `SELECT user_id, driver_state, duty_status FROM v_driver_state WHERE dispatch_pool_id = $1`,
            [POOL_R],
          )
        ).map((r) => [r.user_id, r]),
      );

    const ops: Record<string, () => Promise<boolean>> = {
      intake: async () => {
        const s = await states();
        const who = pick(drivers.filter((d) => s[idOf(d)]?.driver_state === 'available'));
        if (!who) return false;
        const eventId = rnd() < 0.7 ? EVT_R1 : EVT_R2;
        const d = await newDraft(t, who, eventId);
        const p = ok(
          await patchIntake(t, who, d.ticketId, {
            expected_version: d.version,
            ...PAPER_DRAFT(`R-${serial}`, `RK-${serial++}`),
          }),
        );
        await addPhotos(t.db, d.ticketId, idOf(who));
        ok(await submitIntake(t, who, d.ticketId, { expected_version: p.version }));
        return true;
      },
      park: async () => {
        const k = pick(
          await rows(
            t.db,
            `SELECT id, assignee_id FROM tasks WHERE type IN ('park','repark') AND status = 'in_progress' AND event_id = ANY($1)`,
            [[EVT_R1, EVT_R2]],
          ),
        );
        if (!k) return false;
        const tk = await one(
          t.db,
          `SELECT t.status FROM tickets t JOIN tasks k ON k.ticket_id = t.id WHERE k.id = $1`,
          [k.id],
        );
        if (tk.status !== 'parking') return false;
        ok(
          await completeParking(t, keyOf(k.assignee_id), k.id, {
            parking_spot_id: await freeSpot(),
            key_slot_id: await freeSlot(),
          }),
        );
        return true;
      },
      request: async () => {
        const tk = pick(
          await rows(t.db, `SELECT id FROM tickets WHERE status = 'parked' AND venue_id = $1`, [RMS]),
        );
        if (!tk) return false;
        ok(await requestRetrieval(t, 'SUP-R', tk.id), 201);
        return true;
      },
      broadcast: async () => {
        const k = pick(
          await rows(
            t.db,
            `SELECT id FROM tasks WHERE type = 'retrieve' AND status = 'queued' AND venue_id = $1`,
            [RMS],
          ),
        );
        if (!k) return false;
        await openBroadcastBySql(t.db, k.id);
        return true;
      },
      accept: async () => {
        const r = pick(
          await rows(
            t.db,
            `SELECT o.id, r.user_id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id
              WHERE o.status = 'active' AND o.dispatch_pool_id = $1 AND r.eligible_as IN ('accept','reserve_next')`,
            [POOL_R],
          ),
        );
        if (!r) return false;
        const res = await accept(t, keyOf(r.user_id), r.id);
        expect(res.status).toBeLessThan(500);
        return res.status === 200;
      },
      pickup: async () => {
        const k = pick(
          await rows(
            t.db,
            `SELECT k.id, k.assignee_id, t.current_key_slot_id FROM tasks k JOIN tickets t ON t.id = k.ticket_id
              WHERE k.type = 'retrieve' AND k.status = 'accepted' AND k.key_picked_up_at IS NULL AND t.venue_id = $1`,
            [RMS],
          ),
        );
        if (!k) return false;
        ok(await keyPickup(t, keyOf(k.assignee_id), k.id, k.current_key_slot_id));
        return true;
      },
      start: async () => {
        const k = pick(
          await rows(
            t.db,
            `SELECT id, assignee_id FROM tasks WHERE type = 'retrieve' AND status = 'accepted' AND key_picked_up_at IS NOT NULL AND venue_id = $1`,
            [RMS],
          ),
        );
        if (!k) return false;
        ok(await startRetrieval(t, keyOf(k.assignee_id), k.id));
        return true;
      },
      ready: async () => {
        const k = pick(
          await rows(
            t.db,
            `SELECT k.id, k.assignee_id FROM tasks k JOIN tickets t ON t.id = k.ticket_id
              WHERE k.type = 'retrieve' AND k.status = 'in_progress' AND t.status = 'retrieving' AND t.venue_id = $1`,
            [RMS],
          ),
        );
        if (!k) return false;
        ok(await markReady(t, keyOf(k.assignee_id), k.id));
        return true;
      },
      handover: async () => {
        const k = pick(
          await rows(
            t.db,
            `SELECT t.id, t.paper_serial, t.fee_halalas, t.payment_status, k.assignee_id FROM tickets t
               JOIN tasks k ON k.ticket_id = t.id AND k.status = 'in_progress' WHERE t.status = 'ready' AND t.venue_id = $1`,
            [RMS],
          ),
        );
        if (!k || k.payment_status === 'due') return false; // collection is the payments module's (PNT-080)
        ok(
          await handover(t, keyOf(k.assignee_id), k.id, {
            verification: { method: 'paper_stub', paper_serial: k.paper_serial },
          }),
        );
        return true;
      },
      break: async () => {
        const s = await states();
        const who = pick(drivers.filter((d) => ['available', 'on_break'].includes(s[idOf(d)]?.driver_state)));
        if (!who) return false;
        const active = s[idOf(who)]!.driver_state === 'available';
        const res = await t.command('post', '/v1/me/duty/break', { as: who, body: { active } });
        expect(res.status).toBeLessThan(500);
        return res.status === 200;
      },
      tick: async () => {
        t.clock.advanceSeconds(5 + Math.floor(rnd() * 400));
        await worker.drain();
        return true;
      },
    };
    const weights: [string, number][] = [
      ['intake', 4],
      ['park', 4],
      ['request', 4],
      ['broadcast', 1],
      ['accept', 4],
      ['pickup', 3],
      ['start', 3],
      ['ready', 3],
      ['handover', 3],
      ['break', 1],
      ['tick', 3],
    ];
    const total = weights.reduce((s, [, w]) => s + w, 0);
    const choose = () => {
      let x = rnd() * total;
      for (const [name, w] of weights) if ((x -= w) < 0) return name;
      return 'tick';
    };
    for (let i = 1; i <= 200; i++) {
      const name = choose();
      if (await ops[name]!()) counts[name] = (counts[name] ?? 0) + 1;
      if (i % 25 === 0) {
        for (const eventId of [EVT_R1, EVT_R2]) {
          const b = ok(await board(t, eventId));
          expect({ step: i, eventId, ...project(b) }).toEqual({
            step: i,
            eventId,
            ...(await reference(t, eventId)),
          });
        }
        await expectConsistent(t.db);
      }
    }
    // the run exercised the whole lifecycle
    for (const op of ['intake', 'park', 'request', 'accept', 'pickup', 'start', 'ready', 'handover', 'tick'])
      expect(counts[op] ?? 0, op).toBeGreaterThan(0);
  });

  it('queue items: oldest first, waiting time, the live round with its recipient, escalation badges', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV2'), 201);
    const first = await parkedPaperTicket(t, 'DRV2');
    const second = await parkedPaperTicket(t, 'DRV2');
    ok(await t.command('post', '/v1/me/duty/break', { as: 'DRV2', body: { active: true } }));
    t.clock.advanceSeconds(1);
    const r1 = ok(await requestRetrieval(t, 'SUP-R', first.ticketId), 201);
    t.clock.advanceSeconds(2);
    const r2 = ok(await requestRetrieval(t, 'SUP-R', second.ticketId), 201); // nobody free: queued
    let b = ok(await board(t));
    expect(b.queue.map((q: any) => [q.task_id, q.status])).toEqual([
      [r1.task.id, 'offered'],
      [r2.task.id, 'queued'],
    ]);
    expect(b.queue[0]).toMatchObject({
      requested_at: r1.cycle.requested_at,
      waiting_seconds: 2,
      escalated_at: null,
      assignee: null,
      badges: [],
      ticket: { id: first.ticketId, display_number: first.displayNumber, status: 'requested' },
      offer: { mode: 'single', round_no: 1, recipients: 1, recipient: { id: U.DRV1 } },
    });
    expect(b.queue[1]).toMatchObject({ waiting_seconds: 0, offer: null, badges: [] });
    ok(await accept(t, 'DRV1', (await liveOffer(t.db, U.DRV1))!.id));
    t.clock.advanceSeconds(60);
    b = ok(await board(t));
    expect(b.queue.map((q: any) => [q.task_id, q.badges])).toEqual([[r2.task.id, ['late']]]); // 60 s in the queue
    expect(b.active_tasks.map((c: any) => c.task.id)).toEqual([r1.task.id]);
    expect(b.kpis).toMatchObject({ open_requests: 2, oldest_wait_seconds: 60, avg_accept_seconds_30m: 2 }); // KPI-01: queued → claimed
    // DRV1 reserves the second from a broadcast as his next task
    const bc = await openBroadcastBySql(t.db, r2.task.id);
    t.clock.advanceSeconds(4);
    expect(ok(await accept(t, 'DRV1', bc)).result).toBe('assigned_waiting');
    b = ok(await board(t));
    expect(b.queue.map((q: any) => [q.task_id, q.status, q.assignee?.id ?? null, q.badges])).toEqual([
      [r2.task.id, 'assigned_waiting', U.DRV1, []],
    ]);
    expect(b.next_tasks.map((c: any) => c.task.id)).toEqual([r2.task.id]);
    expect(b.drivers.find((d: any) => d.driver.id === U.DRV1)).toMatchObject({
      driver_state: 'busy_with_next',
      active_task_id: r1.task.id,
      next_task_id: r2.task.id,
    });
    expect(b.drivers.find((d: any) => d.driver.id === U.DRV2)).toMatchObject({ driver_state: 'on_break' });
    t.clock.advanceSeconds(300);
    b = ok(await board(t));
    expect(b.queue[0].badges).toEqual(['long_wait']);
    expect(b.next_tasks[0].badges).toEqual(['long_wait']);
    expect(b.kpis).toMatchObject({
      open_requests: 2,
      oldest_wait_seconds: null,
      avg_accept_seconds_30m: 33, // (2 + 64) / 2
      drivers_available: 0,
      drivers_busy: 1,
      drivers_on_break: 1,
      drivers_on_duty: 2,
    });
  });

  it('active tasks with «لم تُستلم»; alerts of the venue, most severe first; failed messages of the last 30 minutes; channel health', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV2'), 201);
    const a = await readyRetrieval(t);
    t.clock.advanceSeconds(600);
    let b = ok(await board(t));
    expect(b.event).toMatchObject({ id: EVT_R1, venue_id: RMS });
    expect(b.active_tasks).toHaveLength(1);
    expect(b.active_tasks[0]).toMatchObject({
      task: { id: a.retrieveTaskId, status: 'in_progress' },
      ticket: { status: 'ready' },
      badges: ['not_collected'],
    });
    expect(b.active_tasks[0].claim_code).toBeNull();
    expect(b.kpis).toMatchObject({ ready_waiting: 1, open_requests: 0 });
    // alerts: pool-wide and this event's, live only, critical first
    const warn = (
      await raise(t, {
        orgId: ORG,
        venueId: RMS,
        type: 'task_stuck',
        dedupeKey: 'task_stuck:x',
        eventId: EVT_R1,
      })
    ).alert;
    t.clock.advanceSeconds(1);
    const crit = (
      await raise(t, {
        orgId: ORG,
        venueId: RMS,
        type: 'no_drivers_on_duty',
        dedupeKey: 'no_drivers_on_duty:p',
        poolId: POOL_R,
      })
    ).alert;
    await raise(t, {
      orgId: ORG,
      venueId: RMS,
      type: 'draft_abandoned',
      dedupeKey: 'draft_abandoned:other',
      eventId: EVT_R2,
    });
    const gone = (
      await raise(t, { orgId: ORG, venueId: RMS, type: 'wa_send_failed', dedupeKey: 'wa_send_failed:y' })
    ).alert;
    await t.db.query(`UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE id = $1`, [gone.id]);
    await raise(t, {
      orgId: ORG,
      venueId: SEED_IDS.venues.LYL,
      type: 'task_stuck',
      dedupeKey: 'task_stuck:lyl',
    });
    // failed outbound messages: one now, one 31 minutes ago, one delivered
    const msg = (status: string, failedAt: Date | null) =>
      t.db.query(
        `INSERT INTO whatsapp_messages (org_id, channel_id, direction, ticket_id, venue_id, event_id, kind, purpose, body_redacted, status, status_rank,
                                        error_code, error_title, failed_at, queued_at, created_at, updated_at)
         VALUES ($1, $2, 'outbound', $3, $4, $5, 'template', 'W-04', 'جارٍ إحضار سيارتك', $6, 0, $7, $8, $9, $10, $10, $10) RETURNING id`,
        [
          ORG,
          CHANNEL,
          a.ticketId,
          RMS,
          EVT_R1,
          status,
          failedAt ? '131026' : null,
          failedAt ? 'Message undeliverable' : null,
          failedAt,
          t.clock.now(),
        ],
      );
    const recent = (await msg('failed', t.clock.now())).rows[0].id;
    await msg('failed', new Date(t.clock.now().getTime() - 31 * 60_000));
    await msg('delivered', null);
    b = ok(await board(t));
    expect(b.alerts.map((x: any) => x.id)).toEqual([crit.id, warn.id]);
    expect(b.failed_messages.map((m: any) => m.id)).toEqual([recent]);
    expect(b.failed_messages[0]).toMatchObject({
      purpose: 'W-04',
      status: 'failed',
      error_code: '131026',
      body_redacted: 'جارٍ إحضار سيارتك',
    });
    expect(b.channel_health).toBe('healthy');
    await t.db.query(`UPDATE whatsapp_channel SET health_status = 'down' WHERE id = $1`, [CHANNEL]);
    expect(ok(await board(t)).channel_health).toBe('down');
  });

  it('custody issues: a driver offline with a key, an unknown holder, an abandoned draft — not a normal movement', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV2'), 201);
    ok(await startDuty(t, 'DRV3'), 201);
    const a = await assignedRetrieval(t);
    ok(await keyPickup(t, 'DRV1', a.retrieveTaskId, a.slotId));
    const lost = await parkedPaperTicket(t, 'DRV2');
    ok(
      await t.command('post', `/v1/tickets/${lost.ticketId}/custody-transfers`, {
        as: 'SUP-R',
        body: { subject: 'key', to_holder_type: 'unknown', reason: 'المفتاح غير موجود في الخانة' },
      }),
      201,
    );
    const draft = await newDraft(t, 'DRV3');
    let b = ok(await board(t));
    // DRV1 online with his task's key: normal; the unknown key is an issue
    expect(b.custody_issues.map((c: any) => [c.ticket.id, c.subject, c.holder.type])).toEqual([
      [lost.ticketId, 'key', 'unknown'],
    ]);
    expect(b.custody_issues[0].since).toBe(t.clock.now().toISOString());
    await t.db.query(
      `UPDATE duty_sessions SET connection_state = 'offline' WHERE user_id = $1 AND status <> 'ended'`,
      [U.DRV1],
    );
    t.clock.advanceSeconds(600); // the draft is now abandoned (intake.draft_abandoned_alert_min = 10)
    b = ok(await board(t));
    const issues = b.custody_issues.map((c: any) => [c.ticket.id, c.subject, c.holder.type, c.holder.id]);
    expect(issues).toEqual(
      expect.arrayContaining([
        [a.ticketId, 'key', 'driver', U.DRV1],
        [lost.ticketId, 'key', 'unknown', null],
        [draft.ticketId, 'vehicle', 'driver', U.DRV3],
        [draft.ticketId, 'key', 'driver', U.DRV3],
      ]),
    );
    expect(issues).toHaveLength(4);
    expect(b.custody_issues.find((c: any) => c.ticket.id === a.ticketId).holder.label).toEqual(
      expect.any(String),
    );
  });

  it('scope: an event outside the venues is RESOURCE_NOT_FOUND; drivers have no alert.read', async () => {
    expect(err(await board(t, EVT_L1), 'RESOURCE_NOT_FOUND', 404)).toEqual({ resource: 'event' });
    err(await board(t, DUMMY), 'RESOURCE_NOT_FOUND', 404);
    err(await board(t, 'nope'), 'RESOURCE_NOT_FOUND', 404);
    err(await board(t, EVT_R1, 'DRV1'), 'PERMISSION_DENIED', 403);
    expect(ok(await board(t, EVT_L1, 'SUP-RL')).event.id).toBe(EVT_L1);
    expect(ok(await board(t, EVT_L1, 'ADM1')).event.id).toBe(EVT_L1);
    const empty = ok(await board(t, EVT_R1, 'OWN1'));
    expect(empty).toMatchObject({
      queue: [],
      active_tasks: [],
      next_tasks: [],
      drivers: [],
      failed_messages: [],
      custody_issues: [],
      kpis: { open_requests: 0, oldest_wait_seconds: null, avg_accept_seconds_30m: null, drivers_on_duty: 0 },
    });
  });
});
