import {
  createLogger,
  dispatchJobs,
  OutboxDispatcher,
  ticketsCustodyJobs,
  useCasesJobs,
  type JobHandler,
} from '@point/server';
import pg from 'pg';
import type { TestApp } from './harness.js';
import {
  accept,
  completeParking,
  liveOffer,
  newDraft,
  nextSlot,
  nextSpot,
  ok,
  one,
  paperTicketInParking,
  parkedPaperTicket,
  requestRetrieval,
  rows,
  startDuty,
  U,
  type Res,
} from './dispatch-fixtures.js';

/**
 * S4 fixtures (PNT-052 … PNT-063, PNT-084, PNT-086): the worker with the dispatch, tickets-custody and use-case
 * timers, a capture of the realtime publications (LISTEN on the test database's `point_realtime`), and the
 * supervisor commands of the dispatch engine.
 */

export function s4Worker(t: TestApp, extra: JobHandler[] = []): OutboxDispatcher {
  const w = new OutboxDispatcher(t.db, t.clock, createLogger({ level: 'silent' }), {
    workerId: `test-worker-${Math.random().toString(36).slice(2, 8)}`,
  });
  for (const h of [...dispatchJobs(), ...ticketsCustodyJobs(), ...useCasesJobs(), ...extra]) w.register(h);
  return w;
}

export interface Published {
  org_id: string;
  rooms: string[];
  message: {
    event: string;
    id: string;
    aggregate?: { type: string; id: string; version: number | null };
    data: Record<string, any>;
    venue_id?: string | null;
    dispatch_pool_id?: string | null;
  };
}

/** Every realtime publication of the test database, in NOTIFY order (DEC-48: published at COMMIT only). */
export async function captureRealtime(t: TestApp) {
  const c = new pg.Client({ connectionString: t.tdb.url });
  // the test database is dropped at the end of the test: a still-open listener must not crash the run
  c.on('error', () => {});
  await c.connect();
  await c.query('LISTEN point_realtime');
  const all: Published[] = [];
  c.on('notification', (n) => {
    if (n.payload) all.push(JSON.parse(n.payload));
  });
  return {
    all,
    /** waits until no new publication arrives for 40 ms (notifications are delivered after the response) */
    async settle(): Promise<Published[]> {
      let n = -1;
      for (let i = 0; i < 25 && n !== all.length; i++) {
        n = all.length;
        await new Promise((r) => setTimeout(r, 40));
      }
      return all;
    },
    of(event: string, room?: string): Published[] {
      return all.filter((m) => m.message.event === event && (!room || m.rooms.includes(room)));
    },
    clear() {
      all.length = 0;
    },
    async stop() {
      await c.end();
    },
  };
}

export const reassign = (
  t: TestApp,
  as: string,
  taskId: string,
  body: Record<string, unknown>,
): Promise<Res> => t.command('post', `/v1/tasks/${taskId}/reassign`, { as, body });

export const releaseCustody = (
  t: TestApp,
  as: string,
  taskId: string,
  body: Record<string, unknown>,
): Promise<Res> => t.command('post', `/v1/tasks/${taskId}/release-custody`, { as, body });

export const cancelCycle = (
  t: TestApp,
  as: string,
  cycleId: string,
  reason = 'العميل ألغى الطلب',
): Promise<Res> => t.command('post', `/v1/retrieval-cycles/${cycleId}/cancel`, { as, body: { reason } });

export const repark = (
  t: TestApp,
  as: string,
  ticketId: string,
  body: Record<string, unknown> = { reason: 'العميل لم يحضر' },
): Promise<Res> => t.command('post', `/v1/tickets/${ticketId}/repark`, { as, body });

export const forceEnd = (t: TestApp, as: string, sessionId: string, reason = 'انقطع السائق'): Promise<Res> =>
  t.command('post', `/v1/duty-sessions/${sessionId}/force-end`, { as, body: { reason } });

export const transfer = (
  t: TestApp,
  as: string,
  driverId: string,
  body: Record<string, unknown>,
): Promise<Res> => t.command('post', `/v1/drivers/${driverId}/transfers`, { as, body });

export const brk = (t: TestApp, as: string, active: boolean): Promise<Res> =>
  t.command('post', '/v1/me/duty/break', { as, body: { active } });

export const endDuty = (t: TestApp, as: string): Promise<Res> =>
  t.command('post', '/v1/me/duty/end', { as, body: {} });

/** The live single round of a driver (unambiguous when he is also a broadcast recipient). */
export async function liveSingle(t: TestApp, user: string): Promise<{ id: string; task_id: string } | null> {
  const r = await t.db.query<{ id: string; task_id: string }>(
    `SELECT o.id, o.task_id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id
      WHERE r.user_id = $1 AND o.status = 'active' AND o.mode = 'single'`,
    [(U as Record<string, string>)[user] ?? user],
  );
  return r.rows[0] ?? null;
}

/** The open duty session id of a user. */
export async function dutyId(t: TestApp, user: string): Promise<string> {
  return (
    await one<{ id: string }>(t.db, `SELECT id FROM duty_sessions WHERE user_id = $1 AND status <> 'ended'`, [
      (U as Record<string, string>)[user] ?? user,
    ])
  ).id;
}

/** A parked paper ticket (by `parker`) whose retrieval SUP-R requested; returns its ids. */
export async function requestedTicket(t: TestApp, parker = 'DRV1') {
  const p = await parkedPaperTicket(t, parker);
  t.clock.advanceSeconds(1);
  const r = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
  return { ...p, retrieveTaskId: r.task.id as string, cycleId: r.cycle.id as string, status: r.task.status };
}

/** DRV3 longest idle, then DRV2, then DRV1. */
export async function threeDrivers(t: TestApp) {
  ok(await startDuty(t, 'DRV3'), 201);
  t.clock.advanceSeconds(10);
  ok(await startDuty(t, 'DRV2'), 201);
  t.clock.advanceSeconds(10);
  ok(await startDuty(t, 'DRV1'), 201);
}

/** A WhatsApp-linked customer on the ticket, so the NotificationPlanner plans its W-xx (12 §5.2). */
export async function linkWhatsapp(t: TestApp, ticketId: string): Promise<string> {
  const c = await one<{ id: string }>(
    t.db,
    `INSERT INTO customers (org_id, phone_e164)
     SELECT org_id, '+9665' || lpad((floor(random() * 1e8))::bigint::text, 8, '0') FROM tickets WHERE id = $1
     RETURNING id`,
    [ticketId],
  );
  await t.db.query(
    `UPDATE tickets SET channel = 'whatsapp', customer_id = $2, wa_link_status = 'linked' WHERE id = $1`,
    [ticketId, c.id],
  );
  return c.id;
}

export const whatsappNotifications = (t: TestApp, ticketId: string) =>
  rows<{ purpose: string; dedupe_key: string }>(
    t.db,
    `SELECT purpose, dedupe_key FROM notifications WHERE ticket_id = $1 AND channel = 'whatsapp' ORDER BY created_at, purpose`,
    [ticketId],
  );

/**
 * DRV1 recipient of two live broadcasts he can act on (reserve_next): every driver was busy with a next task when
 * T3 and T4 opened (view-only), then DRV1's parking completed and his next task was promoted (retrieving, no next).
 */
export async function twoLiveBroadcastsForDrv1(t: TestApp) {
  for (const d of ['DRV1', 'DRV2']) ok(await startDuty(t, d), 201);
  const p = [];
  for (let i = 0; i < 4; i++) p.push(await parkedPaperTicket(t, 'DRV1'));
  const draft = await paperTicketInParking(t, 'DRV1');
  await newDraft(t, 'DRV2');
  ok(await requestRetrieval(t, 'SUP-R', p[0]!.ticketId), 201);
  ok(await accept(t, 'DRV1', (await liveOffer(t.db, U.DRV1))!.id)); // DRV1 busy_with_next
  ok(await requestRetrieval(t, 'SUP-R', p[1]!.ticketId), 201);
  ok(await accept(t, 'DRV2', (await liveOffer(t.db, U.DRV2))!.id)); // DRV2 busy_with_next
  const r3 = ok(await requestRetrieval(t, 'SUP-R', p[2]!.ticketId), 201);
  t.clock.advanceSeconds(1);
  const r4 = ok(await requestRetrieval(t, 'SUP-R', p[3]!.ticketId), 201);
  ok(
    await completeParking(t, 'DRV1', draft.taskId, { parking_spot_id: nextSpot(), key_slot_id: nextSlot() }),
  );
  const offerOf = async (taskId: string) =>
    (
      await one<{ id: string }>(t.db, `SELECT id FROM task_offers WHERE task_id = $1 AND status = 'active'`, [
        taskId,
      ])
    ).id;
  return {
    older: { taskId: r3.task.id as string, offerId: await offerOf(r3.task.id), ticketId: p[2]!.ticketId },
    newer: { taskId: r4.task.id as string, offerId: await offerOf(r4.task.id), ticketId: p[3]!.ticketId },
    tickets: p,
  };
}
