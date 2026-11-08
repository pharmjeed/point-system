#!/usr/bin/env node
/**
 * `pnpm ops:rehearsal` — the automated full-event rehearsal (PNT-102): the scripted operational part of 17 H-10
 * (step 1, the TC-036 list) played by bots against the real processes, on a throwaway database.
 *
 * 1. Builds the backend packages (skip with REHEARSAL_SKIP_BUILD=1), creates a fresh database
 *    `point_rehearsal_<hex>` on ADMIN_DATABASE_URL / TEST_DATABASE_URL (a PostgreSQL 16 where we may CREATE
 *    DATABASE), applies the migrations and the dev/test seed of 17 §4.
 * 2. Boots the three processes of a deployment on ports 4201–4204 (REHEARSAL_PORT_BASE + 1 … + 4): the WhatsApp
 *    simulator (tools/wa-simulator), the api (apps/api/rehearsal/api-server.mjs = the built createApp + the
 *    in-memory bucket) and the real worker (apps/worker/dist/main.js), with the SystemMonitor on in both.
 * 3. Sets the night up through the API like the staff would: the owner (password + TOTP) syncs the templates; the
 *    administrator (password + TOTP) adds key slots and spots, shortens `ready.uncollected_alert_min` (17 §3.3
 *    accelerated settings) and creates the extra drivers (each changes his temporary PIN on first login); the
 *    supervisors close the previous shifts and open the night's shifts and events (RMS paid per vehicle,
 *    LYL included).
 * 4. Plays one evening on an accelerated schedule: ~16 drivers (8 per venue, plus the driving supervisor) with
 *    a WebSocket each (heartbeats, offers, `client.offer_seen`) and the PWA's `/v1/me/home` sync; ~150 cars arrive
 *    at both gates (WhatsApp and paper, photos uploaded through the presigned URLs); the WhatsApp customers press
 *    «طلب السيارة» in the simulator and hand their W-05 code to the driver, the supervisors ask for the paper
 *    cars, follow the alerts and handle the scripted moments (an early request, a field cancel, a no-show and its
 *    repark, a locked code and the exceptional handover, an opt-out, VIP waivers, a reversal with replacement,
 *    breaks, a driver who loses his connection with a car, a driver transfer: once LYL has taken in its last car,
 *    SUP-RL moves an idle LYL driver to RMS, who signs in again and serves RMS cars).
 * 5. Closes the night: start-closing, reconciliation, the cash each driver took handed over (one count five
 *    riyals short), close, shift close.
 * 6. Checks TC-036's expected results — nothing open after the close and the cash equal to what the bots took,
 *    `close_summary` saved, every action with its actor (each ticket's created/parked/delivered by, and every
 *    command's audit rows under its request id in the bot's name) — every scripted moment's outcome in the
 *    database, the invariants, and writes the report (counts, waits p50/p95, alerts raised/resolved, settlement
 *    totals, invariants) to docs/test-evidence/rehearsal/<date>-auto.md (REHEARSAL_REPORT; <date>.md is the
 *    human rehearsal's evidence, which an automated run must not overwrite: DEC-408). Then it stops everything
 *    and drops the database (REHEARSAL_KEEP_DB=1 keeps it); the process logs are kept, and their folder printed,
 *    only when the run fails or is interrupted (SIGINT / SIGTERM clean up the same way). Exit 0 = passed.
 *
 * REHEARSAL_SEED fixes the car plan (arrivals, dwell, channels, how each customer pays, the wrong codes, the
 * scripted moments) and gives every actor its own stream of draws (each driver, each car's customer); which offer
 * or car a draw meets still depends on the timing, so two runs with one seed play the same plan, not the same
 * interleaving.
 *
 * The human rehearsal with real staff, devices and the Meta test number (H-10, AC-12 TC-036 on staging, TC-037,
 * TC-038 — the paper outage drill and the backup restore) is NOT replaced by this run: it stays an owner task.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { generate as totpCode } from 'otplib';
import pg from 'pg';
import { io as connectSocket } from 'socket.io-client';
import {
  bucketQuantile,
  CLOSED_EVENT_CHECKS,
  DURATION_QUERIES,
  INVARIANT_QUERIES,
  percentile,
  promHistogram,
  routeOf,
  sar,
  secs,
  table,
} from './checks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../..');
const T0 = Date.now();
const today = new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------------------------------------ settings
const env = process.env;
const num = (k, d) => (env[k] ? Number(env[k]) : d);
const CFG = {
  admin:
    env.ADMIN_DATABASE_URL ?? env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres',
  base: num('REHEARSAL_PORT_BASE', 4200),
  tickets: num('REHEARSAL_TICKETS', 150),
  arrivalS: num('REHEARSAL_ARRIVAL_WINDOW_S', 240),
  dwellS: [num('REHEARSAL_DWELL_MIN_S', 60), num('REHEARSAL_DWELL_MAX_S', 300)],
  seed: num('REHEARSAL_SEED', 20261029),
  deadlineS: num('REHEARSAL_DEADLINE_S', 1500),
  report: env.REHEARSAL_REPORT ?? join(ROOT, 'docs/test-evidence/rehearsal', `${today}-auto.md`),
  keepDb: env.REHEARSAL_KEEP_DB === '1',
  skipBuild: env.REHEARSAL_SKIP_BUILD === '1',
};
if (CFG.base < 4200 || CFG.base + 4 > 4299)
  throw new Error('REHEARSAL_PORT_BASE must keep the ports in 4200–4299');
const PORT = { api: CFG.base + 1, sim: CFG.base + 2, apiMetrics: CFG.base + 3 }; // worker metrics = apiMetrics + 1
const API = `http://127.0.0.1:${PORT.api}`;
const SIM = `http://127.0.0.1:${PORT.sim}`;
const WORKER_METRICS = `http://127.0.0.1:${PORT.apiMetrics + 1}/metrics`;
const ORIGIN = `http://localhost:${CFG.base}`; // APP_BASE_URL: the staff web origin (CSRF, DEC-29); nothing listens
const COOKIE = 'point_sid';

const log = (...a) => console.log(`[rehearsal ${((Date.now() - T0) / 1000).toFixed(1).padStart(7)} s]`, ...a);

// ------------------------------------------------------------------------------------------------ seeded draws
/** FNV-1a of a stable key: every actor's stream starts from the seed and its own name. */
const hash32 = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/**
 * One actor's draws (mulberry32 from the seed and the actor's key): `stream('plan')` for the car plan,
 * `stream('driver:DRV1')`, `stream('car:RMS:12')` … — an actor's draws never depend on the other actors'.
 */
function stream(key) {
  let state = (CFG.seed ^ hash32(key)) >>> 0;
  const rnd = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const between = (a, b) => a + rnd() * (b - a);
  return {
    between,
    /** an integer in [a, b] */
    int: (a, b) => Math.floor(between(a, b + 1)),
    chance: (p) => rnd() < p,
    pick: (xs) => xs[Math.floor(rnd() * xs.length)],
    pause: (a, b) => sleep(Math.round(between(a, b) * 1000)),
  };
}

// ------------------------------------------------------------------------------------------------ run state
const children = [];
let stopping = false;
const failures = [];
const notes = [];
const fail = (m) => {
  if (interrupted) return; // the bots fail once their processes are gone: no report is written anyway
  failures.push(m);
  log(`FAIL ${m}`);
};
/** what the run created: stopped, dropped and removed at the end and on SIGINT / SIGTERM */
const run = { db: null, database: null, inv: null, pool: null, logDir: null };

/** HTTP statistics of every bot request (client side). */
const http = {
  total: 0,
  byStatus: new Map(),
  byCode: new Map(),
  latencyCmd: [],
  latencyRead: [],
  server5xx: [],
  unexpected: [],
};
/** 4xx/410 answers a busy evening produces by design (races between drivers, scripted wrong codes). */
const EXPECTED_REFUSALS = new Set([
  'TASK_ALREADY_CLAIMED',
  'OFFER_EXPIRED',
  'OFFER_REVOKED',
  'OFFER_NOT_FOUND',
  'NEXT_TASK_ALREADY_RESERVED',
  'OLDER_REQUEST_PENDING',
  'DRIVER_NOT_AVAILABLE',
  'HANDOVER_CODE_INVALID',
  'HANDOVER_CODE_LOCKED',
  'EVENT_CLOSE_BLOCKED',
]);
/**
 * WebSocket measures: `offerLatency` — an offer card at its recipient's socket, from the transaction that opened
 * the round (shown apart, not a 15 §10 target); `claimLatency` — 17 M2: `tasks.claimed_at` (the accept
 * transaction's time, the envelope's `occurred_at`) → `task.claimed` at the other connected drivers.
 */
const ws = { messages: new Map(), offerLatency: [], claimLatency: [], connects: 0, disconnects: 0 };
const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

/** Every command a bot sent with its Idempotency-Key that succeeded: its request id and the bot's user (TC-036). */
const commandLog = [];

/**
 * The money each collector took, per event, kept from the bots' own commands (the handovers with a payment, the
 * exceptional handover, the reversal with its replacement) — never read back from the server: the settlement's
 * per-driver amounts and the cash handovers are checked against it (13 §10–§11).
 */
const ledgers = new Map();
const ledgerOf = (eventId) => {
  if (!ledgers.has(eventId)) ledgers.set(eventId, new Map());
  return ledgers.get(eventId);
};
function took(eventId, userId, method, amount, n = 1) {
  const book = ledgerOf(eventId);
  const l = book.get(userId) ?? { cash: 0, cashCount: 0, pos: 0, posCount: 0 };
  if (method === 'cash') {
    l.cash += amount;
    l.cashCount += n;
  } else {
    l.pos += amount;
    l.posCount += n;
  }
  book.set(userId, l);
}

/** The outcomes of the scripted moments that are not on one car (the cars keep theirs in `car.done`). */
const moments = { transfer: null, plannedBreaks: 0, breaks: [], shortfall: null };

// ------------------------------------------------------------------------------------------------ processes
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
}

function start(name, args, processEnv, logDir) {
  const file = join(logDir, `${name}.log`);
  const out = createWriteStream(file);
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { PATH: env.PATH, HOME: env.HOME, ...processEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  child.on('exit', (code, signal) => {
    if (!stopping) fail(`${name} exited (${code ?? signal}) — see ${file}`);
  });
  children.push({ name, child, file });
  return child;
}

async function waitFor(what, fn, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return;
    } catch {
      // not yet
    }
    if (Date.now() > until) throw new Error(`timeout waiting for ${what}`);
    await sleep(250);
  }
}

async function stopAll() {
  stopping = true;
  for (const c of [...children].reverse()) {
    if (c.child.exitCode !== null || c.child.signalCode !== null) continue;
    c.child.kill('SIGTERM');
    await Promise.race([new Promise((r) => c.child.once('exit', r)), sleep(5000)]);
    if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill('SIGKILL');
  }
}

// ------------------------------------------------------------------------------------------------ HTTP client
/** One staff device: its own session cookie and (behind the reverse proxy, TRUST_PROXY=1) its own address. */
class Client {
  static seq = 10;
  constructor(label, userId = null) {
    this.label = label;
    /** the user the device signs in as: every command it sends must be audited in this name (TC-036) */
    this.userId = userId;
    this.ip = `10.42.${Math.floor(Client.seq / 250)}.${(Client.seq++ % 250) + 1}`;
    this.cookie = null;
  }
  async call(method, path, body, opts = {}) {
    const headers = { 'X-Forwarded-For': this.ip, 'X-Requested-With': 'point-web', Origin: ORIGIN };
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const command = method !== 'GET';
    const keyed = command && opts.key !== false;
    if (keyed) headers['Idempotency-Key'] = randomUUID();
    const t = performance.now();
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      http.server5xx.push(`${method} ${routeOf(path)}: network ${e.message}`);
      return { status: 0, data: null, error: { code: 'NETWORK' } };
    }
    const ms = performance.now() - t;
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    for (const c of res.headers.getSetCookie?.() ?? [])
      if (c.startsWith(`${COOKIE}=`)) this.cookie = c.split(';')[0];
    http.total++;
    bump(http.byStatus, res.status);
    (command ? http.latencyCmd : http.latencyRead).push(ms);
    const code = json?.error?.code;
    if (code) bump(http.byCode, code);
    if (res.status >= 500) http.server5xx.push(`${method} ${routeOf(path)} ${res.status} ${code ?? ''}`);
    else if (res.status >= 400 && !EXPECTED_REFUSALS.has(code) && !(opts.allow ?? []).includes(code))
      http.unexpected.push(
        `${this.label}: ${method} ${routeOf(path)} → ${res.status} ${code} ${JSON.stringify(json?.error?.details ?? {})}`,
      );
    if (keyed && res.status < 300 && json?.meta?.request_id)
      commandLog.push({
        requestId: json.meta.request_id,
        userId: this.userId,
        label: this.label,
        route: `${method} ${routeOf(path)}`,
      });
    return {
      status: res.status,
      data: json?.data ?? null,
      error: json?.error ?? null,
      meta: json?.meta ?? null,
    };
  }
  get = (path, opts) => this.call('GET', path, undefined, opts);
  post = (path, body = {}, opts) => this.call('POST', path, body, opts);
  put = (path, body, opts) => this.call('PUT', path, body, opts);
  patch = (path, body, opts) => this.call('PATCH', path, body, opts);
}

/** `POST /v1/auth/login` (+ `mfa/verify` with the TOTP code of the seeded secret). */
async function login(client, phone, secret, totpSecret) {
  const r = await client.post(
    '/v1/auth/login',
    { phone, secret, device_label: client.label },
    { key: false },
  );
  if (r.status !== 200) throw new Error(`login of ${client.label} failed: ${r.status} ${r.error?.code}`);
  if (r.data.mfa_required) {
    const code = await totpCode({ secret: totpSecret, epoch: Math.floor(Date.now() / 1000) });
    const v = await client.post('/v1/auth/mfa/verify', { mfa_token: r.data.mfa_token, code }, { key: false });
    if (v.status !== 200) throw new Error(`MFA of ${client.label} failed: ${v.status} ${v.error?.code}`);
    return v.data;
  }
  return r.data;
}

const must = (r, what, status = [200, 201]) => {
  if (!status.includes(r.status)) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.error)}`);
  return r.data;
};

/** A car in failure messages and notes: never its phone, plate or code (the report is committed evidence). */
const carLabel = (car) => `${car.venue.key} car ${car.idx} (#${car.displayNumber ?? '?'})`;
/** A user in the report: the bot's key (seed key or employee code), never a name or a phone. */
const keyOf = (userId) => DRIVERS.find((d) => d.userId === userId)?.key ?? USER_KEYS.get(userId) ?? userId;
const USER_KEYS = new Map();

// ------------------------------------------------------------------------------------------------ main
async function main() {
  const logDir = mkdtempSync(join(tmpdir(), 'point-rehearsal-'));
  run.logDir = logDir;
  log(`logs in ${logDir}; ports ${PORT.api}/${PORT.sim}/${PORT.apiMetrics}/${PORT.apiMetrics + 1}`);
  if (!CFG.skipBuild) {
    log('building the backend packages');
    sh('pnpm', [
      ...['--filter', '@point/shared', '--filter', '@point/db', '--filter', '@point/server'],
      ...['--filter', '@point/api', '--filter', '@point/worker', '--filter', '@point/wa-simulator'],
      'build',
    ]);
  }
  const db = await import('@point/db');
  run.db = db;
  const { seed, SEED_IDS, SEED_CREDENTIALS } = await import('@point/db/seed');
  const { setSupervisorMfaRequired } = await import('@point/server/testing');
  const { BRAND_DEFAULTS } = await import('@point/shared');
  const { SimulatorClient } = await import('../../../tools/wa-simulator/dist/index.js');

  // ---------------------------------------------------------------------------- database
  const database = await db.createDatabase(CFG.admin, 'point_rehearsal');
  run.database = database;
  log(`database ${database.name}`);
  const b64 = (n = 32) => randomBytes(n).toString('base64');
  const secrets = {
    SESSION_SECRET: b64(),
    CODE_PEPPER: b64(),
    AUTH_SECRET_PEPPER: b64(),
    DATA_ENCRYPTION_KEY: b64(),
    DATA_ENCRYPTION_KEY_ID: 'rh1',
    WA_ACCESS_TOKEN: randomBytes(18).toString('hex'),
    WA_APP_SECRET: randomBytes(18).toString('hex'),
    WA_VERIFY_TOKEN: randomBytes(12).toString('hex'),
  };
  let pool;
  let report = null;
  try {
    await db.migrate(database.url);
    pool = new pg.Pool({ connectionString: database.url, max: 4 });
    run.pool = pool;
    await seed(pool, {
      env: 'test',
      nodeEnv: 'test',
      dataEncryptionKey: secrets.DATA_ENCRYPTION_KEY,
      dataEncryptionKeyId: secrets.DATA_ENCRYPTION_KEY_ID,
      secretPepper: secrets.AUTH_SECRET_PEPPER,
    });
    // the seed gives TOTP secrets to the owner and the administrator only; supervisors sign in with their password
    await setSupervisorMfaRequired(pool, SEED_IDS.org, false);
    for (const [k, id] of Object.entries(SEED_IDS.users)) USER_KEYS.set(id, k);

    // ---------------------------------------------------------------------------- processes
    const common = {
      NODE_ENV: 'production',
      APP_ENV: 'local',
      TZ: 'UTC',
      LOG_LEVEL: 'info',
      APP_VERSION: `rehearsal-${today}`,
      APP_BASE_URL: ORIGIN,
      API_PORT: String(PORT.api),
      ...BRAND_DEFAULTS,
      DATABASE_URL: database.url,
      SESSION_COOKIE_NAME: COOKIE,
      SESSION_COOKIE_SECURE: 'false',
      ...secrets,
      WA_MODE: 'simulator',
      WA_GRAPH_BASE_URL: SIM,
      WA_DISPLAY_PHONE_E164: '+966500000999',
      METRICS_ENABLED: 'true',
      METRICS_PORT: String(PORT.apiMetrics),
      MONITOR_INTERVAL_S: '10',
      TRUST_PROXY: '1',
    };
    start(
      'wa-simulator',
      ['tools/wa-simulator/dist/main.js'],
      {
        PORT: String(PORT.sim),
        HOST: '127.0.0.1',
        APP_SECRET: secrets.WA_APP_SECRET,
        ACCESS_TOKEN: secrets.WA_ACCESS_TOKEN,
        VERIFY_TOKEN: secrets.WA_VERIFY_TOKEN,
        PHONE_NUMBER_ID: 'SIM-PHONE',
        WABA_ID: 'SIM-WABA',
        DISPLAY_PHONE_E164: '+966500000999',
        WEBHOOK_URL: `${API}/webhooks/whatsapp`,
        AUTO_STATUSES: 'true',
        STATUS_DELAY_MS: '200',
        WEBHOOK_RETRIES: '3',
      },
      logDir,
    );
    start('api', ['apps/api/rehearsal/api-server.mjs'], common, logDir);
    start('worker', ['apps/worker/dist/main.js'], { ...common, WORKER_ID: 'rehearsal-worker-1' }, logDir);
    const sim = new SimulatorClient(SIM);
    await waitFor('the simulator', async () => (await sim.health()).ok);
    await waitFor('the api', async () => (await fetch(`${API}/health/ready`)).status === 200);
    await waitFor('the worker metrics', async () => (await fetch(WORKER_METRICS)).ok);
    log('api, worker and simulator are up');

    const world = await setUp({ SEED_IDS, SEED_CREDENTIALS, sim });
    const started = Date.now();
    await playEvening(world);
    await closeNight(world);
    const playedS = Math.round((Date.now() - started) / 1000);
    await sleep(3000); // the worker projects the last events
    report = await measure({ world, pool, db, playedS, logDir, database });
  } catch (e) {
    fail(`aborted: ${e.stack ?? e.message}`);
  } finally {
    for (const d of DRIVERS) d.stop();
    await stopAll();
    if (report) {
      const text = report(failures);
      mkdirSync(dirname(CFG.report), { recursive: true });
      writeFileSync(CFG.report, text);
      log(`report written to ${relative(ROOT, CFG.report)}`);
    }
    await pool?.end().catch(() => {});
    run.pool = null;
    if (!CFG.keepDb) await db.dropDatabase(CFG.admin, database.name).catch(() => {});
    else log(`database kept: ${database.url}`);
    run.database = null;
  }
  if (failures.length) {
    console.error(`REHEARSAL FAILED:\n - ${failures.join('\n - ')}`);
    log(`process logs kept in ${logDir}`);
    process.exit(1);
  }
  rmSync(logDir, { recursive: true, force: true });
  log('REHEARSAL PASSED');
}

// ------------------------------------------------------------------------------------------------ the world
const DRIVERS = [];
const cars = [];
const carByTicket = new Map();

async function setUp({ SEED_IDS, SEED_CREDENTIALS, sim }) {
  const C = SEED_CREDENTIALS;
  const owner = new Client('OWN1', SEED_IDS.users.OWN1);
  await login(owner, C.OWN1.phone, C.OWN1.secret, C.OWN1.totpSecret);
  must(await owner.post('/v1/admin/whatsapp/templates/sync', {}), 'template sync');
  const templates = must(await owner.get('/v1/admin/whatsapp/templates'), 'templates');
  const approved = (templates.data ?? templates).filter?.((x) => x.status === 'approved').length ?? 0;
  notes.push(`templates synced: ${approved} approved`);

  const admin = new Client('ADM1', SEED_IDS.users.ADM1);
  await login(admin, C.ADM1.phone, C.ADM1.secret, C.ADM1.totpSecret);
  const venues = {
    RMS: {
      key: 'RMS',
      id: SEED_IDS.venues.RMS,
      board: SEED_IDS.keyBoards.RMS,
      slots: [61, 120],
      spots: ['C-', 1, 60],
    },
    LYL: {
      key: 'LYL',
      id: SEED_IDS.venues.LYL,
      board: SEED_IDS.keyBoards.LYL,
      slots: [41, 110],
      spots: ['P2-', 1, 60],
    },
  };
  for (const v of Object.values(venues)) {
    // the big night: more key slots and an overflow zone (S-13 layout)
    must(
      await admin.post(`/v1/key-boards/${v.board}/slots`, { range: { from: v.slots[0], to: v.slots[1] } }),
      `slots of ${v.key}`,
    );
    const zone = must(
      await admin.post(`/v1/venues/${v.id}/parking-zones`, { name: `${v.key} overflow` }),
      `zone of ${v.key}`,
    );
    must(
      await admin.post(`/v1/venues/${v.id}/parking-spots`, {
        zone_id: zone.id,
        range: { prefix: v.spots[0], from: v.spots[1], to: v.spots[2] },
      }),
      `spots of ${v.key}`,
    );
    // 17 §3.3: accelerated settings — a car ready and not collected is flagged after 2 minutes (min of the schema)
    const s = must(await admin.get(`/v1/venues/${v.id}/settings`), 'settings');
    s.settings.ready.uncollected_alert_min = 2;
    must(
      await admin.put(`/v1/venues/${v.id}/settings`, { expected_version: s.version, settings: s.settings }),
      'settings',
    );
    v.spotsFree = [];
    for (let cursor = null, first = true; first || cursor; first = false) {
      const page = await admin.get(
        `/v1/venues/${v.id}/parking-spots?active_only=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      must(page, 'spots');
      for (const s2 of page.data) v.spotsFree.push(s2.id);
      cursor = page.meta?.next_cursor ?? null;
    }
    const boards = must(await admin.get(`/v1/venues/${v.id}/key-boards`), 'boards');
    v.slotsFree = boards.flatMap((b) => b.slots.filter((x) => x.status === 'active').map((x) => x.id));
    v.cars = [];
    v.drivers = [];
  }

  // the extra drivers of the night (S-05): created by the administrator, temporary PIN changed at first login
  const extra = [
    ['RMS', 'سائق الدعم 1'],
    ['RMS', 'سائق الدعم 2'],
    ['LYL', 'سائق ليلتي 3'],
    ['LYL', 'سائق ليلتي 4'],
    ['LYL', 'سائق ليلتي 5'],
    ['LYL', 'سائق ليلتي 6'],
    ['LYL', 'سائق ليلتي 7'],
    ['LYL', 'سائق ليلتي 8'],
  ];
  const created = [];
  for (const [i, [venue, name]] of extra.entries()) {
    const phone = `+96655870${String(i + 11).padStart(4, '0')}`;
    const r = must(
      await admin.post('/v1/drivers', { full_name: name, phone, initial_venue_id: venues[venue].id }),
      `driver ${name}`,
    );
    created.push({ key: r.driver.employee_code, venue, phone, pin: r.temporary_secret, id: r.driver.id });
  }

  // supervisors: SUP-R runs RMS, SUP-RL runs LYL (he has both venues), SUP-RD drives in RMS when needed
  const supR = new Client('SUP-R', SEED_IDS.users['SUP-R']);
  await login(supR, C['SUP-R'].phone, C['SUP-R'].secret);
  const supL = new Client('SUP-RL', SEED_IDS.users['SUP-RL']);
  await login(supL, C['SUP-RL'].phone, C['SUP-RL'].secret);
  venues.RMS.sup = supR;
  venues.LYL.sup = supL;
  const now = new Date();
  const night = {
    RMS: {
      name: 'حفل زفاف — بروفة آلية',
      pricing_mode: 'per_vehicle',
      fee_halalas: 2000,
      allowed_payment_methods: ['cash', 'pos'],
    },
    LYL: { name: 'حفل تخرج — بروفة آلية', pricing_mode: 'included' },
  };
  for (const v of Object.values(venues)) {
    const old = SEED_IDS.shifts[v.key === 'RMS' ? 'SHF-R' : 'SHF-L'];
    must(await v.sup.post(`/v1/shifts/${old}/close`, {}), 'close the previous shift');
    const shift = must(
      await v.sup.post(`/v1/venues/${v.id}/shifts`, {
        name: 'وردية الحفل',
        starts_at: now.toISOString(),
        ends_at: new Date(now.getTime() + 6 * 3600_000).toISOString(),
      }),
      'create the shift',
    );
    must(await v.sup.post(`/v1/shifts/${shift.id}/open`, {}), 'open the shift');
    v.shiftId = shift.id;
    const n = night[v.key];
    const ev = must(
      await v.sup.post(`/v1/venues/${v.id}/events`, {
        name_ar: n.name,
        event_date: today,
        starts_at: now.toISOString(),
        ends_at: new Date(now.getTime() + 5 * 3600_000).toISOString(),
        pricing_mode: n.pricing_mode,
        ...(n.fee_halalas
          ? { fee_halalas: n.fee_halalas, allowed_payment_methods: n.allowed_payment_methods }
          : {}),
      }),
      'create the event',
    );
    must(await v.sup.post(`/v1/events/${ev.id}/open`, {}), 'open the event');
    v.eventId = ev.id;
    v.paid = n.pricing_mode === 'per_vehicle';
  }

  // the drivers sign in on their phones
  const roster = [
    ...['DRV1', 'DRV2', 'DRV3', 'DRV4', 'DRV5', 'DRV6'].map((k) => ({
      key: k,
      venue: 'RMS',
      phone: C[k].phone,
      pin: C[k].secret,
      id: SEED_IDS.users[k],
    })),
    ...['DRV7', 'DRV8'].map((k) => ({
      key: k,
      venue: 'LYL',
      phone: C[k].phone,
      pin: C[k].secret,
      id: SEED_IDS.users[k],
    })),
    ...created,
  ];
  for (const r of roster) {
    const d = new Driver(r, venues[r.venue], sim);
    await d.signIn();
    DRIVERS.push(d);
    venues[r.venue].drivers.push(d);
  }
  const supRD = new Driver(
    {
      key: 'SUP-RD',
      venue: 'RMS',
      phone: C['SUP-RD'].phone,
      pin: C['SUP-RD'].secret,
      id: SEED_IDS.users['SUP-RD'],
      supervisor: true,
    },
    venues.RMS,
    sim,
  );
  await supRD.signIn();
  DRIVERS.push(supRD);
  log(`set up: ${roster.length} drivers + SUP-RD, events ${venues.RMS.eventId} / ${venues.LYL.eventId}`);
  return { venues, sim, supRD, owner, admin };
}

// ------------------------------------------------------------------------------------------------ drivers
let phoneSeq = 0;
const reservedSuffix = (p) => /(0000|1111|2222)$/.test(p); // simulator fault numbers (12 §11.3)

class Driver {
  constructor(r, venue, sim) {
    Object.assign(this, {
      key: r.key,
      phone: r.phone,
      pin: r.pin,
      userId: r.id,
      venue,
      sim,
      supervisor: !!r.supervisor,
    });
    this.client = new Client(r.key, r.id);
    this.rng = stream(`driver:${r.key}`);
    this.onDuty = false;
    this.busy = false;
    this.offline = false;
    this.stopped = false;
    /** the phone stays on its home screen (the supervisor is moving him to another venue) */
    this.paused = false;
    /** one PWA loop at a time: a new duty (after a transfer) ends the previous loop */
    this.gen = 0;
    this.decided = new Set();
    this.home = null;
    this.socket = null;
    this.timer = null;
  }

  async signIn() {
    const me = await login(this.client, this.phone, this.pin);
    if (me.must_change_secret) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const pin = String(this.rng.int(120000, 989999));
        const r = await this.client.post(
          '/v1/auth/secret/change',
          { current_secret: this.pin, new_secret: pin },
          { key: false, allow: ['VALIDATION_FAILED'] },
        );
        if (r.status === 200) {
          this.pin = pin;
          break;
        }
      }
      const again = await this.client.get('/v1/me', {
        allow: ['AUTH_SESSION_REVOKED', 'AUTH_UNAUTHENTICATED'],
      });
      if (again.status === 401) await login(this.client, this.phone, this.pin);
    }
    const device = must(
      await this.client.post(
        '/v1/me/devices',
        {
          label: `${this.key} phone`,
          platform: this.rng.pick(['android', 'ios']),
          display_mode: 'standalone',
          notification_permission: 'granted',
        },
        { key: false },
      ),
      `device of ${this.key}`,
    );
    this.deviceId = device.id;
    must(
      await this.client.post(
        '/v1/me/audio-test',
        { device_id: this.deviceId, result: 'heard' },
        { key: false },
      ),
      'audio test',
    );
    const meRes = must(await this.client.get('/v1/me'), 'me');
    this.userId = meRes.user?.id ?? this.userId;
    this.client.userId = this.userId;
    await this.client.post(
      '/v1/telemetry',
      {
        app_version: 'rehearsal',
        device_id: this.deviceId,
        client_session_id: `rh-${this.key}`,
        events: [
          {
            name: 'app_started',
            occurred_at: new Date().toISOString(),
            properties: {
              display_mode: 'standalone',
              platform: 'android',
              browser_family: 'chrome',
              browser_major: 141,
            },
          },
          {
            name: 'audio_test_completed',
            occurred_at: new Date().toISOString(),
            properties: { result: 'heard', audio_api: 'web_audio', context: 'duty_start' },
          },
        ],
      },
      { key: false },
    );
  }

  connect() {
    this.socket = connectSocket(API, {
      path: '/ws',
      transports: ['websocket'],
      extraHeaders: { Cookie: this.client.cookie, Origin: ORIGIN },
      reconnection: true,
      reconnectionDelay: 1000,
    });
    this.socket.on('connect', () => ws.connects++);
    this.socket.on('disconnect', () => ws.disconnects++);
    this.socket.onAny((event, envl) => {
      bump(ws.messages, event);
      if ((event === 'task.offered' || event === 'task.broadcast') && envl?.occurred_at) {
        const latency = Date.now() - Date.parse(envl.occurred_at);
        ws.offerLatency.push(latency);
        const offerId = envl.payload?.offer_id;
        if (offerId)
          this.socket.emit('client.offer_seen', {
            offer_id: offerId,
            receive_latency_ms: Math.max(0, latency),
          });
      }
      // 17 M2: the accept committed at `claimed_at` (= the envelope's occurred_at, the accept's tx.now); the
      // other drivers' sockets learn it now
      const winner = envl?.payload?.claimed_by?.id;
      if (event === 'task.claimed' && envl?.occurred_at && winner && winner !== this.userId)
        ws.claimLatency.push(Date.now() - Date.parse(envl.occurred_at));
    });
    this.timer = setInterval(() => {
      if (!this.offline && this.socket?.connected)
        this.socket.emit('client.heartbeat', {
          visible: true,
          audio_unlocked: true,
          app_version: 'rehearsal',
        });
    }, 15_000);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.socket?.close();
  }

  async startDuty() {
    must(await this.client.post('/v1/me/duty/start', { device_id: this.deviceId }), `duty of ${this.key}`);
    this.onDuty = true;
    this.connect();
    void this.loop(++this.gen);
  }

  /** The PWA: sync `/v1/me/home`, react to the head offer, advance the current task one step at a time. */
  async loop(gen) {
    while (!this.stopped && this.onDuty && gen === this.gen) {
      if (this.offline || this.onBreak || this.busy || this.paused) {
        await sleep(300);
        continue;
      }
      const r = await this.client.get('/v1/me/home', { allow: ['AUTH_SESSION_REVOKED'] });
      if (r.status === 200 && gen === this.gen) {
        this.home = r.data;
        // the gate may have handed him a car while the screen was loading: the car first
        if (this.busy || this.onBreak || this.offline || this.paused) continue;
        this.stepping = true;
        try {
          await this.step(r.data);
        } catch (e) {
          fail(`${this.key} step: ${e.message}`);
        } finally {
          this.stepping = false;
        }
      }
      await sleep(Math.round(this.rng.between(500, 900)));
    }
  }

  async step(h) {
    if (h.driver_state === 'off_duty') return;
    const offer = h.offer;
    if (offer && (offer.can_accept || offer.can_reserve_next) && !this.decided.has(offer.offer_id)) {
      this.decided.add(offer.offer_id);
      // 6 % of the single offers are missed (in the car park, the phone in a pocket): reminder, expiry, rotation
      if (offer.mode === 'single' && this.rng.chance(0.06)) return;
      await this.rng.pause(1, 4);
      if (this.busy || this.onBreak || this.paused) return; // busy at the gate: the offer runs out and moves on
      const a = await this.client.post(`/v1/task-offers/${offer.offer_id}/accept`, {});
      if (a.status === 200) {
        const car = carByTicket.get(a.data.ticket?.id);
        if (car) car.driver = this;
      }
      return;
    }
    const cur = h.current_task;
    if (!cur) return;
    const t = cur.task;
    const car = carByTicket.get(cur.ticket.id);
    if (t.type === 'retrieve' && t.status === 'accepted') {
      if (car) car.driver = this;
      // the field-cancel guest tells the supervisor at the gate he stays longer before the key leaves its slot
      if (car?.fieldCancel && !car.done.fieldCancel) {
        car.holdUntil ??= Date.now() + 30_000;
        if (Date.now() < car.holdUntil) return;
      }
      if (!t.key_picked_up_at) {
        await this.rng.pause(2, 5);
        const r = await this.client.post(`/v1/tasks/${t.id}/key-pickup`, { key_slot_id: cur.key_slot?.id });
        if (r.status === 200 && car?.slotId) {
          this.venue.slotsFree.push(car.slotId);
          car.slotId = null;
        }
      } else {
        await this.rng.pause(2, 4);
        const r = await this.client.post(`/v1/tasks/${t.id}/start-retrieval`, {});
        if (r.status === 200) {
          if (car?.spotId) {
            this.venue.spotsFree.push(car.spotId);
            car.spotId = null;
          }
          if (car?.basement && !car.done.basement) void this.loseNetwork(130, car);
        }
      }
    } else if (t.type === 'retrieve' && t.status === 'in_progress') {
      if (cur.ticket.status === 'retrieving') {
        await this.rng.pause(6, 14);
        await this.client.post(`/v1/tasks/${t.id}/ready`, {});
      } else if (cur.ticket.status === 'ready' && car) {
        await this.handOver(cur, car);
      }
    } else if (t.type === 'repark' && t.status === 'in_progress') {
      await this.rng.pause(5, 10);
      await this.park(t.id, car);
    }
  }

  async handOver(cur, car) {
    if (car.noShow && !car.reparked) return; // the customer is not there: the supervisor follows the alert
    if (car.lockAt === undefined && car.lockScenario) {
      // the guest reads the wrong message: five wrong codes lock it (the supervisor's exception follows)
      car.lockAt = Date.now();
      const real = (await this.sim.claimCodeDetails(car.phone).catch(() => null))?.code;
      for (const planned of car.wrongCodes) {
        await this.rng.pause(1, 2);
        const code =
          planned !== real ? planned : planned === '999999' ? '100000' : String(Number(planned) + 1);
        await this.client.post(`/v1/tickets/${car.ticketId}/handover`, {
          verification: { method: 'code', code },
          ...(cur.payment_due
            ? { payment: { method: 'cash', amount_halalas: cur.payment_due.amount_halalas } }
            : {}),
        });
      }
      car.lockedBy = this.userId;
      return;
    }
    if (car.lockScenario) return;
    if (!car.atGate) {
      car.atGate = Date.now() + Math.round(car.rng.between(2, 7) * 1000);
      return;
    }
    if (Date.now() < car.atGate) return;
    let verification;
    if (car.channel === 'whatsapp') {
      const c = await this.sim.claimCodeDetails(car.phone).catch(() => null);
      if (!c || c.seq <= (car.codeSeqUsed ?? -1)) return; // W-05 not on his phone yet
      verification = { method: 'code', code: c.code };
      car.codeSeqUsed = c.seq;
      car.codes.push(c.code);
    } else verification = { method: 'paper_stub', paper_serial: car.serial };
    let payment;
    if (cur.payment_due) {
      // how this customer pays was drawn with the car plan (seeded)
      payment =
        car.forcePos || car.payPos
          ? { method: 'pos', amount_halalas: cur.payment_due.amount_halalas, pos_reference: car.posRef }
          : { method: 'cash', amount_halalas: cur.payment_due.amount_halalas };
    }
    await this.rng.pause(1, 3);
    const r = await this.client.post(`/v1/tickets/${car.ticketId}/handover`, {
      verification,
      ...(payment ? { payment } : {}),
    });
    if (r.status === 200) {
      car.deliveredAt = Date.now();
      car.payment = r.data.payment ?? null;
      car.by.delivered = this.userId;
      if (payment) {
        car.collector = this.userId;
        took(car.venue.eventId, this.userId, payment.method, payment.amount_halalas);
      }
    } else car.atGate = undefined;
  }

  async park(taskId, car) {
    const v = this.venue;
    const spotId = v.spotsFree.shift();
    const slotId = v.slotsFree.shift();
    const r = await this.client.post(`/v1/tasks/${taskId}/complete-parking`, {
      parking_spot_id: spotId,
      key_slot_id: slotId,
    });
    if (r.status === 200) {
      if (car) {
        Object.assign(car, { spotId, slotId, parkedAt: Date.now() });
        car.by.parked = this.userId;
      }
      return r;
    }
    v.spotsFree.push(spotId);
    v.slotsFree.push(slotId);
    return r;
  }

  /** A car arrives at the gate: intake through the photos' presigned uploads, then parking. */
  async intake(car) {
    this.busy = true;
    try {
      const v = this.venue;
      // the gate picked him while an offer was reaching his phone: he took the offer, another driver takes the car
      const c = await this.client.post(
        '/v1/tickets',
        { event_id: v.eventId, channel: car.channel },
        { allow: ['MOVEMENT_IN_PROGRESS', 'DRIVER_ON_BREAK'] },
      );
      if (['MOVEMENT_IN_PROGRESS', 'DRIVER_ON_BREAK'].includes(c.error?.code)) return 'again';
      if (c.status !== 201) return false;
      car.ticketId = c.data.ticket.id;
      car.displayNumber = c.data.ticket.display_number;
      car.by.created = this.userId;
      carByTicket.set(car.ticketId, car);
      const parkTaskId = c.data.task.id;
      await this.rng.pause(2, 4);
      const p = await this.client.patch(`/v1/tickets/${car.ticketId}/intake`, {
        expected_version: c.data.ticket.version,
        plate: { digits: car.plate, letters_ar: car.letters },
        vehicle: { make: car.make, model: car.model, color: car.color, type: car.type },
        key_tag: car.keyTag,
        ...(car.channel === 'whatsapp'
          ? { customer_phone: car.phone, consent: { method: 'verbal_staff_confirmed', confirmed: true } }
          : { paper_serial: car.serial }),
      });
      if (p.status !== 200) return false;
      for (const kind of ['photo_front', 'photo_rear', 'photo_left', 'photo_right']) {
        const m = await this.client.post(`/v1/tickets/${car.ticketId}/media`, {
          kind,
          content_type: 'image/jpeg',
          byte_size: JPEG.length,
          captured_at: new Date().toISOString(),
        });
        if (m.status !== 201) return false;
        const put = await fetch(`${API}/__rehearsal/storage`, {
          method: 'PUT',
          headers: { 'x-presigned-url': m.data.upload.url, 'content-type': 'image/jpeg' },
          body: JPEG,
        });
        if (put.status !== 200) fail(`photo upload ${put.status} ${await put.text()}`);
        await this.client.post(`/v1/media/${m.data.media.id}/complete`, {});
      }
      const t = await this.client.get(`/v1/tickets/${car.ticketId}`);
      const s = await this.client.post(`/v1/tickets/${car.ticketId}/submit-intake`, {
        expected_version: t.data.version,
      });
      if (s.status !== 200) return false;
      car.submittedAt = Date.now();
      if (car.earlyPress) {
        void customerLeavesEarly(car);
        // the guest presses while his car is driven to its spot: the request waits for the parking (TT-07, DEC-13)
        for (let i = 0; i < 60 && !stopping; i++) {
          const k = await this.client.get(`/v1/tickets/${car.ticketId}`);
          if (k.data?.pending_retrieval_at) break;
          await sleep(500);
        }
      }
      await this.rng.pause(4, 10); // driving to the spot
      const r = await this.park(parkTaskId, car);
      if (r.status !== 200) return false;
      scheduleDeparture(car);
      return true;
    } finally {
      this.busy = false;
    }
  }

  /** The basement: no network for `seconds` (no heartbeat, no request), then back. */
  async loseNetwork(seconds, car) {
    car.done.basement = this.userId;
    this.offline = true;
    this.socket?.disconnect();
    notes.push(`${this.key} lost the network for ${seconds} s with a car`);
    await sleep(seconds * 1000);
    this.socket?.connect();
    this.offline = false;
    await this.client.post(
      '/v1/me/heartbeat',
      { visible: true, audio_unlocked: true, ws_connected: true },
      { key: false },
    );
  }

  /** A prayer break once his hands are free (S-01 refuses it with a task or a car/key in custody); a few tries. */
  async takeBreak(seconds) {
    for (let attempt = 0; attempt < 8 && !stopping; attempt++) {
      for (let i = 0; i < 240 && (this.busy || this.home?.current_task || this.home?.next_task); i++)
        await sleep(500);
      this.onBreak = true;
      while (this.busy || this.stepping) await sleep(200);
      const r = await this.client.post(
        '/v1/me/duty/break',
        { active: true },
        { allow: ['DRIVER_NOT_AVAILABLE', 'CUSTODY_OPEN', 'INVALID_STATE_TRANSITION'] },
      );
      if (r.status === 200) {
        moments.breaks.push({ key: this.key, userId: this.userId });
        notes.push(`${this.key} took a ${seconds} s break`);
        await sleep(seconds * 1000);
        await this.client.post('/v1/me/duty/break', { active: false });
        this.onBreak = false;
        return;
      }
      this.onBreak = false;
      await sleep(2000);
    }
  }

  /**
   * 10 §9.7 (AC-10): the transfer ended his duty and revoked every session of his; his phone is back on the
   * sign-in screen. He signs in again and starts his duty in the new venue's pool.
   */
  async moveTo(venue) {
    this.gen++; // the old PWA loop ends
    this.onDuty = false;
    if (this.timer) clearInterval(this.timer);
    this.socket?.close();
    const from = this.venue;
    from.drivers.splice(from.drivers.indexOf(this), 1);
    const old = await this.client.get('/v1/me', { allow: ['AUTH_SESSION_REVOKED'] });
    if (old.error?.code !== 'AUTH_SESSION_REVOKED')
      fail(`transfer: the session of ${this.key} still answers (${old.status})`);
    this.client.cookie = null;
    await login(this.client, this.phone, this.pin);
    this.venue = venue;
    this.home = null;
    venue.drivers.push(this);
    this.paused = false;
    await this.startDuty();
  }
}

// 24×16 JPEG (the media module re-encodes it without its metadata on completion)
const JPEG = Buffer.from(
  '/9j/4QFYRXhpZgAASUkqAAgAAAAJAA8BAgALAAAAkAAAABABAgAGAAAAigAAABIBAwABAAAABgAAABoBBQABAAAAegAAABsBBQABAAAAggAAACgBAwABAAAAAgAAABMCAwABAAAAAQAAAGmHBAABAAAAnAAAACWIBAABAAAA6gAAAAAAAAA4YwAA6AMAADhjAADoAwAAR1BTLTEARml4dHVyZUNhbQAABgAAkAcABAAAADAyMTABkQcABAAAAAECAwAAoAcABAAAADAxMDABoAMAAQAAAP//AAACoAQAAQAAABgAAAADoAQAAQAAABAAAAAAAAAABAABAAIAAgAAAE4AAAACAAUAAwAAADgBAAADAAIAAgAAAEUAAAAEAAUAAwAAACABAAAAAAAALgAAAAEAAAAoAAAAAQAAALAEAABkAAAAGAAAAAEAAAAqAAAAAQAAABAOAABkAAAA/+IB8ElDQ19QUk9GSUxFAAEBAAAB4GxjbXMEIAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQAAAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5keem/Vlo+AbaDI4VVRvdPqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKZGVzYwAAAPwAAAAkY3BydAAAASAAAAAid3RwdAAAAUQAAAAUY2hhZAAAAVgAAAAsclhZWgAAAYQAAAAUZ1hZWgAAAZgAAAAUYlhZWgAAAawAAAAUclRSQwAAAcAAAAAgZ1RSQwAAAcAAAAAgYlRSQwAAAcAAAAAgbWx1YwAAAAAAAAABAAAADGVuVVMAAAAIAAAAHABzAFIARwBCbWx1YwAAAAAAAAABAAAADGVuVVMAAAAGAAAAHABDAEMAMAAAWFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDD8AAAXd///zJgAAB5AAAP2S///7of///aIAAAPcAADAcVhZWiAAAAAAAABvoAAAOPIAAAOPWFlaIAAAAAAAAGKWAAC3iQAAGNpYWVogAAAAAAAAJKAAAA+FAAC2xHBhcmEAAAAAAAMAAAACZmkAAPKnAAANWQAAE9AAAApb/9sAQwANCQoLCggNCwoLDg4NDxMgFRMSEhMnHB4XIC4pMTAuKS0sMzpKPjM2RjcsLUBXQUZMTlJTUjI+WmFaUGBKUVJP/9sAQwEODg4TERMmFRUmTzUtNU9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09P/8AAEQgAEAAYAwEiAAIRAQMRAf/EABUAAQEAAAAAAAAAAAAAAAAAAAAF/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABYBAQEBAAAAAAAAAAAAAAAAAAAEBv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIYCFqAAH//Z',
  'base64',
);

// ------------------------------------------------------------------------------------------------ the evening
const MAKES = [
  ['تويوتا', 'كامري', 'sedan'],
  ['تويوتا', 'لاندكروزر', 'suv'],
  ['هيونداي', 'سوناتا', 'sedan'],
  ['نيسان', 'باترول', 'suv'],
  ['لكزس', 'LX', 'suv'],
  ['شفروليه', 'تاهو', 'suv'],
  ['كيا', 'K5', 'sedan'],
  ['فورد', 'تورس', 'sedan'],
];
const COLORS = ['أبيض', 'أسود', 'فضي', 'رمادي', 'أحمر', 'أزرق'];
const LETTERS = ['ب ح د', 'ر س ص', 'ط ع ق', 'ك ل م', 'ن هـ و', 'ي ا ب'];

/** The scripted moments of the night, each on a car that fits it (the outcome is checked in the database). */
const CAR_MOMENTS = {
  earlyPress: 'early request (pressed while being parked, converted at parking)',
  fieldCancel: 'field cancel at the gate, asked again later',
  noShow: 'no-show: ready_not_collected → repark (W-08) → asked again',
  lockScenario: 'five wrong codes → locked → exceptional handover with the driver’s cash',
  optOut: '«إيقاف» after W-01, then the button resumes the consent',
  vip: 'VIP guest: fee waived by the supervisor',
  reverse: 'POS reference corrected by a reversal with replacement',
  basement: 'driver loses the network with this car (connection alert)',
};

function makeCars(venues) {
  const plan = stream('plan');
  const counts = { RMS: Math.round(CFG.tickets * 0.53), LYL: CFG.tickets - Math.round(CFG.tickets * 0.53) };
  let serial = 1000;
  for (const v of Object.values(venues)) {
    for (let i = 0; i < counts[v.key]; i++) {
      const whatsapp = plan.chance(v.key === 'RMS' ? 0.6 : 0.55);
      let phone = null;
      if (whatsapp) {
        do phone = `+9665${v.key === 'RMS' ? '31' : '32'}${String(++phoneSeq).padStart(6, '0')}`;
        while (reservedSuffix(phone));
      }
      const [make, model, type] = plan.pick(MAKES);
      const car = {
        venue: v,
        idx: i,
        channel: whatsapp ? 'whatsapp' : 'paper',
        phone,
        serial: whatsapp ? null : `${v.key[0]}-${serial++}`,
        plate: String(plan.int(1000, 9998)),
        letters: plan.pick(LETTERS),
        make,
        model,
        type,
        color: plan.pick(COLORS),
        keyTag: `${v.key}-K${i + 1}`,
        arriveAt: Math.round(plan.between(0, CFG.arrivalS) * 1000),
        dwellMs: Math.round(plan.between(CFG.dwellS[0], CFG.dwellS[1]) * 1000),
        // the customer's own choices, drawn with the plan: how he pays, his POS slip, the wrong codes he reads
        payPos: plan.chance(0.35),
        posRef: `AP${plan.int(1000, 9999)}`,
        wrongCodes: Array.from({ length: 5 }, () => String(plan.int(100000, 999999))),
        /** the customer's walk to the gate */
        rng: stream(`car:${v.key}:${i}`),
        codes: [],
        /** who took it in, parked it last and delivered it (TC-036 «كل فعل بفاعله») */
        by: {},
        /** what happened of its scripted moments */
        done: {},
        moments: [],
      };
      v.cars.push(car);
      cars.push(car);
    }
    v.cars.sort((a, b) => a.arriveAt - b.arriveAt);
  }
  const wa = (v) => v.cars.filter((c) => c.channel === 'whatsapp');
  const paper = (v) => v.cars.filter((c) => c.channel === 'paper');
  const R = venues.RMS;
  const L = venues.LYL;
  const tag = (car, k) => {
    if (car) {
      car[k] = true;
      car.moments.push(k);
    }
  };
  tag(wa(R)[3], 'earlyPress');
  tag(wa(L)[4], 'earlyPress');
  tag(wa(R)[8], 'fieldCancel');
  tag(wa(R)[12], 'noShow');
  tag(wa(R)[16], 'lockScenario');
  tag(wa(L)[9], 'optOut');
  tag(paper(R)[2], 'vip');
  tag(paper(R)[7], 'vip');
  const rev = wa(R)[20];
  tag(rev, 'reverse');
  if (rev) Object.assign(rev, { forcePos: true, posRef: 'AP7001' });
  tag(wa(L)[14] ?? paper(L)[6], 'basement');
}

let gateRetries = 0;

/** The gate: cars wait in line until a driver of the venue is free (no task, no live offer, not on break). */
async function gate(v, t0) {
  const queue = [];
  let next = 0;
  let inflight = 0;
  while (!stopping && (next < v.cars.length || queue.length || inflight)) {
    while (next < v.cars.length && Date.now() - t0 >= v.cars[next].arriveAt) {
      v.cars[next].arrivedAt = Date.now();
      queue.push(v.cars[next++]);
    }
    if (queue.length) {
      const free = v.drivers.filter(
        (d) =>
          d.onDuty &&
          !d.busy &&
          !d.stepping &&
          !d.onBreak &&
          !d.offline &&
          !d.paused &&
          d.home?.driver_state === 'available' &&
          !d.home?.offer,
      );
      for (const d of free.slice(0, queue.length)) {
        const car = queue.shift();
        car.intakeBy = d;
        inflight++;
        void d.intake(car).then(
          (ok) => {
            inflight--;
            if (ok === 'again') {
              gateRetries++;
              queue.unshift(car);
            } else if (!ok) fail(`intake of ${carLabel(car)} by ${d.key} failed`);
          },
          (e) => {
            inflight--;
            fail(`intake of ${carLabel(car)} by ${d.key}: ${e.message}`);
          },
        );
      }
    }
    await sleep(400);
  }
}

function scheduleDeparture(car) {
  if (car.earlyPress) return; // already asked during parking
  setTimeout(() => void customerLeaves(car), car.dwellMs);
}

async function pressFor(car) {
  for (let i = 0; i < 60 && !stopping; i++) {
    const r = await sim()
      .pressButton({
        to: car.phone,
        purpose: 'W-01',
        from: car.phone,
        timestamp: Math.floor(Date.now() / 1000),
      })
      .catch((e) => e);
    if (!(r instanceof Error)) return true;
    await sleep(500); // W-01 not on the phone yet
  }
  if (!stopping) fail(`${carLabel(car)}: no W-01 to press`);
  return false;
}

let SIMC = null;
const sim = () => SIMC;

async function customerLeavesEarly(car) {
  car.requestedAt = Date.now();
  await sleep(1500);
  await pressFor(car);
}

async function customerLeaves(car) {
  if (stopping) return;
  car.requestedAt = Date.now();
  const v = car.venue;
  if (car.channel === 'whatsapp') {
    if (car.optOut) {
      await sim().sendStop(car.phone, { timestamp: Math.floor(Date.now() / 1000) });
      // the supervisor's board shows the ticket opted out (12 §7.6) before the guest changes his mind
      for (let i = 0; i < 40 && !stopping; i++) {
        const t = await v.sup.get(`/v1/tickets/${car.ticketId}`);
        if (t.data?.wa_link_status === 'opted_out') {
          car.done.optOut = true;
          break;
        }
        await sleep(500);
      }
      await sleep(2000);
    }
    await pressFor(car);
    if (car.fieldCancel) void fieldCancel(car);
  } else {
    if (car.vip && v.paid) {
      const w = await v.sup.post(`/v1/tickets/${car.ticketId}/payment-waiver`, {
        reason: 'ضيف كبار الزوار على حساب المضيف',
      });
      if (w.status === 200) car.done.vip = true;
      else fail(`waiver of ${carLabel(car)}: ${w.status}`);
    }
    const r = await v.sup.post(`/v1/tickets/${car.ticketId}/retrievals`, {
      reason: 'العميل عند البوابة بالكعب الورقي',
    });
    if (r.status !== 201) fail(`request on behalf of ${carLabel(car)}: ${r.status} ${r.error?.code}`);
  }
}

/** The guest tells the supervisor he stays longer once a driver accepted; he asks again 40 s later. */
async function fieldCancel(car) {
  const v = car.venue;
  for (let i = 0; i < 600 && !stopping; i++) {
    const t = await v.sup.get(`/v1/tickets/${car.ticketId}`);
    if (t.data?.status === 'assigned' && t.data.active_cycle?.id) {
      const r = await v.sup.post(`/v1/retrieval-cycles/${t.data.active_cycle.id}/cancel`, {
        reason: 'العميل سيبقى وقتًا أطول',
      });
      if (r.status === 200) {
        car.done.fieldCancel = true;
        await sleep(40_000);
        await pressFor(car);
        return;
      }
    }
    if (['retrieving', 'ready', 'delivered'].includes(t.data?.status)) return; // too late: checked in measure()
    await sleep(300);
  }
}

/**
 * The supervisor's screen S-04: acknowledge critical alerts, repark a no-show, approve the exceptional handover,
 * move a request waiting as a busy driver's next task to a free driver, correct a POS reference.
 */
async function supervise(v) {
  const handled = new Set();
  while (!stopping && !v.closed) {
    const r = await v.sup.get(`/v1/alerts?venue_id=${v.id}&limit=100`);
    for (const a of r.data ?? []) {
      if (a.status === 'open' && a.severity === 'critical' && !handled.has(`ack:${a.id}`)) {
        handled.add(`ack:${a.id}`);
        await v.sup.post(
          `/v1/alerts/${a.id}/acknowledge`,
          { note: 'متابع' },
          { allow: ['INVALID_STATE_TRANSITION'] },
        );
      }
      const car = a.ticket_id ? carByTicket.get(a.ticket_id) : null;
      if (
        a.type === 'ready_not_collected' &&
        car?.noShow &&
        !car.reparked &&
        !handled.has(`repark:${a.id}`)
      ) {
        handled.add(`repark:${a.id}`);
        const rp = await v.sup.post(`/v1/tickets/${car.ticketId}/repark`, { reason: 'العميل لم يحضر' });
        if (rp.status === 200) {
          car.reparked = true;
          car.done.noShow = true;
          car.atGate = undefined;
          // the code of the reparked cycle is revoked: only a newer W-05 is good for the next handover
          const old = await sim()
            .claimCodeDetails(car.phone)
            .catch(() => null);
          if (old) car.codeSeqUsed = old.seq;
          setTimeout(() => void pressFor(car), 45_000); // he comes back and asks again
        }
      }
      if (
        a.type === 'handover_code_locked' &&
        car?.lockScenario &&
        car.lockedBy &&
        !handled.has(`ex:${a.id}`)
      ) {
        handled.add(`ex:${a.id}`);
        const t = await v.sup.get(`/v1/tickets/${car.ticketId}`);
        const due = t.data?.payment_status === 'due';
        const ex = await v.sup.post(`/v1/tickets/${car.ticketId}/handover-exception`, {
          reason: 'العميل أدخل رمزًا من رسالة قديمة؛ تحقق بالهوية',
          identity_checks: { phone_last4: car.phone.slice(-4), plate_confirmed: true },
          ...(due ? { payment: { method: 'cash', amount_halalas: 2000, collected_by: car.lockedBy } } : {}),
        });
        if (ex.status === 200) {
          car.deliveredAt = Date.now();
          car.done.lockScenario = true;
          // the assignee delivered, the supervisor approved (07, 11 TT-19); the guest's cash is in his pocket
          car.by.delivered = car.lockedBy;
          car.payment = ex.data.payment ?? null;
          if (due) {
            car.collector = car.lockedBy;
            took(v.eventId, car.lockedBy, 'cash', 2000);
          }
        } else fail(`exception of ${carLabel(car)}: ${ex.status} ${ex.error?.code}`);
      }
      // 10 EC-31: a driver is free while the oldest request waits as another driver's next task — the decision
      // is the supervisor's (no silent pull); he moves a few of them when the wait drags on (TT-12 reassign)
      if (
        a.type === 'idle_driver_while_next_waiting' &&
        a.status === 'open' &&
        a.task_id &&
        (v.reassigned ?? 0) < 3 &&
        Date.now() - Date.parse(a.raised_at) >= 10_000 &&
        !handled.has(`idle:${a.id}`)
      ) {
        handled.add(`idle:${a.id}`);
        const target = a.details?.idle_driver_ids?.[0];
        const k = a.ticket_id ? await v.sup.get(`/v1/tickets/${a.ticket_id}`) : null;
        if (target && k?.data?.status === 'assigned_waiting') {
          const re = await v.sup.post(
            `/v1/tasks/${a.task_id}/reassign`,
            { reason: 'سائق متاح والطلب محجوز تاليًا لسائق مشغول', target_driver_id: target },
            {
              allow: [
                'INVALID_STATE_TRANSITION',
                'DRIVER_NOT_AVAILABLE',
                'NEXT_TASK_ALREADY_RESERVED',
                'OLDER_REQUEST_PENDING',
                'DUTY_REQUIRED',
                'REASSIGN_BLOCKED_MOVEMENT',
                'CUSTODY_RELEASE_REQUIRED',
              ],
            },
          );
          if (re.status === 200) {
            v.reassigned = (v.reassigned ?? 0) + 1;
            notes.push(
              `${v.key}: ticket ${k.data.display_number}, waiting as a busy driver's next task, reassigned to a free driver`,
            );
          }
        }
      }
    }
    // a POS reference typed wrong: corrected by a reversal with replacement (13 §7.2)
    for (const car of v.cars)
      if (car.reverse && car.payment?.method === 'pos' && !car.reversed) {
        car.reversed = true;
        const amount = car.payment.amount_halalas;
        const rv = await v.sup.post(`/v1/payments/${car.payment.id}/reverse`, {
          reason: 'رقم مرجع الشبكة أُدخل خطأ',
          replacement: { method: 'pos', amount_halalas: amount, pos_reference: 'AP7010' },
        });
        if (rv.status === 200) {
          car.done.reverse = true;
          // the slip is reversed and replaced: still the same collector's POS collection (13 §7.2)
          took(v.eventId, car.collector, 'pos', -amount, -1);
          took(v.eventId, car.collector, 'pos', amount, 1);
        } else fail(`reversal ${rv.status} ${rv.error?.code}`);
      }
    await sleep(3000);
  }
}

/**
 * TC-036 «نقل سائق» (10 §9.7, AC-10): once LYL has taken in its last car, SUP-RL (both venues) moves an idle LYL
 * driver — no task, no next task, no custody — to RMS for the rest of the night; he signs in again there.
 */
async function transferMoment(world) {
  const { LYL: L, RMS: R } = world.venues;
  for (let i = 0; i < 360 && !stopping; i++) {
    const d = L.drivers.find(
      (x) =>
        !x.supervisor &&
        x.onDuty &&
        !x.busy &&
        !x.stepping &&
        !x.onBreak &&
        !x.offline &&
        !x.paused &&
        x.home?.driver_state === 'available' &&
        !x.home?.current_task &&
        !x.home?.next_task &&
        !x.home?.offer,
    );
    if (d) {
      d.paused = true; // his phone stays on the home screen while the supervisor moves him
      for (let j = 0; j < 50 && d.stepping; j++) await sleep(100);
      const r = await L.sup.post(
        `/v1/drivers/${d.userId}/transfers`,
        { to_venue_id: R.id, reason: 'دعم قاعة ريماس بعد اكتمال وصول ضيوف ليلتي' },
        { allow: ['TRANSFER_BLOCKED_CUSTODY'] },
      );
      if (r.status === 201 && r.data?.status === 'completed') {
        moments.transfer = { driverId: d.userId, key: d.key, transferId: r.data.id, at: Date.now() };
        await d.moveTo(R);
        log(`${d.key} transferred from LYL to RMS`);
        return;
      }
      d.paused = false;
      if (r.status !== 409) {
        fail(`transfer of ${d.key}: ${r.status} ${r.error?.code}`);
        return;
      }
    }
    await sleep(500);
  }
  if (!stopping) fail('transfer: no idle LYL driver to move after the last arrival');
}

async function playEvening(world) {
  SIMC = world.sim;
  const { venues } = world;
  makeCars(venues);
  log(`the evening: ${cars.length} cars (${venues.RMS.cars.length} RMS, ${venues.LYL.cars.length} LYL)`);
  const setupDraws = stream('setup');
  for (const d of DRIVERS.filter((x) => !x.supervisor)) {
    await d.startDuty();
    await sleep(Math.round(setupDraws.between(200, 700)));
  }
  const t0 = Date.now();
  const sups = Object.values(venues).map((v) => supervise(v));
  const gateR = gate(venues.RMS, t0);
  const gateL = gate(venues.LYL, t0);
  // TC-036 «نقل سائق»: after LYL's last arrival one of its drivers is moved to RMS
  const transfer = gateL.then(() => transferMoment(world));
  // the driving supervisor joins the RMS drivers for the rush
  setTimeout(() => void world.supRD.startDuty(), Math.round(CFG.arrivalS * 0.3 * 1000));
  // two prayer breaks per venue in the middle of the arrivals
  setTimeout(
    () => {
      for (const v of Object.values(venues))
        for (const d of v.drivers.slice(1, 3)) {
          moments.plannedBreaks++;
          void d.takeBreak(45);
        }
    },
    Math.round(CFG.arrivalS * 0.55 * 1000),
  );
  await Promise.all([gateR, gateL]);
  log('every car has been taken in');
  const deadline = T0 + CFG.deadlineS * 1000;
  for (;;) {
    const left = cars.filter((c) => !c.deliveredAt);
    if (!left.length) break;
    if (Date.now() > deadline) {
      fail(`${left.length} cars not delivered by the deadline`);
      break;
    }
    await sleep(2000);
  }
  await transfer;
  for (const v of Object.values(venues)) v.closed = true;
  await Promise.allSettled(sups);
  log('every car has been delivered');
}

// ------------------------------------------------------------------------------------------------ closing
async function closeNight(world) {
  for (const v of Object.values(world.venues)) {
    const sup = v.sup;
    must(await sup.post(`/v1/events/${v.eventId}/start-closing`, {}), 'start-closing');
    const rec = must(await sup.get(`/v1/events/${v.eventId}/reconciliation`), 'reconciliation');
    v.blockersAtClosing = Object.fromEntries(Object.entries(rec.blockers).map(([k, l]) => [k, l.length]));
    // the settlement per collector is what the bots took (13 §11): nothing is handed over yet, all of it is owed
    const s = must(await sup.get(`/v1/events/${v.eventId}/settlement`), 'settlement');
    const book = ledgerOf(v.eventId);
    v.cashRows = [];
    const ids = new Set([...book.keys(), ...s.drivers.map((d) => d.driver.id)]);
    for (const id of ids) {
      const l = book.get(id) ?? { cash: 0, cashCount: 0, pos: 0, posCount: 0 };
      const d = s.drivers.find((x) => x.driver.id === id);
      const seen = d
        ? {
            cash: d.cash.collected_halalas,
            cashCount: d.cash.count,
            outstanding: d.cash.outstanding_halalas,
            pos: d.pos.halalas,
            posCount: d.pos.count,
          }
        : null;
      const want = {
        cash: l.cash,
        cashCount: l.cashCount,
        outstanding: l.cash,
        pos: l.pos,
        posCount: l.posCount,
      };
      if (!isDeepStrictEqual(seen, want))
        fail(
          `${v.key} settlement of ${keyOf(id)} ${JSON.stringify(seen)} ≠ what the bots took ${JSON.stringify(want)}`,
        );
      v.cashRows.push({ id, took: l, settlement: seen, handed: null });
    }
    // the cash: every driver hands over what he took; the first one counts five riyals short (a recorded difference)
    let shortDone = false;
    for (const row of v.cashRows) {
      if (row.took.cash <= 0) continue;
      const short = shortDone ? 0 : 500;
      shortDone = true;
      const h = must(
        await sup.post('/v1/cash-handovers', {
          event_id: v.eventId,
          driver_id: row.id,
          amount_halalas: row.took.cash - short,
          ...(short ? { note: 'نقص خمسة ريالات عند العد' } : {}),
        }),
        'cash handover',
      );
      row.handed = {
        amount: h.amount_halalas,
        expected: h.expected_halalas,
        difference: h.difference_halalas,
        payments: h.payment_ids.length,
        incident: h.incident_id,
      };
      if (
        h.expected_halalas !== row.took.cash ||
        h.difference_halalas !== -short ||
        h.payment_ids.length !== row.took.cashCount
      )
        fail(
          `${v.key} cash handover of ${keyOf(row.id)}: ${JSON.stringify(row.handed)} for ${row.took.cash} taken`,
        );
      if (short) moments.shortfall = { venue: v.key, driverId: row.id, handoverId: h.id };
    }
    const after = must(await sup.get(`/v1/events/${v.eventId}/reconciliation`), 'reconciliation');
    if (!after.can_close) fail(`${v.key} cannot close: ${JSON.stringify(after.blockers)}`);
    const ev = must(await sup.get(`/v1/events/${v.eventId}`), 'event');
    const closed = must(
      await sup.post(`/v1/events/${v.eventId}/close`, {
        expected_version: ev.version,
        note: 'انتهت البروفة الآلية',
      }),
      'close',
    );
    v.closeSummary = closed.close_summary;
    must(await sup.post(`/v1/shifts/${v.shiftId}/close`, {}), 'shift close');
    log(`${v.key}: event closed, shift closed`);
  }
  for (const d of DRIVERS) d.onDuty = false;
}

// ------------------------------------------------------------------------------------------------ measures
/** Each scripted moment's outcome, read back from the database (a planned moment that did not happen fails). */
async function verifyMoments(q, world) {
  const out = [];
  const add = (moment, where, ok, evidence) => {
    out.push({ moment, where, ok, evidence });
    if (!ok) fail(`scripted moment not exercised: ${moment} (${where}) — ${evidence}`);
  };
  for (const car of cars)
    for (const m of car.moments) {
      const where = `${car.venue.key} #${car.displayNumber ?? '?'}`;
      const label = CAR_MOMENTS[m];
      if (!car.ticketId) {
        add(label, where, false, 'the car was never taken in');
        continue;
      }
      const cycles = await q(
        `SELECT cycle_no, outcome, requested_early, handover_method FROM retrieval_cycles WHERE ticket_id = $1 ORDER BY cycle_no`,
        [car.ticketId],
      );
      const ticket = (
        await q(`SELECT status, payment_status, wa_link_status FROM tickets WHERE id = $1`, [car.ticketId])
      )[0];
      const last = cycles.at(-1);
      const delivered = ticket.status === 'delivered' && last?.outcome === 'delivered';
      const path = cycles.map((c) => c.outcome ?? 'open').join(' → ');
      if (m === 'earlyPress') {
        const early = cycles.filter((c) => c.requested_early).length;
        add(label, where, early === 1 && delivered, `${early} early cycle; cycles ${path}`);
      } else if (m === 'fieldCancel') {
        const canceled = cycles.filter((c) => c.outcome === 'canceled').length;
        add(label, where, canceled === 1 && delivered, `cycles ${path}`);
      } else if (m === 'noShow') {
        const absent = (
          await q(
            `SELECT count(*)::int AS n FROM incidents WHERE ticket_id = $1 AND type = 'customer_absent'`,
            [car.ticketId],
          )
        )[0].n;
        const reparked = cycles.filter((c) => c.outcome === 'reparked').length;
        add(
          label,
          where,
          reparked === 1 && absent === 1 && delivered,
          `cycles ${path}; customer_absent ${absent}`,
        );
      } else if (m === 'lockScenario') {
        const locked = (
          await q(
            `SELECT count(*)::int AS n FROM alerts WHERE ticket_id = $1 AND type = 'handover_code_locked' AND status = 'resolved'`,
            [car.ticketId],
          )
        )[0].n;
        const byException = last?.handover_method === 'supervisor_exception';
        add(
          label,
          where,
          locked === 1 && byException && delivered,
          `handover_code_locked ${locked}; delivered by ${last?.handover_method ?? '—'}; ${ticket.payment_status}`,
        );
      } else if (m === 'optOut') {
        const opted = (
          await q(
            `SELECT count(*)::int AS n FROM outbox_events WHERE type = 'wa.customer_opted_out'
                AND payload->'payload'->'affected_ticket_ids' ? $1`,
            [car.ticketId],
          )
        )[0].n;
        add(
          label,
          where,
          opted === 1 && delivered,
          `wa.customer_opted_out ${opted}; link ${ticket.wa_link_status}`,
        );
      } else if (m === 'vip') {
        add(
          label,
          where,
          ticket.payment_status === 'waived' && delivered,
          `payment ${ticket.payment_status}`,
        );
      } else if (m === 'reverse') {
        const p = await q(
          `SELECT status, count(*)::int AS n FROM payments WHERE ticket_id = $1 GROUP BY 1 ORDER BY 1`,
          [car.ticketId],
        );
        const n = Object.fromEntries(p.map((x) => [x.status, x.n]));
        add(
          label,
          where,
          n.reversed === 1 && n.recorded === 1 && delivered,
          `payments ${p.map((x) => `${x.status} ${x.n}`).join(', ') || '—'}`,
        );
      } else if (m === 'basement') {
        const driver = car.done.basement ?? null;
        const alerts = driver
          ? (
              await q(
                `SELECT status FROM alerts WHERE type = 'driver_connection_lost_with_custody' AND user_id = $1`,
                [driver],
              )
            ).map((x) => x.status)
          : [];
        add(
          label,
          where,
          alerts.length >= 1 && alerts.every((s) => s === 'resolved') && delivered,
          driver
            ? `${keyOf(driver)}: driver_connection_lost_with_custody ${alerts.join(', ') || 'none'}`
            : 'no driver lost the network',
        );
      }
    }
  // the transfer: completed, the assignment moved, his LYL work kept, RMS cars served after it
  const tr = moments.transfer;
  if (!tr)
    add('driver transfer LYL → RMS after the last LYL arrival (10 §9.7)', 'LYL → RMS', false, 'not done');
  else {
    const row = (
      await q(`SELECT status, from_venue_id, to_venue_id FROM driver_transfers WHERE id = $1`, [
        tr.transferId,
      ])
    )[0];
    const assignments = await q(
      `SELECT venue_id, status FROM driver_assignments WHERE driver_id = $1 ORDER BY created_at`,
      [tr.driverId],
    );
    const { RMS: R, LYL: L } = world.venues;
    const served = (
      await q(
        `SELECT count(*) FILTER (WHERE event_id = $2 AND (created_by = $1 OR delivered_by = $1))::int AS rms,
                count(*) FILTER (WHERE event_id = $3 AND created_by = $1 AND venue_id = $4)::int AS lyl
           FROM tickets`,
        [tr.driverId, R.eventId, L.eventId, L.id],
      )
    )[0];
    const moved =
      row?.status === 'completed' &&
      row.from_venue_id === L.id &&
      row.to_venue_id === R.id &&
      assignments.at(-1)?.venue_id === R.id &&
      assignments.at(-1)?.status === 'active' &&
      assignments.some((a) => a.venue_id === L.id && a.status === 'ended');
    add(
      'driver transfer LYL → RMS after the last LYL arrival (10 §9.7)',
      `${tr.key}`,
      moved && served.rms >= 1,
      `transfer ${row?.status ?? '—'}; assignments ${assignments.map((a) => `${a.venue_id === R.id ? 'RMS' : 'LYL'} ${a.status}`).join(', ')}; RMS cars served after it ${served.rms}; his LYL intakes kept in LYL ${served.lyl}`,
    );
  }
  // the prayer breaks
  const breaks = (
    await q(`SELECT count(*)::int AS n FROM outbox_events WHERE type = 'driver.break_started'`)
  )[0].n;
  add(
    `prayer breaks (planned ${moments.plannedBreaks})`,
    moments.breaks.map((b) => b.key).join(', ') || '—',
    moments.plannedBreaks > 0 &&
      moments.breaks.length === moments.plannedBreaks &&
      breaks === moments.plannedBreaks,
    `${breaks} driver.break_started`,
  );
  // the cash shortfall at the handover
  const sf = moments.shortfall;
  const handover = sf
    ? (await q(`SELECT difference_halalas FROM cash_handovers WHERE id = $1`, [sf.handoverId]))[0]
    : null;
  const diffIncidents = sf
    ? (
        await q(
          `SELECT count(*)::int AS n FROM incidents WHERE type = 'payment_discrepancy' AND event_id = $1 AND ticket_id IS NULL`,
          [world.venues[sf.venue].eventId],
        )
      )[0].n
    : 0;
  add(
    'cash shortfall at the cash handover (13 §10)',
    sf ? `${sf.venue} ${keyOf(sf.driverId)}` : '—',
    Number(handover?.difference_halalas) === -500 && diffIncidents === 1,
    `difference ${sar(handover?.difference_halalas ?? 0)}; payment_discrepancy ${diffIncidents}`,
  );
  return out;
}

async function measure({ world, pool, db, playedS, logDir, database }) {
  const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const { venues } = world;
  // 17 M1 «حفظ الطلب» on the worker's own clock after the commit (05 §12.2), read before the processes stop
  const ingestHist = promHistogram(
    await fetch(WORKER_METRICS)
      .then((r) => r.text())
      .catch(() => ''),
    'point_retrieval_request_ingest_seconds',
  );
  const per = {};
  for (const v of Object.values(venues)) {
    const e = v.eventId;
    const s = must(await v.sup.get(`/v1/events/${e}/settlement`), 'settlement');
    const durations = {};
    for (const [name, sql] of Object.entries(DURATION_QUERIES)) {
      const xs = (await q(sql, [e])).map((r) => Number(r.s));
      durations[name] = {
        n: xs.length,
        p50: percentile(xs, 50),
        p95: percentile(xs, 95),
        max: percentile(xs, 100),
      };
    }
    const closed = {};
    for (const [name, sql] of Object.entries(CLOSED_EVENT_CHECKS)) closed[name] = (await q(sql, [e])).length;
    const stored = (
      await q(`SELECT status, closed_at, closed_by, close_summary FROM events WHERE id = $1`, [e])
    )[0];
    // TC-036 «close_summary محفوظ»: the stored summary is the close's answer and freezes the settlement after it
    const summary = stored.close_summary;
    const closeSummary = {
      saved: !!summary && isDeepStrictEqual(summary, v.closeSummary),
      finance: isDeepStrictEqual(summary?.finance, {
        currency: 'SAR',
        amounts: s.amounts,
        drivers: s.drivers,
        discrepancies: s.discrepancies,
      }),
      tickets: isDeepStrictEqual(summary?.tickets, s.tickets),
      closedBy: stored.closed_by === v.sup.userId && summary?.closed_by === v.sup.userId,
      warnings: summary?.warnings ?? null,
    };
    per[v.key] = {
      tickets: await q(
        `SELECT channel, status, count(*)::int AS n FROM tickets WHERE event_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`,
        [e],
      ),
      cycles: await q(
        `SELECT rc.outcome, rc.request_source, rc.requested_early, count(*)::int AS n FROM retrieval_cycles rc
           JOIN tickets t ON t.id = rc.ticket_id WHERE t.event_id = $1 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
        [e],
      ),
      dispatch: (
        await q(
          `SELECT count(*) FILTER (WHERE type = 'retrieve')::int AS retrieve,
                  count(*) FILTER (WHERE type = 'repark')::int AS repark,
                  count(*) FILTER (WHERE type = 'retrieve' AND assigned_waiting_at IS NOT NULL)::int AS reserved_next,
                  count(*) FILTER (WHERE type = 'retrieve' AND escalated_at IS NOT NULL)::int AS escalated,
                  count(*) FILTER (WHERE type = 'retrieve' AND status = 'canceled')::int AS canceled
             FROM tasks WHERE event_id = $1`,
          [e],
        )
      )[0],
      reassigned: (
        await q(
          `SELECT t.display_number FROM outbox_events o JOIN tasks k ON k.id = (o.payload->'payload'->>'task_id')::uuid
             JOIN tickets t ON t.id = k.ticket_id
            WHERE o.type = 'task.reassigned' AND t.event_id = $1 ORDER BY o.seq`,
          [e],
        )
      ).map((x) => x.display_number),
      offers: await q(
        `SELECT o.mode, o.status, coalesce(o.close_reason, '—') AS close_reason, count(*)::int AS n
           FROM task_offers o JOIN tasks k ON k.id = o.task_id WHERE k.event_id = $1 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
        [e],
      ),
      durations,
      settlement: s,
      closeSummary,
      blockersAtClosing: v.blockersAtClosing,
      cashRows: v.cashRows ?? [],
      closed,
      event: stored,
      cash: (
        await q(
          `SELECT count(*)::int AS n, coalesce(sum(amount_halalas), 0)::int AS amount,
                  coalesce(sum(expected_halalas), 0)::int AS expected, coalesce(sum(difference_halalas), 0)::int AS difference
             FROM cash_handovers WHERE event_id = $1`,
          [e],
        )
      )[0],
      payments: await q(
        `SELECT method, status, count(*)::int AS n, sum(amount_halalas)::int AS amount FROM payments
          WHERE event_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`,
        [e],
      ),
      recorded: (
        await q(
          `SELECT coalesce(sum(amount_halalas) FILTER (WHERE status = 'recorded'), 0)::int AS recorded,
                  coalesce(sum(amount_halalas) FILTER (WHERE status = 'recorded' AND method = 'cash'), 0)::int AS cash,
                  coalesce(sum(amount_halalas) FILTER (WHERE status = 'recorded' AND method = 'pos'), 0)::int AS pos
             FROM payments WHERE event_id = $1`,
          [e],
        )
      )[0],
    };
  }
  const messages = await q(
    `SELECT direction, coalesce(purpose, kind) AS purpose, status, count(*)::int AS n FROM whatsapp_messages
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
  );
  // 15 §10 alert table: acknowledged at some point, resolved by the system (resolved_by null) or by staff
  const alerts = await q(
    `SELECT type, severity, count(*)::int AS raised,
            count(*) FILTER (WHERE acknowledged_at IS NOT NULL)::int AS acknowledged,
            count(*) FILTER (WHERE status = 'resolved' AND resolved_by IS NULL)::int AS auto_resolved,
            count(*) FILTER (WHERE status = 'resolved' AND resolved_by IS NOT NULL)::int AS staff_resolved,
            count(*) FILTER (WHERE status <> 'resolved')::int AS open
       FROM alerts GROUP BY 1, 2 ORDER BY 1`,
  );
  const incidents = await q(
    `SELECT type, status, count(*)::int AS n FROM incidents GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  const outbox = await q(`SELECT status, count(*)::int AS n FROM outbox_events GROUP BY 1 ORDER BY 1`);
  const pendingOutbox = await q(
    `SELECT type, count(*)::int AS n FROM outbox_events WHERE status = 'pending' GROUP BY 1 ORDER BY 1`,
  );
  // `ingest_latency_ms` of ticket_retrieval_requested: webhook stored → the cycle written, before the commit
  const ingest = (
    await q(
      `SELECT (properties->>'ingest_latency_ms')::int AS ms FROM analytics_events
        WHERE name = 'ticket_retrieval_requested' AND properties->>'ingest_latency_ms' IS NOT NULL`,
    )
  ).map((x) => x.ms);
  const analytics = (
    await q(
      `SELECT (SELECT count(*)::int FROM outbox_events WHERE type NOT LIKE 'job.%') AS domain_events,
              (SELECT count(*)::int FROM analytics_events WHERE source = 'server') AS server_rows,
              (SELECT count(DISTINCT properties->>'source_event_id')::int FROM analytics_events WHERE source = 'server') AS distinct_sources,
              (SELECT count(*)::int FROM analytics_events WHERE source = 'client') AS client_rows,
              (SELECT count(DISTINCT name)::int FROM analytics_events WHERE source = 'server') AS server_names`,
    )
  )[0];

  // TC-036 «كل فعل بفاعله»: each ticket names the bot that took it in, parked it last and delivered it …
  const ticketRows = await q(
    `SELECT id, created_by, parked_by, delivered_by FROM tickets WHERE event_id = ANY($1::uuid[])`,
    [Object.values(venues).map((v) => v.eventId)],
  );
  const byTicket = new Map(ticketRows.map((t) => [t.id, t]));
  const actorMismatches = [];
  for (const car of cars) {
    const t = car.ticketId ? byTicket.get(car.ticketId) : null;
    if (!t) continue;
    for (const [field, want] of [
      ['created_by', car.by.created],
      ['parked_by', car.by.parked],
      ['delivered_by', car.by.delivered],
    ])
      if ((t[field] ?? null) !== (want ?? null))
        actorMismatches.push(`${carLabel(car)} ${field} ${keyOf(t[field])} ≠ ${keyOf(want ?? null)}`);
  }
  // … and every command a bot sent left its audit row(s) under its request id, in the bot's name
  const auditRows = await q(
    `SELECT request_id, actor_type, actor_id, count(*)::int AS n FROM audit_log
      WHERE request_id = ANY($1::text[]) GROUP BY 1, 2, 3`,
    [commandLog.map((c) => c.requestId)],
  );
  const auditsOf = new Map();
  for (const a of auditRows) auditsOf.set(a.request_id, [...(auditsOf.get(a.request_id) ?? []), a]);
  const unaudited = commandLog.filter((c) => !auditsOf.has(c.requestId));
  const misattributed = commandLog.filter((c) =>
    (auditsOf.get(c.requestId) ?? []).some((a) => a.actor_type !== 'user' || a.actor_id !== c.userId),
  );
  const attribution = {
    tickets: ticketRows.length,
    actorMismatches,
    commands: commandLog.length,
    auditRows: auditRows.reduce((s, a) => s + a.n, 0),
    unaudited,
    misattributed,
    routes: new Set(commandLog.map((c) => c.route)).size,
  };

  const momentRows = await verifyMoments(q, world);
  const invariants = {};
  for (const [name, sql] of Object.entries(INVARIANT_QUERIES)) invariants[name] = (await q(sql)).length;
  const consistency = await q(readFileSync(join(ROOT, 'infra/backup/consistency.sql'), 'utf8'));
  // docs/06_schema_invariants_test.sql on a fresh database built from the same migrations (it needs an empty one)
  const inv = await db.createDatabase(CFG.admin, 'point_rehearsal_inv');
  run.inv = inv;
  let schemaInvariants;
  try {
    await db.migrate(inv.url);
    const out = await db.runSqlScript(inv.url, db.INVARIANTS_SQL);
    schemaInvariants = out.at(-1);
  } finally {
    await db.dropDatabase(CFG.admin, inv.name);
    run.inv = null;
  }
  const version = (await q(`SELECT version() AS v`))[0].v.split(' ').slice(0, 2).join(' ');
  const logs = {};
  for (const c of children) {
    const lines = readFileSync(c.file, 'utf8').split('\n');
    logs[c.name] = {
      lines: lines.length,
      errors: lines.filter((l) => /"level":"(error|fatal)"|"level":(50|60)\b/.test(l)).length,
    };
  }

  // the checks that make the run pass or fail
  for (const [k, n] of Object.entries(invariants)) if (n) fail(`invariant ${k}: ${n} rows`);
  for (const c of consistency) if (Number(c.violations)) fail(`consistency ${c.check_name}: ${c.violations}`);
  if (schemaInvariants !== 'ALL INVARIANT TESTS PASSED') fail(`schema invariants: ${schemaInvariants}`);
  for (const [vk, p] of Object.entries(per)) {
    if (p.event.status !== 'closed') fail(`${vk} event not closed`);
    for (const [k, n] of Object.entries(p.closed)) if (n) fail(`${vk} after close: ${k} (${n})`);
    if (p.settlement.amounts.collected_halalas !== p.recorded.recorded)
      fail(`${vk} settlement ≠ recorded payments`);
    // the money against what the bots took (13 §10–§11), not the server against itself
    const book = [...ledgerOf(venues[vk].eventId).values()];
    const taken = (k) => book.reduce((s, l) => s + l[k], 0);
    if (p.recorded.cash !== taken('cash') || p.recorded.pos !== taken('pos'))
      fail(
        `${vk} recorded cash/POS ${p.recorded.cash}/${p.recorded.pos} ≠ taken ${taken('cash')}/${taken('pos')}`,
      );
    const short = moments.shortfall?.venue === vk ? 500 : 0;
    if (
      p.cash.amount !== taken('cash') - short ||
      p.cash.expected !== taken('cash') ||
      p.cash.difference !== (short ? -short : 0)
    )
      fail(
        `${vk} cash handed over ${p.cash.amount} (difference ${p.cash.difference}) ≠ taken ${taken('cash')} − ${short}`,
      );
    if (!p.settlement.integrity.ok) fail(`${vk} settlement integrity`);
    const cs = p.closeSummary;
    if (!(cs.saved && cs.finance && cs.tickets && cs.closedBy))
      fail(`${vk} close_summary: ${JSON.stringify({ ...cs, warnings: undefined })}`);
  }
  if (attribution.actorMismatches.length)
    fail(
      `${attribution.actorMismatches.length} tickets with another actor: ${attribution.actorMismatches.slice(0, 5).join('; ')}`,
    );
  if (attribution.unaudited.length)
    fail(
      `${attribution.unaudited.length} commands without an audit row: ${[...new Set(attribution.unaudited.map((c) => c.route))].join(', ')}`,
    );
  if (attribution.misattributed.length)
    fail(
      `${attribution.misattributed.length} commands audited in another name: ${[...new Set(attribution.misattributed.map((c) => c.route))].join(', ')}`,
    );
  if (http.server5xx.length) fail(`${http.server5xx.length} server errors (5xx or network)`);
  if (
    analytics.server_rows !== analytics.domain_events ||
    analytics.distinct_sources !== analytics.domain_events
  )
    fail(`analytics rows ${analytics.server_rows} for ${analytics.domain_events} domain events`);
  if (ingestHist.count !== ingest.length)
    fail(`M1: the worker observed ${ingestHist.count} presses for ${ingest.length} cycles opened by a press`);
  if (outbox.some((o) => o.status === 'dead' || o.status === 'failed')) fail('outbox rows failed or dead');

  return (allFailures) =>
    renderReport({
      world,
      per,
      messages,
      alerts,
      incidents,
      outbox,
      pendingOutbox,
      ingest,
      ingestHist,
      analytics,
      attribution,
      momentRows,
      invariants,
      consistency,
      schemaInvariants,
      version,
      logs,
      playedS,
      logDir,
      database,
      failures: allFailures,
    });
}

function renderReport(r) {
  const totalS = Math.round((Date.now() - T0) / 1000);
  const drivers = DRIVERS.filter((d) => !d.supervisor).length;
  const ms = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);
  const bound = (v) => (v === null ? '—' : v === Infinity ? '> 5 s' : `≤ ${v * 1000} ms`);
  const met = (v, limit) => (v === null ? '—' : v <= limit ? 'met' : 'NOT met');
  const lines = [];
  const L = (s = '') => lines.push(s);
  L(`# Automated rehearsal — ${today}`);
  L();
  L(
    '`pnpm ops:rehearsal` (apps/api/rehearsal/run.mjs) — PNT-102: the scripted operational part of 17 H-10 (step 1,',
  );
  L(
    'the TC-036 list), played by bots against the real api, worker and WhatsApp simulator. Every TC-036 scope item is',
  );
  L(
    'played (the moments table) and every TC-036 expected result is checked below: zero reconciliation, the cash equal',
  );
  L('to what was taken, `close_summary` saved, every action with its actor.');
  L();
  L(
    `**Result: ${r.failures.length ? 'FAILED' : 'PASSED'}** — ${r.failures.length ? r.failures.length + ' check(s) failed (listed at the end)' : 'every check below held'}.`,
  );
  L();
  L(
    '> This is the automated rehearsal. **The human rehearsal remains an owner task** (16 PNT-102, 17 H-10): TC-036',
  );
  L(
    '> guided on staging with real staff and phones (H-07 devices) and the Meta test number (Q-03), the paper outage',
  );
  L(
    '> drill (H-10 steps 2–4, TC-038) and the backup restore (H-09, TC-037). AC-12 and AC-19 evidence from it is still',
  );
  L('> to be recorded; PNT-102 stays in progress.');
  L();
  L('## Setup');
  L();
  const tr = moments.transfer;
  L(
    table(
      ['Item', 'Value'],
      [
        [
          'Database',
          `PostgreSQL ${r.version.replace('PostgreSQL ', '')}, fresh \`point_rehearsal_*\` (migrations + 17 §4 seed), dropped after the run`,
        ],
        [
          'Processes',
          `wa-simulator :${PORT.sim}, api :${PORT.api} (metrics :${PORT.apiMetrics}), worker (metrics :${PORT.apiMetrics + 1}); NODE_ENV=production, APP_ENV=local, rate limits on, SystemMonitor every 10 s`,
        ],
        ['Venues', 'RMS «حفل زفاف» per vehicle 20.00 SAR (cash, POS) · LYL «حفل تخرج» included'],
        [
          'Staff',
          `${drivers} drivers (8 per venue at the start; ${drivers - 8} created by the administrator, PIN changed at first login${tr ? `; ${tr.key} moved from LYL to RMS after LYL's last arrival` : ''}) + SUP-RD driving; SUP-R (RMS), SUP-RL (LYL, both venues); OWN1 and ADM1 with TOTP`,
        ],
        [
          'Schedule',
          `${cars.length} cars arriving over ${CFG.arrivalS} s, parked ${CFG.dwellS[0]}–${CFG.dwellS[1]} s; driver actions 1–15 s; \`ready.uncollected_alert_min\` = 2 (17 §3.3)`,
        ],
        [
          'Timers',
          'canon §12 defaults otherwise: reminder 15 s, single offer 30 s, escalation 60 s, heartbeat 15/45/120 s',
        ],
        [
          'Seed',
          `${CFG.seed}: the car plan (arrivals, dwell, channels, how each customer pays, the wrong codes, the scripted moments) and every actor's own draws; the interleaving depends on the timing`,
        ],
        ['Duration', `${r.playedS} s of play, ${totalS} s in all (build, boot, setup, closing, measures)`],
      ],
    ),
  );
  L();
  L('## Scripted moments (TC-036 scope)');
  L();
  L(
    table(
      ['Moment', 'Where', 'Outcome (read back from the database)', 'Exercised'],
      r.momentRows.map((m) => [m.moment, m.where, m.evidence, m.ok ? 'yes' : '**NO**']),
    ),
  );
  if (notes.length) {
    L();
    L('Run notes: ' + notes.join('; ') + '.');
  }
  for (const [vk, p] of Object.entries(r.per)) {
    L();
    L(`## ${vk}`);
    L();
    L(
      table(
        ['Channel', 'Status', 'Tickets'],
        p.tickets.map((x) => [x.channel, x.status, x.n]),
      ),
    );
    L();
    L(
      table(
        ['Cycle outcome', 'Source', 'Early', 'Cycles'],
        p.cycles.map((x) => [x.outcome ?? 'open', x.request_source, x.requested_early ? 'yes' : 'no', x.n]),
      ),
    );
    L();
    L(
      table(
        [
          'Retrieve tasks',
          'Repark tasks',
          'Reserved as next (W-03)',
          'Escalated (60 s)',
          'Canceled',
          'Reassigned',
        ],
        [
          [
            p.dispatch.retrieve,
            p.dispatch.repark,
            p.dispatch.reserved_next,
            p.dispatch.escalated,
            p.dispatch.canceled,
            p.reassigned.length,
          ],
        ],
      ),
    );
    L();
    L(
      table(
        ['Offer mode', 'Status', 'Close reason', 'Rounds'],
        p.offers.map((x) => [x.mode, x.status, x.close_reason, x.n]),
      ),
    );
    L();
    L(
      table(
        ['Wait (15 §10)', 'n', 'p50', 'p95', 'max'],
        Object.entries(p.durations).map(([k, d]) => [k, d.n, secs(d.p50), secs(d.p95), secs(d.max)]),
      ),
    );
    L();
    const a = p.settlement.amounts;
    L(
      table(
        ['Money (settlement)', 'Value'],
        [
          ['billable', sar(a.billable_halalas)],
          ['collected', sar(a.collected_halalas)],
          ['waived', sar(a.waived_halalas)],
          ['due', sar(a.due_halalas)],
          ['recorded payments (SQL)', sar(p.recorded.recorded)],
          ['cash / POS recorded (SQL)', `${sar(p.recorded.cash)} / ${sar(p.recorded.pos)}`],
          [
            'cash handed over',
            `${sar(p.cash.amount)} in ${p.cash.n} handovers (expected ${sar(p.cash.expected)}, difference ${sar(p.cash.difference)})`,
          ],
          ['integrity', p.settlement.integrity.ok ? 'ok' : JSON.stringify(p.settlement.integrity.violations)],
        ],
      ),
    );
    if (p.payments.length) {
      L();
      L(
        table(
          ['Method', 'Status', 'Payments', 'Amount'],
          p.payments.map((x) => [x.method, x.status, x.n, sar(x.amount)]),
        ),
      );
    }
    if (p.cashRows.length) {
      L();
      L(
        'Per collector — what the bots took (their own commands) against the settlement before the cash handovers, and',
      );
      L('the handover:');
      L();
      L(
        table(
          [
            'Collector',
            'Cash taken',
            'Settlement cash (owed)',
            'Handed over',
            'Difference',
            'POS taken',
            'Settlement POS',
          ],
          p.cashRows.map((x) => [
            keyOf(x.id),
            `${sar(x.took.cash)} (${x.took.cashCount})`,
            x.settlement ? `${sar(x.settlement.cash)} (${sar(x.settlement.outstanding)})` : '—',
            x.handed ? sar(x.handed.amount) : '—',
            x.handed ? sar(x.handed.difference) : '—',
            `${sar(x.took.pos)} (${x.took.posCount})`,
            x.settlement ? sar(x.settlement.pos) : '—',
          ]),
        ),
      );
    }
    L();
    const cs = p.closeSummary;
    L(
      `Closing: blockers at start-closing ${JSON.stringify(p.blockersAtClosing)}; event \`${p.event.status}\`; \`close_summary\` saved ${cs.saved ? 'yes' : 'NO'} (finance = the settlement after the close ${cs.finance ? 'yes' : 'NO'}, tickets ${cs.tickets ? 'yes' : 'NO'}, closed by the supervisor ${cs.closedBy ? 'yes' : 'NO'}; warnings accepted: ${cs.warnings ? `${cs.warnings.open_incidents.length} open incidents, ${cs.warnings.failed_messages} failed messages, ${cs.warnings.cash_discrepancies.length} cash differences` : '—'}); after the close every check of a closed event is 0: ${Object.entries(
        p.closed,
      )
        .map(([k, n]) => `${k} ${n}`)
        .join(', ')}.`,
    );
  }
  L();
  L('## Every action with its actor (TC-036)');
  L();
  const at = r.attribution;
  L(
    table(
      ['Check', 'Result'],
      [
        [
          'tickets: created_by / parked_by / delivered_by = the bot that took it in, parked it last, delivered it',
          `${at.tickets} tickets, ${at.actorMismatches.length} mismatches${at.actorMismatches.length ? ': ' + at.actorMismatches.slice(0, 5).join('; ') : ''}`,
        ],
        [
          'commands with an Idempotency-Key that succeeded (every bot: the drivers, SUP-RD, SUP-R, SUP-RL, OWN1, ADM1)',
          `${at.commands} on ${at.routes} routes → ${at.auditRows} audit rows under their request ids`,
        ],
        ['commands without an audit row', String(at.unaudited.length)],
        ['commands with an audit row in another name', String(at.misattributed.length)],
      ],
    ),
  );
  L();
  L('## Messages, alerts, incidents');
  L();
  L(
    table(
      ['Direction', 'Purpose / kind', 'Status', 'Messages'],
      r.messages.map((x) => [x.direction, x.purpose, x.status, x.n]),
    ),
  );
  L();
  L(
    table(
      ['Alert', 'Severity', 'Raised', 'Acknowledged', 'Resolved (system)', 'Resolved (staff)', 'Still open'],
      r.alerts.map((x) => [
        x.type,
        x.severity,
        x.raised,
        x.acknowledged,
        x.auto_resolved,
        x.staff_resolved,
        x.open,
      ]),
    ),
  );
  L();
  L(
    table(
      ['Incident', 'Status', 'Count'],
      r.incidents.map((x) => [x.type, x.status, x.n]),
    ),
  );
  L();
  L('## Platform');
  L();
  const classes = [...http.byStatus.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([s, n]) => `${s}: ${n}`)
    .join(', ');
  const h = r.ingestHist;
  const m1p95 = bucketQuantile(h, 95);
  const m2p95 = percentile(ws.claimLatency, 95);
  L(
    table(
      ['Measure', 'Value'],
      [
        ['HTTP requests (bots)', `${http.total} — ${classes}`],
        [
          'Command latency (client)',
          `p50 ${percentile(http.latencyCmd, 50)?.toFixed(0)} ms, p95 ${percentile(http.latencyCmd, 95)?.toFixed(0)} ms`,
        ],
        [
          'Read latency (client)',
          `p50 ${percentile(http.latencyRead, 50)?.toFixed(0)} ms, p95 ${percentile(http.latencyRead, 95)?.toFixed(0)} ms`,
        ],
        [
          'Refusals by code',
          [...http.byCode.entries()]
            .sort()
            .map(([c, n]) => `${c} ${n}`)
            .join(', ') || '—',
        ],
        [
          'Server errors (5xx / network) — 17 M3',
          http.server5xx.length ? http.server5xx.slice(0, 10).join('; ') : '0',
        ],
        [
          'Unexpected refusals',
          http.unexpected.length
            ? `${http.unexpected.length}: ${http.unexpected.slice(0, 8).join('; ')}`
            : '0',
        ],
        ['Gate: car handed to the next driver (the one picked had just taken an offer)', String(gateRetries)],
        [
          'WebSocket',
          `${ws.connects} connects, ${ws.disconnects} disconnects; ${[...ws.messages.entries()]
            .sort()
            .map(([k, n]) => `${k} ${n}`)
            .join(', ')}`,
        ],
        [
          '17 M1 «حفظ الطلب»: webhook received → retrieval cycle committed (the worker’s `point_retrieval_request_ingest_seconds`, after the commit); target p95 < 2 s',
          `n ${h.count}; p50 ${bound(bucketQuantile(h, 50))}, p95 ${bound(m1p95)} (bucket bounds), mean ${h.count ? ms((h.sum / h.count) * 1000) : '—'}; target ${met(m1p95, 2)}`,
        ],
        [
          'webhook stored → cycle written, before the commit (`ingest_latency_ms` of ticket_retrieval_requested, 15 §7)',
          `p50 ${ms(percentile(r.ingest, 50))}, p95 ${ms(percentile(r.ingest, 95))} (n ${r.ingest.length})`,
        ],
        [
          '17 M2 assignment published: `tasks.claimed_at` → `task.claimed` at the other connected drivers; target p95 < 3 s',
          `p50 ${ms(percentile(ws.claimLatency, 50))}, p95 ${ms(m2p95)} (n ${ws.claimLatency.length}); target ${met(m2p95 === null ? null : m2p95 / 1000, 3)}`,
        ],
        [
          'Offer card at its recipient’s socket, from the transaction that opened the round (shown apart, not a target — 15 §10)',
          `p50 ${ms(percentile(ws.offerLatency, 50))}, p95 ${ms(percentile(ws.offerLatency, 95))} (n ${ws.offerLatency.length})`,
        ],
        ['Outbox', r.outbox.map((x) => `${x.status} ${x.n}`).join(', ')],
        [
          'Outbox rows still pending at the end (future timers)',
          r.pendingOutbox.map((x) => `${x.type} ${x.n}`).join(', ') || '—',
        ],
        [
          'Analytics (15 §13)',
          `${r.analytics.domain_events} domain events → ${r.analytics.server_rows} server rows (${r.analytics.distinct_sources} distinct, ${r.analytics.server_names} names); ${r.analytics.client_rows} client rows`,
        ],
        [
          'Process logs',
          Object.entries(r.logs)
            .map(([k, x]) => `${k} ${x.lines} lines, ${x.errors} error lines`)
            .join('; '),
        ],
      ],
    ),
  );
  L();
  L('## Invariants');
  L();
  L(
    table(
      ['Check', 'Violations'],
      [
        ...Object.entries(r.invariants).map(([k, n]) => [`10 §14.1 / 11 §1.7 — ${k}`, n]),
        ...r.consistency.map((c) => [`consistency.sql — ${c.check_name}`, c.violations]),
        ['docs/06_schema_invariants_test.sql (fresh database, same migrations)', r.schemaInvariants],
      ],
    ),
  );
  if (r.failures.length) {
    L();
    L('## Failed checks');
    L();
    for (const f of r.failures) L(`- ${f}`);
  }
  L();
  L('## Owner tasks');
  L();
  L(
    '- H-10 step 1 by people: TC-036 guided on staging with assigned roles (a supervisor, four drivers, three team',
  );
  L(
    '  «customers»), the real phones of H-07 and the Meta test number (Q-03) — this run covers its list with bots only.',
  );
  L(
    '- H-10 steps 2–4 (TC-038): the API stopped for ten minutes in the middle of the event, the numbered paper log,',
  );
  L('  then every paper entry reconciled with `manual-reconcile` and checked.');
  L('- H-09 (TC-037): the backup restore drill on staging.');
  L(
    '- Record the AC-12 / AC-19 evidence, and classify the defects on the 17 §16 scale (the owner confirms within a',
  );
  L('  working day).');
  L();
  L('## Reading notes');
  L();
  const reassigned = Object.entries(r.per)
    .filter(([, p]) => p.reassigned.length)
    .map(([vk, p]) => `${vk} ${p.reassigned.map((n) => `#${n}`).join(', ')}`);
  L(
    `- KPI-01 reads \`tasks.claimed_at\` as 15 §10 defines it. A supervisor's reassignment claims the task again in the new`,
  );
  L(
    `  driver's name (TT-10b), so a reassigned task counts up to its reassignment${reassigned.length ? ` — reassigned this run: ${reassigned.join('; ')}` : ' (none this run)'}. The`,
  );
  L('  customer’s full wait is in KPI-03 and KPI-05.');
  const openDiff = r.incidents.filter((x) => x.type === 'payment_discrepancy' && x.status !== 'resolved');
  L(
    `- ${openDiff.reduce((s, x) => s + x.n, 0)} \`payment_discrepancy\` incident(s) open: the scripted cash shortfall (one count five riyals short,`,
  );
  L('  13 §10.2). It stays open for review after the close and does not block it.');
  L(
    '- The outbox rows still pending are future timers that fire later and find nothing to do: code expiry, next-task and',
  );
  L('  ready checks scheduled for cars already delivered, and the recurring sweeps.');
  L(
    '- Defects found by this rehearsal while it was built, on the 17 §16 scale: «request saved» was not measured',
  );
  L(
    '  (`ingest_latency_ms` always null, `point_retrieval_request_ingest_seconds` never observed) — level 3 (observability,',
  );
  L(
    '  no effect on custody or money), fixed on this branch before this run (docs/progress/notes/g4-rehearsal.md §4).',
  );
  L(
    '  `point_dispatch_publish_seconds` (05 §12.2, the system source of 15 §10’s second target) is declared and never',
  );
  L(
    '  observed — level 3, recorded for the lead in the same notes; M2 above is measured on the drivers’ sockets.',
  );
  L(
    `- Command: \`TEST_DATABASE_URL=postgres://…/postgres pnpm ops:rehearsal\` (this run: ${CFG.tickets} cars, arrivals over ${CFG.arrivalS} s, seed ${CFG.seed}${CFG.tickets === 150 && CFG.arrivalS === 240 && CFG.seed === 20261029 ? ' — the defaults' : ''}).`,
  );
  L();
  return lines.join('\n');
}

let interrupted = false;
/** SIGINT / SIGTERM: stop the bots and the processes, drop the databases (unless REHEARSAL_KEEP_DB=1), keep the logs. */
async function interrupt(signal) {
  if (interrupted) return;
  interrupted = true;
  log(`${signal}: stopping the processes and dropping the databases`);
  stopping = true;
  for (const d of DRIVERS) d.stop();
  await stopAll();
  await run.pool?.end().catch(() => {});
  if (run.db && !CFG.keepDb)
    for (const d of [run.inv, run.database])
      if (d) await run.db.dropDatabase(CFG.admin, d.name).catch(() => {});
  if (run.logDir) log(`process logs kept in ${run.logDir}`);
  process.exit(signal === 'SIGINT' ? 130 : 143);
}
process.on('SIGINT', () => void interrupt('SIGINT'));
process.on('SIGTERM', () => void interrupt('SIGTERM'));

await main();
