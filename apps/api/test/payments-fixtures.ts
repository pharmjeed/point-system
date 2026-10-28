import { SEED_IDS } from '@point/db/seed';
import {
  createLogger,
  EXPORTS_STORAGE,
  OutboxDispatcher,
  paymentsReportsJobs,
  type InMemoryObjectStorage,
} from '@point/server';
import type { TestApp } from './harness.js';
import {
  accept,
  EVT_R2,
  handover,
  keyPickup,
  liveOffer,
  markReady,
  ok,
  parkedPaperTicket,
  requestRetrieval,
  startRetrieval,
  U,
  type Res,
} from './dispatch-fixtures.js';

/**
 * Fixtures of the payments-reports tests (PNT-080 … PNT-082, PNT-087 … PNT-089): per_vehicle tickets driven to
 * `ready` and delivered through the real S2 routes, the money commands, and a worker for `job.export_generate`.
 */
export const ORG = SEED_IDS.org;
export const FEE = 2000; // EVT-R2: per_vehicle, 2000 halalas, cash + pos (17 §4)
export const uid = (k: string): string => (U as Record<string, string>)[k] ?? k;

export const CASH = { method: 'cash', amount_halalas: FEE } as const;
export const POS = (ref = 'AP4821') => ({ method: 'pos', amount_halalas: FEE, pos_reference: ref });

export interface ReadyTicket {
  ticketId: string;
  displayNumber: number;
  serial: string;
  spotId: string;
  slotId: string;
  retrieveTaskId: string;
  cycleId: string;
  version: number;
}

/**
 * A paper ticket of `eventId` (EVT-R2 by default) taken in and parked by `driver`, requested on behalf by
 * `requester`, accepted by `driver` (the only available driver of the pool, or the longest idle) and brought to
 * `ready`: the S2 path of the handover.
 */
export async function readyTicket(
  t: TestApp,
  driver: string,
  opts: { eventId?: string; requester?: string } = {},
): Promise<ReadyTicket> {
  const p = await parkedPaperTicket(t, driver, { eventId: opts.eventId ?? EVT_R2 });
  const r = ok(await requestRetrieval(t, opts.requester ?? 'SUP-R', p.ticketId), 201);
  const offer = await liveOffer(t.db, uid(driver));
  if (!offer || offer.task_id !== r.task.id) throw new Error(`the retrieval was not offered to ${driver}`);
  ok(await accept(t, driver, offer.id));
  ok(await keyPickup(t, driver, r.task.id, p.slotId));
  ok(await startRetrieval(t, driver, r.task.id));
  const ready = ok(await markReady(t, driver, r.task.id));
  return {
    ticketId: p.ticketId,
    displayNumber: p.displayNumber,
    serial: p.serial,
    spotId: p.spotId,
    slotId: p.slotId,
    retrieveTaskId: r.task.id,
    cycleId: r.cycle.id,
    version: ready.ticket.version,
  };
}

export const pay = (t: TestApp, as: string, ticketId: string, body: unknown, key?: string): Promise<Res> =>
  t.command('post', `/v1/tickets/${ticketId}/payments`, { as, body, key });

export const waive = (t: TestApp, as: string, ticketId: string, body: unknown = {}): Promise<Res> =>
  t.command('post', `/v1/tickets/${ticketId}/payment-waiver`, { as, body });

export const reverse = (t: TestApp, as: string, paymentId: string, body: unknown): Promise<Res> =>
  t.command('post', `/v1/payments/${paymentId}/reverse`, { as, body });

export const cashHandover = (t: TestApp, as: string, body: unknown, key?: string): Promise<Res> =>
  t.command('post', '/v1/cash-handovers', { as, body, key });

export const deliver = (t: TestApp, driver: string, r: ReadyTicket, payment?: unknown): Promise<Res> =>
  handover(t, driver, r.ticketId, {
    verification: { method: 'paper_stub', paper_serial: r.serial },
    ...(payment === undefined ? {} : { payment }),
  });

/** ready → handover with the payment collected inline: a delivered ticket and its `recorded` payment. */
export async function deliveredWith(
  t: TestApp,
  driver: string,
  payment: unknown = CASH,
  opts: { eventId?: string; requester?: string } = {},
): Promise<ReadyTicket & { paymentId: string }> {
  const r = await readyTicket(t, driver, opts);
  const d = ok(await deliver(t, driver, r, payment));
  return { ...r, paymentId: d.payment.id, version: d.ticket.version };
}

/** `POST /v1/me/duty/break`: a driver on break receives no offer, so the next retrieval goes to the other one. */
export const onBreak = (t: TestApp, as: string, active: boolean): Promise<Res> =>
  t.command('post', '/v1/me/duty/break', { as, body: { active } });

export const settlement = async (t: TestApp, as: string, eventId: string) =>
  ok(await t.get(`/v1/events/${eventId}/settlement`, as));

let staffSeq = 0;
/** A supervisor whose only scope is LYL (the seed has none): RMS resources are outside his venues. */
export async function lylSupervisor(t: TestApp): Promise<string> {
  const k = staffSeq++;
  const r = await t.db.query<{ id: string }>(
    `INSERT INTO users (org_id, employee_code, full_name, phone_e164, role, secret_kind, secret_hash, must_change_secret)
     VALUES ($1, $2, $3, $4, 'supervisor', 'password', 'x', false) RETURNING id`,
    [ORG, `S-L${String(k).padStart(3, '0')}`, `مشرف ليلتي ${k}`, `+9665${String(80000000 + k)}`],
  );
  const id = r.rows[0]!.id;
  await t.db.query(
    `INSERT INTO role_scopes (org_id, user_id, scope_type, venue_id, granted_by) VALUES ($1, $2, 'venue', $3, $4)`,
    [ORG, id, SEED_IDS.venues.LYL, U.ADM1],
  );
  return id;
}

export const startClosing = (t: TestApp, as: string, eventId: string, body: unknown = {}): Promise<Res> =>
  t.command('post', `/v1/events/${eventId}/start-closing`, { as, body });

export const closeEvent = (t: TestApp, as: string, eventId: string, body: unknown = {}): Promise<Res> =>
  t.command('post', `/v1/events/${eventId}/close`, { as, body });

/** A dispatcher running only `job.export_generate` against the api's exports storage (in memory in tests). */
export function exportsWorker(t: TestApp) {
  const storage = t.app.get<InMemoryObjectStorage>(EXPORTS_STORAGE);
  const worker = new OutboxDispatcher(t.db, t.clock, createLogger({ level: 'silent' }), {
    workerId: 'test-exports',
  });
  for (const h of paymentsReportsJobs({ storage })) worker.register(h);
  return { worker, storage };
}
