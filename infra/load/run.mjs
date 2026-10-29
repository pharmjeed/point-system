#!/usr/bin/env node
// pnpm ops:load — the load profile of 17 H-08 / AC-13 (PNT-097) against a locally started production build.
//
//  0. builds the backend (tsc → dist) unless --no-build; a fresh database point_load_<id> with the migrations and
//     the harness seed (5 venues, 10 drivers each; infra/harness/seed.mjs — never a production path)
//  1. starts the WhatsApp simulator, then `node apps/api/dist/main.js` and `node apps/worker/dist/main.js`
//     (NODE_ENV=production) on ports 4100–4199; syncs the templates as the owner (password + TOTP)
//  2. prep (not measured): every driver signs in, starts duty, opens Socket.IO; supervisors open theirs; 120
//     WhatsApp tickets go through intake → submit (W-01) → complete-parking on the real routes
//  3. warm-up (2 min): 50 connected drivers with heartbeats, nothing requested
//  4. burst: 100 «request the car» presses in 60 s (20 per venue, uniform + two short bursts) as signed webhooks —
//     k6 (infra/load/k6/webhooks.js) when a k6 binary is available, else the same plan sent from Node
//  5. drivers accept after 1–10 s and run the retrieval with compressed steps (key pickup, start, ready, the
//     code from the simulator, handover); drain until every request is delivered or 15 min
//  6. measures M1 … M5 of H-08, the error rate (409s counted apart), stuck tasks, the consistency queries and the
//     schema invariants; writes results.json + report.md to the output directory; exit 1 if AC-13 fails.
//
// Knobs (flag or environment): --rate LOAD_RATE (presses/min, 100) · --duration LOAD_DURATION_S (60) ·
// --venues LOAD_VENUES (5) · --drivers LOAD_DRIVERS_PER_VENUE (10) · --tickets LOAD_TICKETS (120) ·
// --warmup LOAD_WARMUP_S (120) · --drain LOAD_DRAIN_S (900) · --k6 LOAD_K6 (path | off; default: k6 on PATH) ·
// --port LOAD_PORT_BASE (4100) · --out LOAD_OUT · --seed LOAD_SEED · --reserve LOAD_RESERVE_P (0.3) ·
// --auth-rate LOAD_AUTH_RATE_PER_MIN (600) · --keep-db · --no-build.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { ApiClient, httpLog } from '../harness/api.mjs';
import { consistency, createDb, dropDb, migrateDb, schemaInvariants } from '../harness/db.mjs';
import { ROOT, importDist, pg } from '../harness/deps.mjs';
import { serverEnv, simulatorEnv } from '../harness/env.mjs';
import { Proc, SCRIPTS, sampleUsage, waitHttp } from '../harness/procs.mjs';
import { runId, seedWorld } from '../harness/seed.mjs';
import { groupBy, ms, summary, table } from '../harness/stats.mjs';
import { DriverBot, SupervisorWatcher, observed, prng } from './bots.mjs';

const { values: a } = parseArgs({
  options: {
    rate: { type: 'string' },
    duration: { type: 'string' },
    venues: { type: 'string' },
    drivers: { type: 'string' },
    tickets: { type: 'string' },
    warmup: { type: 'string' },
    drain: { type: 'string' },
    k6: { type: 'string' },
    port: { type: 'string' },
    out: { type: 'string' },
    seed: { type: 'string' },
    reserve: { type: 'string' },
    'auth-rate': { type: 'string' },
    'keep-db': { type: 'boolean' },
    'no-build': { type: 'boolean' },
  },
});
const env = process.env;
const num = (flag, name, def) => Number(a[flag] ?? env[name] ?? def);
const K = {
  rate: num('rate', 'LOAD_RATE', 100),
  durationS: num('duration', 'LOAD_DURATION_S', 60),
  venues: num('venues', 'LOAD_VENUES', 5),
  driversPerVenue: num('drivers', 'LOAD_DRIVERS_PER_VENUE', 10),
  tickets: num('tickets', 'LOAD_TICKETS', 120),
  warmupS: num('warmup', 'LOAD_WARMUP_S', 120),
  drainS: num('drain', 'LOAD_DRAIN_S', 900),
  portBase: num('port', 'LOAD_PORT_BASE', 4100),
  seed: num('seed', 'LOAD_SEED', Math.floor(Math.random() * 2 ** 31)),
  reserveP: num('reserve', 'LOAD_RESERVE_P', 0.3),
  authRate: num('auth-rate', 'LOAD_AUTH_RATE_PER_MIN', 600),
  k6: a.k6 ?? env.LOAD_K6 ?? 'k6',
  keepDb: !!a['keep-db'] || env.LOAD_KEEP_DB === '1',
  build: !a['no-build'] && env.LOAD_BUILD !== '0',
};
K.presses = Math.round((K.rate * K.durationS) / 60);
if (K.presses > K.tickets) throw new Error(`--tickets (${K.tickets}) must cover the presses (${K.presses})`);
const id = runId();
const OUT = a.out ?? env.LOAD_OUT ?? join(tmpdir(), `point-load-${id}`);
mkdirSync(OUT, { recursive: true });
const ports = { api: K.portBase, metrics: K.portBase + 1, sim: K.portBase + 10 };
const DB = `point_load_${id}`;
const t0 = Date.now();
const log = (m) => console.log(`[load ${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s] ${m}`);
const rng = prng(K.seed);

function k6Binary() {
  if (K.k6 === 'off') return null;
  const r = spawnSync(K.k6, ['version'], { encoding: 'utf8' });
  return r.status === 0 ? { path: K.k6, version: r.stdout.trim() } : null;
}

function build() {
  log('building the backend (tsc → dist)');
  const r = spawnSync(
    'pnpm',
    [
      '-r',
      ...['shared', 'db', 'server', 'api', 'worker', 'wa-simulator'].flatMap((p) => [
        '--filter',
        `@point/${p}`,
      ]),
      'build',
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (r.status !== 0) throw new Error('backend build failed');
}

/** The Meta webhook of a «request the car» press (12 §6.5), exactly as the simulator emits it. */
function pressBody({ w01, wamid, ts, srv }) {
  const display = srv.WA_DISPLAY_PHONE_E164.replace(/\D/g, '');
  const button = w01.buttons[0];
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: srv.WA_BUSINESS_ACCOUNT_ID,
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: display, phone_number_id: srv.WA_PHONE_NUMBER_ID },
              contacts: [{ profile: { name: `load ${w01.waId.slice(-4)}` }, wa_id: w01.waId }],
              messages: [
                {
                  context: { from: display, id: w01.wamid },
                  from: w01.waId,
                  id: wamid,
                  timestamp: String(ts),
                  type: 'button',
                  button: { payload: button.payload, text: button.text },
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  });
}

/** Press times (ms from the start): uniform over the window plus two short bursts of 2 s (17 H-08 phase 2). */
function schedule(n, durationMs) {
  const burst = Math.round(n * 0.3);
  const b1 = Math.floor(burst / 2);
  const b2 = burst - b1;
  const flat = n - burst;
  const at = [];
  for (let i = 0; i < flat; i++) at.push(Math.round(((i + 0.5) * durationMs) / flat));
  const add = (center, k) => {
    for (let i = 0; i < k; i++) at.push(Math.round(center + (k > 1 ? (i / (k - 1)) * 2000 : 0)));
  };
  add(durationMs * 0.3, b1);
  add(durationMs * 0.7, b2);
  return at.sort((x, y) => x - y);
}

const procs = [];
let pool = null;
let usage = null;
const dbSamples = [];
let dbSampler = null;

async function main() {
  const k6 = k6Binary();
  log(
    `run ${id} → ${OUT}; knobs ${JSON.stringify(K)}; k6 ${k6 ? k6.version : 'not available (Node sends the plan)'}`,
  );
  if (K.build) build();

  // 0. database
  const url = await createDb(DB);
  log(`database ${DB}: ${await migrateDb(url)}`);
  const srv = serverEnv({
    dbUrl: url,
    ports,
    overrides: {
      // the generator signs in 50+ staff from one address; in production each device has its own (DEPLOYMENT §11.3)
      RATE_LIMIT_AUTH_PER_MIN: String(K.authRate),
    },
  });
  const world = await seedWorld(url, { venues: K.venues, driversPerVenue: K.driversPerVenue, env: srv });
  writeFileSync(join(OUT, 'world.json'), JSON.stringify(world, null, 2));
  log(
    `seeded ${world.venues.length} venues, ${world.venues.reduce((n, v) => n + v.drivers.length, 0)} drivers`,
  );
  pool = new pg.Pool({ connectionString: url, max: 3 });

  // 1. processes
  const sim = new Proc('simulator', SCRIPTS.simulator, simulatorEnv(srv, { ports }), OUT).start();
  procs.push(sim);
  await waitHttp(`http://127.0.0.1:${ports.sim}/_sim/health`);
  const api = new Proc('api', SCRIPTS.api, srv, OUT).start();
  procs.push(api);
  await waitHttp(`http://127.0.0.1:${ports.api}/health/ready`);
  const worker = new Proc('worker', SCRIPTS.worker, { ...srv, WORKER_ID: `load-worker-${id}` }, OUT).start();
  procs.push(worker);
  await waitHttp(`http://127.0.0.1:${ports.metrics + 1}/metrics`);
  usage = sampleUsage(procs, 2000);
  dbSampler = setInterval(() => void sampleDb(), 2000);
  const base = `http://127.0.0.1:${ports.api}`;
  const { SimulatorClient } = await importDist('tools/wa-simulator/dist/index.js');
  const simc = new SimulatorClient(`http://127.0.0.1:${ports.sim}`);

  const owner = new ApiClient(base, { label: 'owner' });
  await owner.login(world.owner.phone, world.owner.secret, world.owner.totpSecret);
  const sync = await owner.command('POST', '/v1/admin/whatsapp/templates/sync', {});
  if (sync.status !== 200) throw new Error(`template sync ${sync.status} ${sync.error?.code}`);
  log('processes up, templates synced');

  // 2. prep: staff on duty with sockets, tickets parked and linked
  const phoneOfTicket = new Map();
  const botOpts = {
    acceptMinS: 1,
    acceptMaxS: 10,
    stepMinS: 0.5,
    stepMaxS: 1.5,
    driveMinS: 1,
    driveMaxS: 3,
    reserveProbability: K.reserveP,
    heartbeatS: 15,
  };
  const bots = world.venues.flatMap((venue) =>
    venue.drivers.map(
      (driver) => new DriverBot({ base, venue, driver, sim: simc, rng, phoneOfTicket, log, opts: botOpts }),
    ),
  );
  const watchers = world.venues.map((venue) => new SupervisorWatcher({ base, venue, log }));
  await Promise.all([...bots.map((b) => b.signIn()), ...unique(watchers).map((w) => w.signIn())]);
  log(`${bots.length} drivers on duty with sockets, ${unique(watchers).length} supervisor sockets`);

  const perVenue = Math.ceil(K.tickets / world.venues.length);
  const specs = [];
  world.venues.forEach((venue, vi) => {
    for (let i = 0; i < perVenue && specs.length < K.tickets; i++) {
      const event = venue.events[i % venue.events.length];
      specs.push({
        venue: venue.code,
        venueIndex: vi,
        eventId: event.id,
        phone: `+96656${vi + 1}${String(i + 1).padStart(6, '0')}`,
        plateDigits: String(1000 + vi * 200 + i),
        keyTag: `L${vi + 1}-${i + 1}`,
        spotId: venue.spots[i],
        slotId: venue.slots[i],
      });
    }
  });
  const prepStart = Date.now();
  const tickets = [];
  await Promise.all(
    bots.map(async (bot) => {
      const slot = bot.venue.drivers.indexOf(bot.driver);
      const mine = specs
        .filter((s) => s.venue === bot.venue.code)
        .filter((_, i) => i % bot.venue.drivers.length === slot);
      for (const s of mine) {
        const t = await bot.intake(s);
        phoneOfTicket.set(t.ticketId, s.phone);
        tickets.push({ ...t, venueIndex: s.venueIndex });
      }
    }),
  );
  log(
    `${tickets.length} tickets parked in ${((Date.now() - prepStart) / 1000).toFixed(1)} s; waiting for W-01 acceptance`,
  );
  await until(
    async () =>
      Number(
        (
          await pool.query(
            `SELECT count(*)::int AS n FROM tickets WHERE status = 'parked' AND wa_link_status = 'linked'`,
          )
        ).rows[0].n,
      ) >= tickets.length,
    180_000,
    'every ticket parked and linked',
  );
  const prepEnd = Date.now();

  // the press plan: the W-01 of each chosen ticket, 20 per venue, interleaved
  const w01 = new Map((await simc.listMessages({ purpose: 'W-01' })).map((m) => [m.waId ?? digits(m.to), m]));
  const byVenue = groupBy(tickets, (t) => t.venueIndex);
  const order = [];
  for (let i = 0; order.length < K.presses; i++)
    for (const list of byVenue.values()) if (list[i] && order.length < K.presses) order.push(list[i]);
  const startAt = Date.now() + K.warmupS * 1000 + 5_000;
  const times = schedule(K.presses, K.durationS * 1000);
  const presses = order.map((t, i) => {
    const m = w01.get(digits(t.phone));
    if (!m) throw new Error(`no W-01 for ${t.phone}`);
    const raw = pressBody({
      w01: m,
      wamid: `wamid.LOAD.${randomUUID()}`,
      ts: Math.floor((startAt + times[i]) / 1000),
      srv,
    });
    return { at_ms: times[i], venue: t.venue, raw, ticketId: t.ticketId, sha: sha256(raw) };
  });
  const plan = {
    apiBase: base,
    appSecret: srv.WA_APP_SECRET,
    startAt,
    durationS: K.durationS,
    presses: presses.map(({ at_ms, venue, raw }) => ({ at_ms, venue, raw })),
  };
  const planPath = join(OUT, 'plan.json');
  writeFileSync(planPath, JSON.stringify(plan));

  // 3. warm-up, then 4. the burst (bots react from now on)
  log(`warm-up ${K.warmupS} s with ${bots.length} connected drivers`);
  for (const b of bots) b.active = true;
  const k6Run = k6 ? runK6(k6.path, planPath) : null;
  const nodeRun = k6 ? null : sendPlanFromNode(plan);
  await sleep(Math.max(0, startAt - Date.now()));
  const burstStart = Date.now();
  log(`burst: ${K.presses} presses over ${K.durationS} s (${k6 ? 'k6' : 'node'})`);
  const k6Result = k6Run ? await k6Run : null;
  if (nodeRun) await nodeRun;
  const burstEnd = Date.now();
  log(`presses sent in ${((burstEnd - burstStart) / 1000).toFixed(1)} s; draining`);

  // 5. drain
  const pressedIds = presses.map((p) => p.ticketId);
  const delivered = async () =>
    Number(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM tickets WHERE id = ANY($1::uuid[]) AND status = 'delivered'`,
          [pressedIds],
        )
      ).rows[0].n,
    );
  let lastReport = 0;
  const drainUntil = Date.now() + K.drainS * 1000;
  let done = 0;
  while (Date.now() < drainUntil) {
    done = await delivered();
    if (done >= pressedIds.length) break;
    if (Date.now() - lastReport > 15_000) {
      log(`delivered ${done}/${pressedIds.length}`);
      lastReport = Date.now();
    }
    await sleep(1000);
  }
  const drainEnd = Date.now();
  log(`delivered ${done}/${pressedIds.length} after ${((drainEnd - burstStart) / 1000).toFixed(1)} s`);
  for (const b of bots) b.active = false;
  await sleep(8_000); // last statuses and outbox rows settle
  const settleEnd = Date.now();

  // 6. measurements
  const results = await measure({
    world,
    tickets,
    presses,
    bots,
    simc,
    k6,
    k6Result,
    windows: { prepStart, prepEnd, burstStart, burstEnd, drainEnd, settleEnd },
  });
  results.metrics = await metricsSnapshot();
  results.consistency = await consistency(pool);
  results.invariants = await schemaInvariants();
  results.verdict = verdict(results);
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  writeFileSync(join(OUT, 'report.md'), report(results));
  console.log(`\n${report(results)}\n`);
  log(`results: ${join(OUT, 'results.json')}, report: ${join(OUT, 'report.md')}, logs: ${OUT}`);
  for (const b of bots) await b.stop();
  for (const w of unique(watchers)) await w.stop();
  return results.verdict.pass;
}

function unique(watchers) {
  const seen = new Set();
  return watchers.filter((w) =>
    seen.has(w.venue.supervisor.id) ? false : (seen.add(w.venue.supervisor.id), true),
  );
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const digits = (s) => String(s ?? '').replace(/\D/g, '');

async function until(fn, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function sampleDb() {
  try {
    const now = new Date();
    const o = (
      await pool.query(
        `SELECT count(*)::int AS due, EXTRACT(EPOCH FROM ($1::timestamptz - min(available_at)))::float AS oldest_s
           FROM outbox_events WHERE status = 'pending' AND available_at <= $1`,
        [now],
      )
    ).rows[0];
    const c = (
      await pool.query(
        `SELECT application_name AS app, count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 GROUP BY 1`,
        [DB],
      )
    ).rows;
    dbSamples.push({
      at: now.getTime(),
      due: o.due,
      oldestS: o.oldest_s ?? 0,
      conns: Object.fromEntries(c.map((r) => [r.app, r.n])),
    });
  } catch {
    // a sample lost under load is not a result
  }
}

function runK6(bin, planPath) {
  const summaryPath = join(OUT, 'k6-summary.json');
  return new Promise((resolve) => {
    const child = spawn(
      bin,
      [
        'run',
        '--quiet',
        '-e',
        `PLAN=${planPath}`,
        '-e',
        `SUMMARY_OUT=${summaryPath}`,
        join(ROOT, 'infra/load/k6/webhooks.js'),
      ],
      {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    child.on('exit', (code) => {
      writeFileSync(join(OUT, 'k6.log'), text);
      let summary;
      try {
        summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
      } catch {
        summary = null;
      }
      resolve({ code, summary, stdout: text.trim().split('\n').slice(-3).join('\n') });
    });
  });
}

/** The same plan without k6: each press at its time, signed like Meta, recorded in the HTTP log. */
async function sendPlanFromNode(plan) {
  await Promise.all(
    plan.presses.map(async (p) => {
      await sleep(Math.max(0, plan.startAt + p.at_ms - Date.now()));
      const started = performance.now();
      const rec = {
        at: Date.now(),
        client: 'meta',
        route: 'POST /webhooks/whatsapp',
        status: 0,
        code: null,
        ms: 0,
        error: null,
      };
      try {
        const r = await fetch(`${plan.apiBase}/webhooks/whatsapp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'facebookexternalua',
            'X-Hub-Signature-256': `sha256=${createHmac('sha256', plan.appSecret).update(p.raw).digest('hex')}`,
          },
          body: p.raw,
          signal: AbortSignal.timeout(30_000),
        });
        await r.arrayBuffer();
        rec.status = r.status;
      } catch (e) {
        rec.error = e?.cause?.code ?? e?.name ?? 'network';
      }
      rec.ms = performance.now() - started;
      httpLog.push(rec);
    }),
  );
}

async function measure({ world, tickets, presses, bots, simc, k6, k6Result, windows }) {
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
  const W = windows;
  const pressedIds = presses.map((p) => p.ticketId);

  // M1 — webhook received → cycle committed
  const inbound = new Map(
    (
      await q(`SELECT body_sha256, received_at FROM whatsapp_inbound_events WHERE body_sha256 = ANY($1)`, [
        presses.map((p) => p.sha),
      ])
    ).map((r) => [r.body_sha256, new Date(r.received_at).getTime()]),
  );
  const cycles = new Map(
    (
      await q(
        `SELECT t.id AS ticket_id, t.status, c.id AS cycle_id, c.created_at, c.delivered_at, k.id AS task_id, k.claimed_at,
                k.assignee_id, k.status AS task_status
           FROM tickets t
           LEFT JOIN retrieval_cycles c ON c.ticket_id = t.id
           LEFT JOIN tasks k ON k.cycle_id = c.id AND k.type = 'retrieve' AND k.status <> 'canceled'
          WHERE t.id = ANY($1::uuid[])`,
        [pressedIds],
      )
    ).map((r) => [r.ticket_id, r]),
  );
  const m1Lower = [];
  const m1Observed = [];
  const perPress = [];
  for (const p of presses) {
    const rec = inbound.get(p.sha);
    const c = cycles.get(p.ticketId);
    const created = c?.created_at ? new Date(c.created_at).getTime() : null;
    const seen = c?.task_id ? (observed.firstTaskUpdate.get(c.task_id) ?? null) : null;
    if (rec && created) m1Lower.push(created - rec);
    if (rec && seen) m1Observed.push(seen - rec);
    perPress.push({
      ticketId: p.ticketId,
      venue: p.venue,
      received: rec ?? null,
      cycleCreated: created,
      observed: seen,
      status: c?.status,
    });
  }

  // M2 — tasks.claimed_at → task.claimed at the other connected drivers
  const claimedAt = new Map(
    (
      await q(`SELECT id, claimed_at FROM tasks WHERE id = ANY($1::uuid[]) AND claimed_at IS NOT NULL`, [
        [...new Set(observed.claimed.map((c) => c.taskId))],
      ])
    ).map((r) => [r.id, new Date(r.claimed_at).getTime()]),
  );
  const m2 = [];
  const m2PerTask = new Map();
  for (const c of observed.claimed) {
    const at = claimedAt.get(c.taskId);
    if (!at || c.userId === c.winnerId) continue;
    const d = c.at - at;
    m2.push(d);
    m2PerTask.set(c.taskId, Math.max(m2PerTask.get(c.taskId) ?? 0, d));
  }

  // M3 — server errors over every HTTP exchange of the measured window (generator, presses, simulator webhooks)
  const inWindow = (r) => r.at >= W.burstStart - 1000 && r.at <= W.settleEnd;
  const generator = httpLog.filter((r) => r.client !== 'meta' && inWindow(r));
  const prep = httpLog.filter((r) => r.at >= W.prepStart && r.at < W.burstStart - 1000);
  const deliveries = (await simc.webhookDeliveries()).filter((d) => {
    const at = Date.parse(d.at);
    return at >= W.burstStart - 1000 && at <= W.settleEnd;
  });
  const k6m = k6Result?.summary?.metrics ?? null;
  const k6Count = k6m?.http_reqs?.values?.count ?? 0;
  const k6Failed = Math.round((k6m?.http_req_failed?.values?.rate ?? 0) * k6Count);
  const k6Server = k6m?.webhook_5xx?.values?.count ?? 0;
  const nodePresses = httpLog.filter((r) => r.client === 'meta');
  const pressCount = k6 ? k6Count : nodePresses.length;
  const press5xx = k6 ? k6Server : nodePresses.filter((r) => r.status >= 500 || r.status === 0).length;
  // a simulator delivery retried after a failed attempt counts every attempt (the api answered each one)
  const simAttempts = deliveries.reduce((n, d) => n + Math.max(1, d.attempts ?? 1), 0);
  const sim5xx = deliveries.reduce(
    (n, d) => n + (d.ok ? Math.max(0, (d.attempts ?? 1) - 1) : Math.max(1, d.attempts ?? 1)),
    0,
  );
  const total = generator.length + simAttempts + pressCount;
  const gen5xx = generator.filter((r) => r.status >= 500 || r.status === 0).length;
  const conflicts = generator.filter((r) => r.status >= 400 && r.status < 500);
  const errors = gen5xx + sim5xx + press5xx;

  // M4 — outbox: processing lag of the rows of the window, oldest due row while running
  const lagRows = await q(
    `SELECT type, EXTRACT(EPOCH FROM (processed_at - available_at)) * 1000 AS lag_ms
       FROM outbox_events WHERE status = 'done' AND available_at >= $1 AND available_at <= $2`,
    [new Date(W.burstStart), new Date(W.settleEnd)],
  );
  const lagBy = (pred) => summary(lagRows.filter(pred).map((r) => Number(r.lag_ms)));
  const runSamples = dbSamples.filter((s) => s.at >= W.burstStart && s.at <= W.drainEnd);

  // stuck work and alerts after the run (AC-13)
  const openTasks = await q(
    `SELECT type, status, count(*)::int AS n FROM tasks WHERE status NOT IN ('completed','canceled') GROUP BY 1, 2`,
  );
  const notDelivered = perPress.filter((p) => p.status !== 'delivered');
  // stuck rows by the system monitor's own rule (14 §8 outbox_lag): due longer than ops.outbox_lag_alert_s (30 s),
  // a lapsed lease, failed or dead — a timer that fell due a moment ago is the worker's next poll, not stuck work;
  // timers scheduled later are listed apart (no-ops once they fire)
  const outboxLeft = await q(
    `SELECT status, type, count(*)::int AS n FROM outbox_events
      WHERE (status = 'pending' AND available_at <= now() - interval '30 seconds')
         OR (status = 'processing' AND locked_until < now())
         OR status IN ('failed', 'dead')
      GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  const dueAtEnd = (
    await q(
      `SELECT count(*)::int AS n, EXTRACT(EPOCH FROM (now() - min(available_at)))::float AS oldest_s
         FROM outbox_events WHERE status = 'pending' AND available_at <= now()`,
    )
  )[0];
  const timersLater = await q(
    `SELECT type, count(*)::int AS n FROM outbox_events WHERE status = 'pending' AND available_at > now() GROUP BY 1 ORDER BY 1`,
  );
  const pendingNotifications = await q(
    `SELECT channel, purpose, count(*)::int AS n FROM notifications WHERE status = 'pending' GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  const notifications = await q(
    `SELECT channel, status, count(*)::int AS n FROM notifications GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  const alerts = await q(`SELECT type, status, count(*)::int AS n FROM alerts GROUP BY 1, 2 ORDER BY 1, 2`);
  const stuckAlerts = alerts.filter((r) => r.type === 'task_stuck' || r.type === 'outbox_lag');

  // WhatsApp: what each pressed customer received (one of each state message, no backlog)
  const messages = await simc.listMessages();
  const pressedPhones = new Set(
    presses.map((p) => digits(tickets.find((t) => t.ticketId === p.ticketId).phone)),
  );
  const perCustomer = new Map();
  for (const m of messages) {
    const phone = m.waId ?? digits(m.to);
    if (!pressedPhones.has(phone)) continue;
    const k = perCustomer.get(phone) ?? {};
    k[m.purpose] = (k[m.purpose] ?? 0) + 1;
    perCustomer.set(phone, k);
  }
  const duplicates = [...perCustomer.entries()].filter(([, k]) => Object.values(k).some((n) => n > 1));
  const purposeTotals = {};
  for (const k of perCustomer.values())
    for (const [p, n] of Object.entries(k)) purposeTotals[p] = (purposeTotals[p] ?? 0) + n;

  // M5 — resources
  const cpuBy = groupBy(
    usage.samples.filter((s) => s.at >= W.burstStart && s.at <= W.drainEnd),
    (s) => s.proc,
  );
  const resources = [...cpuBy.entries()].map(([proc, xs]) => ({
    proc,
    cpu: summary(xs.map((x) => x.cpuPct)),
    rssMaxMb: Math.max(...xs.map((x) => x.rssMb)),
  }));
  const connMax = {};
  for (const s of runSamples)
    for (const [app, n] of Object.entries(s.conns)) connMax[app] = Math.max(connMax[app] ?? 0, n);

  const routes = [...groupBy(generator, (r) => r.route).entries()].map(([route, rs]) => ({
    route,
    ...summary(rs.map((r) => r.ms)),
    s5xx: rs.filter((r) => r.status >= 500 || r.status === 0).length,
    s4xx: rs.filter((r) => r.status >= 400 && r.status < 500).length,
  }));
  const worst = [...generator, ...nodePresses]
    .filter(inWindow)
    .sort((x, y) => y.ms - x.ms)
    .slice(0, 10)
    .map((r) => ({
      route: r.route,
      status: r.status,
      code: r.code,
      ms: Math.round(r.ms),
      at: new Date(r.at).toISOString(),
    }));

  return {
    run: id,
    date: new Date(t0).toISOString(),
    knobs: K,
    machine: {
      cpus: cpus().length,
      model: cpus()[0]?.model,
      memGb: Math.round(totalmem() / 2 ** 30),
      node: process.version,
      loadavg: loadavg(),
    },
    k6: k6 ? { version: k6.version, exit: k6Result?.code, stdout: k6Result?.stdout } : null,
    windows: Object.fromEntries(Object.entries(W).map(([k, v]) => [k, new Date(v).toISOString()])),
    durations: {
      prepS: (W.prepEnd - W.prepStart) / 1000,
      burstS: (W.burstEnd - W.burstStart) / 1000,
      drainS: (W.drainEnd - W.burstStart) / 1000,
    },
    world: {
      venues: world.venues.length,
      drivers: bots.length,
      tickets: tickets.length,
      presses: presses.length,
    },
    m1: {
      observed: summary(m1Observed),
      lowerBound: summary(m1Lower),
      missingInbound: perPress.filter((p) => !p.received).length,
      missingCycle: perPress.filter((p) => !p.cycleCreated).length,
    },
    m2: { perRecipient: summary(m2), perTaskMax: summary([...m2PerTask.values()]), tasks: m2PerTask.size },
    m3: {
      total,
      errors,
      errorRate: total ? errors / total : 0,
      generator: { count: generator.length, s5xx: gen5xx },
      presses: { count: pressCount, s5xx: press5xx, failed: k6 ? k6Failed : press5xx },
      simulatorWebhooks: { count: deliveries.length, attempts: simAttempts, failed: sim5xx },
      expected4xx: Object.fromEntries(
        [...groupBy(conflicts, (r) => `${r.route} ${r.code ?? r.status}`).entries()].map(([k, v]) => [
          k,
          v.length,
        ]),
      ),
      pressAck: k6m
        ? {
            p95: k6m.webhook_ack_ms?.values?.['p(95)'],
            max: k6m.webhook_ack_ms?.values?.max,
            med: k6m.webhook_ack_ms?.values?.med,
          }
        : summary(nodePresses.map((r) => r.ms)),
      prepRequests: {
        count: prep.length,
        s5xx: prep.filter((r) => r.status >= 500 || r.status === 0).length,
      },
    },
    m4: {
      lagAll: lagBy(() => true),
      lagWaSend: lagBy((r) => r.type === 'job.wa_send'),
      lagInbound: lagBy((r) => r.type === 'job.wa_process_inbound'),
      lagJobs: lagBy(
        (r) => r.type.startsWith('job.') && r.type !== 'job.wa_send' && r.type !== 'job.wa_process_inbound',
      ),
      lagEvents: lagBy((r) => !r.type.startsWith('job.')),
      oldestDue: summary(runSamples.map((s) => s.oldestS * 1000)),
      dueRows: summary(runSamples.map((s) => s.due)),
      thresholdS: 30,
    },
    m5: { resources, dbConnectionsMax: connMax },
    routes,
    worst,
    stuck: {
      openTasks,
      notDelivered: notDelivered.length,
      outboxLeft,
      dueAtEnd,
      timersLater,
      pendingNotifications,
      stuckAlerts,
    },
    notifications,
    alerts,
    whatsapp: { customers: perCustomer.size, purposeTotals, duplicates: duplicates.length },
    drivers: {
      deliveries: bots.reduce((n, b) => n + b.done, 0),
      failures: bots.flatMap((b) => b.failures),
      socketIssues: observed.socketIssues.length,
      offersSeen: observed.offers.length,
    },
  };
}

/** The api's and the worker's /metrics at the end of the run (17 §11 «لقطة لوحات المراقبة»): files + selected series. */
async function metricsSnapshot() {
  const pick =
    /^point_(dispatch_accept_rejections_total|dispatch_offers_total|dispatch_escalations_total|db_tx_retries_total|ws_connections|wa_send_total|wa_skipped_total|push_send_total|outbox_events_total\{[^}]*status="(failed|dead)"|outbox_dead|tasks_stuck|(db_lock_wait|wa_webhook_duration|dispatch_time_to_claim|dispatch_pass_duration|timer_lag)_seconds_(sum|count))/;
  const out = {};
  for (const [name, port] of [
    ['api', ports.metrics],
    ['worker', ports.metrics + 1],
  ]) {
    try {
      const text = await fetch(`http://127.0.0.1:${port}/metrics`, {
        signal: AbortSignal.timeout(5000),
      }).then((r) => r.text());
      writeFileSync(join(OUT, `metrics-${name}.txt`), text);
      out[name] = text.split('\n').filter((l) => pick.test(l));
    } catch (e) {
      out[name] = [`unavailable: ${e.message}`];
    }
  }
  return out;
}

function verdict(r) {
  const checks = [
    ['M1 p95 request save < 2 s (observed commit)', (r.m1.observed.p95 ?? Infinity) < 2000],
    ['M2 p95 assignment publish < 3 s', (r.m2.perRecipient.p95 ?? Infinity) < 3000],
    ['M3 server errors < 0.1 %', r.m3.errorRate < 0.001],
    ['every request delivered, no stuck task', r.stuck.notDelivered === 0 && r.stuck.openTasks.length === 0],
    [
      'no stuck outbox row (due > 30 s, lapsed lease, failed, dead); no pending notification',
      r.stuck.outboxLeft.length === 0 && r.stuck.pendingNotifications.length === 0,
    ],
    ['no task_stuck / outbox_lag alert', r.stuck.stuckAlerts.length === 0],
    ['consistency queries all zero', Object.values(r.consistency).every((n) => n === 0)],
    ['schema invariants test passed', r.invariants.passed],
    ['one message per state per customer', r.whatsapp.duplicates === 0],
  ];
  return { pass: checks.every(([, ok]) => ok), checks: checks.map(([name, ok]) => ({ name, ok })) };
}

function report(r) {
  const s = (x) => (x ? `${ms(x.p50)} / ${ms(x.p95)} / ${ms(x.max)} (n=${x.count})` : '—');
  const lines = [
    `# Load run ${r.run} — ${r.date}`,
    '',
    `Knobs: ${r.world.venues} venues, ${r.world.drivers} drivers, ${r.world.tickets} parked tickets, ${r.world.presses} presses over ${r.knobs.durationS} s (${r.knobs.rate}/min), warm-up ${r.knobs.warmupS} s, seed ${r.knobs.seed}. Machine: ${r.machine.cpus} CPU (${r.machine.model}), ${r.machine.memGb} GB, Node ${r.machine.node}. Presses: ${r.k6 ? r.k6.version : 'Node generator'}.`,
    '',
    table(
      ['Check', 'Result'],
      r.verdict.checks.map((c) => [c.name, c.ok ? 'pass' : '**FAIL**']),
    ),
    '',
    table(
      ['Metric', 'p50 / p95 / max', 'Target'],
      [
        [
          'M1 request save — webhook received → cycle commit observed (supervisor socket)',
          s(r.m1.observed),
          'p95 < 2 s',
        ],
        ['M1 lower bound — received → cycle row (transaction start)', s(r.m1.lowerBound), '—'],
        [
          'M2 assignment publish — claimed_at → task.claimed at other drivers',
          s(r.m2.perRecipient),
          'p95 < 3 s',
        ],
        ['M2 per task, slowest recipient', s(r.m2.perTaskMax), '—'],
        [
          'Webhook acknowledgement (press → 200)',
          r.m3.pressAck.p95 !== undefined
            ? `${ms(r.m3.pressAck.med ?? r.m3.pressAck.p50)} / ${ms(r.m3.pressAck.p95)} / ${ms(r.m3.pressAck.max)}`
            : '—',
          '—',
        ],
        ['M4 outbox processing lag, all rows', s(r.m4.lagAll), 'alert at 30 s'],
        ['M4 oldest due row while running (2 s samples)', s(r.m4.oldestDue), 'alert at 30 s'],
      ],
    ),
    '',
    `M3: ${r.m3.errors} server errors / ${r.m3.total} requests = ${(r.m3.errorRate * 100).toFixed(3)} % (generator ${r.m3.generator.count}, presses ${r.m3.presses.count}, simulator webhooks ${r.m3.simulatorWebhooks.count}). Expected 4xx (not errors): ${JSON.stringify(r.m3.expected4xx)}.`,
    '',
    `Drain: ${r.world.presses - r.stuck.notDelivered}/${r.world.presses} delivered ${r.durations.drainS.toFixed(1)} s after the first press; open tasks ${JSON.stringify(r.stuck.openTasks)}; stuck outbox rows ${JSON.stringify(r.stuck.outboxLeft)} (due at the end: ${JSON.stringify(r.stuck.dueAtEnd)}); pending notifications ${JSON.stringify(r.stuck.pendingNotifications)}; timers scheduled later (no-ops when they fire) ${JSON.stringify(r.stuck.timersLater)}; WhatsApp per customer ${JSON.stringify(r.whatsapp.purposeTotals)} (duplicates ${r.whatsapp.duplicates}).`,
    '',
    table(
      ['Process', 'CPU % p50 / p95 / max', 'RSS max MB'],
      r.m5.resources.map((x) => [
        x.proc,
        `${Math.round(x.cpu.p50 ?? 0)} / ${Math.round(x.cpu.p95 ?? 0)} / ${Math.round(x.cpu.max ?? 0)}`,
        Math.round(x.rssMaxMb),
      ]),
    ),
    '',
    `DB connections (max per application; each process pools at most DATABASE_POOL_MAX = ${r.knobs.poolMax ?? 20}): ${JSON.stringify(r.m5.dbConnectionsMax)}.`,
    '',
    table(
      ['Route', 'n', 'p50', 'p95', 'max', '4xx', '5xx'],
      r.routes
        .sort((x, y) => y.count - x.count)
        .map((x) => [x.route, x.count, ms(x.p50), ms(x.p95), ms(x.max), x.s4xx, x.s5xx]),
    ),
    '',
    table(
      ['Worst requests', 'status', 'ms', 'at'],
      r.worst.map((w) => [w.route, `${w.status}${w.code ? ` ${w.code}` : ''}`, w.ms, w.at]),
    ),
    '',
    `Consistency: ${JSON.stringify(r.consistency)}. Schema invariants: ${r.invariants.passed ? 'ALL INVARIANT TESTS PASSED' : 'FAILED'}.`,
    '',
    'Metrics snapshot at the end of the run (selected series; full text in metrics-api.txt / metrics-worker.txt):',
    '',
    '```',
    ...Object.entries(r.metrics ?? {}).flatMap(([proc, lines]) => lines.map((l) => `${proc}  ${l}`)),
    '```',
  ];
  return lines.join('\n');
}

let ok = false;
try {
  ok = await main();
} catch (e) {
  console.error(`[load] FAILED: ${e?.stack ?? e}`);
} finally {
  if (dbSampler) clearInterval(dbSampler);
  usage?.stop();
  for (const p of [...procs].reverse()) await p.stop().catch(() => {});
  await pool?.end().catch(() => {});
  if (!K.keepDb) await dropDb(DB).catch((e) => console.error(`drop ${DB}: ${e.message}`));
}
process.exit(ok ? 0 : 1);
