#!/usr/bin/env node
// pnpm ops:chaos — PNT-098: the chaos and self-healing checks of 17 H-03 and 17 §12 against the production build.
//
// Every scenario gets its own database (point_chaos_<scenario>_<run>), seed, WhatsApp simulator, api and worker
// (child processes on ports 4120–4199), then breaks something on purpose and verifies what must still hold:
//   kp1 … kp5        the kill points of H-03 (CHAOS_KILL_AT, SIGKILL): TC-013 … TC-017 / AC-06 — nothing lost,
//                    nothing duplicated, the outbox resumes, a retried command replays its stored answer
//   kp4_silent       KP-4 without any status webhook: at most one duplicate message, recorded as attempt 2
//   db_outage        backends terminated, then the database refusing connections for 60 s: SERVICE_UNAVAILABLE,
//                    no request lost (Meta redelivers), timers run late and once, the processes survive
//   wa_outage        the simulator's `channel_down` (Graph 190) for 2 min: wa_channel_down, internal operations go
//                    on, after recovery only the current state of each ticket is sent (TC-WA-22)
//   wa_outage_temporary  the provider failing with 131016 for 150 s: down after the 2-minute streak (12 §5.14)
//   push_outage      the test Push service stopped: failures counted, push_failed_repeatedly, dispatch unaffected
//   worker_stop      the worker stopped 2 min: outbox_lag raised, escalations due meanwhile run once afterwards
//   worker_x3        three workers on one outbox: no row processed twice, every message sent once
//
// Knobs: --only kp1,kp5,… · --out DIR · --port CHAOS_PORT_BASE (4120) · --keep-db · --no-build ·
// CHAOS_DB_OUTAGE_S (60) · CHAOS_WA_OUTAGE_S (120) · CHAOS_WA_TEMP_OUTAGE_S (150) · CHAOS_WORKER_STOP_S (120).
import { spawnSync } from 'node:child_process';
import { createECDH, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { ApiClient } from '../harness/api.mjs';
import { consistency, createDb, dropDb, migrateDb, withAdmin } from '../harness/db.mjs';
import { ROOT, importDist, pg } from '../harness/deps.mjs';
import { serverEnv, simulatorEnv } from '../harness/env.mjs';
import { intakeAndPark, must } from '../harness/flows.mjs';
import { Proc, SCRIPTS, waitHttp } from '../harness/procs.mjs';
import { runId, seedWorld } from '../harness/seed.mjs';
import { table } from '../harness/stats.mjs';
import { DriverBot, prng } from '../load/bots.mjs';

const { values: a } = parseArgs({
  options: {
    only: { type: 'string' },
    out: { type: 'string' },
    port: { type: 'string' },
    'keep-db': { type: 'boolean' },
    'no-build': { type: 'boolean' },
  },
});
const env = process.env;
const RUN = runId();
const OUT = a.out ?? env.CHAOS_OUT ?? join(tmpdir(), `point-chaos-${RUN}`);
mkdirSync(OUT, { recursive: true });
const BASE_PORT = Number(a.port ?? env.CHAOS_PORT_BASE ?? 4120);
const P = { api: BASE_PORT, metrics: BASE_PORT + 1, sim: BASE_PORT + 10, push: BASE_PORT + 20 };
const KEEP = !!a['keep-db'];
const S = (name, def) => Number(env[name] ?? def) * 1000;
const DB_OUTAGE_MS = S('CHAOS_DB_OUTAGE_S', 60);
const WA_OUTAGE_MS = S('CHAOS_WA_OUTAGE_S', 120);
const WA_TEMP_OUTAGE_MS = S('CHAOS_WA_TEMP_OUTAGE_S', 150);
const WORKER_STOP_MS = S('CHAOS_WORKER_STOP_S', 120);
const t0 = Date.now();
const log = (m) => console.log(`[chaos ${((Date.now() - t0) / 1000).toFixed(1).padStart(7)} s] ${m}`);

const count = (rows) => Number(rows[0]?.n ?? 0);
const digits = (s) => String(s ?? '').replace(/\D/g, '');

/** A test Web Push service (17 §3.1): records each push (headers only, the body is encrypted) and answers 201. */
function pushService(port) {
  const received = [];
  let server = null;
  return {
    received,
    start: () =>
      new Promise((resolve) => {
        server = createServer((req, res) => {
          let bytes = 0;
          req.on('data', (d) => (bytes += d.length));
          req.on('end', () => {
            received.push({
              at: Date.now(),
              path: req.url,
              ttl: req.headers.ttl,
              urgency: req.headers.urgency,
              topic: req.headers.topic,
              bytes,
            });
            res.writeHead(201).end();
          });
        });
        server.listen(port, '127.0.0.1', resolve);
      }),
    stop: () =>
      new Promise((resolve) => {
        if (!server) return resolve();
        server.closeAllConnections?.();
        server.close(() => resolve());
        server = null;
      }),
  };
}

/** VAPID keys (P-256, base64url: 65-byte public point, 32-byte private scalar) for the real web-push sender. */
function vapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(pub.x, 'base64url'),
    Buffer.from(pub.y, 'base64url'),
  ]);
  return {
    VAPID_PUBLIC_KEY: raw.toString('base64url'),
    VAPID_PRIVATE_KEY: privateKey.export({ format: 'jwk' }).d,
  };
}

/** A browser's push subscription keys (p256dh = a P-256 public key, auth = 16 random bytes). */
function subscriptionKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}

class Stage {
  constructor(name) {
    this.name = name;
    this.checks = [];
    this.notes = [];
    this.drivers = new Map();
    this.ticketSeq = 0;
  }

  async init(o = {}) {
    this.dir = join(OUT, this.name);
    mkdirSync(this.dir, { recursive: true });
    this.dbName = `point_chaos_${this.name}_${RUN}`;
    this.url = await createDb(this.dbName);
    await migrateDb(this.url);
    this.srv = serverEnv({
      dbUrl: this.url,
      ports: P,
      overrides: {
        RATE_LIMIT_AUTH_PER_MIN: '600',
        // test knob: a crashed worker's lease frees its rows after 10 s (production default 30 s)
        WORKER_LEASE_SECONDS: '10',
        ...(o.server ?? {}),
      },
    });
    this.world = await seedWorld(this.url, { venues: 2, driversPerVenue: o.drivers ?? 4, env: this.srv });
    this.venue = this.world.venues[0];
    this.pool = new pg.Pool({ connectionString: this.url, max: 3 });
    this.pool.on('error', () => {}); // the outage scenarios terminate these connections too
    this.sim = new Proc(
      'simulator',
      SCRIPTS.simulator,
      simulatorEnv(this.srv, { ports: P, overrides: { WEBHOOK_RETRIES: '8', ...(o.sim ?? {}) } }),
      this.dir,
    );
    this.api = new Proc('api', SCRIPTS.api, this.srv, this.dir);
    this.worker = new Proc('worker', SCRIPTS.worker, { ...this.srv, WORKER_ID: 'chaos-worker-1' }, this.dir);
    this.sim.start();
    await waitHttp(`http://127.0.0.1:${P.sim}/_sim/health`);
    await this.startApi();
    await this.startWorker();
    const { SimulatorClient } = await importDist('tools/wa-simulator/dist/index.js');
    this.simc = new SimulatorClient(`http://127.0.0.1:${P.sim}`);
    this.base = `http://127.0.0.1:${P.api}`;
    const owner = new ApiClient(this.base, { label: 'owner' });
    await owner.login(this.world.owner.phone, this.world.owner.secret, this.world.owner.totpSecret);
    await must(owner.command('POST', '/v1/admin/whatsapp/templates/sync', {}), 'template sync');
    log(`${this.name}: stage ready (${this.dbName})`);
    return this;
  }

  async startApi(extra = {}) {
    this.api.start(extra);
    await waitHttp(`http://127.0.0.1:${P.api}/health/ready`, { timeoutMs: 60_000 });
  }

  async startWorker(extra = {}) {
    this.worker.start(extra);
    await waitHttp(`http://127.0.0.1:${P.metrics + 1}/metrics`, { timeoutMs: 60_000 });
  }

  check(name, ok, detail = '') {
    this.checks.push({
      name,
      ok: !!ok,
      detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
    });
    log(
      `${this.name}: ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`,
    );
  }

  note(text) {
    this.notes.push(text);
    log(`${this.name}: note ${text}`);
  }

  rows(sql, params = []) {
    return this.pool.query(sql, params).then((r) => r.rows);
  }

  /** A driver of the first venue, signed in and on duty (cached). */
  async driver(i) {
    const d = this.venue.drivers[i];
    if (this.drivers.has(d.id)) return this.drivers.get(d.id);
    const api = new ApiClient(this.base, { label: `drv${i}` });
    await api.login(d.phone, d.pin);
    await must(api.command('POST', '/v1/me/duty/start', {}), `duty start drv${i}`);
    api.userId = d.id;
    this.drivers.set(d.id, api);
    return api;
  }

  async supervisor() {
    if (this.sup) return this.sup;
    this.sup = new ApiClient(this.base, { label: 'sup' });
    await this.sup.login(this.venue.supervisor.phone, this.venue.supervisor.password);
    return this.sup;
  }

  /** A WhatsApp ticket of the first venue parked by `driver`, linked (W-01 accepted) and quiet. */
  async parked(driver) {
    const n = ++this.ticketSeq;
    const spec = {
      eventId: this.venue.events[0].id,
      phone: `+966570${String(n).padStart(6, '0')}`,
      plateDigits: String(3000 + n),
      keyTag: `C-${n}`,
      spotId: this.venue.spots[n],
      slotId: this.venue.slots[n],
    };
    const t = await intakeAndPark(driver, spec);
    await this.waitFor(
      async () =>
        (await this.rows(`SELECT wa_link_status FROM tickets WHERE id = $1`, [t.ticketId]))[0]
          ?.wa_link_status === 'linked',
      30_000,
      'W-01 accepted',
    );
    return t;
  }

  /** Waits until the simulator's webhook log stops growing (no delivery in flight). */
  async settleWebhooks(quietMs = 2500) {
    let last = -1;
    let stableSince = Date.now();
    for (;;) {
      const n = (await this.simc.webhookDeliveries()).length;
      if (n !== last) {
        last = n;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= quietMs) return;
      await sleep(250);
    }
  }

  async waitFor(fn, timeoutMs, what) {
    const end = Date.now() + timeoutMs;
    let v;
    while (Date.now() < end) {
      try {
        v = await fn();
      } catch {
        v = undefined;
      }
      if (v) return v;
      await sleep(500);
    }
    throw new Error(`timed out (${timeoutMs} ms) waiting for ${what}`);
  }

  async messagesTo(phone, purpose) {
    const all = await this.simc.listMessages(purpose ? { purpose } : {});
    return all.filter((m) => (m.waId ?? digits(m.to)) === digits(phone)).sort((x, y) => x.seq - y.seq);
  }

  /** The live round of a ticket's retrieve task and an `accept` recipient. */
  async liveOffer(ticketId) {
    return (
      await this.rows(
        `SELECT o.id AS offer_id, o.mode, r.user_id, t.id AS task_id
           FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id JOIN tasks t ON t.id = o.task_id
          WHERE t.ticket_id = $1 AND t.type = 'retrieve' AND o.status = 'active' AND r.eligible_as = 'accept'
          ORDER BY o.created_at DESC, r.user_id LIMIT 1`,
        [ticketId],
      )
    )[0];
  }

  async consistent() {
    const c = await consistency(this.pool);
    const bad = Object.entries(c).filter(([, n]) => n !== 0);
    this.check(
      'consistency queries all zero (10 §14.1, 11 §1.7, restore checks)',
      bad.length === 0,
      bad.length ? Object.fromEntries(bad) : '',
    );
  }

  alive(...procs) {
    for (const p of procs)
      this.check(`${p.name} process still running`, p.running, p.exit ? JSON.stringify(p.exit) : '');
  }

  async close() {
    for (const p of [this.worker, this.api, this.sim, ...(this.extra ?? [])]) await p?.stop().catch(() => {});
    await this.pool?.end().catch(() => {});
    if (!KEEP) await dropDb(this.dbName).catch((e) => log(`drop ${this.dbName}: ${e.message}`));
  }
}

const killed = (p, point) => p.exit?.signal === 'SIGKILL' && p.killPoint === point;

// ------------------------------------------------------------------------------------------------ kill points

/** TC-013 (KP-1): the api dies after storing the webhook and before its 200; the redelivery is deduplicated. */
async function kp1(st) {
  const drv = await st.driver(0);
  const t = await st.parked(drv);
  await st.settleWebhooks();
  await st.api.stop();
  await st.startApi({ CHAOS_KILL_AT: 'webhook_after_store_before_ack' });
  const press = st.simc.pressButton({ to: t.phone, purpose: 'W-01' });
  await st.api.waitExit(20_000);
  st.check(
    'api killed at KP-1 webhook_after_store_before_ack (SIGKILL)',
    killed(st.api, 'webhook_after_store_before_ack'),
    st.api.exit,
  );
  const stored = await st.rows(
    `SELECT count(*)::int AS n FROM whatsapp_inbound_events WHERE raw_body LIKE '%"type":"button"%'`,
  );
  st.check(
    'the press was stored before the crash (no 200 sent)',
    count(stored) === 1,
    `${count(stored)} row(s)`,
  );
  await st.startApi();
  const res = await press;
  const d = res.deliveries?.[0];
  st.check('Meta (the simulator) redelivered the same body and got 200', d?.ok && d.attempts >= 2, {
    attempts: d?.attempts,
    httpStatus: d?.httpStatus,
  });
  const wamid = res.wamids?.[0];
  await st.waitFor(async () => (await st.messagesTo(t.phone, 'W-02')).length >= 1, 60_000, 'W-02');
  await sleep(4000);
  const events = await st.rows(
    `SELECT count(*)::int AS n FROM whatsapp_inbound_events WHERE raw_body LIKE $1`,
    [`%${wamid}%`],
  );
  st.check(
    'one whatsapp_inbound_events row for the press (body_sha256)',
    count(events) === 1,
    `${count(events)}`,
  );
  const cycles = await st.rows(`SELECT count(*)::int AS n FROM retrieval_cycles WHERE ticket_id = $1`, [
    t.ticketId,
  ]);
  st.check('one retrieval cycle', count(cycles) === 1, `${count(cycles)}`);
  const tasks = await st.rows(
    `SELECT count(*)::int AS n FROM tasks WHERE ticket_id = $1 AND type = 'retrieve'`,
    [t.ticketId],
  );
  st.check('one retrieve task', count(tasks) === 1, `${count(tasks)}`);
  st.check('one W-02 to the customer', (await st.messagesTo(t.phone, 'W-02')).length === 1);
  await st.consistent();
}

/** TC-014 (KP-2): the worker dies after the cycle committed and before the event is `processed`; reprocessed once. */
async function kp2(st) {
  const drv = await st.driver(0);
  const t = await st.parked(drv);
  await st.settleWebhooks();
  await st.worker.stop();
  await st.startWorker({ CHAOS_KILL_AT: 'inbound_after_cycle_commit' });
  const res = await st.simc.pressButton({ to: t.phone, purpose: 'W-01' });
  const wamid = res.wamids?.[0];
  await st.worker.waitExit(30_000);
  st.check(
    'worker killed at KP-2 inbound_after_cycle_commit (SIGKILL)',
    killed(st.worker, 'inbound_after_cycle_commit'),
    st.worker.exit,
  );
  const ev = (
    await st.rows(`SELECT id, status FROM whatsapp_inbound_events WHERE raw_body LIKE $1`, [`%${wamid}%`])
  )[0];
  const cyclesAtCrash = await st.rows(
    `SELECT count(*)::int AS n FROM retrieval_cycles WHERE ticket_id = $1`,
    [t.ticketId],
  );
  st.check(
    'at the crash: the cycle is committed and the event still pending',
    count(cyclesAtCrash) === 1 && ev?.status === 'pending',
    { cycles: count(cyclesAtCrash), event: ev?.status },
  );
  await st.startWorker();
  await st.waitFor(
    async () =>
      (await st.rows(`SELECT status FROM whatsapp_inbound_events WHERE id = $1`, [ev.id]))[0]?.status ===
      'processed',
    90_000,
    'the event processed after the lease expired',
  );
  await st.waitFor(async () => (await st.messagesTo(t.phone, 'W-02')).length >= 1, 60_000, 'W-02');
  await sleep(4000);
  const job = (
    await st.rows(
      `SELECT status, attempts FROM outbox_events WHERE type = 'job.wa_process_inbound' AND payload->>'inbound_event_id' = $1`,
      [ev.id],
    )
  )[0];
  st.check(
    'the inbound job ran again after the lease and completed (attempts = 2)',
    job?.status === 'done' && job.attempts === 2,
    job,
  );
  const cycles = await st.rows(`SELECT count(*)::int AS n FROM retrieval_cycles WHERE ticket_id = $1`, [
    t.ticketId,
  ]);
  st.check(
    'still one retrieval cycle (uq_retrieval_cycles_open, wamid unique)',
    count(cycles) === 1,
    `${count(cycles)}`,
  );
  const msgs = await st.rows(`SELECT count(*)::int AS n FROM whatsapp_messages WHERE wa_message_id = $1`, [
    wamid,
  ]);
  st.check('one inbound whatsapp_messages row for the press', count(msgs) === 1);
  st.check('one W-02', (await st.messagesTo(t.phone, 'W-02')).length === 1);
  await st.consistent();
}

/** TC-015 (KP-3): the worker dies holding the lease of job.wa_send; another run sends it once (attempts 2). */
async function kp3(st) {
  const drv = await st.driver(0);
  const t = await st.parked(drv);
  await st.settleWebhooks();
  await st.worker.stop();
  await st.startWorker({ CHAOS_KILL_AT: 'outbox_after_lock_before_send' });
  await st.simc.pressButton({ to: t.phone, purpose: 'W-01' });
  await st.worker.waitExit(30_000);
  st.check(
    'worker killed at KP-3 outbox_after_lock_before_send (SIGKILL)',
    killed(st.worker, 'outbox_after_lock_before_send'),
    st.worker.exit,
  );
  const leased = (
    await st.rows(
      `SELECT o.id, o.status, o.attempts FROM outbox_events o JOIN notifications n ON n.id::text = o.payload->>'notification_id'
        WHERE o.type = 'job.wa_send' AND n.ticket_id = $1 AND n.purpose = 'W-02'`,
      [t.ticketId],
    )
  )[0];
  st.check(
    'at the crash: the W-02 job is leased (processing, attempt 1) and nothing was sent',
    leased?.status === 'processing' &&
      leased.attempts === 1 &&
      (await st.messagesTo(t.phone, 'W-02')).length === 0,
    leased,
  );
  await st.startWorker();
  await st.waitFor(
    async () => (await st.messagesTo(t.phone, 'W-02')).length >= 1,
    90_000,
    'W-02 after the lease expired',
  );
  await sleep(4000);
  const row = (await st.rows(`SELECT status, attempts FROM outbox_events WHERE id = $1`, [leased?.id]))[0];
  st.check(
    'the same row completed by the next run (attempts = 2)',
    row?.status === 'done' && row.attempts === 2,
    row,
  );
  st.check('W-02 sent once', (await st.messagesTo(t.phone, 'W-02')).length === 1);
  await st.consistent();
}

/** TC-016 (KP-4): accepted by the provider, not recorded; the status webhook proves it — no resend. */
async function kp4(st, { silent = false } = {}) {
  const drv = await st.driver(0);
  const t = await st.parked(drv);
  await st.settleWebhooks();
  if (silent) await st.simc.configure({ autoStatuses: false });
  await st.worker.stop();
  await st.startWorker({ CHAOS_KILL_AT: 'wa_send_after_provider_ok_before_done' });
  await st.simc.pressButton({ to: t.phone, purpose: 'W-01' });
  await st.worker.waitExit(30_000);
  st.check(
    'worker killed at KP-4 wa_send_after_provider_ok_before_done (SIGKILL)',
    killed(st.worker, 'wa_send_after_provider_ok_before_done'),
    st.worker.exit,
  );
  const atCrash = await st.messagesTo(t.phone, 'W-02');
  const n = (
    await st.rows(`SELECT id FROM notifications WHERE ticket_id = $1 AND purpose = 'W-02'`, [t.ticketId])
  )[0];
  const msgRow = (
    await st.rows(
      `SELECT wa_message_id FROM whatsapp_messages WHERE notification_id = $1 AND direction = 'outbound'`,
      [n?.id],
    )
  )[0];
  st.check(
    'at the crash: the provider holds W-02, the database has no wa_message_id',
    atCrash.length === 1 && !msgRow?.wa_message_id,
    { provider: atCrash.length, wa_message_id: msgRow?.wa_message_id ?? null },
  );
  await st.startWorker();
  if (!silent) {
    await st.waitFor(
      async () =>
        (await st.rows(`SELECT status FROM notifications WHERE id = $1`, [n.id]))[0]?.status !== 'pending',
      90_000,
      'W-02 settled by the status webhook',
    );
    await sleep(15_000); // past the lease: the retried job must not send again
    const sent = await st.messagesTo(t.phone, 'W-02');
    st.check(
      'no resend: the status webhook (biz_opaque_callback_data) proved the acceptance',
      sent.length === 1,
      `${sent.length} copy(ies)`,
    );
    const nn = (await st.rows(`SELECT status FROM notifications WHERE id = $1`, [n.id]))[0];
    st.check('the notification is sent', ['sent', 'delivered', 'read'].includes(nn?.status), nn);
  } else {
    // no proof of acceptance: after CRASH_WAIT_MS (30 s) one more attempt, never a third (12 §5.13)
    await st.waitFor(
      async () => (await st.messagesTo(t.phone, 'W-02')).length >= 2,
      120_000,
      'the second attempt',
    );
    await sleep(45_000);
    const sent = await st.messagesTo(t.phone, 'W-02');
    st.check('at most one duplicate, never a third copy', sent.length === 2, `${sent.length} copies`);
    const attempts = await st.rows(
      `SELECT attempt_no, outcome, provider_error_code FROM notification_attempts WHERE notification_id = $1 ORDER BY attempt_no`,
      [n.id],
    );
    st.check(
      'the duplicate is recorded as the second attempt',
      attempts.length === 2 && attempts[1].outcome === 'success',
      attempts,
    );
    await st.simc.configure({ autoStatuses: true });
  }
  const cycles = await st.rows(`SELECT count(*)::int AS n FROM retrieval_cycles WHERE ticket_id = $1`, [
    t.ticketId,
  ]);
  const tasks = await st.rows(
    `SELECT count(*)::int AS n FROM tasks WHERE ticket_id = $1 AND type = 'retrieve'`,
    [t.ticketId],
  );
  st.check(
    'no operational effect repeated (one cycle, one retrieve task)',
    count(cycles) === 1 && count(tasks) === 1,
  );
  await st.consistent();
}

/** TC-017 (KP-5): the api dies after committing the accept; the same key replays the stored answer. */
async function kp5(st) {
  const parker = await st.driver(0);
  await st.driver(1);
  await st.driver(2);
  const t = await st.parked(parker);
  await st.settleWebhooks();
  await st.simc.pressButton({ to: t.phone, purpose: 'W-01' });
  const offer = await st.waitFor(() => st.liveOffer(t.ticketId), 30_000, 'a live offer');
  const driver = st.drivers.get(offer.user_id);
  await st.api.stop();
  await st.startApi({ CHAOS_KILL_AT: 'accept_after_commit_before_response' });
  const key = `chaos-${randomUUID()}`;
  const first = await driver.request('POST', `/v1/task-offers/${offer.offer_id}/accept`, {
    body: {},
    key,
    timeoutMs: 15_000,
  });
  await st.api.waitExit(20_000);
  st.check(
    'api killed at KP-5 accept_after_commit_before_response (SIGKILL)',
    killed(st.api, 'accept_after_commit_before_response'),
    st.api.exit,
  );
  st.check('the client got no answer (connection lost)', first.status === 0, first.error);
  const stored = (
    await st.rows(`SELECT status, response_status FROM idempotency_keys WHERE key = $1`, [key])
  )[0];
  st.check(
    'the accept committed with its answer stored under the key',
    stored?.status === 'completed' && stored.response_status === 200,
    stored,
  );
  await st.startApi();
  const retry = await driver.request('POST', `/v1/task-offers/${offer.offer_id}/accept`, { body: {}, key });
  st.check(
    'the retry with the same key replays 200 (Idempotent-Replayed)',
    retry.status === 200 && retry.replayed,
    { status: retry.status, replayed: retry.replayed, code: retry.error?.code },
  );
  const again = await driver.request('POST', `/v1/task-offers/${offer.offer_id}/accept`, { body: {}, key });
  st.check(
    'a second retry replays the same answer',
    again.status === 200 && again.replayed && JSON.stringify(again.data) === JSON.stringify(retry.data),
  );
  const task = (await st.rows(`SELECT status, assignee_id FROM tasks WHERE id = $1`, [offer.task_id]))[0];
  st.check(
    'one assignment, to the accepting driver',
    task?.assignee_id === offer.user_id && task.status === 'accepted',
    task,
  );
  const claimed = await st.rows(
    `SELECT count(*)::int AS n FROM outbox_events WHERE type = 'task.claimed' AND aggregate_id = $1`,
    [offer.task_id],
  );
  st.check('one task.claimed event', count(claimed) === 1, `${count(claimed)}`);
  const winners = await st.rows(
    `SELECT count(*)::int AS n FROM offer_recipients WHERE offer_id = $1 AND response = 'accepted'`,
    [offer.offer_id],
  );
  st.check('offer_recipients: one accepted response', count(winners) === 1);
  await st.consistent();
}

// ------------------------------------------------------------------------------------------------ outages

/** 17 §12: the database lost (backends terminated), then refusing connections for 60 s. */
async function dbOutage(st) {
  const parker = await st.driver(0);
  const second = await st.driver(1);
  const t1 = await st.parked(parker);
  const t2 = await st.parked(parker);
  const t3 = await st.parked(parker);
  const late = new ApiClient(st.base, { label: 'late-driver' });
  const lateDriver = st.venue.drivers[3];
  await late.login(lateDriver.phone, lateDriver.pin);
  await st.settleWebhooks();
  const terminate = () =>
    withAdmin((c) =>
      c.query(
        `SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [st.dbName],
      ),
    );

  // A — connection loss: every backend terminated at once
  const killedBackends = (await terminate()).rows[0].n;
  const reads = [];
  for (let i = 0; i < 3; i++) reads.push((await second.get('/v1/me/home')).status);
  st.check(
    'backends terminated: requests recover on new connections (at most the first meets a dead one)',
    reads.at(-1) === 200 && reads.every((s) => s === 200 || s === 503),
    { terminated: killedBackends, statuses: reads },
  );
  await st.simc.pressButton({ to: t1.phone, purpose: 'W-01' });
  await st.waitFor(
    async () => (await st.messagesTo(t1.phone, 'W-02')).length === 1,
    60_000,
    'W-02 after the reconnect',
  );
  st.check('after the reconnect the press is processed and W-02 sent (LISTEN/poll resumed)', true);

  // B — 60 s outage: a request with a live single offer whose timers fall inside the outage
  await st.simc.pressButton({ to: t2.phone, purpose: 'W-01' });
  const offer = await st.waitFor(() => st.liveOffer(t2.ticketId), 30_000, 'a live offer for T2');
  const task2 = offer.task_id;
  await withAdmin((c) => c.query(`ALTER DATABASE ${st.dbName} ALLOW_CONNECTIONS false`));
  await terminate();
  const cutAt = Date.now();
  log(`db_outage: database refusing connections for ${DB_OUTAGE_MS / 1000} s`);
  await sleep(2000);
  const home = await second.get('/v1/me/home');
  st.check(
    'during the outage a read answers 503 SERVICE_UNAVAILABLE with Retry-After',
    home.status === 503 && home.error?.code === 'SERVICE_UNAVAILABLE',
    { status: home.status, code: home.error?.code },
  );
  const ready = await fetch(`${st.base}/health/ready`).then((r) => r.status);
  st.check('readiness answers 503 during the outage', ready === 503, `${ready}`);
  const key = `chaos-${randomUUID()}`;
  const cmd = await late.request('POST', '/v1/me/duty/start', { body: {}, key });
  st.check(
    'a command answers 503 SERVICE_UNAVAILABLE (nothing kept for its key)',
    cmd.status === 503 && cmd.error?.code === 'SERVICE_UNAVAILABLE',
    { status: cmd.status, code: cmd.error?.code },
  );
  const press3 = st.simc.pressButton({ to: t3.phone, purpose: 'W-01' }); // Meta keeps redelivering
  await sleep(Math.max(0, cutAt + DB_OUTAGE_MS - Date.now()));
  st.alive(st.api, st.worker);
  await withAdmin((c) => c.query(`ALTER DATABASE ${st.dbName} ALLOW_CONNECTIONS true`));
  const backAt = Date.now();
  await waitHttp(`${st.base}/health/ready`, { timeoutMs: 30_000 });
  st.check('readiness back within 30 s of the recovery', true, `${Date.now() - backAt} ms`);
  const retried = await late.request('POST', '/v1/me/duty/start', { body: {}, key });
  st.check(
    'the command retried with the same key runs once now (201, not a replay)',
    retried.status === 201 && !retried.replayed,
    { status: retried.status, code: retried.error?.code },
  );
  const replay = await late.request('POST', '/v1/me/duty/start', { body: {}, key });
  st.check('…and a further retry replays it', replay.status === 201 && replay.replayed);
  const d3 = (await press3).deliveries?.[0];
  st.check(
    'the press sent during the outage was redelivered until stored (not lost)',
    d3?.ok && d3.attempts > 1,
    { attempts: d3?.attempts, httpStatus: d3?.httpStatus },
  );
  await st.waitFor(
    async () =>
      count(
        await st.rows(`SELECT count(*)::int AS n FROM retrieval_cycles WHERE ticket_id = $1`, [t3.ticketId]),
      ) === 1,
    60_000,
    'T3 cycle',
  );
  st.check('T3 request created after the recovery (no request lost)', true);
  // timers due during the outage ran late, once
  await st.waitFor(
    async () =>
      count(
        await st.rows(
          `SELECT count(*)::int AS n FROM outbox_events WHERE type = 'job.escalate_unaccepted' AND payload->>'task_id' = $1 AND status = 'done'`,
          [task2],
        ),
      ) >= 1,
    90_000,
    'the escalation of T2 after the recovery',
  );
  await sleep(5000);
  const expire = await st.rows(
    `SELECT status, attempts, processed_at FROM outbox_events WHERE type = 'job.offer_expire' AND payload->>'offer_id' = $1`,
    [offer.offer_id],
  );
  st.check(
    'the offer expiry due during the outage ran once, after it',
    expire.length === 1 &&
      expire[0].status === 'done' &&
      new Date(expire[0].processed_at).getTime() >= backAt,
    expire,
  );
  const esc = await st.rows(
    `SELECT status, attempts FROM outbox_events WHERE type = 'job.escalate_unaccepted' AND payload->>'task_id' = $1`,
    [task2],
  );
  st.check(
    'the escalation due during the outage ran once',
    esc.filter((r) => r.status === 'done').length === 1,
    esc,
  );
  const escalated = await st.rows(
    `SELECT count(*)::int AS n FROM outbox_events WHERE type = 'task.escalated' AND aggregate_id = $1`,
    [task2],
  );
  const alert = await st.rows(`SELECT count(*)::int AS n FROM alerts WHERE dedupe_key = $1`, [
    `request_unaccepted:${task2}`,
  ]);
  st.check(
    'one task.escalated and one request_unaccepted alert for T2',
    count(escalated) === 1 && count(alert) === 1,
    { escalated: count(escalated), alerts: count(alert) },
  );
  const offerRow = (
    await st.rows(`SELECT status, close_reason FROM task_offers WHERE id = $1`, [offer.offer_id])
  )[0];
  st.check('the expired offer is closed', offerRow?.status !== 'active', offerRow);
  st.alive(st.api, st.worker);
  await st.consistent();
}

/** Flow helper: accept the live offer of a ticket, pick the key up, start, mark ready (all through the API). */
async function toReady(st, ticketId) {
  const offer = await st.waitFor(() => st.liveOffer(ticketId), 60_000, `a live offer for ${ticketId}`);
  const driver = st.drivers.get(offer.user_id);
  if (!driver) throw new Error(`offer went to a driver without a client (${offer.user_id})`);
  const acc = await must(driver.command('POST', `/v1/task-offers/${offer.offer_id}/accept`, {}), 'accept');
  const taskId = acc.data.task.id;
  const home = await must(driver.get('/v1/me/home'), 'home');
  const slot = home.data.current_task?.key_slot?.id;
  await must(driver.command('POST', `/v1/tasks/${taskId}/key-pickup`, { key_slot_id: slot }), 'key-pickup');
  await must(driver.command('POST', `/v1/tasks/${taskId}/start-retrieval`, {}), 'start');
  await must(driver.command('POST', `/v1/tasks/${taskId}/ready`, {}), 'ready');
  return { driver, taskId };
}

/** Purposes received by a phone after `since` (epoch ms). */
async function receivedSince(st, phone, since) {
  return (await st.messagesTo(phone)).filter((m) => Date.parse(m.acceptedAt) >= since).map((m) => m.purpose);
}

/** 17 §12 / TC-WA-22: WhatsApp down (Graph 190 for 2 min); internal work continues; only current states after. */
async function waOutage(st) {
  const parker = await st.driver(0);
  await st.driver(1);
  await st.driver(2);
  await st.driver(3);
  const sup = await st.supervisor();
  const t1 = await st.parked(parker);
  const t2 = await st.parked(parker);
  const t3 = await st.parked(parker);
  await st.settleWebhooks();
  const since = Date.now();
  await st.simc.setChannel({ state: 'down', code: 190, durationMs: WA_OUTAGE_MS });
  log(`wa_outage: Graph answers 190 for ${WA_OUTAGE_MS / 1000} s`);
  // T1: the customer asks and the vehicle gets ready during the outage → only W-05 afterwards
  await st.simc.pressButton({ to: t1.phone, purpose: 'W-01' });
  const r1 = await toReady(st, t1.ticketId);
  // T2: requested by the supervisor and delivered by exception during the outage → only W-06 afterwards
  await must(
    sup.command('POST', `/v1/tickets/${t2.ticketId}/retrievals`, { reason: 'طلب ميداني أثناء التعطل' }),
    'on behalf',
  );
  await toReady(st, t2.ticketId);
  await must(
    sup.command('POST', `/v1/tickets/${t2.ticketId}/handover-exception`, {
      reason: 'واتساب متعطل: تحقق يدوي',
      identity_checks: { phone_last4: digits(t2.phone).slice(-4), plate_confirmed: true },
    }),
    'handover exception',
  );
  // T3: asks during the outage and still waits at the recovery → only W-02 afterwards
  await st.simc.pressButton({ to: t3.phone, purpose: 'W-01' });
  st.check(
    'internal operations went on during the outage (requests, accept, start, ready, exception handover)',
    true,
  );
  const alert = await st.waitFor(
    async () =>
      (
        await st.rows(
          `SELECT venue_id, status, severity FROM alerts WHERE type = 'wa_channel_down' AND status <> 'resolved'`,
        )
      )[0],
    60_000,
    'wa_channel_down',
  );
  const health = (await st.rows(`SELECT health_status FROM whatsapp_channel`))[0]?.health_status;
  st.check('wa_channel_down raised and the channel down', !!alert && health === 'down', { alert, health });
  st.check(
    'nothing reached the customers during the outage',
    (await Promise.all([t1, t2, t3].map((t) => receivedSince(st, t.phone, since)))).every(
      (p) => p.length === 0,
    ),
  );
  await sleep(Math.max(0, since + WA_OUTAGE_MS - Date.now()));
  log('wa_outage: Graph back; waiting for the probe and the pending messages');
  await st.waitFor(
    async () => (await st.rows(`SELECT health_status FROM whatsapp_channel`))[0]?.health_status === 'healthy',
    180_000,
    'channel healthy',
  );
  await st.waitFor(
    async () =>
      count(
        await st.rows(
          `SELECT count(*)::int AS n FROM notifications WHERE channel = 'whatsapp' AND status = 'pending' AND ticket_id = ANY($1::uuid[])`,
          [[t1.ticketId, t2.ticketId, t3.ticketId]],
        ),
      ) === 0,
    180_000,
    'no pending WhatsApp notification',
  );
  const resolved = await st.rows(
    `SELECT count(*)::int AS n FROM alerts WHERE type = 'wa_channel_down' AND status <> 'resolved'`,
  );
  st.check('wa_channel_down resolved automatically', count(resolved) === 0);
  const got = {
    T1: await receivedSince(st, t1.phone, since),
    T2: await receivedSince(st, t2.phone, since),
    T3: await receivedSince(st, t3.phone, since),
  };
  st.check('T1 (ready) receives W-05 only', JSON.stringify(got.T1) === '["W-05"]', got.T1);
  st.check('T2 (delivered by exception) receives W-06 only', JSON.stringify(got.T2) === '["W-06"]', got.T2);
  st.check('T3 (still requested) receives W-02 only', JSON.stringify(got.T3) === '["W-02"]', got.T3);
  const skipped = await st.rows(
    `SELECT purpose, skipped_reason FROM notifications WHERE status = 'skipped' AND ticket_id = ANY($1::uuid[]) ORDER BY purpose`,
    [[t1.ticketId, t2.ticketId]],
  );
  st.check(
    'the intermediate states were skipped, not sent (superseded/stale)',
    skipped.length >= 3 && skipped.every((s) => ['superseded', 'stale'].includes(s.skipped_reason)),
    skipped,
  );
  // the customer reads the code that arrived after the recovery; the handover closes the ticket
  const code = await st.simc.claimCode(t1.phone);
  await must(
    r1.driver.command('POST', `/v1/tickets/${t1.ticketId}/handover`, {
      verification: { method: 'code', code },
    }),
    'handover with the code',
  );
  await st.waitFor(
    async () => (await receivedSince(st, t1.phone, since)).includes('W-06'),
    60_000,
    'W-06 for T1',
  );
  st.check(
    'T1 delivered with the code received after the recovery (W-05 then W-06)',
    JSON.stringify(await receivedSince(st, t1.phone, since)) === '["W-05","W-06"]',
  );
  await st.consistent();
}

/** 12 §5.14 with temporary errors (131016 for 150 s): `down` only after the 2-minute failing streak. */
async function waOutageTemporary(st) {
  const parker = await st.driver(0);
  await st.driver(1);
  await st.driver(2);
  const sup = await st.supervisor();
  const t1 = await st.parked(parker);
  const t2 = await st.parked(parker);
  await st.settleWebhooks();
  const since = Date.now();
  await st.simc.setChannel({ state: 'down', code: 131016, durationMs: WA_TEMP_OUTAGE_MS });
  log(`wa_outage_temporary: Graph answers 131016 for ${WA_TEMP_OUTAGE_MS / 1000} s`);
  await st.simc.pressButton({ to: t1.phone, purpose: 'W-01' }); // its W-02 retries 1, 4, 16, 64 s
  // T1 is accepted (and stays `assigned`) so the older request does not hold the drivers T2 needs (10 §5.4)
  const o1 = await st.waitFor(() => st.liveOffer(t1.ticketId), 60_000, 'T1 offer');
  await must(
    st.drivers.get(o1.user_id).command('POST', `/v1/task-offers/${o1.offer_id}/accept`, {}),
    'accept T1',
  );
  await sleep(Math.max(0, since + 60_000 - Date.now()));
  await must(
    sup.command('POST', `/v1/tickets/${t2.ticketId}/retrievals`, { reason: 'طلب أثناء تعطل مؤقت' }),
    'on behalf',
  );
  const down = await st.waitFor(
    async () =>
      (await st.rows(`SELECT health_changed_at FROM whatsapp_channel WHERE health_status = 'down'`))[0],
    120_000,
    'channel down',
  );
  const after = (new Date(down.health_changed_at).getTime() - since) / 1000;
  st.check(
    'the channel goes down after the 2-minute failing streak (12 §5.14)',
    after >= 115,
    `${after.toFixed(0)} s after the first failure`,
  );
  const alert = await st.rows(
    `SELECT count(*)::int AS n FROM alerts WHERE type = 'wa_channel_down' AND status <> 'resolved'`,
  );
  st.check('wa_channel_down raised', count(alert) >= 1);
  await toReady(st, t2.ticketId); // T2 reaches `ready` while the channel is down
  await sleep(Math.max(0, since + WA_TEMP_OUTAGE_MS - Date.now()));
  await st.waitFor(
    async () => (await st.rows(`SELECT health_status FROM whatsapp_channel`))[0]?.health_status === 'healthy',
    180_000,
    'healthy',
  );
  await st.waitFor(
    async () =>
      count(
        await st.rows(
          `SELECT count(*)::int AS n FROM notifications WHERE channel = 'whatsapp' AND status = 'pending' AND ticket_id = ANY($1::uuid[])`,
          [[t1.ticketId, t2.ticketId]],
        ),
      ) === 0,
    180_000,
    'no pending notification',
  );
  const got2 = await receivedSince(st, t2.phone, since);
  st.check('T2 (ready at the recovery) receives W-05 only', JSON.stringify(got2) === '["W-05"]', got2);
  const w02 = (
    await st.rows(
      `SELECT status, skipped_reason, last_error_code, attempts FROM notifications WHERE ticket_id = $1 AND purpose = 'W-02'`,
      [t1.ticketId],
    )
  )[0];
  const got1 = await receivedSince(st, t1.phone, since);
  st.note(
    `T1 asked at the start of the outage: its W-02 ended ${w02?.status} after ${w02?.attempts} attempts (${w02?.last_error_code}); ` +
      `received after the recovery: ${JSON.stringify(got1)}. The 5 attempts of 12 §5.9 (1+4+16+64 s) end before the 2-minute streak ` +
      `of §5.14 turns the channel down, so a request made in the first ~35 s of a temporary outage gets wa_send_failed instead of ` +
      `its W-02 after the recovery (see DEC-PROPOSED in docs/progress/notes/load-chaos.md).`,
  );
  await st.consistent();
}

/** 17 §12: the test Push service stopped; dispatch unaffected; push_failed_repeatedly; recovery resets it. */
async function pushOutage(st) {
  const push = pushService(P.push);
  await push.start();
  try {
    const only = await st.driver(0); // the only driver on duty: every offer goes to him
    const reg = await must(
      only.command(
        'POST',
        '/v1/me/devices',
        { platform: 'android', display_mode: 'standalone', notification_permission: 'granted' },
        { key: false },
      ),
      'device',
    );
    const deviceId = reg.data.id;
    await must(
      only.request('PUT', `/v1/me/devices/${deviceId}`, {
        body: {
          push_subscription: {
            endpoint: `http://127.0.0.1:${P.push}/push/${deviceId}`,
            keys: subscriptionKeys(),
          },
        },
      }),
      'subscription',
    );
    const t1 = await st.parked(only);
    const t2 = await st.parked(only);
    await st.settleWebhooks();
    await st.simc.pressButton({ to: t1.phone, purpose: 'W-01' });
    await st.waitFor(() => push.received.length >= 1, 30_000, 'the offer push');
    st.check(
      'the offer push reaches the test Push service (TTL, Urgency, Topic, encrypted body)',
      push.received[0].ttl && push.received[0].urgency === 'high' && push.received[0].bytes > 0,
      push.received[0],
    );
    await push.stop();
    log('push_outage: test Push service stopped');
    const before = push.received.length;
    // the offers of T1 keep rotating to the only driver: each push attempt fails
    const alert = await st.waitFor(
      async () =>
        (
          await st.rows(
            `SELECT status, details FROM alerts WHERE type = 'push_failed_repeatedly' AND status <> 'resolved'`,
          )
        )[0],
      150_000,
      'push_failed_repeatedly',
    );
    st.check('push_failed_repeatedly raised after consecutive failures', !!alert, alert?.details);
    const failures = (await st.rows(`SELECT push_failed_count FROM devices WHERE id = $1`, [deviceId]))[0];
    st.check('the failures are counted on the device', failures?.push_failed_count >= 3, failures);
    // dispatch does not depend on Push: the live offer (socket / home) is accepted through the API
    const offer = await st.waitFor(() => st.liveOffer(t1.ticketId), 60_000, 'live offer');
    const acc = await only.command('POST', `/v1/task-offers/${offer.offer_id}/accept`, {});
    st.check('dispatch unaffected: the offer is accepted during the Push outage', acc.status === 200, {
      status: acc.status,
      code: acc.error?.code,
    });
    await st.simc.pressButton({ to: t2.phone, purpose: 'W-01' }); // waits: the only driver is busy
    await push.start();
    log('push_outage: test Push service back');
    // the driver finishes T1; T2 is then offered to him and its push succeeds, which resets the device
    const home = await must(only.get('/v1/me/home'), 'home');
    const taskId = acc.data.task.id;
    await must(
      only.command('POST', `/v1/tasks/${taskId}/key-pickup`, {
        key_slot_id: home.data.current_task.key_slot.id,
      }),
      'key-pickup',
    );
    await must(only.command('POST', `/v1/tasks/${taskId}/start-retrieval`, {}), 'start');
    await must(only.command('POST', `/v1/tasks/${taskId}/ready`, {}), 'ready');
    const code = await st.waitFor(() => st.simc.claimCode(t1.phone).catch(() => null), 60_000, 'W-05 code');
    await must(
      only.command('POST', `/v1/tickets/${t1.ticketId}/handover`, { verification: { method: 'code', code } }),
      'handover',
    );
    await st.waitFor(
      async () =>
        (await st.rows(`SELECT push_failed_count FROM devices WHERE id = $1`, [deviceId]))[0]
          ?.push_failed_count === 0,
      150_000,
      'a successful push',
    );
    st.check(
      'after the recovery a push succeeds and the device counter resets',
      push.received.length > before,
    );
    const open = await st.rows(
      `SELECT count(*)::int AS n FROM alerts WHERE type = 'push_failed_repeatedly' AND status <> 'resolved'`,
    );
    st.check('push_failed_repeatedly resolved automatically', count(open) === 0);
    await st.consistent();
  } finally {
    await push.stop();
  }
}

/** 17 §12: the worker stopped 2 minutes — outbox_lag raised; work due meanwhile runs once after the restart. */
async function workerStop(st) {
  const parker = await st.driver(0);
  await st.driver(1);
  const sup = await st.supervisor();
  const t1 = await st.parked(parker);
  const t2 = await st.parked(parker);
  await st.settleWebhooks();
  // T2 queued with a live offer and its escalation timer before the stop
  const req = await must(
    sup.command('POST', `/v1/tickets/${t2.ticketId}/retrievals`, { reason: 'طلب قبل توقف العامل' }),
    'on behalf',
  );
  const task2 = req.data.task.id;
  await sleep(1500);
  await st.worker.stop();
  const stoppedAt = Date.now();
  log(`worker_stop: worker stopped for ${WORKER_STOP_MS / 1000} s`);
  const press = await st.simc.pressButton({ to: t1.phone, purpose: 'W-01' });
  st.check(
    'webhooks are still acknowledged while the worker is down',
    press.deliveries?.[0]?.ok,
    press.deliveries?.[0],
  );
  const lag = await st.waitFor(
    async () =>
      (
        await st.rows(
          `SELECT severity, details FROM alerts WHERE type = 'outbox_lag' AND status <> 'resolved'`,
        )
      )[0],
    90_000,
    'outbox_lag',
  );
  st.check('outbox_lag raised by the api monitor while the worker is down', !!lag, {
    after_s: Math.round((Date.now() - stoppedAt) / 1000),
    ...lag,
  });
  await sleep(Math.max(0, stoppedAt + WORKER_STOP_MS - Date.now()));
  await st.startWorker();
  const restartedAt = Date.now();
  await st.waitFor(
    async () =>
      count(
        await st.rows(`SELECT count(*)::int AS n FROM retrieval_cycles WHERE ticket_id = $1`, [t1.ticketId]),
      ) === 1,
    60_000,
    'T1 cycle after the restart',
  );
  st.check('the press stored during the stop became a request after the restart', true);
  await st.waitFor(
    async () =>
      count(
        await st.rows(
          `SELECT count(*)::int AS n FROM outbox_events WHERE status = 'pending' AND available_at <= now()`,
        ),
      ) === 0,
    60_000,
    'the backlog drained',
  );
  st.check(
    'the backlog drained after the restart',
    true,
    `${Math.round((Date.now() - restartedAt) / 1000)} s`,
  );
  const esc = await st.rows(
    `SELECT status, attempts FROM outbox_events WHERE type = 'job.escalate_unaccepted' AND payload->>'task_id' = $1`,
    [task2],
  );
  const escalated = await st.rows(
    `SELECT count(*)::int AS n FROM outbox_events WHERE type = 'task.escalated' AND aggregate_id = $1`,
    [task2],
  );
  st.check(
    'the escalation due during the stop ran once after the restart',
    esc.filter((r) => r.status === 'done').length === 1 && count(escalated) === 1,
    { jobs: esc, events: count(escalated) },
  );
  await st.consistent();
}

/** 17 §12: three workers on one outbox — no row processed twice, every message sent once. */
async function workerX3(st) {
  st.extra = [2, 3].map(
    (n) =>
      new Proc(
        `worker${n}`,
        SCRIPTS.worker,
        { ...st.srv, WORKER_ID: `chaos-worker-${n}`, METRICS_PORT: String(P.metrics + 20 + n * 2) },
        st.dir,
      ),
  );
  for (const [i, w] of st.extra.entries()) {
    w.start();
    await waitHttp(`http://127.0.0.1:${P.metrics + 21 + (i + 2) * 2}/metrics`);
  }
  const rng = prng(7);
  const phoneOfTicket = new Map();
  const bots = st.venue.drivers.map(
    (driver) =>
      new DriverBot({
        base: st.base,
        venue: st.venue,
        driver,
        sim: st.simc,
        rng,
        phoneOfTicket,
        log,
        opts: {
          acceptMinS: 0.5,
          acceptMaxS: 3,
          stepMinS: 0.2,
          stepMaxS: 0.6,
          driveMinS: 0.3,
          driveMaxS: 0.8,
          reserveProbability: 0.5,
          heartbeatS: 15,
        },
      }),
  );
  await Promise.all(bots.map((b) => b.signIn()));
  const tickets = [];
  for (const b of bots)
    for (let k = 0; k < 2; k++) {
      const t = await st.parked(b.api);
      phoneOfTicket.set(t.ticketId, t.phone);
      tickets.push(t);
    }
  await st.settleWebhooks();
  for (const b of bots) b.active = true;
  await Promise.all(tickets.map((t) => st.simc.pressButton({ to: t.phone, purpose: 'W-01' })));
  await st.waitFor(
    async () =>
      count(
        await st.rows(
          `SELECT count(*)::int AS n FROM tickets WHERE id = ANY($1::uuid[]) AND status = 'delivered'`,
          [tickets.map((t) => t.ticketId)],
        ),
      ) === tickets.length,
    240_000,
    'every ticket delivered',
  );
  for (const b of bots) b.active = false;
  await sleep(6000);
  const dup = [];
  for (const t of tickets) {
    const by = {};
    for (const m of await st.messagesTo(t.phone)) by[m.purpose] = (by[m.purpose] ?? 0) + 1;
    if (Object.values(by).some((n) => n > 1)) dup.push(by);
  }
  st.check(`every message sent once to each of the ${tickets.length} customers`, dup.length === 0, dup);
  // a row run by two workers would show as a lease lost at completion (OutboxDispatcher.markDone)
  const lost = ['worker', 'worker2', 'worker3']
    .map((n) => readFileSync(join(st.dir, `${n}.log`), 'utf8').split('outbox lease lost').length - 1)
    .reduce((x, y) => x + y, 0);
  st.check('no outbox row completed by two workers (no lease lost)', lost === 0, `${lost}`);
  const per = {};
  for (const [name, port] of [
    ['worker', P.metrics + 1],
    ...st.extra.map((w, i) => [w.name, P.metrics + 21 + (i + 2) * 2]),
  ]) {
    const text = await fetch(`http://127.0.0.1:${port}/metrics`).then((r) => r.text());
    per[name] = text
      .split('\n')
      .filter((l) => l.startsWith('point_outbox_events_total{') && l.includes('status="done"'))
      .reduce((n, l) => n + Number(l.split(' ').at(-1)), 0);
  }
  const doneRows = count(await st.rows(`SELECT count(*)::int AS n FROM outbox_events WHERE status = 'done'`));
  st.check('the three workers shared the outbox', Object.values(per).filter((n) => n > 0).length === 3, per);
  st.note(
    `rows completed per worker ${JSON.stringify(per)} (all done rows in the database: ${doneRows}, including the prep before the extra workers)`,
  );
  for (const b of bots) await b.stop();
  await st.consistent();
}

const SCENARIOS = {
  kp1: { fn: kp1, title: 'KP-1 webhook_after_store_before_ack (TC-013)' },
  kp2: { fn: kp2, title: 'KP-2 inbound_after_cycle_commit (TC-014)' },
  kp3: { fn: kp3, title: 'KP-3 outbox_after_lock_before_send (TC-015)' },
  kp4: {
    fn: (st) => kp4(st),
    title: 'KP-4 wa_send_after_provider_ok_before_done, status webhook arrives (TC-016)',
  },
  kp4_silent: {
    fn: (st) => kp4(st, { silent: true }),
    title: 'KP-4 without any status webhook (TC-016, at most one duplicate)',
  },
  kp5: { fn: kp5, title: 'KP-5 accept_after_commit_before_response (TC-017)' },
  db_outage: { fn: dbOutage, title: 'database: backends terminated, then 60 s refusing connections' },
  wa_outage: { fn: waOutage, title: 'WhatsApp outage (Graph 190, 12 §11.4 channel_down) — TC-WA-22' },
  wa_outage_temporary: {
    fn: waOutageTemporary,
    title: 'WhatsApp temporary errors (131016) — the 2-minute rule of 12 §5.14',
  },
  push_outage: {
    fn: pushOutage,
    title: 'Push outage (test Push service stopped)',
    stage: () => ({ server: vapidKeys() }),
  },
  worker_stop: { fn: workerStop, title: 'worker stopped 2 minutes (outbox_lag)' },
  worker_x3: { fn: workerX3, title: 'three workers on one outbox' },
};

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

async function main() {
  const only = (a.only ?? env.CHAOS_ONLY ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const names = only.length ? only : Object.keys(SCENARIOS);
  for (const n of names)
    if (!SCENARIOS[n]) throw new Error(`unknown scenario ${n} (${Object.keys(SCENARIOS).join(', ')})`);
  if (!a['no-build'] && env.CHAOS_BUILD !== '0') build();
  log(`run ${RUN} → ${OUT}; scenarios ${names.join(', ')}`);
  const results = [];
  for (const name of names) {
    const sc = SCENARIOS[name];
    const st = new Stage(name);
    const started = Date.now();
    try {
      await st.init(sc.stage?.() ?? {});
      await sc.fn(st);
    } catch (e) {
      st.check(`scenario ran to the end`, false, e?.message ?? String(e));
      log(e?.stack ?? e);
    } finally {
      await st.close();
    }
    const pass = st.checks.length > 0 && st.checks.every((c) => c.ok);
    results.push({
      name,
      title: sc.title,
      pass,
      seconds: Math.round((Date.now() - started) / 1000),
      checks: st.checks,
      notes: st.notes,
    });
    log(
      `${name}: ${pass ? 'PASS' : 'FAIL'} (${st.checks.filter((c) => c.ok).length}/${st.checks.length} checks)`,
    );
  }
  const report = [
    `# Chaos run ${RUN} — ${new Date(t0).toISOString()}`,
    '',
    table(
      ['Scenario', 'Result', 'Checks', 'Duration'],
      results.map((r) => [
        `${r.name} — ${r.title}`,
        r.pass ? 'pass' : '**FAIL**',
        `${r.checks.filter((c) => c.ok).length}/${r.checks.length}`,
        `${r.seconds} s`,
      ]),
    ),
    '',
    ...results.flatMap((r) => [
      `## ${r.name} — ${r.title}`,
      '',
      table(
        ['Check', 'Result', 'Detail'],
        r.checks.map((c) => [c.name, c.ok ? 'ok' : '**FAIL**', c.detail]),
      ),
      ...(r.notes.length ? ['', ...r.notes.map((n) => `- ${n}`)] : []),
      '',
    ]),
  ].join('\n');
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ run: RUN, results }, null, 2));
  writeFileSync(join(OUT, 'report.md'), report);
  console.log(`\n${report}`);
  log(`results: ${join(OUT, 'results.json')} · report: ${join(OUT, 'report.md')} · logs: ${OUT}/<scenario>/`);
  return results.every((r) => r.pass);
}

let ok = false;
try {
  ok = await main();
} catch (e) {
  console.error(`[chaos] FAILED: ${e?.stack ?? e}`);
}
process.exit(ok ? 0 : 1);
