#!/usr/bin/env node
/**
 * `pnpm ops:rehearsal` — the automated full-event rehearsal (PNT-102; 17 AC-12 TC-036, H-10 operational part).
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
 *    cars, follow the alerts and handle the scripted exceptions (an early request, a field cancel, a no-show and
 *    its repark, a locked code and the exceptional handover, an opt-out, VIP waivers, a reversal with
 *    replacement, breaks, a driver who loses his connection with a car, a cash shortfall).
 * 5. Closes the night: start-closing, reconciliation, cash handovers, close, shift close.
 * 6. Writes the report (counts, waits p50/p95, alerts raised/resolved, settlement totals, invariants) to
 *    docs/test-evidence/rehearsal/<date>.md (REHEARSAL_REPORT), then stops everything and drops the database
 *    (REHEARSAL_KEEP_DB=1 keeps it). Exit 0 = the rehearsal passed its checks.
 *
 * The human rehearsal with real staff, devices and the Meta test number (H-10, AC-12 TC-036 … TC-038, the
 * paper outage drill and the backup restore) is NOT replaced by this run: it stays an owner task.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { generate as totpCode } from 'otplib';
import pg from 'pg';
import { io as connectSocket } from 'socket.io-client';
import {
  CLOSED_EVENT_CHECKS,
  DURATION_QUERIES,
  INVARIANT_QUERIES,
  percentile,
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
  report: env.REHEARSAL_REPORT ?? join(ROOT, 'docs/test-evidence/rehearsal', `${today}.md`),
  keepDb: env.REHEARSAL_KEEP_DB === '1',
  skipBuild: env.REHEARSAL_SKIP_BUILD === '1',
};
if (CFG.base < 4200 || CFG.base + 4 > 4299)
  throw new Error('REHEARSAL_PORT_BASE must keep the ports in 4200–4299');
const PORT = { api: CFG.base + 1, sim: CFG.base + 2, apiMetrics: CFG.base + 3 }; // worker metrics = apiMetrics + 1
const API = `http://127.0.0.1:${PORT.api}`;
const SIM = `http://127.0.0.1:${PORT.sim}`;
const ORIGIN = `http://localhost:${CFG.base}`; // APP_BASE_URL: the staff web origin (CSRF, DEC-29); nothing listens
const COOKIE = 'point_sid';

const log = (...a) => console.log(`[rehearsal ${((Date.now() - T0) / 1000).toFixed(1).padStart(7)} s]`, ...a);

// deterministic choices (the timings still depend on the machine)
let prng = CFG.seed >>> 0;
const rnd = () => {
  prng = (prng + 0x6d2b79f5) | 0;
  let t = Math.imul(prng ^ (prng >>> 15), 1 | prng);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (a, b) => a + rnd() * (b - a);
const chance = (p) => rnd() < p;
const pause = (a, b) => sleep(Math.round(between(a, b) * 1000));
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

// ------------------------------------------------------------------------------------------------ run state
const children = [];
let stopping = false;
const failures = [];
const notes = [];
const fail = (m) => {
  failures.push(m);
  log(`FAIL ${m}`);
};

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
const ws = { messages: new Map(), offerLatency: [], connects: 0, disconnects: 0 };
const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

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
  for (const c of children.reverse()) {
    c.child.kill('SIGTERM');
    await Promise.race([new Promise((r) => c.child.once('exit', r)), sleep(5000)]);
    if (c.child.exitCode === null) c.child.kill('SIGKILL');
  }
}

// ------------------------------------------------------------------------------------------------ HTTP client
/** One staff device: its own session cookie and (behind the reverse proxy, TRUST_PROXY=1) its own address. */
class Client {
  static seq = 10;
  constructor(label) {
    this.label = label;
    this.ip = `10.42.${Math.floor(Client.seq / 250)}.${(Client.seq++ % 250) + 1}`;
    this.cookie = null;
  }
  async call(method, path, body, opts = {}) {
    const headers = { 'X-Forwarded-For': this.ip, 'X-Requested-With': 'point-web', Origin: ORIGIN };
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const command = method !== 'GET';
    if (command && opts.key !== false) headers['Idempotency-Key'] = randomUUID();
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

// ------------------------------------------------------------------------------------------------ main
async function main() {
  const logDir = mkdtempSync(join(tmpdir(), 'point-rehearsal-'));
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
  const { seed, SEED_IDS, SEED_CREDENTIALS } = await import('@point/db/seed');
  const { setSupervisorMfaRequired } = await import('@point/server/testing');
  const { BRAND_DEFAULTS } = await import('@point/shared');
  const { SimulatorClient } = await import('../../../tools/wa-simulator/dist/index.js');

  // ---------------------------------------------------------------------------- database
  const database = await db.createDatabase(CFG.admin, 'point_rehearsal');
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
    await seed(pool, {
      env: 'test',
      nodeEnv: 'test',
      dataEncryptionKey: secrets.DATA_ENCRYPTION_KEY,
      dataEncryptionKeyId: secrets.DATA_ENCRYPTION_KEY_ID,
      secretPepper: secrets.AUTH_SECRET_PEPPER,
    });
    // the seed gives TOTP secrets to the owner and the administrator only; supervisors sign in with their password
    await setSupervisorMfaRequired(pool, SEED_IDS.org, false);

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
    await waitFor(
      'the worker metrics',
      async () => (await fetch(`http://127.0.0.1:${PORT.apiMetrics + 1}/metrics`)).ok,
    );
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
    if (!CFG.keepDb) await db.dropDatabase(CFG.admin, database.name).catch(() => {});
    else log(`database kept: ${database.url}`);
  }
  if (failures.length) {
    console.error(`REHEARSAL FAILED:\n - ${failures.join('\n - ')}`);
    process.exit(1);
  }
  log('REHEARSAL PASSED');
}

// ------------------------------------------------------------------------------------------------ the world
const DRIVERS = [];
const cars = [];
const carByTicket = new Map();

async function setUp({ SEED_IDS, SEED_CREDENTIALS, sim }) {
  const C = SEED_CREDENTIALS;
  const owner = new Client('OWN1');
  await login(owner, C.OWN1.phone, C.OWN1.secret, C.OWN1.totpSecret);
  must(await owner.post('/v1/admin/whatsapp/templates/sync', {}), 'template sync');
  const templates = must(await owner.get('/v1/admin/whatsapp/templates'), 'templates');
  const approved = (templates.data ?? templates).filter?.((x) => x.status === 'approved').length ?? 0;
  notes.push(`templates synced: ${approved} approved`);

  const admin = new Client('ADM1');
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
  const supR = new Client('SUP-R');
  await login(supR, C['SUP-R'].phone, C['SUP-R'].secret);
  const supL = new Client('SUP-RL');
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
    this.client = new Client(r.key);
    this.onDuty = false;
    this.busy = false;
    this.offline = false;
    this.stopped = false;
    this.decided = new Set();
    this.home = null;
    this.socket = null;
    this.timer = null;
  }

  async signIn() {
    const me = await login(this.client, this.phone, this.pin);
    if (me.must_change_secret) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const pin = String(Math.floor(between(120000, 989999)));
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
          platform: pick(['android', 'ios']),
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
    void this.loop();
  }

  /** The PWA: sync `/v1/me/home`, react to the head offer, advance the current task one step at a time. */
  async loop() {
    while (!this.stopped && this.onDuty) {
      if (this.offline || this.onBreak || this.busy) {
        await sleep(300);
        continue;
      }
      const r = await this.client.get('/v1/me/home', { allow: ['AUTH_SESSION_REVOKED'] });
      if (r.status === 200) {
        this.home = r.data;
        try {
          await this.step(r.data);
        } catch (e) {
          fail(`${this.key} step: ${e.message}`);
        }
      }
      await sleep(Math.round(between(500, 900)));
    }
  }

  async step(h) {
    if (h.driver_state === 'off_duty') return;
    const offer = h.offer;
    if (offer && (offer.can_accept || offer.can_reserve_next) && !this.decided.has(offer.offer_id)) {
      this.decided.add(offer.offer_id);
      // 6 % of the single offers are missed (in the car park, the phone in a pocket): reminder, expiry, rotation
      if (offer.mode === 'single' && chance(0.06)) return;
      await pause(1, 4);
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
      if (!t.key_picked_up_at) {
        await pause(2, 5);
        const r = await this.client.post(`/v1/tasks/${t.id}/key-pickup`, { key_slot_id: cur.key_slot?.id });
        if (r.status === 200 && car?.slotId) {
          this.venue.slotsFree.push(car.slotId);
          car.slotId = null;
        }
      } else {
        await pause(2, 4);
        const r = await this.client.post(`/v1/tasks/${t.id}/start-retrieval`, {});
        if (r.status === 200) {
          if (car?.spotId) {
            this.venue.spotsFree.push(car.spotId);
            car.spotId = null;
          }
          if (car?.basement) void this.loseNetwork(130);
        }
      }
    } else if (t.type === 'retrieve' && t.status === 'in_progress') {
      if (cur.ticket.status === 'retrieving') {
        await pause(6, 14);
        await this.client.post(`/v1/tasks/${t.id}/ready`, {});
      } else if (cur.ticket.status === 'ready' && car) {
        await this.handOver(cur, car);
      }
    } else if (t.type === 'repark' && t.status === 'in_progress') {
      await pause(5, 10);
      await this.park(t.id, car);
    }
  }

  async handOver(cur, car) {
    if (car.noShow && !car.reparked) return; // the customer is not there: the supervisor follows the alert
    if (car.lockAt === undefined && car.lockScenario) {
      // the guest reads the wrong message: five wrong codes lock it (the supervisor's exception follows)
      car.lockAt = Date.now();
      for (let i = 0; i < 5; i++) {
        await pause(1, 2);
        await this.client.post(`/v1/tickets/${car.ticketId}/handover`, {
          verification: { method: 'code', code: String(100000 + Math.floor(rnd() * 899999)) },
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
      car.atGate = Date.now() + Math.round(between(2, 7) * 1000);
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
      const pos = car.forcePos || chance(0.35);
      payment = pos
        ? {
            method: 'pos',
            amount_halalas: cur.payment_due.amount_halalas,
            pos_reference: car.posRef ?? `AP${Math.floor(between(1000, 9999))}`,
          }
        : { method: 'cash', amount_halalas: cur.payment_due.amount_halalas };
    }
    await pause(1, 3);
    const r = await this.client.post(`/v1/tickets/${car.ticketId}/handover`, {
      verification,
      ...(payment ? { payment } : {}),
    });
    if (r.status === 200) {
      car.deliveredAt = Date.now();
      car.payment = r.data.payment ?? null;
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
      if (car) Object.assign(car, { spotId, slotId, parkedAt: Date.now() });
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
      const c = await this.client.post('/v1/tickets', { event_id: v.eventId, channel: car.channel });
      if (c.status !== 201) return false;
      car.ticketId = c.data.ticket.id;
      car.displayNumber = c.data.ticket.display_number;
      carByTicket.set(car.ticketId, car);
      const parkTaskId = c.data.task.id;
      await pause(2, 4);
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
      if (car.earlyPress) void customerLeavesEarly(car);
      await pause(4, 10); // driving to the spot
      const r = await this.park(parkTaskId, car);
      if (r.status !== 200) return false;
      scheduleDeparture(car);
      return true;
    } finally {
      this.busy = false;
    }
  }

  /** The basement: no network for `seconds` (no heartbeat, no request), then back. */
  async loseNetwork(seconds) {
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

  async takeBreak(seconds) {
    this.onBreak = true;
    while (this.busy) await sleep(200);
    const r = await this.client.post(
      '/v1/me/duty/break',
      { active: true },
      { allow: ['DRIVER_NOT_AVAILABLE', 'INVALID_STATE_TRANSITION'] },
    );
    if (r.status === 200) {
      await sleep(seconds * 1000);
      await this.client.post('/v1/me/duty/break', { active: false });
    }
    this.onBreak = false;
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

function makeCars(venues) {
  const counts = { RMS: Math.round(CFG.tickets * 0.53), LYL: CFG.tickets - Math.round(CFG.tickets * 0.53) };
  let serial = 1000;
  for (const v of Object.values(venues)) {
    for (let i = 0; i < counts[v.key]; i++) {
      const whatsapp = chance(v.key === 'RMS' ? 0.6 : 0.55);
      let phone = null;
      if (whatsapp) {
        do phone = `+9665${v.key === 'RMS' ? '31' : '32'}${String(++phoneSeq).padStart(6, '0')}`;
        while (reservedSuffix(phone));
      }
      const [make, model, type] = pick(MAKES);
      const car = {
        venue: v,
        idx: i,
        channel: whatsapp ? 'whatsapp' : 'paper',
        phone,
        serial: whatsapp ? null : `${v.key[0]}-${serial++}`,
        plate: String(1000 + Math.floor(rnd() * 8999)),
        letters: pick(LETTERS),
        make,
        model,
        type,
        color: pick(COLORS),
        keyTag: `${v.key}-K${i + 1}`,
        arriveAt: Math.round(between(0, CFG.arrivalS) * 1000),
        dwellMs: Math.round(between(CFG.dwellS[0], CFG.dwellS[1]) * 1000),
        codes: [],
      };
      v.cars.push(car);
      cars.push(car);
    }
    v.cars.sort((a, b) => a.arriveAt - b.arriveAt);
  }
  // the scripted moments of the night (each on a car that fits it)
  const wa = (v) => v.cars.filter((c) => c.channel === 'whatsapp');
  const paper = (v) => v.cars.filter((c) => c.channel === 'paper');
  const R = venues.RMS;
  const L = venues.LYL;
  const tag = (car, k, label) => {
    if (car) {
      car[k] = true;
      car.labels = [...(car.labels ?? []), label];
    }
  };
  tag(wa(R)[3], 'earlyPress', 'early request (pressed while being parked)');
  tag(wa(L)[4], 'earlyPress', 'early request (pressed while being parked)');
  tag(wa(R)[8], 'fieldCancel', 'field cancel at the gate, asked again later');
  tag(wa(R)[12], 'noShow', 'no-show: ready_not_collected → repark (W-08) → asked again');
  tag(wa(R)[16], 'lockScenario', 'five wrong codes → locked → exceptional handover');
  tag(wa(L)[9], 'optOut', '«إيقاف» after W-01, then the button resumes the consent');
  tag(paper(R)[2], 'vip', 'VIP guest: fee waived by the supervisor');
  tag(paper(R)[7], 'vip', 'VIP guest: fee waived by the supervisor');
  const rev = wa(R)[20];
  tag(rev, 'reverse', 'POS reference corrected by a reversal with replacement');
  if (rev) Object.assign(rev, { forcePos: true, posRef: 'AP7001' });
  tag(wa(L)[14] ?? paper(L)[6], 'basement', 'driver loses the network with this car (connection alert)');
}

/** The gate: cars wait in line until a driver of the venue is free (no task, no live offer, not on break). */
async function gate(v, t0) {
  const queue = [];
  let next = 0;
  while (!stopping && (next < v.cars.length || queue.length)) {
    while (next < v.cars.length && Date.now() - t0 >= v.cars[next].arriveAt) {
      v.cars[next].arrivedAt = Date.now();
      queue.push(v.cars[next++]);
    }
    if (queue.length) {
      const free = v.drivers.filter(
        (d) =>
          d.onDuty &&
          !d.busy &&
          !d.onBreak &&
          !d.offline &&
          d.home?.driver_state === 'available' &&
          !d.home?.offer,
      );
      for (const d of free.slice(0, queue.length)) {
        const car = queue.shift();
        car.intakeBy = d;
        void d.intake(car).then((ok) => {
          if (!ok) fail(`intake of ${v.key} car ${car.idx} by ${d.key} failed`);
        });
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
  fail(`${car.phone}: no W-01 to press`);
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
      await sleep(4000);
    }
    await pressFor(car);
    if (car.fieldCancel) void fieldCancel(car);
  } else {
    if (car.vip && v.paid) {
      const w = await v.sup.post(`/v1/tickets/${car.ticketId}/payment-waiver`, {
        reason: 'ضيف كبار الزوار على حساب المضيف',
      });
      if (w.status !== 200) fail(`waiver of ${car.serial}: ${w.status}`);
    }
    const r = await v.sup.post(`/v1/tickets/${car.ticketId}/retrievals`, {
      reason: 'العميل عند البوابة بالكعب الورقي',
    });
    if (r.status !== 201) fail(`request on behalf of ${car.serial}: ${r.status} ${r.error?.code}`);
  }
}

/** The guest tells the supervisor he stays longer once a driver accepted; he asks again 40 s later. */
async function fieldCancel(car) {
  const v = car.venue;
  for (let i = 0; i < 120 && !stopping; i++) {
    const t = await v.sup.get(`/v1/tickets/${car.ticketId}`);
    if (t.data?.status === 'assigned' && t.data.active_cycle?.id) {
      const r = await v.sup.post(`/v1/retrieval-cycles/${t.data.active_cycle.id}/cancel`, {
        reason: 'العميل سيبقى وقتًا أطول',
      });
      if (r.status === 200) {
        notes.push(`field cancel of ticket ${car.displayNumber} (${v.key})`);
        await sleep(40_000);
        await pressFor(car);
        return;
      }
    }
    if (['retrieving', 'ready', 'delivered'].includes(t.data?.status)) return; // too late: it goes on
    await sleep(500);
  }
}

/** The supervisor's screen S-04: acknowledge critical alerts, repark a no-show, approve the exceptional handover. */
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
          car.atGate = undefined;
          // the code of the reparked cycle is revoked: only a newer W-05 is good for the next handover
          const old = await sim()
            .claimCodeDetails(car.phone)
            .catch(() => null);
          if (old) car.codeSeqUsed = old.seq;
          notes.push(`no-show: ticket ${car.displayNumber} reparked after ready_not_collected`);
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
          notes.push(`code locked on ticket ${car.displayNumber}: exceptional handover by the supervisor`);
        } else fail(`exception of ${car.displayNumber}: ${ex.status} ${ex.error?.code}`);
      }
    }
    // a POS reference typed wrong: corrected by a reversal with replacement (13 §7.2)
    for (const car of v.cars)
      if (car.reverse && car.payment?.method === 'pos' && !car.reversed) {
        car.reversed = true;
        const rv = await v.sup.post(`/v1/payments/${car.payment.id}/reverse`, {
          reason: 'رقم مرجع الشبكة أُدخل خطأ',
          replacement: { method: 'pos', amount_halalas: car.payment.amount_halalas, pos_reference: 'AP7010' },
        });
        if (rv.status !== 200) fail(`reversal ${rv.status} ${rv.error?.code}`);
      }
    await sleep(3000);
  }
}

async function playEvening(world) {
  SIMC = world.sim;
  const { venues } = world;
  makeCars(venues);
  log(`the evening: ${cars.length} cars (${venues.RMS.cars.length} RMS, ${venues.LYL.cars.length} LYL)`);
  for (const d of DRIVERS.filter((x) => !x.supervisor)) {
    await d.startDuty();
    await sleep(Math.round(between(200, 700)));
  }
  const t0 = Date.now();
  const sups = Object.values(venues).map((v) => supervise(v));
  const gates = Object.values(venues).map((v) => gate(v, t0));
  // the driving supervisor joins the RMS drivers for the rush
  setTimeout(() => void world.supRD.startDuty(), Math.round(CFG.arrivalS * 0.3 * 1000));
  // two prayer breaks per venue in the middle of the arrivals
  setTimeout(
    () => {
      for (const v of Object.values(venues)) for (const d of v.drivers.slice(1, 3)) void d.takeBreak(45);
    },
    Math.round(CFG.arrivalS * 0.55 * 1000),
  );
  await Promise.all(gates);
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
    if (v.paid) {
      const s = must(await sup.get(`/v1/events/${v.eventId}/settlement`), 'settlement');
      let shortDone = false;
      for (const d of s.drivers) {
        const out = d.cash.outstanding_halalas;
        if (out <= 0) continue;
        const short = shortDone ? 0 : 500;
        shortDone = true;
        must(
          await sup.post('/v1/cash-handovers', {
            event_id: v.eventId,
            driver_id: d.driver.id,
            amount_halalas: out - short,
            ...(short ? { note: 'نقص خمسة ريالات عند العد' } : {}),
          }),
          'cash handover',
        );
      }
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
async function measure({ world, pool, db, playedS, logDir, database }) {
  const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const { venues } = world;
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
      offers: await q(
        `SELECT o.mode, o.status, coalesce(o.close_reason, '—') AS close_reason, count(*)::int AS n
           FROM task_offers o JOIN tasks k ON k.id = o.task_id WHERE k.event_id = $1 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
        [e],
      ),
      durations,
      settlement: s,
      closeSummary: v.closeSummary,
      blockersAtClosing: v.blockersAtClosing,
      closed,
      event: (await q(`SELECT status, closed_at FROM events WHERE id = $1`, [e]))[0],
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
                  coalesce(sum(amount_halalas) FILTER (WHERE status = 'recorded' AND method = 'cash'), 0)::int AS cash
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
  const alerts = await q(
    `SELECT type, severity, count(*)::int AS raised, count(*) FILTER (WHERE status = 'resolved')::int AS resolved,
            count(*) FILTER (WHERE status = 'acknowledged')::int AS acknowledged,
            count(*) FILTER (WHERE status = 'open')::int AS open
       FROM alerts GROUP BY 1, 2 ORDER BY 1`,
  );
  const incidents = await q(
    `SELECT type, status, count(*)::int AS n FROM incidents GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  const outbox = await q(`SELECT status, count(*)::int AS n FROM outbox_events GROUP BY 1 ORDER BY 1`);
  const pendingOutbox = await q(
    `SELECT type, count(*)::int AS n FROM outbox_events WHERE status = 'pending' GROUP BY 1 ORDER BY 1`,
  );
  // 17 H-08 M1 for the button: webhook received → cycle committed (`ingest_latency_ms` of ticket_retrieval_requested)
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
  const invariants = {};
  for (const [name, sql] of Object.entries(INVARIANT_QUERIES)) invariants[name] = (await q(sql)).length;
  const consistency = await q(readFileSync(join(ROOT, 'infra/backup/consistency.sql'), 'utf8'));
  // docs/06_schema_invariants_test.sql on a fresh database built from the same migrations (it needs an empty one)
  const inv = await db.createDatabase(CFG.admin, 'point_rehearsal_inv');
  let schemaInvariants;
  try {
    await db.migrate(inv.url);
    const out = await db.runSqlScript(inv.url, db.INVARIANTS_SQL);
    schemaInvariants = out.at(-1);
  } finally {
    await db.dropDatabase(CFG.admin, inv.name);
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
    if (p.cash.expected !== p.recorded.cash) fail(`${vk} cash expected ≠ cash collected`);
    if (p.cash.amount !== p.recorded.cash + p.cash.difference)
      fail(`${vk} cash handed over ≠ collected + difference`);
    if (!p.settlement.integrity.ok) fail(`${vk} settlement integrity`);
  }
  if (http.server5xx.length) fail(`${http.server5xx.length} server errors (5xx or network)`);
  if (
    analytics.server_rows !== analytics.domain_events ||
    analytics.distinct_sources !== analytics.domain_events
  )
    fail(`analytics rows ${analytics.server_rows} for ${analytics.domain_events} domain events`);
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
      analytics,
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
  const lines = [];
  const L = (s = '') => lines.push(s);
  L(`# Automated rehearsal — ${today}`);
  L();
  L(
    `\`pnpm ops:rehearsal\` (apps/api/rehearsal/run.mjs; PNT-102, 17 AC-12 TC-036 operational part, H-10 step 1).`,
  );
  L();
  L(
    `**Result: ${r.failures.length ? 'FAILED' : 'PASSED'}** — ${r.failures.length ? r.failures.length + ' check(s) failed (listed at the end)' : 'every check below held'}.`,
  );
  L();
  L(
    '> This is the automated rehearsal. **The human rehearsal remains an owner task** (16 PNT-102, 17 H-10): real staff',
  );
  L(
    '> and phones (H-07 devices), the Meta test number (Q-03), the paper outage drill (TC-038) and the backup restore',
  );
  L(
    '> (TC-037) on staging. AC-12 and AC-19 evidence from it is still to be recorded; PNT-102 stays in progress.',
  );
  L();
  L('## Setup');
  L();
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
          `${drivers} drivers (8 per venue; ${drivers - 8} created by the administrator, PIN changed at first login) + SUP-RD driving; SUP-R (RMS), SUP-RL (LYL); OWN1 and ADM1 with TOTP`,
        ],
        [
          'Schedule',
          `${cars.length} cars arriving over ${CFG.arrivalS} s, parked ${CFG.dwellS[0]}–${CFG.dwellS[1]} s; driver actions 1–15 s; \`ready.uncollected_alert_min\` = 2 (17 §3.3)`,
        ],
        [
          'Timers',
          'canon §12 defaults otherwise: reminder 15 s, single offer 30 s, escalation 60 s, heartbeat 15/45/120 s',
        ],
        ['Duration', `${r.playedS} s of play, ${totalS} s in all (build, boot, setup, closing, measures)`],
      ],
    ),
  );
  L();
  L(
    'Scripted moments: ' +
      cars
        .filter((c) => c.labels)
        .map((c) => `${c.venue.key} #${c.displayNumber ?? '?'} ${c.labels.join(', ')}`)
        .join('; ') +
      '.',
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
        ['Retrieve tasks', 'Repark tasks', 'Reserved as next (W-03)', 'Escalated (60 s)', 'Canceled'],
        [
          [
            p.dispatch.retrieve,
            p.dispatch.repark,
            p.dispatch.reserved_next,
            p.dispatch.escalated,
            p.dispatch.canceled,
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
          ['cash collected (SQL)', sar(p.recorded.cash)],
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
    L();
    L(
      `Closing: blockers at start-closing ${JSON.stringify(p.blockersAtClosing)}; event \`${p.event.status}\`; after the close every check of a closed event is 0: ${Object.entries(
        p.closed,
      )
        .map(([k, n]) => `${k} ${n}`)
        .join(', ')}.`,
    );
  }
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
      ['Alert', 'Severity', 'Raised', 'Acknowledged', 'Resolved', 'Still open'],
      r.alerts.map((x) => [x.type, x.severity, x.raised, x.acknowledged, x.resolved, x.open]),
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
          'Server errors (5xx / network)',
          http.server5xx.length ? http.server5xx.slice(0, 10).join('; ') : '0',
        ],
        [
          'Unexpected refusals',
          http.unexpected.length
            ? `${http.unexpected.length}: ${http.unexpected.slice(0, 8).join('; ')}`
            : '0',
        ],
        [
          'WebSocket',
          `${ws.connects} connects, ${ws.disconnects} disconnects; ${[...ws.messages.entries()]
            .sort()
            .map(([k, n]) => `${k} ${n}`)
            .join(', ')}`,
        ],
        [
          'Offer delivery (commit → driver socket; target p95 < 3 s, 17 M2)',
          `p50 ${percentile(ws.offerLatency, 50) ?? '—'} ms, p95 ${percentile(ws.offerLatency, 95) ?? '—'} ms (n ${ws.offerLatency.length})`,
        ],
        [
          'Request saved (webhook received → cycle committed; target p95 < 2 s, 17 M1)',
          `p50 ${percentile(r.ingest, 50) ?? '—'} ms, p95 ${percentile(r.ingest, 95) ?? '—'} ms (n ${r.ingest.length})`,
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
    '- The human rehearsal of H-10 with real staff and devices, the Meta test number, the paper outage drill (TC-038)',
  );
  L(
    '  and the backup restore (TC-037) on staging; record AC-12 / AC-19 evidence and classify defects (17 severity).',
  );
  L();
  return lines.join('\n');
}

process.on('SIGINT', () => {
  void stopAll().then(() => process.exit(130));
});

await main();
