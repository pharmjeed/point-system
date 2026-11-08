import { randomUUID } from 'node:crypto';
import { SEED_IDS } from '@point/db/seed';
import {
  createLogger,
  customerAccountsJobs,
  CustomerPushRuntime,
  CustomerPushSimulator,
  defaultCustomerPushSimulator,
  newCustomerToken,
  sha256Hex,
  type WhatsappRuntime,
} from '@point/server';
import {
  CUSTOMER_REALTIME_NAMESPACE,
  CUSTOMER_ROUTES,
  CustomerHandoverCodeSchema,
  CustomerPushDataSchema,
  CustomerVisitDetailSchema,
  CustomerVisitListSchema,
  CustomerVisitRatingSchema,
  CustomerVisitRequestResultSchema,
  generatePassToken,
  passStep,
  successEnvelopeSchema,
  type CustomerPass,
} from '@point/shared/customer';
import { io, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { realtimeOf } from '../src/bootstrap.js';
import {
  createCustomerApp,
  freshDriver,
  messagesTo,
  park,
  tablesContaining,
  type CustomerApp,
} from './customer-harness.js';
import {
  accept,
  addPhotos,
  EVT_R1,
  handover,
  keyPickup,
  markReady,
  newDraft,
  ok,
  patchIntake,
  startRetrieval,
  submitIntake,
} from './dispatch-fixtures.js';
import { newKey } from './harness.js';

/**
 * V2-015 / V2-016 on a real PostgreSQL with the worker: the live visit of the customer app (C-12, C-16, C-13) — the
 * request from the app as the WhatsApp button's command, the handover code of an app ticket shown to the customer
 * only, the rating — the customer socket namespace, and the pushes with their lock-screen-safe payload, the provider
 * receipts and the pruning of dead tokens (DEC-516 … DEC-520).
 */

const ORG = SEED_IDS.org;
let w: CustomerApp;
let sim: CustomerPushSimulator;
const logLines: string[] = [];
let phoneSeq = 0;
let plateSeq = 6000;
const nextPhone = () => `+9665${String(82000000 + ++phoneSeq)}`;

interface Account {
  id: string;
  phone: string;
  access: string;
  sessionId: string;
}

async function session(accountId: string): Promise<{ access: string; sessionId: string }> {
  const sid = randomUUID();
  const access = newCustomerToken('access', sid);
  await w.db.query(
    `INSERT INTO customer_account_sessions (id, account_id, device_id, platform, refresh_hash, access_hash,
            access_expires_at, refresh_expires_at, created_at)
     VALUES ($1, $2, $3, 'ios', $4, $5, $6::timestamptz + interval '15 minutes', $6::timestamptz + interval '60 days', $6)`,
    [
      sid,
      accountId,
      `device-${sid}`,
      sha256Hex(newCustomerToken('refresh', sid)),
      sha256Hex(access),
      w.clock.now(),
    ],
  );
  return { access, sessionId: sid };
}

async function account(name = 'نورة الشهري'): Promise<Account> {
  const phone = nextPhone();
  const a = await w.db.query<{ id: string }>(
    `INSERT INTO customer_accounts (phone_e164, display_name) VALUES ($1, $2) RETURNING id`,
    [phone, name],
  );
  const id = a.rows[0]!.id;
  return { id, phone, ...(await session(id)) };
}

/** A fresh access token on the same session (the 15-minute token after the clock moved on). */
async function refreshAccess(a: Account): Promise<void> {
  const access = newCustomerToken('access', a.sessionId);
  await w.db.query(
    `UPDATE customer_account_sessions SET access_hash = $2, access_expires_at = $3::timestamptz + interval '15 minutes'
      WHERE id = $1`,
    [a.sessionId, sha256Hex(access), w.clock.now()],
  );
  a.access = access;
}

async function vehicle(accountId: string): Promise<{ id: string; digits: string }> {
  const digits = String(++plateSeq);
  const r = await w.db.query<{ id: string }>(
    `INSERT INTO customer_vehicles (account_id, plate_digits, plate_letters_ar, plate_letters_en, vehicle_make,
            vehicle_model, vehicle_color, vehicle_type)
     VALUES ($1, $2, 'ر س ص', 'R S X', 'hyundai', 'سوناتا', 'silver', 'sedan') RETURNING id`,
    [accountId, digits],
  );
  return { id: r.rows[0]!.id, digits };
}

const bearer = (a: Account) => ({ Authorization: `Bearer ${a.access}` });
const cget = (a: Account, path: string) => w.http().get(path).set(bearer(a));
const cpost = (a: Account, path: string, body: unknown = {}, key: string | null = newKey()) => {
  const r = w.http().post(path).set(bearer(a));
  return (key ? r.set('Idempotency-Key', key) : r).send(body as object);
};
const errOf = (r: { status: number; body: any }) => ({
  status: r.status,
  code: r.body?.error?.code,
  ...(r.body?.error?.details?.reason ? { reason: r.body.error.details.reason } : {}),
});

async function passOf(a: Account): Promise<CustomerPass> {
  const r = await cget(a, CUSTOMER_ROUTES.pass.path);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data;
}

const visitPath = (id: string) => `/v1/customer/visits/${id}`;
const getVisit = async (a: Account, id: string) => {
  const r = await cget(a, visitPath(id));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return successEnvelopeSchema(CustomerVisitDetailSchema).parse(r.body).data;
};

/** Registers an Expo token for the account's session (POST /v1/customer/devices). */
async function registerPush(a: Account, token = `ExponentPushToken[${randomUUID().replace(/-/g, '')}]`) {
  const r = await cpost(a, CUSTOMER_ROUTES.devices.path, { provider: 'expo', push_token: token });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.data).toMatchObject({ push_registered: true, provider: 'expo' });
  expect(JSON.stringify(r.body)).not.toContain(token);
  return token;
}

interface AppTicket {
  ticketId: string;
  taskId: string;
  driver: string;
  slotId: string;
  digits: string;
  keyTag: string;
}

/**
 * An app ticket of the account (O-01 intake by pass, D-05/D-06), up to `parking` — or `parked` with `park`.
 * `step` offsets the pass step for a second ticket of the same account within one step.
 */
async function appTicket(a: Account, o: { park?: boolean; step?: number } = {}): Promise<AppTicket> {
  const v = await vehicle(a.id);
  const p = await passOf(a);
  const driver = await freshDriver(w);
  const d = await newDraft(w, driver, EVT_R1);
  const pass_token = generatePassToken({
    secret: p.secret,
    accountId: p.account_id,
    vehicleId: v.id,
    step: passStep(w.clock.now().getTime()) + (o.step ?? 0),
  });
  const r = ok(
    await w.command('post', '/v1/tickets/intake-pass', {
      as: driver,
      body: { pass_token, ticket_id: d.ticketId, expected_version: d.version },
    }),
  );
  const keyTag = `KV-${plateSeq}`;
  const patched = ok(
    await patchIntake(w, driver, d.ticketId, { expected_version: r.ticket.version, key_tag: keyTag }),
  );
  await addPhotos(w.db, d.ticketId, driver);
  ok(await submitIntake(w, driver, d.ticketId, { expected_version: patched.version }));
  let slotId = '';
  if (o.park ?? true) slotId = (await park(w, driver, d.taskId)).slotId;
  return { ticketId: d.ticketId, taskId: d.taskId, driver, slotId, digits: v.digits, keyTag };
}

/** The live offer of the ticket's retrieve task and its driver. */
async function offerOf(ticketId: string) {
  return (
    await w.db.query<{ id: string; task_id: string; user_id: string }>(
      `SELECT o.id, o.task_id, r.user_id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id
         JOIN tasks k ON k.id = o.task_id
        WHERE k.ticket_id = $1 AND o.status = 'active'`,
      [ticketId],
    )
  ).rows[0]!;
}

/** Request from the app → accepted → key → started → ready. */
async function readyAppTicket(a: Account, t: AppTicket) {
  ok(await cpost(a, `${visitPath(t.ticketId)}/request`), 201);
  const offer = await offerOf(t.ticketId);
  ok(await accept(w, offer.user_id, offer.id));
  ok(await keyPickup(w, offer.user_id, offer.task_id, t.slotId));
  ok(await startRetrieval(w, offer.user_id, offer.task_id));
  ok(await markReady(w, offer.user_id, offer.task_id));
  return { driver: offer.user_id, taskId: offer.task_id };
}

const cycles = async (ticketId: string) =>
  (
    await w.db.query(
      `SELECT request_source, requested_by_customer_id, requested_early, requested_at, closed_at FROM retrieval_cycles
        WHERE ticket_id = $1 ORDER BY cycle_no`,
      [ticketId],
    )
  ).rows;

const sentTo = (token: string) => sim.sent.filter((m) => m.to === token);

beforeAll(async () => {
  w = await createCustomerApp();
  sim = new CustomerPushSimulator(() => w.clock.now());
  const logger = createLogger({
    level: 'debug',
    destination: { write: (l: string) => void logLines.push(l) },
  });
  const push = new CustomerPushRuntime({ env: w.env, sender: sim, logger });
  for (const h of customerAccountsJobs({ push, runtime: w.rt as WhatsappRuntime })) w.dispatcher.register(h);
}, 120_000);
afterAll(async () => w?.close());
afterEach(async () => {
  await w.drain();
});

// ---------------------------------------------------------------------------------------------
// C-16 and C-12 reads
// ---------------------------------------------------------------------------------------------

describe('V2-015 — GET /v1/customer/visits[/{ticketId}] (C-16, C-12)', () => {
  it('lists the account’s visits with pages; the detail has the timeline, photos as short links and no key or spot', async () => {
    const a = await account();
    const first = await appTicket(a);
    w.clock.advance(1000);
    const second = await appTicket(a, { step: 1 });
    const page1 = await cget(a, `${CUSTOMER_ROUTES.visits.path}?limit=1`);
    expect(page1.status).toBe(200);
    const list1 = successEnvelopeSchema(CustomerVisitListSchema).parse(page1.body);
    expect(list1.data.items.map((v) => v.ticket_id)).toEqual([second.ticketId]);
    expect(list1.meta.next_cursor).toBeTruthy();
    const page2 = await cget(
      a,
      `${CUSTOMER_ROUTES.visits.path}?limit=1&cursor=${encodeURIComponent(list1.meta.next_cursor!)}`,
    );
    const list2 = successEnvelopeSchema(CustomerVisitListSchema).parse(page2.body);
    expect(list2.data.items.map((v) => v.ticket_id)).toEqual([first.ticketId]);
    expect(list2.meta.next_cursor ?? null).toBeNull();
    expect(list2.data.items[0]).toMatchObject({
      status: 'parked',
      open: true,
      channel: 'app',
      duration_min: null,
      payment: { entitlement: 'event_included', payment_status: 'not_required', fee_halalas: 0 },
      rated: false,
    });
    expect(errOf(await cget(a, `${CUSTOMER_ROUTES.visits.path}?cursor=bad`))).toEqual({
      status: 422,
      code: 'VALIDATION_FAILED',
    });

    const r = await cget(a, visitPath(first.ticketId));
    expect(r.headers['cache-control']).toContain('no-store');
    const v = successEnvelopeSchema(CustomerVisitDetailSchema).parse(r.body).data;
    expect(v.timeline.map((s) => [s.step, s.at !== null])).toEqual([
      ['received', true],
      ['parked', true],
      ['requested', false],
      ['accepted', false],
      ['on_the_way', false],
      ['ready', false],
      ['delivered', false],
    ]);
    expect(v.request).toEqual({ can_request: true, pending_early: false, requested_at: null });
    expect(v.handover).toEqual({ method: 'app_code', code_available: false, code_expires_at: null });
    expect(v.photos).toHaveLength(4);
    for (const p of v.photos)
      expect(new Date(p.expires_at).getTime() - w.clock.now().getTime()).toBeLessThanOrEqual(300_000);
    // never the key tag, the key slot, the spot or a staff id (V2-D12)
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(first.keyTag);
    expect(text).not.toContain(first.slotId);
    expect(text).not.toContain(first.driver);
    expect(text).not.toMatch(/key_slot|spot|key_tag/);
  });

  it('another account, a voided ticket or a malformed id: the same not-found', async () => {
    const a = await account();
    const b = await account();
    const t = await appTicket(a, { park: false });
    for (const [who, id] of [
      [b, t.ticketId],
      [a, randomUUID()],
      [a, 'not-a-uuid'],
    ] as const)
      expect(errOf(await cget(who, visitPath(id)))).toEqual({ status: 404, code: 'RESOURCE_NOT_FOUND' });
    expect(errOf(await cpost(b, `${visitPath(t.ticketId)}/request`))).toEqual({
      status: 404,
      code: 'RESOURCE_NOT_FOUND',
    });
    expect((await cget(b, CUSTOMER_ROUTES.visits.path)).body.data.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The request from the app (DEC-516)
// ---------------------------------------------------------------------------------------------

describe('V2-015 — POST /v1/customer/visits/{ticketId}/request', () => {
  it('happy path: the WhatsApp button’s command with source app — a cycle, its task offered, the audit, no WhatsApp', async () => {
    const a = await account();
    const t = await appTicket(a);
    const key = newKey();
    const r = await cpost(a, `${visitPath(t.ticketId)}/request`, {}, key);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const data = successEnvelopeSchema(CustomerVisitRequestResultSchema).parse(r.body).data;
    expect(data.outcome).toBe('requested');
    expect(['requested', 'assigned']).toContain(data.visit.status);
    expect(data.visit.request.can_request).toBe(false);
    const ticket = (await w.db.query(`SELECT customer_id, status FROM tickets WHERE id = $1`, [t.ticketId]))
      .rows[0];
    expect(await cycles(t.ticketId)).toEqual([
      expect.objectContaining({
        request_source: 'app',
        requested_by_customer_id: ticket.customer_id,
        requested_early: false,
        closed_at: null,
      }),
    ]);
    // the immediate dispatch pass offered the task to a driver on duty (10 §7.2)
    expect(await offerOf(t.ticketId)).toBeTruthy();
    const audit = await w.db.query(
      `SELECT actor_type, actor_id, action, metadata FROM audit_log WHERE entity_id = $1 AND action = 'retrieval.request'`,
      [t.ticketId],
    );
    expect(audit.rows).toEqual([
      expect.objectContaining({
        actor_type: 'customer',
        actor_id: ticket.customer_id,
        metadata: expect.objectContaining({ source: 'app', outcome: 'requested' }),
      }),
    ]);
    const trail = await w.db.query(
      `SELECT action FROM customer_audit_log WHERE account_id = $1 AND entity_id = $2 AND action LIKE 'customer.visit.%'`,
      [a.id, t.ticketId],
    );
    expect(trail.rows.map((x) => x.action)).toEqual(['customer.visit.requested']);
    const event = await w.db.query(
      `SELECT payload FROM outbox_events WHERE type = 'ticket.retrieval_requested' AND aggregate_id = $1`,
      [t.ticketId],
    );
    expect(event.rows[0].payload.payload).toMatchObject({ request_source: 'app', requested_early: false });
    await w.drain();
    expect(await messagesTo(w, a.phone)).toEqual([]);

    // the same key replays the answer, no second effect
    const again = await cpost(a, `${visitPath(t.ticketId)}/request`, {}, key);
    expect(again.status).toBe(201);
    expect(again.body.data).toEqual(r.body.data);
    expect(await cycles(t.ticketId)).toHaveLength(1);
    // another key: the request is already active
    expect(errOf(await cpost(a, `${visitPath(t.ticketId)}/request`))).toEqual({
      status: 409,
      code: 'RETRIEVAL_ALREADY_ACTIVE',
    });
    expect(await cycles(t.ticketId)).toHaveLength(1);
  });

  it('concurrent requests with different keys open one cycle (one open cycle per ticket)', async () => {
    const a = await account();
    const t = await appTicket(a);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => cpost(a, `${visitPath(t.ticketId)}/request`)),
    );
    expect(results.filter((x) => x.status === 201)).toHaveLength(1);
    expect(results.filter((x) => x.body?.error?.code === 'RETRIEVAL_ALREADY_ACTIVE')).toHaveLength(4);
    expect(await cycles(t.ticketId)).toHaveLength(1);
  });

  it('early request while the car is being parked (DEC-13): kept with its time, converted at parking with source app', async () => {
    const a = await account();
    const t = await appTicket(a, { park: false });
    const pressedAt = w.clock.now().toISOString();
    const r = await cpost(a, `${visitPath(t.ticketId)}/request`);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.outcome).toBe('requested_early');
    expect(r.body.data.visit.request).toEqual({
      can_request: false,
      pending_early: true,
      requested_at: pressedAt,
    });
    const row = (
      await w.db.query(
        `SELECT status, pending_retrieval_at, pending_retrieval_source FROM tickets WHERE id = $1`,
        [t.ticketId],
      )
    ).rows[0];
    expect(row).toMatchObject({ status: 'parking', pending_retrieval_source: 'app' });
    expect(await cycles(t.ticketId)).toEqual([]);
    // a second press keeps the original time
    expect(errOf(await cpost(a, `${visitPath(t.ticketId)}/request`))).toEqual({
      status: 409,
      code: 'RETRIEVAL_ALREADY_ACTIVE',
    });
    w.clock.advance(60_000);
    const { slotId } = await park(w, t.driver, t.taskId);
    expect(slotId).toBeTruthy();
    const [c] = await cycles(t.ticketId);
    expect(c).toMatchObject({ request_source: 'app', requested_early: true });
    expect(new Date(c.requested_at).toISOString()).toBe(pressedAt);
  });

  it('a delivered visit is closed; a voided one is not a visit any more', async () => {
    const a = await account();
    const t = await appTicket(a, { park: false });
    await w.db.query(
      `UPDATE tickets SET status = 'voided', voided_at = $2, voided_by = $3, void_reason = 'استلام خاطئ' WHERE id = $1`,
      [t.ticketId, w.clock.now(), SEED_IDS.users['SUP-R']],
    );
    expect(errOf(await cpost(a, `${visitPath(t.ticketId)}/request`))).toEqual({
      status: 404,
      code: 'RESOURCE_NOT_FOUND',
    });
    expect(errOf(await cget(a, visitPath(t.ticketId)))).toEqual({ status: 404, code: 'RESOURCE_NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------------------------
// The handover code of an app ticket (DEC-517)
// ---------------------------------------------------------------------------------------------

describe('V2-015 — the handover code of an app ticket (DEC-38, DEC-517)', () => {
  it('issued at ready, shown to the customer only while ready, verified by D-11, never in staff payloads or logs', async () => {
    const a = await account();
    const t = await appTicket(a);
    const codePath = `${visitPath(t.ticketId)}/handover-code`;
    expect(errOf(await cget(a, codePath))).toEqual({ status: 409, code: 'HANDOVER_NOT_READY' });
    const { driver, taskId } = await readyAppTicket(a, t);
    await w.drain();

    // ready: the code is live with its single encrypted copy (no W-05 sent it away)
    const [c] = (await w.db.query(`SELECT * FROM claim_codes WHERE ticket_id = $1`, [t.ticketId])).rows;
    expect(c).toMatchObject({ consumed_at: null, revoked_at: null, sent_message_id: null });
    expect(c.code_ciphertext).toBeTruthy();
    const ready = (
      await w.db.query(
        `SELECT payload FROM outbox_events WHERE type = 'ticket.ready' AND aggregate_id = $1`,
        [t.ticketId],
      )
    ).rows[0].payload.payload;
    expect(ready).toMatchObject({ expected_method: 'code', claim_code_id: c.id });
    expect(await messagesTo(w, a.phone)).toEqual([]);

    const visit = await getVisit(a, t.ticketId);
    expect(visit.handover).toMatchObject({ method: 'app_code', code_available: true });
    const r = await cget(a, codePath);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.headers['cache-control']).toContain('no-store');
    const code = successEnvelopeSchema(CustomerHandoverCodeSchema).parse(r.body).data;
    expect(code).toMatchObject({ ticket_id: t.ticketId, attempts_left: 5 });
    // another account never gets it
    const b = await account();
    expect(errOf(await cget(b, codePath))).toEqual({ status: 404, code: 'RESOURCE_NOT_FOUND' });

    // staff never see it: the ticket detail, the driver's task card
    for (const res of [
      await w.get(`/v1/tickets/${t.ticketId}`, 'SUP-R'),
      await w.get('/v1/me/home', driver),
    ]) {
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toMatch(new RegExp(`(^|[^0-9a-f])${code.code}([^0-9a-f]|$)`));
    }
    // nowhere in the database as plain text (the ciphertext and the HMAC only), nor in a log line
    expect(
      await tablesContaining(w, code.code, new RegExp(`(^|[^0-9a-f])${code.code}([^0-9a-f]|$)`)),
    ).toEqual([]);
    expect(logLines.join('\n')).not.toContain(code.code);
    const shown = await w.db.query(
      `SELECT metadata::text AS m FROM customer_audit_log WHERE account_id = $1 AND action = 'customer.visit.handover_code_shown'`,
      [a.id],
    );
    expect(shown.rows).toHaveLength(1);
    expect(shown.rows[0].m).not.toContain(code.code);

    // the customer says it to the driver: D-11 verifies it as for W-05; the copy is purged
    const done = ok(
      await handover(w, driver, t.ticketId, { verification: { method: 'code', code: code.code } }),
    );
    expect(JSON.stringify(done)).not.toContain(code.code);
    const after = (
      await w.db.query(`SELECT consumed_at, code_ciphertext FROM claim_codes WHERE id = $1`, [c.id])
    ).rows[0];
    expect(after.consumed_at).toBeTruthy();
    expect(after.code_ciphertext).toBeNull();
    expect(errOf(await cget(a, codePath))).toEqual({ status: 409, code: 'HANDOVER_NOT_READY' });
    expect(taskId).toBeTruthy();
  });

  it('expired: unavailable until the driver reissues it (resend works for an app ticket, without WhatsApp)', async () => {
    const a = await account();
    const t = await appTicket(a);
    const { driver } = await readyAppTicket(a, t);
    const codePath = `${visitPath(t.ticketId)}/handover-code`;
    const first = (await cget(a, codePath)).body.data.code;
    w.clock.advance(31 * 60_000);
    await refreshAccess(a);
    expect(errOf(await cget(a, codePath))).toEqual({
      status: 409,
      code: 'HANDOVER_CODE_UNAVAILABLE',
      reason: 'expired',
    });
    await w.drain(); // job.claim_code_expire
    expect(errOf(await cget(a, codePath))).toMatchObject({
      code: 'HANDOVER_CODE_UNAVAILABLE',
      reason: 'expired',
    });
    const resent = await w.command('post', `/v1/tickets/${t.ticketId}/handover-code/resend`, { as: driver });
    expect(resent.status, JSON.stringify(resent.body)).toBe(200);
    expect(resent.body.data.sent_status).toBeNull();
    const second = await cget(a, codePath);
    expect(second.status).toBe(200);
    expect(second.body.data.code).toMatch(/^[0-9]{6}$/);
    expect(await messagesTo(w, a.phone)).toEqual([]);
    expect(first).toMatch(/^[0-9]{6}$/);
  });

  it('a WhatsApp visit of the account gets its code in W-05, not in the app', async () => {
    const a = await account();
    const t = await appTicket(a);
    // the same ticket seen as a WhatsApp visit of the account (DEC-504) in ready
    await w.db.query(
      `UPDATE tickets SET status = 'ready', channel = 'whatsapp', customer_vehicle_id = NULL WHERE id = $1`,
      [t.ticketId],
    );
    expect(errOf(await cget(a, `${visitPath(t.ticketId)}/handover-code`))).toEqual({
      status: 409,
      code: 'HANDOVER_CODE_UNAVAILABLE',
      reason: 'whatsapp',
    });
    expect((await getVisit(a, t.ticketId)).handover).toEqual({
      method: 'whatsapp',
      code_available: false,
      code_expires_at: null,
    });
    await w.db.query(`UPDATE tickets SET status = 'parked', channel = 'app' WHERE id = $1`, [t.ticketId]);
  });
});

// ---------------------------------------------------------------------------------------------
// C-13 rating (DEC-518)
// ---------------------------------------------------------------------------------------------

describe('V2-015 — POST /v1/customer/visits/{ticketId}/rating (C-13)', () => {
  it('once per visit, after the delivery; the note is not on the account trail', async () => {
    const a = await account();
    const t = await appTicket(a);
    const ratingPath = `${visitPath(t.ticketId)}/rating`;
    expect(errOf(await cpost(a, ratingPath, { stars: 5 }))).toEqual({
      status: 409,
      code: 'CUSTOMER_VISIT_NOT_DELIVERED',
    });
    const { driver } = await readyAppTicket(a, t);
    const code = (await cget(a, `${visitPath(t.ticketId)}/handover-code`)).body.data.code;
    ok(await handover(w, driver, t.ticketId, { verification: { method: 'code', code } }));
    expect((await getVisit(a, t.ticketId)).can_rate).toBe(true);
    expect(errOf(await cpost(a, ratingPath, { stars: 6 }))).toEqual({
      status: 422,
      code: 'VALIDATION_FAILED',
    });
    const key = newKey();
    const r = await cpost(a, ratingPath, { stars: 4, note: '  خدمة سريعة  ' }, key);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(successEnvelopeSchema(CustomerVisitRatingSchema).parse(r.body).data).toMatchObject({
      ticket_id: t.ticketId,
      stars: 4,
      note: 'خدمة سريعة',
    });
    expect((await cpost(a, ratingPath, { stars: 4, note: '  خدمة سريعة  ' }, key)).status).toBe(201);
    expect(errOf(await cpost(a, ratingPath, { stars: 1 }))).toEqual({
      status: 409,
      code: 'CUSTOMER_VISIT_ALREADY_RATED',
    });
    const rows = await w.db.query(
      `SELECT org_id, stars, note FROM customer_visit_ratings WHERE ticket_id = $1`,
      [t.ticketId],
    );
    expect(rows.rows).toEqual([{ org_id: ORG, stars: 4, note: 'خدمة سريعة' }]);
    const trail = await w.db.query(
      `SELECT metadata::text AS m FROM customer_audit_log WHERE account_id = $1 AND action = 'customer.visit.rated'`,
      [a.id],
    );
    expect(trail.rows).toHaveLength(1);
    expect(trail.rows[0].m).not.toContain('خدمة');
    const v = await getVisit(a, t.ticketId);
    expect(v).toMatchObject({ status: 'delivered', open: false, rated: true, can_rate: false });
    expect(v.duration_min).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The customer socket (DEC-520)
// ---------------------------------------------------------------------------------------------

describe('V2-015 — realtime: the /customer namespace', () => {
  const sockets: Socket[] = [];
  afterAll(() => {
    for (const s of sockets) s.close();
  });
  const connect = (namespace: string, headers: Record<string, string>) => {
    const s = io(`${w.apiUrl}${namespace}`, {
      path: '/ws',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true, // one Manager per socket: each handshake carries its own headers
      extraHeaders: headers,
    });
    sockets.push(s);
    return s;
  };
  const connected = (s: Socket) =>
    new Promise<void>((resolve, reject) => {
      s.once('connect', () => resolve());
      s.once('connect_error', (e: any) => reject(e));
    });
  const next = (s: Socket, event: string, ms = 3000) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${event}`)), ms);
      s.once(event, (m: any) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  const none = (s: Socket, event: string, ms = 600) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), ms);
      s.once(event, () => {
        clearTimeout(timer);
        reject(new Error(`unexpected ${event}`));
      });
    });

  it('authenticates with the customer Bearer token only, and never mixes with the staff namespace', async () => {
    const a = await account();
    // no token, a staff cookie, a refresh token instead of the access token
    await expect(connected(connect(CUSTOMER_REALTIME_NAMESPACE, {}))).rejects.toBeTruthy();
    await expect(
      connected(
        connect(CUSTOMER_REALTIME_NAMESPACE, {
          origin: 'http://localhost:5173',
          cookie: await w.sessionFor('DRV1'),
        }),
      ),
    ).rejects.toMatchObject({ data: { code: 'AUTH_UNAUTHENTICATED' } });
    await expect(
      connected(
        connect(CUSTOMER_REALTIME_NAMESPACE, {
          authorization: `Bearer ${newCustomerToken('refresh', a.sessionId)}`,
        }),
      ),
    ).rejects.toBeTruthy();
    // the customer token on the staff namespace (even with a staff cookie beside it)
    await expect(
      connected(connect('/', { authorization: `Bearer ${a.access}`, cookie: await w.sessionFor('DRV1') })),
    ).rejects.toMatchObject({ data: { code: 'AUTH_UNAUTHENTICATED' } });
    const ok1 = connect(CUSTOMER_REALTIME_NAMESPACE, { authorization: `Bearer ${a.access}` });
    await connected(ok1);
  });

  it('delivers visit.updated to the account’s room only, with a minimal customer envelope; a revoked session is ended', async () => {
    const a = await account();
    const b = await account();
    const t = await appTicket(a);
    const sa = connect(CUSTOMER_REALTIME_NAMESPACE, { authorization: `Bearer ${a.access}` });
    const sb = connect(CUSTOMER_REALTIME_NAMESPACE, { authorization: `Bearer ${b.access}` });
    await Promise.all([connected(sa), connected(sb)]);
    const got = next(sa, 'visit.updated');
    const notB = none(sb, 'visit.updated');
    ok(await cpost(a, `${visitPath(t.ticketId)}/request`), 201);
    const m = await got;
    await notB;
    expect(Object.keys(m).sort()).toEqual(['id', 'occurred_at', 'payload', 'type']);
    expect(m.type).toBe('visit.updated');
    expect(m.payload).toEqual({
      ticket_id: t.ticketId,
      status: expect.stringMatching(/^(requested|assigned)$/),
      open: true,
    });

    // a staff change (the offered driver accepts) reaches the customer too
    const offer = await offerOf(t.ticketId);
    const accepted = next(sa, 'visit.updated');
    ok(await accept(w, offer.user_id, offer.id));
    expect((await accepted).payload).toMatchObject({ ticket_id: t.ticketId, status: 'assigned' });

    // logout elsewhere / theft detection: the next re-check ends the socket with session.revoked
    await w.db.query(
      `UPDATE customer_account_sessions SET revoked_at = $2, revoked_reason = 'logout' WHERE id = $1`,
      [a.sessionId, w.clock.now()],
    );
    const revoked = next(sa, 'session.revoked');
    await realtimeOf(w.app)!.revalidateAll();
    expect((await revoked).payload).toEqual({ reason: 'logout' });
    // b is untouched; its 15-minute access token expiring does not end its socket
    w.clock.advance(20 * 60_000);
    await realtimeOf(w.app)!.revalidateAll();
    expect(sb.connected).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Pushes (DEC-519, DEC-520)
// ---------------------------------------------------------------------------------------------

describe('V2-016 — customer pushes', () => {
  it('one push per event on each registered device, with a lock-screen-safe payload', async () => {
    const a = await account();
    const token = await registerPush(a);
    const silent = await session(a.id); // a second device of the account without a token: nothing to it
    expect(silent.access).toBeTruthy();
    const t = await appTicket(a);
    await w.drain();
    expect(sentTo(token).map((m) => m.data.kind)).toEqual(['car_received']);
    // the worker sends right after each commit (drained step by step, as it runs in production)
    ok(await cpost(a, `${visitPath(t.ticketId)}/request`), 201);
    await w.drain();
    expect(sentTo(token)).toHaveLength(1); // the request itself pushes nothing (C-12 shows it live)
    const offer = await offerOf(t.ticketId);
    const driver = offer.user_id;
    ok(await accept(w, driver, offer.id));
    await w.drain();
    ok(await keyPickup(w, driver, offer.task_id, t.slotId));
    ok(await startRetrieval(w, driver, offer.task_id));
    await w.drain();
    ok(await markReady(w, driver, offer.task_id));
    await w.drain();
    expect(sentTo(token).map((m) => m.data.kind)).toEqual(['car_received', 'request_accepted', 'car_ready']);
    const code = (await cget(a, `${visitPath(t.ticketId)}/handover-code`)).body.data.code as string;
    expect(code).toMatch(/^[0-9]{6}$/);

    // the reminder when the car waits at the gate (ready_not_collected, 10 §12)
    const timer = (
      await w.db.query<{ at: Date }>(
        `SELECT available_at AS at FROM outbox_events WHERE type = 'job.ready_uncollected_check' AND status = 'pending'
          AND payload::text LIKE '%' || $1 || '%'`,
        [t.ticketId],
      )
    ).rows[0]!;
    w.clock.set(new Date(timer.at));
    await w.drain();
    await w.drain();
    expect(sentTo(token).map((m) => m.data.kind)).toEqual([
      'car_received',
      'request_accepted',
      'car_ready',
      'pickup_reminder',
    ]);

    const venue = (await w.db.query(`SELECT name_ar FROM venues WHERE id = $1`, [SEED_IDS.venues.RMS]))
      .rows[0];
    const [received, accepted, ready, reminder] = sentTo(token);
    expect(received).toMatchObject({
      title: w.env.BRAND_CUSTOMER_NAME_AR,
      body: `استلمنا سيارتك في ${venue.name_ar}`,
    });
    expect(accepted!.body).toBe('سائقنا في طريقه إلى سيارتك');
    expect(ready!.body).toBe('سيارتك جاهزة عند البوابة');
    expect(reminder!.body).toBe('سيارتك ما زالت بانتظارك');
    for (const m of [received!, accepted!, ready!, reminder!]) {
      // data: opaque ids only (DEC-23); exactly the three keys
      expect(Object.keys(m.data).sort()).toEqual(['kind', 'type', 'visit_id']);
      expect(CustomerPushDataSchema.parse(m.data)).toEqual({
        type: 'visit',
        kind: m.data.kind,
        visit_id: t.ticketId,
      });
      // what the lock screen shows: no plate, key, spot, code, name or phone
      const shown = `${m.title} ${m.body}`;
      expect(shown).not.toMatch(/[0-9]/);
      expect(shown).not.toContain('نورة');
      const text = JSON.stringify({ title: m.title, body: m.body, data: m.data });
      expect(text).not.toContain(t.digits);
      expect(text).not.toContain(t.keyTag);
      expect(text).not.toContain(a.phone.slice(-7));
      expect(text).not.toMatch(new RegExp(`(^|[^0-9a-f])${code}([^0-9a-f]|$)`));
    }
    // the rows: ids and states only, one per device session; the planner never pushed to the silent session
    const rows = await w.db.query(
      `SELECT * FROM customer_push_messages WHERE ticket_id = $1 ORDER BY created_at`,
      [t.ticketId],
    );
    expect(rows.rows.map((r) => [r.kind, r.status, r.provider, r.session_id])).toEqual([
      ['car_received', 'sent', 'simulator', a.sessionId],
      ['request_accepted', 'sent', 'simulator', a.sessionId],
      ['car_ready', 'sent', 'simulator', a.sessionId],
      ['pickup_reminder', 'sent', 'simulator', a.sessionId],
    ]);
    expect(JSON.stringify(rows.rows)).not.toContain(token);
    const jobs = await w.db.query(
      `SELECT payload FROM outbox_events WHERE type = 'job.customer_push_send' AND payload->>'push_id' = ANY($1)`,
      [rows.rows.map((r) => r.id)],
    );
    for (const j of jobs.rows) expect(Object.keys(j.payload)).toEqual(['push_id']);
    expect(logLines.join('\n')).not.toContain(token);

    // the receipts later: delivered
    w.clock.advance(w.env.CUSTOMER_PUSH_RECEIPT_DELAY_S * 1000 + 1000);
    await w.drain();
    const delivered = await w.db.query(
      `SELECT status, receipt_status FROM customer_push_messages WHERE ticket_id = $1`,
      [t.ticketId],
    );
    expect(delivered.rows.every((r) => r.status === 'delivered' && r.receipt_status === 'ok')).toBe(true);
  });

  it('a WhatsApp visit of the account gets its W-xx messages, no push', async () => {
    const a = await account();
    const token = await registerPush(a);
    const t = await appTicket(a, { park: false });
    await w.drain();
    const before = sentTo(token).length;
    await w.db.query(`UPDATE tickets SET channel = 'whatsapp', customer_vehicle_id = NULL WHERE id = $1`, [
      t.ticketId,
    ]);
    await park(w, t.driver, t.taskId);
    ok(await cpost(a, `${visitPath(t.ticketId)}/request`), 201);
    await w.drain();
    expect(sentTo(token)).toHaveLength(before);
  });

  it('a dead token is pruned — at the send and at the receipt — and nothing more is sent to it', async () => {
    const a = await account();
    const token = await registerPush(a);
    sim.unregister(token);
    await appTicket(a, { park: false });
    await w.drain();
    const row = (
      await w.db.query(`SELECT status, error_code FROM customer_push_messages WHERE account_id = $1`, [a.id])
    ).rows;
    expect(row).toEqual([{ status: 'failed', error_code: 'DeviceNotRegistered' }]);
    const s = (
      await w.db.query(`SELECT push_token FROM customer_account_sessions WHERE id = $1`, [a.sessionId])
    ).rows[0];
    expect(s.push_token).toBeNull();

    // a receipt that says the device is gone
    const b = await account();
    const tokenB = await registerPush(b);
    sim.failReceipt(tokenB);
    const tb = await appTicket(b, { park: false });
    await w.drain();
    expect(sentTo(tokenB)).toHaveLength(1);
    w.clock.advance(w.env.CUSTOMER_PUSH_RECEIPT_DELAY_S * 1000 + 1000);
    await w.drain();
    const rb = (
      await w.db.query(
        `SELECT status, receipt_status, error_code FROM customer_push_messages WHERE ticket_id = $1`,
        [tb.ticketId],
      )
    ).rows;
    expect(rb).toEqual([{ status: 'failed', receipt_status: 'error', error_code: 'DeviceNotRegistered' }]);
    expect(
      (await w.db.query(`SELECT push_token FROM customer_account_sessions WHERE id = $1`, [b.sessionId]))
        .rows[0].push_token,
    ).toBeNull();
  });

  it('device registration: removal, a token moving to the newest session, sign-out and account deletion drop it', async () => {
    const a = await account();
    const token = await registerPush(a);
    // the same phone signs in to another account: the token moves there
    const b = await account();
    await registerPush(b, token);
    const tokens = await w.db.query(
      `SELECT id, push_token FROM customer_account_sessions WHERE id = ANY($1) ORDER BY id`,
      [[a.sessionId, b.sessionId]],
    );
    expect(Object.fromEntries(tokens.rows.map((r) => [r.id, r.push_token]))).toEqual({
      [a.sessionId]: null,
      [b.sessionId]: token,
    });
    // C-19 off
    const off = await cpost(b, CUSTOMER_ROUTES.devices.path, { provider: 'expo', push_token: null });
    expect(off.body.data).toEqual({ push_registered: false, provider: null, registered_at: null });
    expect(
      errOf(await cpost(b, CUSTOMER_ROUTES.devices.path, { provider: 'expo', push_token: 'not-a-token' })),
    ).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    // a pending push to a session revoked meanwhile is skipped, never sent
    await registerPush(b);
    const t = await appTicket(b, { park: false });
    await w.db.query(
      `UPDATE customer_account_sessions SET revoked_at = $2, revoked_reason = 'logout', push_token = NULL,
              push_provider = NULL, push_registered_at = NULL WHERE id = $1`,
      [b.sessionId, w.clock.now()],
    );
    await w.drain();
    expect(
      (
        await w.db.query(`SELECT status, skipped_reason FROM customer_push_messages WHERE ticket_id = $1`, [
          t.ticketId,
        ])
      ).rows,
    ).toEqual([{ status: 'skipped', skipped_reason: 'session_revoked' }]);
  });

  it('the simulator never reaches the network; live outside production still simulates', async () => {
    const calls: string[] = [];
    const spy = (async (url: string) => {
      calls.push(String(url));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const live = new CustomerPushRuntime({ env: { ...w.env, CUSTOMER_PUSH_MODE: 'live' }, fetch: spy });
    expect(live.sender.provider).toBe('simulator');
    expect(live.sender).toBe(defaultCustomerPushSimulator());
    await live.sender.send([
      {
        to: 'ExponentPushToken[xxxxxxxxxxxxxxxx]',
        title: 'x',
        body: 'y',
        data: { type: 'visit', kind: 'car_ready', visit_id: randomUUID() },
      },
    ]);
    expect(calls).toEqual([]);
    const prod = new CustomerPushRuntime({
      env: { ...w.env, APP_ENV: 'production', CUSTOMER_PUSH_MODE: 'live' },
      fetch: spy,
    });
    expect(prod.sender.provider).toBe('expo');
  });
});
