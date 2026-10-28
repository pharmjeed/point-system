import { seedKeySlotId, seedSpotId } from '@point/db/seed';
import { dispatchJobs, ticketsCustodyJobs } from '@point/server';
import type { OutboundMessage } from '../../../tools/wa-simulator/src/index.js';
import {
  addPhotos,
  completeParking,
  createDrivers,
  EVT_L1,
  EVT_R1,
  newDraft,
  ok,
  PAPER_DRAFT,
  LYL,
  patchIntake,
  RMS,
  startDuty,
  submitIntake,
  U,
  type Res,
} from './dispatch-fixtures.js';
import { createWaTestApp, type WaTestApp } from './wa-harness.js';

/**
 * S3 customer-flow harness (PNT-043 … PNT-051, PNT-078): the WhatsApp harness (api on a port, simulator,
 * worker dispatcher on the FakeClock) plus the dispatch and tickets-custody jobs, synced templates, the
 * wa.me display number, and the HTTP steps of a WhatsApp ticket.
 */
export interface CustomerApp extends WaTestApp {
  /** clock seconds for simulator timestamps */
  now(): number;
}

export const DISPLAY_PHONE = '+966500000999';

export async function createCustomerApp(opts: { env?: Record<string, string> } = {}): Promise<CustomerApp> {
  const w = await createWaTestApp({ env: { WA_DISPLAY_PHONE_E164: DISPLAY_PHONE, ...(opts.env ?? {}) } });
  for (const h of [...dispatchJobs(), ...ticketsCustodyJobs()]) w.dispatcher.register(h);
  (w.db.config as { lockTimeoutMs?: number }).lockTimeoutMs = 20000;
  (w.app.getHttpServer() as { setMaxListeners(n: number): unknown }).setMaxListeners(64);
  await w.syncTemplates();
  return Object.assign(w, { now: () => w.ts() });
}

let seq = 0;
const nextSeq = () => ++seq;

export interface WaTicket {
  ticketId: string;
  taskId: string;
  displayNumber: number;
  version: number;
  phone: string;
}

/** Intake of a WhatsApp ticket up to `parking` with phone + verbal consent (the submit links directly). */
export async function whatsappTicket(
  w: CustomerApp,
  as: keyof typeof U | string,
  phone: string,
  opts: { venue?: 'RMS' | 'LYL'; submit?: boolean } = {},
): Promise<WaTicket & { submit: Res | null }> {
  const n = nextSeq();
  const d = await newDraft(w, as as string, opts.venue === 'LYL' ? EVT_L1 : EVT_R1);
  const p = ok(
    await patchIntake(w, as as string, d.ticketId, {
      expected_version: d.version,
      ...PAPER_DRAFT('X', `WK-${n}`, String(2000 + n)),
      channel: 'whatsapp',
      paper_serial: null,
      customer_phone: phone,
      consent: { method: 'verbal_staff_confirmed', confirmed: true },
    }),
  );
  await addPhotos(w.db, d.ticketId, (U as Record<string, string>)[as as string] ?? (as as string));
  if (opts.submit === false)
    return {
      ticketId: d.ticketId,
      taskId: d.taskId,
      displayNumber: d.displayNumber,
      version: p.version,
      phone,
      submit: null,
    };
  const res = await submitIntake(w, as as string, d.ticketId, { expected_version: p.version });
  const version = res.status === 200 ? res.body.data.version : p.version;
  return {
    ticketId: d.ticketId,
    taskId: d.taskId,
    displayNumber: d.displayNumber,
    version,
    phone,
    submit: res,
  };
}

const spotN = { RMS: 0, LYL: 0 };
/** complete-parking with a fresh spot and key slot of the venue. */
export async function park(w: CustomerApp, as: string, taskId: string, venue: 'RMS' | 'LYL' = 'RMS') {
  const n = ++spotN[venue];
  const spot =
    venue === 'RMS'
      ? seedSpotId(`B-${String(n).padStart(2, '0')}`)
      : seedSpotId(`P1-${String(n).padStart(2, '0')}`);
  const slotId = seedKeySlotId(venue, venue === 'RMS' ? 30 + n : n);
  const r = ok(await completeParking(w, as, taskId, { parking_spot_id: spot, key_slot_id: slotId }));
  return { spot, slotId, version: r.ticket.version as number };
}

export async function onDuty(w: CustomerApp, ...drivers: string[]) {
  for (const d of drivers) ok(await startDuty(w, d), 201);
}

/**
 * A new driver of the venue, on duty (an intake keeps its driver busy until the car is parked, so tests that
 * open several tickets use one driver each).
 */
export async function freshDriver(w: CustomerApp, venue: 'RMS' | 'LYL' = 'RMS'): Promise<string> {
  // createDrivers' venue parameter is typed after its RMS default
  const [id] = await createDrivers(w.db, 1, (venue === 'RMS' ? RMS : LYL) as typeof RMS);
  ok(await startDuty(w, id!), 201);
  return id!;
}

/** Every outbound message the simulator recorded for a phone, oldest first. */
export async function messagesTo(w: CustomerApp, phone: string): Promise<OutboundMessage[]> {
  return (await w.sim.client.listMessages({ to: phone })).sort((a, b) => a.seq - b.seq);
}

export const purposes = async (w: CustomerApp, phone: string) =>
  (await messagesTo(w, phone)).map((m) => m.purpose);

/** `sent` + `delivered` for every accepted message without statuses yet (the per-ticket ordering gate). */
export async function deliverAll(w: CustomerApp, phone: string) {
  for (const m of await messagesTo(w, phone))
    if (m.statuses.length === 0)
      await w.sim.client.emitStatuses({ wamid: m.wamid, statuses: ['sent', 'delivered'], timestamp: w.ts() });
}

/**
 * Sends due work, delivers what the provider accepted (so the per-ticket ordering gate opens) and moves the
 * clock only to the next deferred `job.wa_send` (a few seconds at most), never to other timers.
 */
export async function settle(w: CustomerApp, phone: string) {
  for (let i = 0; i < 8; i++) {
    await w.drain();
    await deliverAll(w, phone);
    await w.drain();
    const next = (
      await w.db.query<{ at: Date | null }>(
        `SELECT min(available_at) AS at FROM outbox_events WHERE status = 'pending' AND type = 'job.wa_send' AND available_at > $1`,
        [w.clock.now()],
      )
    ).rows[0]?.at;
    if (!next || new Date(next).getTime() - w.clock.now().getTime() > 10_000) break;
    w.clock.set(new Date(next));
  }
}

/** The customer presses «طلب السيارة» of the W-01 of a ticket (the latest one to his phone by default). */
export function press(
  w: CustomerApp,
  phone: string,
  opts: {
    wamid?: string;
    from?: string;
    copies?: number;
    parallel?: number;
    duplicateMode?: 'same_body' | 'same_wamid' | 'distinct';
    payloadOverride?: string;
  } = {},
) {
  return w.sim.client.pressButton({
    ...(opts.wamid ? { wamid: opts.wamid } : { to: phone, purpose: 'W-01' }),
    from: opts.from ?? phone,
    timestamp: w.ts(),
    ...(opts.copies ? { copies: opts.copies } : {}),
    ...(opts.parallel ? { parallel: opts.parallel } : {}),
    ...(opts.duplicateMode ? { duplicateMode: opts.duplicateMode } : {}),
    ...(opts.payloadOverride ? { payloadOverride: opts.payloadOverride } : {}),
  });
}

export async function ticketRow(w: CustomerApp, id: string) {
  return (await w.db.query(`SELECT * FROM tickets WHERE id = $1`, [id])).rows[0];
}

export async function cyclesOf(w: CustomerApp, id: string) {
  return (await w.db.query(`SELECT * FROM retrieval_cycles WHERE ticket_id = $1 ORDER BY cycle_no`, [id]))
    .rows;
}

export async function tasksOf(w: CustomerApp, id: string) {
  return (await w.db.query(`SELECT * FROM tasks WHERE ticket_id = $1 ORDER BY created_at, id`, [id])).rows;
}

/**
 * The tables in which `needle` occurs in any column (leak checks of 17 H-04: raw action tokens, handover
 * codes). Every base table of the schema is scanned as text.
 */
export async function tablesContaining(w: CustomerApp, needle: string, pattern?: RegExp): Promise<string[]> {
  const tables = (
    await w.db.query<{ t: string }>(
      `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`,
    )
  ).rows.map((r) => r.t);
  const hits: string[] = [];
  for (const t of tables) {
    const rows = (
      await w.db.query<{ x: string }>(`SELECT x::text AS x FROM "${t}" x WHERE x::text LIKE $1`, [
        `%${needle}%`,
      ])
    ).rows;
    if (rows.some((r) => (pattern ? pattern.test(r.x) : true))) hits.push(t);
  }
  return hits;
}
