#!/usr/bin/env node
// pnpm ops:load:v2 — the V2 load profile (V2-051, DEC-563; targets in docs/17 §H-08ب) against a locally started
// production build, on a throwaway database like `pnpm ops:load` (DEC-371): never an existing database, dropped at
// the end unless --keep-db.
//
//  0. builds the backend and both simulators unless --no-build; point_load_v2_<id> with the migrations and the
//     harness seed (2 venues); the first venue listed (P-04) with a monthly plan (P-05)
//  1. starts the WhatsApp simulator (the Point number), the payment simulator (Moyasar), then the api and the worker
//     (NODE_ENV=production) on ports 4600–4699
//  2. sign-in (measured): --customers customers arrive over --signin-window seconds and sign in through the real
//     WhatsApp code (C-02 → C-03: POST /auth/otp, the code read from the simulator as the customer reads it, POST
//     /auth/verify), add a vehicle, open the pass (C-11), home, and the customer socket (/customer)
//  3. visits (measured): drivers on duty scan the pass of --visits customers (O-01 intake-pass → park); each
//     customer pays the visit's fee in the app (90 % frictionless card, 10 % 3-D Secure answered at the simulator),
//     polls C-12 every --poll seconds while its socket listens, presses «طلب السيارة» in the app; driver bots
//     accept, retrieve and hand over with the code the customer reads in C-12
//  4. subscriptions (measured): --subs customers subscribe (C-09/C-10, a card saved for the renewals)
//  5. renewal batch (measured): the worker process is stopped and the production worker runs in this process on an
//     injected clock (FakeClock) set past the end of every period: job.subscription_renew charges every saved card
//     (merchant-initiated), the payments, the periods, the invoices — drained until nothing is due at that clock
//  6. checks: the V2 targets (docs/17 §H-08ب), server errors, stuck work at the injected clock, the consistency
//     queries, the schema invariants, and every log line of the api and the worker scanned for a full phone
//     number, a sign-in code or a handover code; results.json + report.md; exit 1 when a target fails
//
// Knobs (flag or environment): --customers LOAD_V2_CUSTOMERS (200) · --visits LOAD_V2_VISITS (100) ·
// --subs LOAD_V2_SUBS (100) · --drivers LOAD_V2_DRIVERS (10, on the first venue) · --signin-window
// LOAD_V2_SIGNIN_S (60) · --poll LOAD_V2_POLL_S (3) · --visit-window LOAD_V2_VISIT_S (60) · --port LOAD_V2_PORT_BASE (4600) · --out LOAD_V2_OUT ·
// --seed LOAD_V2_SEED · --keep-db · --no-build.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { ApiClient, httpLog } from '../harness/api.mjs';
import { consistency, createDb, dropDb, migrateDb, schemaInvariants } from '../harness/db.mjs';
import { ROOT, importDist, pg } from '../harness/deps.mjs';
import { serverEnv, simulatorEnv } from '../harness/env.mjs';
import { must } from '../harness/flows.mjs';
import { Proc, SCRIPTS, sampleUsage, waitHttp } from '../harness/procs.mjs';
import { runId, seedWorld } from '../harness/seed.mjs';
import { groupBy, ms, summary, table } from '../harness/stats.mjs';
import {
  CARDS,
  CARD_VERSION,
  CustomerClient,
  PAYMENT_SIMULATOR,
  listedVenueWithPlan,
  paySim,
  paymentSimulatorEnv,
  platformSession,
  scanLogText,
  tokenize,
  v2ServerEnv,
} from '../harness/v2.mjs';
import { DriverBot, prng } from './bots.mjs';

const { values: a } = parseArgs({
  options: {
    customers: { type: 'string' },
    visits: { type: 'string' },
    subs: { type: 'string' },
    drivers: { type: 'string' },
    'signin-window': { type: 'string' },
    poll: { type: 'string' },
    'visit-window': { type: 'string' },
    port: { type: 'string' },
    out: { type: 'string' },
    seed: { type: 'string' },
    'keep-db': { type: 'boolean' },
    'no-build': { type: 'boolean' },
  },
});
const env = process.env;
const num = (flag, name, def) => Number(a[flag] ?? env[name] ?? def);
const K = {
  customers: num('customers', 'LOAD_V2_CUSTOMERS', 200),
  visits: num('visits', 'LOAD_V2_VISITS', 100),
  subs: num('subs', 'LOAD_V2_SUBS', 100),
  drivers: num('drivers', 'LOAD_V2_DRIVERS', 10),
  signinS: num('signin-window', 'LOAD_V2_SIGNIN_S', 60),
  pollS: num('poll', 'LOAD_V2_POLL_S', 3),
  visitS: num('visit-window', 'LOAD_V2_VISIT_S', 60),
  portBase: num('port', 'LOAD_V2_PORT_BASE', 4600),
  seed: num('seed', 'LOAD_V2_SEED', Math.floor(Math.random() * 2 ** 31)),
  keepDb: !!a['keep-db'] || env.LOAD_KEEP_DB === '1',
  build: !a['no-build'] && env.LOAD_BUILD !== '0',
};
if (K.visits + K.subs > K.customers)
  throw new Error(`--visits (${K.visits}) + --subs (${K.subs}) must not exceed --customers (${K.customers})`);
const id = runId();
const OUT = a.out ?? env.LOAD_V2_OUT ?? join(tmpdir(), `point-load-v2-${id}`);
mkdirSync(OUT, { recursive: true });
const ports = { api: K.portBase, metrics: K.portBase + 1, sim: K.portBase + 10, pay: K.portBase + 40 };
const DB = `point_load_v2_${id}`;
const t0 = Date.now();
const log = (m) => console.log(`[load-v2 ${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s] ${m}`);
const rng = prng(K.seed);

/**
 * The targets of docs/17 §H-08ب (V2-051, DEC-563). p95 over every exchange of the measured phases; errors are 5xx +
 * network failures over all of them.
 */
export const V2_TARGETS = {
  'POST /v1/customer/auth/otp': 500,
  'POST /v1/customer/auth/verify': 500,
  'GET /v1/customer/pass': 300,
  'GET /v1/customer/home': 500,
  'GET /v1/customer/visits/{id}': 300,
  'POST /v1/customer/visits/{id}/request': 1000,
  'GET /v1/customer/visits/{id}/handover-code': 300,
  'POST /v1/customer/visits/{id}/pay': 2000,
  'POST /v1/customer/subscriptions': 2000,
  codeDeliveryMs: 5000, // otp answered → the code at the simulator (the worker's job.customer_otp_send)
  visitUpdatedMs: 2000, // a staff or customer command answered → visit.updated at the customer's socket
  paidAfter3dsMs: 10000, // the 3-D Secure answer → C-12 reads the payment paid (webhook → worker)
  renewalsPerSecond: 5, // the renewal batch at the injected clock
  serverErrorRate: 0.001,
};

function build() {
  log('building the backend and the simulators (tsc → dist)');
  const r = spawnSync(
    'pnpm',
    [
      '-r',
      ...['shared', 'db', 'server', 'api', 'worker', 'wa-simulator', 'payment-simulator'].flatMap((p) => [
        '--filter',
        `@point/${p}`,
      ]),
      'build',
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (r.status !== 0) throw new Error('backend build failed');
}

/** A driver of the run whose handover code comes from the customer's C-12 (an app ticket has no W-05). */
class AppDriverBot extends DriverBot {
  async codeFor(phone, timeoutMs = 60_000) {
    const c = this.customerByPhone.get(phone);
    const ticketId = c?.ticketId;
    const until = Date.now() + timeoutMs;
    while (c && Date.now() < until) {
      const r = await c.get(`/v1/customer/visits/${ticketId}/handover-code`);
      if (r.status === 200 && r.data?.code) {
        codesSeen.add(String(r.data.code));
        return String(r.data.code);
      }
      await sleep(300);
    }
    throw new Error(`no handover code in C-12 for ${phone.slice(-4)}`);
  }
}

const procs = [];
let pool = null;
let usage = null;
const codesSeen = new Set();
const socketEvents = []; // { at, account, ticketId, status }
const marks = { codeDelivery: [], updated: [], paid3ds: [] };

/** Refuses to start when a port of the run is taken (another run on this machine would answer in its place). */
async function assertPortsFree() {
  const { createServer } = await import('node:net');
  for (const port of [ports.api, ports.metrics, ports.metrics + 1, ports.sim, ports.pay])
    await new Promise((resolve, reject) => {
      const s = createServer();
      s.once('error', () => reject(new Error(`port ${port} is in use: pick another --port base`)));
      s.listen(port, '127.0.0.1', () => s.close(resolve));
    });
}

async function main() {
  log(`run ${id} → ${OUT}; knobs ${JSON.stringify(K)}`);
  await assertPortsFree();
  if (K.build) build();
  const url = await createDb(DB);
  log(`database ${DB}: ${await migrateDb(url)}`);
  const webhookSecret = `whsec-${id}-${Math.floor(rng() * 1e9)}`;
  const srv = serverEnv({
    dbUrl: url,
    ports,
    overrides: {
      // every customer and driver signs in from this one address; production has one per device (DEPLOYMENT §11.3)
      RATE_LIMIT_AUTH_PER_MIN: '100000',
      RATE_LIMIT_COMMANDS_PER_MIN: '100000',
      RATE_LIMIT_READS_PER_MIN: '100000',
      RATE_LIMIT_WRITES_PER_MIN: '100000',
      ...v2ServerEnv({ ports, webhookSecret }),
    },
  });
  const world = await seedWorld(url, {
    venues: 2,
    driversPerVenue: K.drivers,
    env: srv,
    spotsPerVenue: K.visits + 4,
    slotsPerVenue: K.visits + 4,
  });
  pool = new pg.Pool({ connectionString: url, max: 3 });
  const venue = world.venues[0];
  const owner = await platformSession(pool, { phone: '+966559990301', cookieName: 'point_platform_sid' });
  const planId = await listedVenueWithPlan(pool, {
    venueId: venue.id,
    orgId: world.org,
    approver: owner.userId,
  });

  // 1. processes
  const sim = new Proc('simulator', SCRIPTS.simulator, simulatorEnv(srv, { ports }), OUT).start();
  procs.push(sim);
  await waitHttp(`http://127.0.0.1:${ports.sim}/_sim/health`);
  const pay = new Proc(
    'payment-simulator',
    PAYMENT_SIMULATOR,
    paymentSimulatorEnv({ ports, webhookSecret, retries: 5 }),
    OUT,
  ).start();
  procs.push(pay);
  const payBase = `http://127.0.0.1:${ports.pay}`;
  await waitHttp(`${payBase}/_sim/payments`);
  const api = new Proc('api', SCRIPTS.api, srv, OUT).start();
  procs.push(api);
  await waitHttp(`http://127.0.0.1:${ports.api}/health/ready`);
  const worker = new Proc(
    'worker',
    SCRIPTS.worker,
    { ...srv, WORKER_ID: `load-v2-worker-${id}` },
    OUT,
  ).start();
  procs.push(worker);
  await waitHttp(`http://127.0.0.1:${ports.metrics + 1}/metrics`);
  usage = sampleUsage(procs, 2000);
  const base = `http://127.0.0.1:${ports.api}`;
  const { SimulatorClient } = await importDist('tools/wa-simulator/dist/index.js');
  const simc = new SimulatorClient(`http://127.0.0.1:${ports.sim}`);
  const ps = paySim(payBase);
  const shared = await importDist('packages/shared/dist/index.js');
  const sharedCustomer = await importDist('packages/shared/dist/customer/index.js');
  const ownerApi = new ApiClient(base, { label: 'owner' });
  await ownerApi.login(world.owner.phone, world.owner.secret, world.owner.totpSecret);
  await must(ownerApi.command('POST', '/v1/admin/whatsapp/templates/sync', {}), 'template sync');
  log('processes up, templates synced, venue listed with a plan');

  // drivers of the first venue on duty (prep)
  const customerByPhone = new Map();
  const phoneOfTicket = new Map();
  const bots = venue.drivers.map(
    (driver) =>
      new AppDriverBot({
        base,
        venue,
        driver,
        sim: simc,
        rng,
        phoneOfTicket,
        customerByPhone,
        log,
        opts: {
          acceptMinS: 0.5,
          acceptMaxS: 3,
          stepMinS: 0.3,
          stepMaxS: 1,
          driveMinS: 0.5,
          driveMaxS: 1.5,
          reserveProbability: 0.3,
          heartbeatS: 15,
        },
      }),
  );
  await Promise.all(bots.map((b) => b.signIn()));
  log(`${bots.length} drivers on duty with sockets`);

  // 2. sign-in, vehicle, pass, home, socket
  const phases = {};
  const phase = (name, fn) => async () => {
    const start = Date.now();
    const out = await fn();
    phases[name] = { start, end: Date.now() };
    log(`${name}: ${((Date.now() - start) / 1000).toFixed(1)} s`);
    return out;
  };
  const customers = await phase('signin', async () => {
    const list = [];
    await Promise.all(
      Array.from({ length: K.customers }, async (_, i) => {
        await sleep(((i + 0.5) / K.customers) * K.signinS * 1000);
        const phone = `+96658${String(1000000 + i).padStart(7, '0')}`;
        const c = new CustomerClient(base, null, { label: `cust-${i}` });
        const before = Date.now();
        const s = await c.signIn(phone, simc, {
          device: `load-v2-device-${i}`,
          templateName: shared.WA_CUSTOMER_OTP_TEMPLATE_NAME,
        });
        marks.codeDelivery.push(s.deliveredMs);
        void before;
        codesSeen.add(s.code);
        c.phone = phone;
        const v = await c.command('POST', '/v1/customer/vehicles', {
          plate: { country: 'SA', digits: String(1000 + i), letters_ar: 'ب ح د' },
          vehicle_make: 'toyota',
          vehicle_color: 'white',
          vehicle_type: 'sedan',
        });
        if (v.status !== 201) throw new Error(`vehicle ${v.status} ${v.error?.code}`);
        c.vehicleId = v.data.id;
        const p = await c.get('/v1/customer/pass');
        if (p.status !== 200) throw new Error(`pass ${p.status} ${p.error?.code}`);
        c.pass = p.data;
        await c.get('/v1/customer/home');
        await c.get('/v1/customer/me');
        c.sock = c.socket();
        c.sock.on('visit.updated', (m) => {
          const d = m?.data ?? m?.payload ?? m;
          socketEvents.push({
            at: Date.now(),
            account: c.account.id,
            ticketId: d?.ticket_id,
            status: d?.status,
          });
        });
        customerByPhone.set(phone, c);
        list.push(c);
      }),
    );
    return list;
  })();
  log(`${customers.length} customers signed in, each with a vehicle, the pass and a socket`);

  // 3. visits: the pass scanned (prep), then pay, poll, request, retrieval, handover
  const visitors = customers.slice(0, K.visits);
  const feeEvent = venue.events.find((e) => Number(e.fee_halalas) > 0) ?? venue.events[0];
  await phase('intake', async () => {
    let next = 0;
    await Promise.all(
      bots.map(async (bot, bi) => {
        for (;;) {
          const i = next++;
          if (i >= visitors.length) return;
          const c = visitors[i];
          const draft = await must(
            bot.api.command('POST', '/v1/tickets', { event_id: feeEvent.id }),
            'draft',
          );
          const pass_token = sharedCustomer.generatePassToken({
            secret: c.pass.secret,
            accountId: c.pass.account_id,
            vehicleId: c.vehicleId,
            step: sharedCustomer.passStep(Date.now()),
          });
          const scanned = await must(
            bot.api.command('POST', '/v1/tickets/intake-pass', {
              pass_token,
              ticket_id: draft.data.ticket.id,
              expected_version: draft.data.ticket.version,
            }),
            'intake-pass',
          );
          const patched = await must(
            bot.api.command('PATCH', `/v1/tickets/${draft.data.ticket.id}/intake`, {
              expected_version: scanned.data.ticket.version,
              key_tag: `V2-${i + 1}`,
            }),
            'patch-intake',
          );
          await must(
            bot.api.command('POST', `/v1/tickets/${draft.data.ticket.id}/submit-intake`, {
              expected_version: patched.data.version,
            }),
            'submit-intake',
          );
          await must(
            bot.api.command('POST', `/v1/tasks/${draft.data.task.id}/complete-parking`, {
              parking_spot_id: venue.spots[i],
              key_slot_id: venue.slots[i],
            }),
            'complete-parking',
          );
          c.ticketId = draft.data.ticket.id;
          phoneOfTicket.set(c.ticketId, c.phone);
          void bi;
        }
      }),
    );
    // the fee of the visit: the event's own when it has one (the intake decided it), else set as the venue would
    await pool.query(
      `UPDATE tickets SET payment_status = 'due', fee_halalas = 2300, entitlement = 'none'
        WHERE id = ANY($1::uuid[]) AND (payment_status <> 'due' OR entitlement <> 'none')`,
      [visitors.map((c) => c.ticketId)],
    );
  })();
  log(`${visitors.length} app tickets parked by pass`);

  for (const b of bots) b.active = true;
  await phase('visits', async () => {
    await Promise.all(
      visitors.map(async (c, i) => {
        // arrivals uniform over the visit window: 100 visits in 60 s is the rate of 17 H-08 (100 presses a minute),
        // here on one venue and one dispatch pool
        await sleep(((i + rng()) / visitors.length) * K.visitS * 1000);
        const threeDs = i % 10 === 9;
        const token = await tokenize(payBase, threeDs ? CARDS.threeDs : CARDS.success);
        const r = await c.command('POST', `/v1/customer/visits/${c.ticketId}/pay`, {
          source: { type: 'token', token },
        });
        if (r.status !== 201) throw new Error(`pay ${r.status} ${r.error?.code}`);
        if (threeDs) {
          const gp = (
            await pool.query(`SELECT gateway_payment_id FROM online_payments WHERE id = $1`, [
              r.data.payment_id,
            ])
          ).rows[0].gateway_payment_id;
          const answered = Date.now();
          await ps.complete3ds(gp, 'success');
          for (;;) {
            const p = await c.get(`/v1/customer/payments/${r.data.payment_id}`);
            if (p.data?.status === 'paid') break;
            await sleep(250);
          }
          marks.paid3ds.push(Date.now() - answered);
        }
        // C-12 polled while the socket listens; the request after a short look at the visit
        let polling = true;
        const poller = (async () => {
          while (polling) {
            await c.get(`/v1/customer/visits/${c.ticketId}`);
            await sleep(K.pollS * 1000);
          }
        })();
        await sleep(1000 + rng() * 3000);
        // the mark runs from the moment the request is sent (an upper bound of commit → socket): the event is
        // published in the command's transaction and may arrive before the HTTP answer
        const sentAt = Date.now();
        const req = await c.command('POST', `/v1/customer/visits/${c.ticketId}/request`, {});
        if (req.status !== 201) throw new Error(`request ${req.status} ${req.error?.code}`);
        const seen = await waitFor(
          () =>
            socketEvents.find((e) => e.ticketId === c.ticketId && e.at >= sentAt && e.status === 'requested'),
          15_000,
        );
        if (seen) marks.updated.push(seen.at - sentAt);
        await waitFor(
          async () =>
            (await pool.query(`SELECT status FROM tickets WHERE id = $1`, [c.ticketId])).rows[0].status ===
            'delivered',
          600_000,
          1000,
        );
        polling = false;
        await poller;
      }),
    );
  })();
  for (const b of bots) b.active = false;
  const delivered = Number(
    (
      await pool.query(
        `SELECT count(*)::int AS n FROM tickets WHERE id = ANY($1::uuid[]) AND status = 'delivered'`,
        [visitors.map((c) => c.ticketId)],
      )
    ).rows[0].n,
  );
  log(`${delivered}/${visitors.length} app visits delivered`);

  // 4. subscriptions
  const subscribers = customers.slice(K.visits, K.visits + K.subs);
  await phase('subscribe', async () => {
    await Promise.all(
      subscribers.map(async (c, i) => {
        await sleep((i / Math.max(1, subscribers.length)) * 20_000);
        const token = await tokenize(payBase, CARDS.success);
        const r = await c.command('POST', '/v1/customer/subscriptions', {
          plan_id: planId,
          billing_cycle: 'monthly',
          vehicle_ids: [c.vehicleId],
          source: { type: 'token', token },
          save_card: true,
          card_on_file_version: CARD_VERSION,
        });
        if (r.status !== 201) throw new Error(`subscribe ${r.status} ${r.error?.code}`);
        c.subscriptionId = r.data.subscription?.subscription_id ?? r.data.subscription?.id;
      }),
    );
    await waitFor(
      async () =>
        Number(
          (
            await pool.query(
              `SELECT count(*)::int AS n FROM subscriptions WHERE id = ANY($1::uuid[]) AND status = 'active'`,
              [subscribers.map((c) => c.subscriptionId)],
            )
          ).rows[0].n,
        ) === subscribers.length,
      120_000,
      500,
    );
  })();
  log(`${subscribers.length} subscriptions active`);
  await waitQuiet(pool, 20_000);

  // 5. the renewal batch on an injected clock (the production worker, in this process)
  await worker.stop();
  const renewal = await phase('renewal', () =>
    renewalBatch(
      srv,
      subscribers.map((c) => c.subscriptionId),
      ps,
    ),
  )();
  log(`renewal batch: ${JSON.stringify(renewal.summary)}`);

  // 6. measurements and checks
  usage.stop();
  for (const c of customers) c.sock?.close();
  for (const b of bots) await b.stop();
  const results = await measure({ customers, visitors, subscribers, delivered, renewal, phases, bots });
  results.consistency = await consistency(pool);
  results.invariants = await schemaInvariants();
  results.logs = scanLogs(customers);
  results.verdict = verdict(results);
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  writeFileSync(join(OUT, 'report.md'), report(results));
  console.log(`\n${report(results)}\n`);
  log(`results: ${join(OUT, 'results.json')}, report: ${join(OUT, 'report.md')}, logs: ${OUT}`);
  return results.verdict.pass;
}

async function waitFor(fn, timeoutMs, everyMs = 100) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  return null;
}

/** Nothing due and nothing leased in the outbox (the run's real clock), up to `timeoutMs`. */
async function waitQuiet(q, timeoutMs) {
  await waitFor(
    async () =>
      Number(
        (
          await q.query(
            `SELECT count(*)::int AS n FROM outbox_events WHERE (status = 'pending' AND available_at <= now())
                OR status = 'processing'`,
          )
        ).rows[0].n,
      ) === 0,
    timeoutMs,
    500,
  );
}

/**
 * Phase 5: the production worker (apps/worker/dist: every handler and projector) in this process on a FakeClock past
 * the end of every period. Its environment is the run's server environment (the runtimes read process.env).
 */
async function renewalBatch(srv, subscriptionIds, ps) {
  Object.assign(process.env, { ...srv, LOG_LEVEL: 'warn', WORKER_ID: `load-v2-renewals-${id}` });
  const server = await importDist('packages/server/dist/index.js');
  const { createWorker } = await importDist('apps/worker/dist/worker.js');
  const handlers = await importDist('apps/worker/dist/handlers.js');
  const ends = (
    await pool.query(`SELECT max(current_period_end) AS end FROM subscriptions WHERE id = ANY($1::uuid[])`, [
      subscriptionIds,
    ])
  ).rows[0].end;
  const clock = new server.FakeClock(new Date(new Date(ends).getTime() + 60_000).toISOString());
  // every job of the batch timed by type (what the batch spent its time on)
  const jobTimes = new Map();
  const timed = handlers.allHandlers().map((h) => ({
    ...h,
    async handle(ctx) {
      const started = performance.now();
      try {
        return await h.handle(ctx);
      } finally {
        const t = jobTimes.get(h.type) ?? { n: 0, ms: 0, max: 0 };
        const d = performance.now() - started;
        jobTimes.set(h.type, { n: t.n + 1, ms: t.ms + d, max: Math.max(t.max, d) });
      }
    },
  }));
  const w = createWorker({
    env: server.loadEnv(process.env),
    clock,
    handlers: timed,
    projectors: handlers.allProjectors(),
  });
  const chargesBefore = (await ps.payments()).length;
  const start = Date.now();
  let rounds = 0;
  let renewed = 0;
  const deadline = start + 600_000;
  for (; Date.now() < deadline; rounds++) {
    await w.dispatcher.drain(50);
    renewed = Number(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM subscriptions WHERE id = ANY($1::uuid[]) AND periods_paid = 2`,
          [subscriptionIds],
        )
      ).rows[0].n,
    );
    const due = Number(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM outbox_events WHERE status IN ('pending','processing') AND available_at <= $1`,
          [clock.now()],
        )
      ).rows[0].n,
    );
    if (renewed === subscriptionIds.length && due === 0) break;
    await sleep(200);
  }
  const renewedAt = Date.now();
  // the gateway's webhooks of the renewals (stored by the api) are processed at the injected clock too
  await ps.flush();
  await sleep(1000);
  for (let i = 0; i < 20; i++) if ((await w.dispatcher.drain(50)) === 0) break;
  const at = clock.now();
  const rows = (
    await pool.query(
      `SELECT count(*) FILTER (WHERE status = 'paid')::int AS paid, count(*)::int AS total,
              count(DISTINCT given_id)::int AS given_ids
         FROM online_payments WHERE subscription_id = ANY($1::uuid[]) AND subscription_period_seq = 2`,
      [subscriptionIds],
    )
  ).rows[0];
  const periods = Number(
    (
      await pool.query(
        `SELECT count(*)::int AS n FROM subscription_periods WHERE subscription_id = ANY($1::uuid[])`,
        [subscriptionIds],
      )
    ).rows[0].n,
  );
  const invoices = Number(
    (
      await pool.query(
        `SELECT count(*)::int AS n FROM invoices i JOIN online_payments p ON p.id = i.online_payment_id
          WHERE p.subscription_id = ANY($1::uuid[]) AND p.subscription_period_seq = 2`,
        [subscriptionIds],
      )
    ).rows[0].n,
  );
  const stuck = (
    await pool.query(
      `SELECT count(*) FILTER (WHERE status = 'pending' AND available_at <= $1)::int AS due,
              count(*) FILTER (WHERE status = 'processing')::int AS processing,
              count(*) FILTER (WHERE status IN ('failed','dead'))::int AS failed
         FROM outbox_events`,
      [at],
    )
  ).rows[0];
  const charges = (await ps.payments()).length - chargesBefore;
  const seconds = (renewedAt - start) / 1000;
  await w.db.close();
  return {
    summary: {
      subscriptions: subscriptionIds.length,
      renewed,
      seconds: Number(seconds.toFixed(2)),
      perSecond: Number((renewed / Math.max(seconds, 0.001)).toFixed(2)),
      payments: rows.total,
      paid: rows.paid,
      givenIds: rows.given_ids,
      gatewayCharges: charges,
      periods,
      invoices,
      rounds,
      injectedClock: at.toISOString(),
    },
    jobs: Object.fromEntries(
      [...jobTimes].map(([k, v]) => [k, { n: v.n, totalMs: Math.round(v.ms), maxMs: Math.round(v.max) }]),
    ),
    stuck,
  };
}

/** Every api and worker log line of the run: no full phone number, no sign-in code, no handover code. */
function scanLogs(customers) {
  const text = ['api.log', 'worker.log']
    .map((f) => {
      try {
        return readFileSync(join(OUT, f), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
  return { ...scanLogText(text, codesSeen), customers: customers.length };
}

async function measure({ customers, visitors, subscribers, delivered, renewal, phases, bots }) {
  const start = Math.min(...Object.values(phases).map((p) => p.start));
  const window = httpLog.filter((r) => r.at >= start);
  const byRoute = groupBy(window, (r) => r.route);
  const routes = {};
  for (const [route, recs] of byRoute) {
    const s = summary(recs.map((r) => r.ms));
    routes[route] = {
      ...s,
      statuses: Object.fromEntries([...groupBy(recs, (r) => r.status)].map(([k, v]) => [k, v.length])),
      errors: [...new Set(recs.filter((r) => r.code).map((r) => r.code))],
    };
  }
  const serverErrors = window.filter((r) => r.status === 0 || r.status >= 500).length;
  const unexpected4xx = window.filter(
    (r) =>
      r.status >= 400 &&
      r.status < 500 &&
      r.status !== 409 &&
      r.status !== 410 &&
      !/handover-code/.test(r.route),
  );
  return {
    run: id,
    date: new Date(t0).toISOString(),
    knobs: K,
    targets: V2_TARGETS,
    phases: Object.fromEntries(
      Object.entries(phases).map(([k, p]) => [k, { seconds: Number(((p.end - p.start) / 1000).toFixed(1)) }]),
    ),
    counts: {
      customers: customers.length,
      visits: visitors.length,
      delivered,
      subscriptions: subscribers.length,
      driverFailures: bots.reduce((n, b) => n + b.failures.length, 0),
      socketEvents: socketEvents.length,
    },
    routes,
    marks: {
      codeDelivery: summary(marks.codeDelivery),
      visitUpdated: summary(marks.updated),
      paidAfter3ds: summary(marks.paid3ds),
    },
    errors: {
      exchanges: window.length,
      serverErrors,
      rate: window.length ? serverErrors / window.length : 0,
      unexpected4xx: unexpected4xx.length,
      unexpected4xxSample: unexpected4xx.slice(0, 5).map((r) => `${r.route} ${r.status} ${r.code}`),
    },
    renewal,
    resources: summarizeUsage(),
  };
}

function summarizeUsage() {
  const out = {};
  for (const [proc, s] of groupBy(usage?.samples ?? [], (x) => x.proc))
    out[proc] = {
      cpuP95: Number((summary(s.map((x) => x.cpuPct)).p95 ?? 0).toFixed(1)),
      rssMaxMb: Number(Math.max(...s.map((x) => x.rssMb)).toFixed(0)),
    };
  return out;
}

function verdict(r) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  for (const [route, target] of Object.entries(V2_TARGETS)) {
    if (!route.includes(' ')) continue;
    const s = r.routes[route];
    add(`${route} p95 < ${target} ms`, s && s.p95 !== null && s.p95 < target, s ? ms(s.p95) : 'not measured');
  }
  add(
    `code delivery p95 < ${V2_TARGETS.codeDeliveryMs} ms`,
    r.marks.codeDelivery.p95 !== null && r.marks.codeDelivery.p95 < V2_TARGETS.codeDeliveryMs,
    ms(r.marks.codeDelivery.p95),
  );
  add(
    `visit.updated at the customer socket p95 < ${V2_TARGETS.visitUpdatedMs} ms (every request observed)`,
    r.marks.visitUpdated.p95 !== null &&
      r.marks.visitUpdated.p95 < V2_TARGETS.visitUpdatedMs &&
      r.marks.visitUpdated.count === r.counts.visits,
    `${ms(r.marks.visitUpdated.p95)} (${r.marks.visitUpdated.count}/${r.counts.visits})`,
  );
  if (r.marks.paidAfter3ds.count)
    add(
      `3-D Secure answered → paid in C-12 p95 < ${V2_TARGETS.paidAfter3dsMs} ms`,
      r.marks.paidAfter3ds.p95 < V2_TARGETS.paidAfter3dsMs,
      ms(r.marks.paidAfter3ds.p95),
    );
  add(
    'every app visit delivered',
    r.counts.delivered === r.counts.visits,
    `${r.counts.delivered}/${r.counts.visits}`,
  );
  add('no failed driver retrieval', r.counts.driverFailures === 0, `${r.counts.driverFailures}`);
  add(
    `server errors (5xx + network) < ${V2_TARGETS.serverErrorRate * 100} %`,
    r.errors.rate < V2_TARGETS.serverErrorRate,
    `${r.errors.serverErrors}/${r.errors.exchanges}`,
  );
  add('no unexpected 4xx', r.errors.unexpected4xx === 0, r.errors.unexpected4xxSample.join('; ') || '0');
  const rn = r.renewal.summary;
  add(
    'every subscription renewed once: one payment per period, one given_id each, one gateway charge, one invoice',
    rn.renewed === rn.subscriptions &&
      rn.payments === rn.subscriptions &&
      rn.paid === rn.subscriptions &&
      rn.givenIds === rn.subscriptions &&
      rn.gatewayCharges === rn.subscriptions &&
      rn.invoices === rn.subscriptions &&
      rn.periods === 2 * rn.subscriptions,
    JSON.stringify(rn),
  );
  add(
    `renewals ≥ ${V2_TARGETS.renewalsPerSecond} per second at the injected clock`,
    rn.perSecond >= V2_TARGETS.renewalsPerSecond,
    `${rn.perSecond}/s`,
  );
  add(
    'no stuck work at the injected clock (no due, leased, failed or dead outbox row)',
    r.renewal.stuck.due === 0 && r.renewal.stuck.processing === 0 && r.renewal.stuck.failed === 0,
    JSON.stringify(r.renewal.stuck),
  );
  const bad = Object.entries(r.consistency).filter(([, n]) => n !== 0);
  add(
    'consistency queries all zero',
    bad.length === 0,
    bad.length ? JSON.stringify(Object.fromEntries(bad)) : '0',
  );
  add(
    'schema invariants (docs/06_schema_invariants_test.sql)',
    r.invariants.passed,
    r.invariants.tail.join(' '),
  );
  add(
    'no full phone number, sign-in code or handover code in any api/worker log line',
    r.logs.fullPhones === 0 && r.logs.secretHits === 0 && r.logs.secretsChecked > 0,
    `${r.logs.lines} lines, ${r.logs.secretsChecked} secrets checked`,
  );
  return { pass: checks.every((c) => c.ok), checks };
}

function report(r) {
  const routeRows = Object.entries(r.routes)
    .filter(([route]) => route.includes('/v1/customer') || route.includes('/v1/tickets/intake-pass'))
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([route, s]) => [
      route,
      s.count,
      ms(s.p50),
      ms(s.p95),
      ms(s.p99),
      ms(s.max),
      Object.entries(s.statuses)
        .map(([k, v]) => `${k}×${v}`)
        .join(' '),
    ]);
  return [
    `# V2 load run ${r.run} — ${r.date}`,
    '',
    `Knobs: ${JSON.stringify(r.knobs)}`,
    '',
    `Phases: ${Object.entries(r.phases)
      .map(([k, v]) => `${k} ${v.seconds} s`)
      .join(' · ')}`,
    '',
    table(
      ['Check', 'Result', 'Measured'],
      r.verdict.checks.map((c) => [c.name, c.ok ? 'pass' : '**FAIL**', c.detail]),
    ),
    '',
    '## Customer routes',
    '',
    table(['Route', 'n', 'p50', 'p95', 'p99', 'max', 'statuses'], routeRows),
    '',
    '## Marks',
    '',
    table(
      ['Mark', 'n', 'p50', 'p95', 'max'],
      Object.entries(r.marks).map(([k, s]) => [k, s.count, ms(s.p50), ms(s.p95), ms(s.max)]),
    ),
    '',
    `Renewal batch: ${JSON.stringify(r.renewal.summary)}`,
    '',
    `Resources (cpu p95 %, rss max MB): ${JSON.stringify(r.resources)}`,
  ].join('\n');
}

let ok = false;
try {
  ok = await main();
} catch (e) {
  console.error(`[load-v2] FAILED: ${e?.stack ?? e}`);
} finally {
  usage?.stop();
  for (const p of procs.reverse()) await p.stop().catch(() => {});
  await pool?.end().catch(() => {});
  if (!K.keepDb) await dropDb(DB).catch((e) => console.error(`drop ${DB}: ${e.message}`));
}
process.exit(ok ? 0 : 1);
