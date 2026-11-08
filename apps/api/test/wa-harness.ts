import type { AddressInfo } from 'node:net';
import { SEED_IDS } from '@point/db/seed';
import {
  OutboxDispatcher,
  WhatsappRuntime,
  createLogger,
  emitEvent,
  encrypt,
  hmacHex,
  installCustomerFlows,
  notificationsJobs,
  parseEncryptionKey,
  resetWhatsappSeams,
  whatsappJobs,
  type Logger,
  type Tx,
} from '@point/server';
import { startSimulator, type RunningSimulator } from '../../../tools/wa-simulator/src/index.js';
import { createTestApp, newKey, type TestApp } from './harness.js';

/**
 * WhatsApp integration harness (PNT-038 … PNT-042, PNT-046, PNT-048): the API (webhook, admin routes)
 * listening on a real port, the simulator in-process as Graph API and webhook emitter, and the worker's
 * OutboxDispatcher with the real `job.wa_send` / `job.wa_process_inbound` handlers on the same FakeClock.
 */

/** Test values for the seeded secret references (env://WA_ACCESS_TOKEN …): not real secrets. */
export const WA_TEST_SECRETS = {
  WA_ACCESS_TOKEN: 'sim-access-token-for-tests',
  WA_APP_SECRET: 'sim-app-secret-for-tests',
  WA_VERIFY_TOKEN: 'sim-verify-token-for-tests',
} as const;

export const silentLogger = createLogger({ level: 'silent' });

export interface WaTestApp extends TestApp {
  sim: RunningSimulator;
  /** the worker-side runtime (the api has its own, built by WhatsappHttpModule) */
  rt: WhatsappRuntime;
  dispatcher: OutboxDispatcher;
  apiUrl: string;
  /** Runs every due outbox row (domain events and jobs) until nothing is due. */
  drain(): Promise<number>;
  /** Drains, then moves the clock to the next deferred job and drains again, up to `maxAdvanceMs`. */
  flush(maxAdvanceMs?: number): Promise<void>;
  /** Unix seconds of the FakeClock (simulator webhook timestamps). */
  ts(offsetS?: number): number;
  syncTemplates(): Promise<void>;
}

export async function createWaTestApp(
  opts: { env?: Record<string, string>; logger?: Logger } = {},
): Promise<WaTestApp> {
  Object.assign(process.env, WA_TEST_SECRETS);
  const sim = await startSimulator({
    appSecret: WA_TEST_SECRETS.WA_APP_SECRET,
    accessToken: WA_TEST_SECRETS.WA_ACCESS_TOKEN,
    verifyToken: WA_TEST_SECRETS.WA_VERIFY_TOKEN,
    phoneNumberId: 'SIM-PHONE',
    wabaId: 'SIM-WABA',
    autoStatuses: false,
  });
  const t = await createTestApp({
    env: { WA_GRAPH_BASE_URL: sim.url, WA_HTTP_TIMEOUT_MS: '3000', ...(opts.env ?? {}) },
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  await t.app.listen(0, '127.0.0.1');
  const apiUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
  await sim.client.configure({ webhookUrl: `${apiUrl}/webhooks/whatsapp` });
  const rt = new WhatsappRuntime({ env: t.env, logger: silentLogger });
  const dispatcher = new OutboxDispatcher(t.db, t.clock, silentLogger, {
    workerId: 'wa-test-worker',
    batchSize: 50,
    concurrency: 1,
  });
  for (const h of [...whatsappJobs({ runtime: rt }), ...notificationsJobs()]) dispatcher.register(h);

  const w: WaTestApp = {
    ...t,
    sim,
    rt,
    dispatcher,
    apiUrl,
    drain: () => dispatcher.drain(200),
    async flush(maxAdvanceMs = 60_000) {
      const limit = t.clock.now().getTime() + maxAdvanceMs;
      for (let i = 0; i < 300; i++) {
        await dispatcher.drain(200);
        // rows due now but queued behind an ordering key wait for a deferred predecessor: jump to it
        const next = (
          await t.db.query<{ at: Date | null }>(
            `SELECT min(available_at) AS at FROM outbox_events WHERE status = 'pending' AND available_at > $1`,
            [t.clock.now()],
          )
        ).rows[0]?.at;
        if (!next) return;
        const at = new Date(next).getTime();
        if (at > limit) return;
        t.clock.set(new Date(at));
      }
    },
    ts: (offsetS = 0) => Math.floor(t.clock.now().getTime() / 1000) + offsetS,
    async syncTemplates() {
      const r = await t.command('post', '/v1/admin/whatsapp/templates/sync', { as: 'OWN1', key: newKey() });
      if (r.status !== 200) throw new Error(`template sync failed: ${r.status} ${JSON.stringify(r.body)}`);
    },
    async close() {
      resetWhatsappSeams();
      installCustomerFlows(); // the S3 flows registered at load (PNT-045 button press, PNT-043 direct link)
      await sim.close();
      await t.close();
    },
  };
  return w;
}

// ---------------------------------------------------------------------------------------------
// Rows the WhatsApp adapter reads, created with SQL (the ticket commands arrive in S2/S3 tickets)
// ---------------------------------------------------------------------------------------------

export const ORG = SEED_IDS.org;
export const RMS = SEED_IDS.venues.RMS;
export const LYL = SEED_IDS.venues.LYL;
export const CUS1 = SEED_IDS.customers.CUS1; // +966551234567
export const CUS2 = SEED_IDS.customers.CUS2; // +966559876543
export const DRV1 = SEED_IDS.users.DRV1;

const EVENT_BY_VENUE = { RMS: SEED_IDS.events['EVT-R1'], LYL: SEED_IDS.events['EVT-L1'] } as const;
let displaySeq = 100;

export interface TicketFixture {
  id: string;
  displayNumber: number;
  venueId: string;
  eventId: string;
  poolId: string;
}

export async function createTicket(
  w: Pick<TestApp, 'db'>,
  o: {
    venue?: 'RMS' | 'LYL';
    customerId?: string | null;
    status?: string;
    channel?: 'whatsapp' | 'paper';
    waLinkStatus?: string;
    linkVersion?: number;
    consent?: boolean;
  } = {},
): Promise<TicketFixture> {
  const venue = o.venue ?? 'RMS';
  const venueId = SEED_IDS.venues[venue];
  const eventId = EVENT_BY_VENUE[venue];
  const poolId = SEED_IDS.defaultPoolByVenue[venue];
  const displayNumber = ++displaySeq;
  const status = o.status ?? 'parked';
  const customerId = o.customerId === undefined ? CUS1 : o.customerId;
  const r = await w.db.query<{ id: string }>(
    `INSERT INTO tickets (org_id, venue_id, event_id, dispatch_pool_id, display_number, status, channel, customer_id,
            wa_link_status, link_version, paper_serial, plate_digits, plate_letters_ar, vehicle_make, vehicle_model, vehicle_color,
            vehicle_holder_type, key_holder_type, created_by, submitted_at, parked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '4821', 'ب ح د', 'تويوتا', 'كامري', 'بيضاء',
             'unknown', 'unknown', $12, now(), now())
     RETURNING id`,
    [
      ORG,
      venueId,
      eventId,
      poolId,
      displayNumber,
      status,
      o.channel ?? 'whatsapp',
      customerId,
      o.waLinkStatus ?? 'linked',
      o.linkVersion ?? 1,
      o.channel === 'paper' ? `P-${displayNumber}` : null,
      DRV1,
    ],
  );
  const id = r.rows[0]!.id;
  if ((o.consent ?? true) && customerId)
    await w.db.query(
      `INSERT INTO customer_consents (org_id, customer_id, ticket_id, method, captured_by, captured_at)
       VALUES ($1, $2, $3, 'verbal_staff_confirmed', $4, now())`,
      [ORG, customerId, id, DRV1],
    );
  return { id, displayNumber, venueId, eventId, poolId };
}

export async function createCycle(
  w: Pick<TestApp, 'db' | 'clock'>,
  t: TicketFixture,
  o: { cycleNo?: number; requestedEarly?: boolean; customerId?: string } = {},
): Promise<string> {
  const r = await w.db.query<{ id: string }>(
    `INSERT INTO retrieval_cycles (org_id, venue_id, ticket_id, cycle_no, requested_at, request_source,
            requested_by_customer_id, requested_early, created_at)
     VALUES ($1, $2, $3, $4, $5, 'whatsapp', $6, $7, $5) RETURNING id`,
    [ORG, t.venueId, t.id, o.cycleNo ?? 1, w.clock.now(), o.customerId ?? CUS1, o.requestedEarly ?? false],
  );
  const id = r.rows[0]!.id;
  await w.db.query(`UPDATE tickets SET active_cycle_id = $2, last_requested_at = $3 WHERE id = $1`, [
    t.id,
    id,
    w.clock.now(),
  ]);
  return id;
}

export async function createTask(
  w: Pick<TestApp, 'db' | 'clock'>,
  t: TicketFixture,
  cycleId: string,
  status: 'queued' | 'assigned_waiting' | 'accepted' | 'in_progress',
  assignee: string | null = DRV1,
): Promise<string> {
  const r = await w.db.query<{ id: string }>(
    `INSERT INTO tasks (org_id, venue_id, dispatch_pool_id, event_id, ticket_id, cycle_id, type, status, priority_at,
            assignee_id, queued_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'retrieve', $7, $8, $9, $8, $8) RETURNING id`,
    [
      ORG,
      t.venueId,
      t.poolId,
      t.eventId,
      t.id,
      cycleId,
      status,
      w.clock.now(),
      status === 'queued' ? null : assignee,
    ],
  );
  return r.rows[0]!.id;
}

/** A live handover code with its single encrypted copy (DEC-38). */
export async function createClaimCode(
  w: Pick<TestApp, 'db' | 'clock' | 'env'>,
  t: TicketFixture,
  cycleId: string,
  code: string,
  ttlMin = 30,
): Promise<string> {
  const key = parseEncryptionKey(w.env.DATA_ENCRYPTION_KEY, w.env.DATA_ENCRYPTION_KEY_ID);
  const r = await w.db.query<{ id: string }>(
    `INSERT INTO claim_codes (org_id, ticket_id, cycle_id, code_hash, code_ciphertext, issued_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6::timestamptz + make_interval(mins => $7)) RETURNING id`,
    [
      ORG,
      t.id,
      cycleId,
      hmacHex(w.env.CODE_PEPPER, `${cycleId}:${code}`),
      encrypt(code, key),
      w.clock.now(),
      ttlMin,
    ],
  );
  return r.rows[0]!.id;
}

/** A command transaction: optional writes, then the domain event; the NotificationPlanner runs at COMMIT. */
export async function emit(
  w: Pick<TestApp, 'db'>,
  type: string,
  t: TicketFixture | null,
  payload: Record<string, unknown>,
  before?: (tx: Tx) => Promise<void>,
): Promise<void> {
  await w.db.transaction(async (tx) => {
    if (before) await before(tx);
    const version = t
      ? (await tx.one<{ version: number }>(`SELECT version FROM tickets WHERE id = $1`, [t.id])).version
      : null;
    await emitEvent(tx, {
      type,
      orgId: ORG,
      venueId: t?.venueId ?? null,
      eventId: t?.eventId ?? null,
      aggregate: t ? { type: 'ticket', id: t.id, version } : { type: 'customer', id: ORG, version: null },
      actor: { type: 'user', id: DRV1 },
      payload: t
        ? {
            ticket: { ticket_id: t.id, display_number: t.displayNumber, ticket_version: version },
            ...payload,
          }
        : payload,
    });
  });
}

export async function setTicket(w: Pick<TestApp, 'db'>, t: TicketFixture, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  await w.db.query(
    `UPDATE tickets SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, version = version + 1 WHERE id = $1`,
    [t.id, ...keys.map((k) => fields[k])],
  );
}

export async function notificationsOf(w: Pick<TestApp, 'db'>, ticketId: string) {
  return (
    await w.db.query<{
      id: string;
      purpose: string;
      status: string;
      skipped_reason: string | null;
      attempts: number;
      last_error_code: string | null;
      dedupe_key: string;
    }>(
      `SELECT id, purpose, status, skipped_reason, attempts, last_error_code, dedupe_key FROM notifications
        WHERE ticket_id = $1 ORDER BY created_at, purpose`,
      [ticketId],
    )
  ).rows;
}
