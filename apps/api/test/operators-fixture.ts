import { SEED_IDS, seedKeySlotId, seedSpotId, type SeedUserKey } from '@point/db/seed';
import {
  incidentsProjectors,
  InvoicingRuntime,
  invoicingJobs,
  issueDocument,
  OBJECT_STORAGE,
  paymentsReportsJobs,
  raiseAlert,
  EXPORTS_STORAGE,
  type Database,
  type InMemoryObjectStorage,
  type ObjectStorage,
} from '@point/server';
import { expect } from 'vitest';
import { createCustomerApp, press, settle, type CustomerApp } from './customer-harness.js';
import {
  accept,
  addPhotos,
  completeParking,
  handover,
  keyPickup,
  markReady,
  newDraft,
  ok,
  PAPER_DRAFT,
  patchIntake,
  requestRetrieval,
  rows,
  one,
  startDuty,
  startRetrieval,
  submitIntake,
} from './dispatch-fixtures.js';

/**
 * V2-007 (docs/v2/02 §1, 17 §9.1): two complete operators on one deployment. Operator A is the 17 §4 seed
 * (ORG1). Operator B is the same seed mirrored into a second `organizations` row: every seeded row is copied
 * with its id moved from the `…-4000-8000-…` space to `…-4000-9000-…` (so `B(SEED_IDS.venues.RMS)` is B's
 * «ريماس»), its own WhatsApp channel (same Meta app secret, its own phone number id, as several operators of one
 * platform app have) and staff phones of its own. Both are then driven through the same real routes
 * ({@link populate}): tickets in every state, a payment, a cash handover, an incident, an alert, a WhatsApp
 * ticket with its outbound messages and the customer's button press, photos, an export, a device, a transfer.
 */

/** Seed id → operator B's id (the 4th uuid group 8000 → 9000; the variant stays RFC 9562). */
export const toB = (id: string): string =>
  id.startsWith('00000000-0000-4000-8000-') ? `00000000-0000-4000-9000-${id.slice(24)}` : id;

export interface Operator {
  key: 'A' | 'B';
  org: string;
  /** the operator's copy of a seeded id */
  id(seedId: string): string;
  user(k: SeedUserKey): string;
  venue: string; // «ريماس»
  venue2: string; // «ليلتي»
  pool: string;
  pool2: string;
  event: string; // EVT-R1, included
  feeEvent: string; // EVT-R2, per_vehicle 2000
  event2: string; // EVT-L1
  shift: string;
  zone: string;
  board: string;
  spot(label: string): string;
  slot(n: number): string;
  phoneNumberId: string;
  /** resources created by {@link populate}, by name */
  r: Record<string, string>;
  /** the paper serial of each paper ticket (handover) */
  serials: Record<string, string>;
}

export function operator(key: 'A' | 'B'): Operator {
  const id = key === 'A' ? (x: string) => x : toB;
  return {
    key,
    org: id(SEED_IDS.org),
    id,
    user: (k) => id(SEED_IDS.users[k]),
    venue: id(SEED_IDS.venues.RMS),
    venue2: id(SEED_IDS.venues.LYL),
    pool: id(SEED_IDS.pools['POOL-R']),
    pool2: id(SEED_IDS.pools['POOL-L']),
    event: id(SEED_IDS.events['EVT-R1']),
    feeEvent: id(SEED_IDS.events['EVT-R2']),
    event2: id(SEED_IDS.events['EVT-L1']),
    shift: id(SEED_IDS.shifts['SHF-R']),
    zone: id(SEED_IDS.zones.RMS.A),
    board: id(SEED_IDS.keyBoards.RMS),
    spot: (label) => id(seedSpotId(label)),
    slot: (n) => id(seedKeySlotId('RMS', n)),
    phoneNumberId: key === 'A' ? 'SIM-PHONE' : 'SIM-PHONE-B',
    r: {},
    serials: {},
  };
}

/** Tables the 17 §4 seed fills, in foreign-key order (packages/db/src/seed). */
const SEEDED_TABLES = [
  'organizations',
  'venues',
  'dispatch_pools',
  'users',
  'role_scopes',
  'driver_assignments',
  'events',
  'shifts',
  'customers',
  'parking_zones',
  'parking_spots',
  'key_boards',
  'key_slots',
  'whatsapp_channel',
] as const;

/**
 * Copies every seeded row of operator A into operator B (ids through {@link toB}). Customers keep their phones —
 * the same person may be a customer of two operators — while the staff get B phones and B has its own channel.
 */
export async function seedOperatorB(db: Database): Promise<void> {
  const override: Record<string, Record<string, string>> = {
    organizations: { name_ar: `'المشغل الثاني'`, name_en: `'Second Operator'` },
    users: { phone_e164: `'+96651' || substr(phone_e164, 7)` },
    whatsapp_channel: { business_account_id: `'SIM-WABA-B'`, phone_number_id: `'SIM-PHONE-B'` },
  };
  await db.transaction(async (tx) => {
    for (const table of SEEDED_TABLES) {
      const cols = (
        await tx.query<{ column_name: string; data_type: string }>(
          `SELECT column_name, data_type FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER' AND is_identity = 'NO'
            ORDER BY ordinal_position`,
          [table],
        )
      ).rows;
      const expr = cols.map(({ column_name: c, data_type: type }) => {
        const o = override[table]?.[c];
        if (o) return o;
        if (type !== 'uuid') return c;
        return `CASE WHEN ${c}::text LIKE '00000000-0000-4000-8000-%'
                     THEN ('00000000-0000-4000-9000-' || substr(${c}::text, 25))::uuid ELSE ${c} END`;
      });
      const where = table === 'organizations' ? 'id = $1' : 'org_id = $1';
      // created_by of the copied users points at B's owner: insert the owner first (as the seed does)
      const order = table === 'users' ? `ORDER BY (created_by IS NOT NULL), id` : '';
      await tx.query(
        `INSERT INTO ${table} (${cols.map((c) => c.column_name).join(', ')})
         SELECT ${expr.join(', ')} FROM ${table} WHERE ${where} AND id::text LIKE '00000000-0000-4000-8000-%' ${order}`,
        [SEED_IDS.org],
      );
    }
  });
}

export interface OperatorsApp extends CustomerApp {
  A: Operator;
  B: Operator;
  storage: InMemoryObjectStorage;
}

/**
 * The customer harness (api on a port, simulator, worker with the WhatsApp, notifications, dispatch and custody
 * jobs) with the incidents projectors and the export job, operator B mirrored, both channels' templates synced,
 * and both operators populated.
 */
export async function createOperatorsApp(): Promise<OperatorsApp> {
  const w = await createCustomerApp();
  const storage = w.app.get<InMemoryObjectStorage>(EXPORTS_STORAGE);
  for (const h of paymentsReportsJobs({ storage })) w.dispatcher.register(h);
  // V2-040 / V2-041: each operator's settlement statement and system-subscription invoice (O-05 / O-06)
  const invoicing = new InvoicingRuntime({
    env: w.env,
    clock: w.clock,
    storage: w.app.get<ObjectStorage>(OBJECT_STORAGE, { strict: false }),
  });
  for (const h of invoicingJobs({ runtime: invoicing })) w.dispatcher.register(h);
  for (const p of incidentsProjectors()) w.dispatcher.registerProjector(p);
  await w.sim.client.configure({ phoneNumberId: null }); // both operators' numbers are served
  await seedOperatorB(w.db);
  const A = operator('A');
  const B = operator('B');
  ok(await w.command('post', '/v1/admin/whatsapp/templates/sync', { as: B.user('OWN1') }));
  const o = Object.assign(w, { A, B, storage });
  await populate(o, A);
  await populate(o, B);
  return o;
}

let plateSeq = 3000;
let serialSeq = 700;
let spotSeq = 0;

/** POST /v1/tickets → PATCH (paper) → photos → submit: the ticket is `parking`. */
async function paperInParking(w: CustomerApp, op: Operator, driver: string, eventId: string) {
  const serial = `${op.key}-${serialSeq++}`;
  const d = await newDraft(w, driver, eventId);
  const p = ok(
    await patchIntake(w, driver, d.ticketId, {
      expected_version: d.version,
      ...PAPER_DRAFT(serial, `K${op.key}-${serialSeq}`, String(plateSeq++)),
    }),
  );
  await addPhotos(w.db, d.ticketId, driver);
  ok(await submitIntake(w, driver, d.ticketId, { expected_version: p.version }));
  op.serials[d.ticketId] = serial;
  return d;
}

/** … then complete-parking in the next free spot and key slot of «ريماس». */
async function paperParked(w: CustomerApp, op: Operator, driver: string, eventId: string) {
  const d = await paperInParking(w, op, driver, eventId);
  const n = ++spotSeq;
  const spotId = op.spot(`A-${String(n).padStart(2, '0')}`);
  const slotId = op.slot(n);
  ok(await completeParking(w, driver, d.taskId, { parking_spot_id: spotId, key_slot_id: slotId }));
  return { ...d, spotId, slotId };
}

/** The live offer of a task and its first recipient. */
async function offerOf(db: Database, taskId: string) {
  return one<{ id: string; user_id: string }>(
    db,
    `SELECT o.id, r.user_id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id
      WHERE o.task_id = $1 AND o.status = 'active' ORDER BY r.user_id LIMIT 1`,
    [taskId],
  );
}

/** A parked ticket requested by the supervisor and brought to `ready` by whoever the engine offered it to. */
async function toReady(w: CustomerApp, op: Operator, parker: string, eventId: string) {
  const p = await paperParked(w, op, parker, eventId);
  w.clock.advanceSeconds(1);
  const r = ok(await requestRetrieval(w, op.user('SUP-R'), p.ticketId), 201);
  const offer = await offerOf(w.db, r.task.id);
  ok(await accept(w, offer.user_id, offer.id));
  ok(await keyPickup(w, offer.user_id, r.task.id, p.slotId));
  ok(await startRetrieval(w, offer.user_id, r.task.id));
  ok(await markReady(w, offer.user_id, r.task.id));
  return { ...p, retrieveTaskId: r.task.id as string, cycleId: r.cycle.id as string, driver: offer.user_id };
}

/**
 * The same operational day for one operator, through the real routes: duty, intake (paper and WhatsApp), parking,
 * retrieval requests, offers, handovers with a payment, a cash handover, a voided ticket, an incident, an alert,
 * the WhatsApp messages and the customer's press, an export, a device, a transfer. The named resources land in
 * `op.r`.
 */
export async function populate(w: OperatorsApp, op: Operator): Promise<void> {
  const u = op.user;
  const sup = u('SUP-R');
  for (const d of ['DRV1', 'DRV2'] as const) {
    ok(await startDuty(w, u(d)), 201);
    w.clock.advanceSeconds(1);
  }
  // delivered with a cash payment (per_vehicle event), then a ticket left at ready
  const delivered = await toReady(w, op, u('DRV2'), op.feeEvent);
  const h = ok(
    await handover(w, delivered.driver, delivered.ticketId, {
      verification: { method: 'paper_stub', paper_serial: op.serials[delivered.ticketId] },
      payment: { method: 'cash', amount_halalas: 2000 },
    }),
  );
  op.r.ticketDelivered = delivered.ticketId;
  op.r.payment = h.payment.id;
  w.clock.advanceSeconds(1);
  ok(
    await w.command('post', '/v1/cash-handovers', {
      as: sup,
      body: { event_id: op.feeEvent, driver_id: delivered.driver, amount_halalas: 2000 },
    }),
    201,
  );
  w.clock.advanceSeconds(1);
  const ready = await toReady(w, op, u('DRV2'), op.feeEvent);
  op.r.ticketReady = ready.ticketId;
  op.r.taskRetrieve = ready.retrieveTaskId;
  // a retrieval left offered (requested) with its open cycle and live offer
  w.clock.advanceSeconds(1);
  const req = await paperParked(w, op, u('DRV2'), op.event);
  w.clock.advanceSeconds(1);
  const rr = ok(await requestRetrieval(w, sup, req.ticketId), 201);
  op.r.ticketRequested = req.ticketId;
  op.r.cycle = rr.cycle.id;
  op.r.offer = (await offerOf(w.db, rr.task.id)).id;
  op.r.taskOffered = rr.task.id;
  // parked, parking, draft, voided
  ok(await startDuty(w, u('DRV4')), 201);
  const parked = await paperParked(w, op, u('DRV4'), op.event);
  op.r.ticketParked = parked.ticketId;
  op.r.spotTaken = parked.spotId;
  op.r.slotTaken = parked.slotId;
  ok(await startDuty(w, u('DRV5')), 201);
  const parking = await paperInParking(w, op, u('DRV5'), op.event);
  op.r.ticketParking = parking.ticketId;
  op.r.taskPark = parking.taskId;
  ok(await startDuty(w, u('DRV6')), 201);
  op.r.ticketDraft = (await newDraft(w, u('DRV6'), op.event)).ticketId;
  ok(await startDuty(w, u('DRV3')), 201);
  const doomed = await newDraft(w, u('DRV3'), op.event);
  ok(
    await w.command('post', `/v1/tickets/${doomed.ticketId}/void`, {
      as: sup,
      body: { expected_version: doomed.version, reason: 'تذكرة تجريبية', custody_returned_to_customer: true },
    }),
  );
  op.r.ticketVoided = doomed.ticketId;
  // WhatsApp: W-01 to the customer (same phone at both operators), then «طلب السيارة»
  const wa = await newDraft(w, u('DRV3'), op.event);
  const wp = ok(
    await patchIntake(w, u('DRV3'), wa.ticketId, {
      expected_version: wa.version,
      ...PAPER_DRAFT('X', `W${op.key}-1`, String(plateSeq++)),
      channel: 'whatsapp',
      paper_serial: null,
      customer_phone: '0551234567',
      consent: { method: 'verbal_staff_confirmed', confirmed: true },
    }),
  );
  await addPhotos(w.db, wa.ticketId, u('DRV3'));
  ok(await submitIntake(w, u('DRV3'), wa.ticketId, { expected_version: wp.version }));
  ok(
    await completeParking(w, u('DRV3'), wa.taskId, {
      parking_spot_id: op.spot('B-01'),
      key_slot_id: op.slot(50),
    }),
  );
  op.r.ticketWhatsapp = wa.ticketId;
  await settle(w, '+966551234567');
  // incident, alert
  op.r.incident = ok(
    await w.command('post', '/v1/incidents', {
      as: sup,
      body: { venue_id: op.venue, ticket_id: op.r.ticketParked, type: 'other', description: 'واقعة تجريبية' },
    }),
    201,
  ).id;
  op.r.alert = (
    await w.db.transaction((tx) =>
      raiseAlert(tx, { orgId: op.org, venueId: op.venue, type: 'task_stuck', dedupeKey: `iso:${op.key}` }),
    )
  ).alert.id;
  // an export (generated by the worker), a device, a transfer
  op.r.export = ok(
    await w.command('post', '/v1/exports', {
      as: u('ADM1'),
      body: { kind: 'tickets', filters: { venue_id: op.venue } },
    }),
    202,
  ).id;
  op.r.device = ok(
    await w.command('post', '/v1/me/devices', {
      as: u('DRV1'),
      key: null,
      body: { platform: 'android', display_mode: 'standalone', notification_permission: 'default' },
    }),
    201,
  ).id;
  op.r.transfer = ok(
    await w.command('post', `/v1/drivers/${u('DRV8')}/transfers`, {
      as: u('ADM1'),
      body: { to_venue_id: op.venue, reason: 'نقل للحاجة' },
    }),
    201,
  ).id;
  // V2-041 / V2-042 (O-05 / O-06): an issued statement of September and its system-subscription tax invoice
  op.r.statement = await w.db.transaction(async (tx) => {
    await tx.query(`UPDATE organizations SET legal_name = $2 WHERE id = $1`, [
      op.org,
      `شركة المشغل ${op.key}`,
    ]);
    const st = await tx.one<{ id: string }>(
      `INSERT INTO settlement_statements (org_id, period_start, period_end, status, issued_at)
       VALUES ($1, '2026-09-01', '2026-10-01', 'issued', $2) RETURNING id`,
      [op.org, tx.now],
    );
    const inv = await issueDocument(tx, {
      series: 'standard',
      kind: 'operator_standard',
      orgId: op.org,
      statementId: st.id,
      supplyDate: '2026-09-01',
      periodStart: '2026-09-01',
      periodEnd: '2026-10-01',
      buyer: { kind: 'operator', legal_name_ar: `شركة المشغل ${op.key}` },
      lines: [
        {
          description_ar: 'اشتراك نظام التشغيل',
          description_en: 'Operating system subscription',
          quantity: 1,
          unit_price_halalas: 50_000,
          net_halalas: 50_000,
          vat_rate_bp: 1500,
          vat_halalas: 7_500,
          total_halalas: 57_500,
        },
      ],
      vatRateBp: 1500,
    });
    await tx.query(`UPDATE settlement_statements SET saas_invoice_id = $2 WHERE id = $1`, [st.id, inv.id]);
    op.r.invoice = inv.id;
    return st.id;
  });
  await w.drain();
  // rows the routes address that no command above returned
  const row = (sql: string) => one<{ id: string }>(w.db, sql, [op.org]).then((x) => x.id);
  op.r.media = await row(`SELECT id FROM media_assets WHERE org_id = $1 ORDER BY created_at, id LIMIT 1`);
  op.r.dutySession = await row(
    `SELECT id FROM duty_sessions WHERE org_id = $1 AND status <> 'ended' ORDER BY started_at, id LIMIT 1`,
  );
  op.r.outbox = await row(`SELECT id::text AS id FROM outbox_events WHERE org_id = $1 ORDER BY seq LIMIT 1`);
  expect(
    await rows(
      w.db,
      `SELECT status, count(*)::int AS n FROM tickets WHERE org_id = $1 GROUP BY 1 ORDER BY 1`,
      [op.org],
    ),
  ).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'delivered' })]));
}

/** The customer presses «طلب السيارة» of the latest W-01 the operator's number sent him. */
export async function pressFor(w: OperatorsApp, op: Operator) {
  const m = (await w.sim.client.listMessages({ to: '+966551234567', purpose: 'W-01' }))
    .filter((x) => x.phoneNumberId === op.phoneNumberId)
    .sort((a, b) => b.seq - a.seq)[0];
  if (!m) throw new Error(`no W-01 from ${op.phoneNumberId}`);
  return press(w, '+966551234567', { wamid: m.wamid });
}
