import {
  createLogger,
  incidentsProjectors,
  OutboxDispatcher,
  raiseAlert,
  ticketsCustodyJobs,
  type RaiseAlertInput,
} from '@point/server';
import { SEED_IDS } from '@point/db/seed';
import pg from 'pg';
import { expect } from 'vitest';
import type { TestApp } from './harness.js';
import {
  accept,
  addPhotos,
  completeParking,
  handover,
  keyPickup,
  liveOffer,
  markReady,
  newDraft,
  nextSlot,
  nextSpot,
  ok,
  parkedPaperTicket,
  patchIntake,
  requestRetrieval,
  startRetrieval,
  submitIntake,
  U,
} from './dispatch-fixtures.js';

/**
 * Shared fixtures of the S6 supervisor backend tests (PNT-074 … PNT-085): alerts raised through the core writer,
 * a worker draining the incidents projectors and the tickets-custody timers, a realtime listener and the
 * retrieval steps up to `ready` / `delivered`.
 */

export const DUMMY = '00000000-0000-4000-8000-0000deadbeef';
export const ORG = SEED_IDS.org;

export const raise = (t: TestApp, a: RaiseAlertInput) => t.db.transaction((tx) => raiseAlert(tx, a));

let workerSeq = 0;
/** A worker with the handlers and projectors this slice owns (plus any extra the test needs). */
export function supervisorWorker(t: TestApp, extra: { handlers?: any[]; projectors?: any[] } = {}) {
  const w = new OutboxDispatcher(t.db, t.clock, createLogger({ level: 'silent' }), {
    workerId: `s6-worker-${workerSeq++}`,
  });
  for (const h of [...ticketsCustodyJobs(), ...(extra.handlers ?? [])]) w.register(h);
  for (const p of [...incidentsProjectors(), ...(extra.projectors ?? [])]) w.registerProjector(p);
  return w;
}

export interface RealtimeNote {
  org_id: string;
  rooms: string[];
  message: { event: string; id: string; data: Record<string, any>; venue_id?: string | null };
}

/** LISTEN point_realtime on the test database (the frames each api instance would relay, DEC-48). */
export async function realtimeListener(t: TestApp) {
  const notes: RealtimeNote[] = [];
  const client = new pg.Client({ connectionString: t.tdb.url });
  await client.connect();
  client.on('notification', (n) => {
    if (n.channel === 'point_realtime' && n.payload) notes.push(JSON.parse(n.payload));
  });
  await client.query('LISTEN point_realtime');
  return {
    notes,
    settle: () => new Promise((r) => setTimeout(r, 60)),
    clear: () => notes.splice(0, notes.length),
    close: () => client.end(),
  };
}

/** A paper ticket parked by `parker`, retrieval requested by SUP-R and accepted by `driver`. */
export async function assignedRetrieval(
  t: TestApp,
  opts: { parker?: string; driver?: string; eventId?: string } = {},
) {
  const parker = opts.parker ?? 'DRV2';
  const driver = opts.driver ?? 'DRV1';
  const p = await parkedPaperTicket(t, parker, { eventId: opts.eventId });
  t.clock.advanceSeconds(1);
  const r = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
  const driverId = (U as Record<string, string>)[driver] ?? driver;
  const offer = await liveOffer(t.db, driverId);
  expect(offer?.task_id).toBe(r.task.id);
  ok(await accept(t, driver, offer!.id));
  return { ...p, retrieveTaskId: r.task.id as string, cycleId: r.cycle.id as string, driver, driverId };
}

/** … then key pickup, start and ready. */
export async function readyRetrieval(
  t: TestApp,
  opts: { parker?: string; driver?: string; eventId?: string } = {},
) {
  const a = await assignedRetrieval(t, opts);
  ok(await keyPickup(t, a.driver, a.retrieveTaskId, a.slotId));
  ok(await startRetrieval(t, a.driver, a.retrieveTaskId));
  ok(await markReady(t, a.driver, a.retrieveTaskId));
  return a;
}

/** … then the paper-stub handover: the ticket is `delivered`. */
export async function deliveredTicket(
  t: TestApp,
  opts: { parker?: string; driver?: string; eventId?: string } = {},
) {
  const a = await readyRetrieval(t, opts);
  ok(
    await handover(t, a.driver, a.ticketId, {
      verification: { method: 'paper_stub', paper_serial: a.serial },
    }),
  );
  return a;
}

export async function auditRows(t: TestApp, action: string, entityId?: string) {
  return (
    await t.db.query(
      `SELECT * FROM audit_log WHERE action = $1 AND ($2::uuid IS NULL OR entity_id = $2::uuid) ORDER BY occurred_at, id`,
      [action, entityId ?? null],
    )
  ).rows;
}

let tagSeq = 500;
/**
 * A WhatsApp ticket with the customer's phone and the staff-confirmed consent, submitted to `parking` (the W-01
 * link itself is the whatsapp module's flow); `park: true` completes the parking in a fresh spot and slot.
 */
export async function whatsappTicket(
  t: TestApp,
  driver: string,
  opts: { phone?: string; eventId?: string; park?: boolean } = {},
) {
  const d = await newDraft(t, driver, opts.eventId);
  const p = ok(
    await patchIntake(t, driver, d.ticketId, {
      expected_version: d.version,
      plate: { digits: String(2000 + (tagSeq % 7000)).slice(0, 4), letters_ar: 'س ص ع' },
      vehicle: { make: 'هيونداي', model: 'سوناتا', color: 'رمادي', type: 'sedan' },
      customer_phone: opts.phone ?? '0551234567',
      consent: { method: 'verbal_staff_confirmed', confirmed: true },
      key_tag: `W-${tagSeq++}`,
    }),
  );
  await addPhotos(t.db, d.ticketId, (U as Record<string, string>)[driver] ?? driver);
  const s = ok(await submitIntake(t, driver, d.ticketId, { expected_version: p.version }));
  if (!opts.park) return { ...d, version: s.version as number, spotId: null, slotId: null };
  const spotId = nextSpot();
  const slotId = nextSlot();
  const r = ok(await completeParking(t, driver, d.taskId, { parking_spot_id: spotId, key_slot_id: slotId }));
  return { ...d, version: r.ticket.version as number, spotId, slotId };
}
