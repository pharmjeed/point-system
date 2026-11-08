import { randomUUID } from 'node:crypto';
import {
  createLogger,
  customerAccountsJobs,
  CustomerPushRuntime,
  CustomerPushSimulator,
  InvoicingRuntime,
  invoicingJobs,
  newCustomerToken,
  OBJECT_STORAGE,
  PaymentsRuntime,
  paymentsOnlineJobs,
  rateLimitClassOf,
  sha256Hex,
  SimulatorEInvoicingProvider,
  subscriptionsJobs,
  type ObjectStorage,
  type WhatsappRuntime,
} from '@point/server';
import { WA_CUSTOMER_OTP_TEMPLATE_NAME, type PlatformRole } from '@point/shared';
import {
  CUSTOMER_OTP_DAILY_LOCK_HOURS,
  CUSTOMER_OTP_LOCK_MINUTES,
  CUSTOMER_ROUTES,
  generatePassToken,
  passStep,
  type CustomerPass,
} from '@point/shared/customer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SECRET_KEY,
  DEFAULT_WEBHOOK_SECRET,
  TEST_CARDS,
  startPaymentSimulator,
  type RunningPaymentSimulator,
} from '../../../tools/payment-simulator/src/index.js';
import {
  createCustomerApp,
  freshDriver,
  park,
  tablesContaining,
  type CustomerApp,
} from './customer-harness.js';
import {
  accept,
  addPhotos,
  EVT_R1,
  keyPickup,
  markReady,
  newDraft,
  ok,
  patchIntake,
  startRetrieval,
  submitIntake,
} from './dispatch-fixtures.js';
import { CSRF, newKey, SEED_IDS } from './harness.js';

/**
 * V2-051 — the automated security test of the V2 surfaces (docs/v2/07_Security_Review.md, DEC-560 … DEC-564) on a
 * real PostgreSQL 16 with the WhatsApp simulator (the Point number), the payment simulator (Moyasar) and the
 * e-invoicing simulator: IDOR across customer accounts on every resource of `/v1/customer/*`, token confusion between
 * the staff cookie, the platform cookie and the customer Bearer tokens, the sign-in code (brute force, limits,
 * enumeration), webhook signatures and replays, mass assignment, price tampering, the handover code and full phone
 * numbers in responses, tables, push payloads and in every log line the api and the worker wrote meanwhile.
 * Each `it` names the threat of 07 §2 it covers (T-xx).
 */

const RMS = SEED_IDS.venues.RMS;
const ORG = SEED_IDS.org;
const CARD_VERSION = '2026-11-01';
const CALLBACK_SECRET = 'v2-security-einvoice-callback-secret';
const FEE = 2300;
const MONTHLY = 30_000;
const ROLES: PlatformRole[] = ['platform_owner', 'platform_finance', 'platform_support'];

let w: CustomerApp;
let sim: RunningPaymentSimulator;
let storage: ObjectStorage;
const apiLog: string[] = [];
const workerLog: string[] = [];
/** every sign-in code and handover code seen during the run (none may appear in a log line) */
const secretsSeen = new Set<string>();
const cookies = {} as Record<PlatformRole, string>;
let planId: string;
let phoneSeq = 0;
let plateSeq = 7100;
const nextPhone = () => `+9665${String(86000000 + ++phoneSeq)}`;

interface Account {
  id: string;
  phone: string;
  access: string;
  refresh: string;
  sessionId: string;
}

async function account(): Promise<Account> {
  const phone = nextPhone();
  const id = (
    await w.db.query<{ id: string }>(
      `INSERT INTO customer_accounts (phone_e164, display_name) VALUES ($1, 'عميل') RETURNING id`,
      [phone],
    )
  ).rows[0]!.id;
  const sid = randomUUID();
  const access = newCustomerToken('access', sid);
  const refresh = newCustomerToken('refresh', sid);
  await w.db.query(
    `INSERT INTO customer_account_sessions (id, account_id, device_id, platform, refresh_hash, access_hash,
            access_expires_at, refresh_expires_at, created_at)
     VALUES ($1, $2, $3, 'ios', $4, $5, $6::timestamptz + interval '400 days', $6::timestamptz + interval '400 days', $6)`,
    [sid, id, `device-${sid}`, sha256Hex(refresh), sha256Hex(access), w.clock.now()],
  );
  return { id, phone, access, refresh, sessionId: sid };
}

const bearer = (a: Account | string) => ({ Authorization: `Bearer ${typeof a === 'string' ? a : a.access}` });
const cget = (a: Account, path: string) => w.http().get(path).set(bearer(a));
const csend = (
  a: Account,
  method: 'post' | 'put' | 'patch' | 'delete',
  path: string,
  body: unknown = {},
  key: string = newKey(),
) => {
  const server = w.http();
  return server[method](path)
    .set(bearer(a))
    .set('Idempotency-Key', key)
    .send(body as object);
};
const errOf = (r: { status: number; body: any }) => ({ status: r.status, code: r.body?.error?.code });
const NOT_FOUND = { status: 404, code: 'RESOURCE_NOT_FOUND' };

async function vehicle(a: Account): Promise<string> {
  const r = await csend(a, 'post', CUSTOMER_ROUTES.vehicleCreate.path, {
    plate: { country: 'SA', digits: String(++plateSeq), letters_ar: 'ب ح د' },
    vehicle_make: 'toyota',
    vehicle_color: 'white',
    vehicle_type: 'sedan',
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.id as string;
}

async function passOf(a: Account): Promise<CustomerPass> {
  const r = await cget(a, CUSTOMER_ROUTES.pass.path);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data;
}

interface AppTicket {
  ticketId: string;
  taskId: string;
  slotId: string;
}

/** An app ticket of the account (O-01, the pass scanned by a driver), parked, its fee due. */
async function appTicket(a: Account, vehicleId: string, step = 0): Promise<AppTicket> {
  const p = await passOf(a);
  const driver = await freshDriver(w);
  const d = await newDraft(w, driver, EVT_R1);
  const pass_token = generatePassToken({
    secret: p.secret,
    accountId: p.account_id,
    vehicleId,
    step: passStep(w.clock.now().getTime()) + step,
  });
  const r = ok(
    await w.command('post', '/v1/tickets/intake-pass', {
      as: driver,
      body: { pass_token, ticket_id: d.ticketId, expected_version: d.version },
    }),
  );
  const patched = ok(
    await patchIntake(w, driver, d.ticketId, {
      expected_version: r.ticket.version,
      key_tag: `SEC-${plateSeq}`,
    }),
  );
  await addPhotos(w.db, d.ticketId, driver);
  ok(await submitIntake(w, driver, d.ticketId, { expected_version: patched.version }));
  const { slotId } = await park(w, driver, d.taskId);
  await w.db.query(
    `UPDATE tickets SET payment_status = 'due', fee_halalas = $2, entitlement = 'none' WHERE id = $1`,
    [d.ticketId, FEE],
  );
  return { ticketId: d.ticketId, taskId: d.taskId, slotId };
}

const settle = async () => {
  for (let round = 0; round < 3; round++) {
    await sim.client.flush();
    for (let i = 0; i < 10; i++) if ((await w.dispatcher.drain(200)) === 0) break;
  }
};
const token = (card: { number: string } = TEST_CARDS.success) => sim.client.tokenize(card.number);
const touch = () => w.db.query(`UPDATE platform_sessions SET last_seen_at = $1`, [w.clock.now()]);

/** The B side of the IDOR matrix: every kind of resource the customer API names by id. */
interface Resources {
  vehicleId: string;
  ticket: AppTicket;
  paymentId: string;
  gatewayPaymentId: string;
  invoiceId: string;
  methodId: string;
  subscriptionId: string;
}

async function resourcesOf(b: Account): Promise<Resources> {
  const vehicleId = await vehicle(b);
  const ticket = await appTicket(b, vehicleId);
  const pay = await csend(b, 'post', `/v1/customer/visits/${ticket.ticketId}/pay`, {
    source: { type: 'token', token: await token() },
    save_card: true,
    card_on_file_version: CARD_VERSION,
  });
  expect(pay.status, JSON.stringify(pay.body)).toBe(201);
  expect(pay.body.data.status).toBe('paid');
  await settle();
  const paymentId = pay.body.data.payment_id as string;
  const p = (
    await w.db.query<{ gateway_payment_id: string }>(
      `SELECT gateway_payment_id FROM online_payments WHERE id = $1`,
      [paymentId],
    )
  ).rows[0]!;
  const inv = (
    await w.db.query<{ id: string }>(`SELECT id FROM invoices WHERE online_payment_id = $1`, [paymentId])
  ).rows[0];
  expect(inv, 'the paid visit has its simplified invoice').toBeTruthy();
  const methods = await cget(b, CUSTOMER_ROUTES.paymentMethods.path);
  const methodId = methods.body.data.items[0]?.id as string;
  expect(methodId).toBeTruthy();
  const subVehicle = await vehicle(b);
  const sub = await csend(b, 'post', CUSTOMER_ROUTES.subscribe.path, {
    plan_id: planId,
    billing_cycle: 'monthly',
    vehicle_ids: [subVehicle],
    source: { type: 'saved', payment_method_id: methodId },
  });
  expect(sub.status, JSON.stringify(sub.body)).toBe(201);
  await settle();
  return {
    vehicleId,
    ticket,
    paymentId,
    gatewayPaymentId: p.gateway_payment_id,
    invoiceId: inv!.id,
    methodId,
    subscriptionId: sub.body.data.subscription.subscription_id ?? sub.body.data.subscription.id,
  };
}

beforeAll(async () => {
  process.env.MOYASAR_SECRET_KEY = DEFAULT_SECRET_KEY;
  process.env.MOYASAR_WEBHOOK_SECRET = DEFAULT_WEBHOOK_SECRET;
  process.env.EINVOICE_WEBHOOK_SECRET = CALLBACK_SECRET;
  let simNow = () => new Date('2026-10-27T16:00:00.000Z');
  sim = await startPaymentSimulator({ env: {}, now: () => simNow() });
  const capture = (sink: string[]) =>
    createLogger({ level: 'debug', destination: { write: (l: string) => void sink.push(l) } });
  w = await createCustomerApp({
    env: { MOYASAR_BASE_URL: sim.url, MOYASAR_HTTP_TIMEOUT_MS: '3000', LOG_LEVEL: 'debug' },
    logger: capture(apiLog),
  });
  simNow = () => w.clock.now();
  await sim.client.configure({ webhookUrl: `${w.apiUrl}/webhooks/payments/moyasar`, autoWebhooks: true });
  // the worker side: every job of the run logs into workerLog (the dispatcher's own lines included)
  const logger = capture(workerLog);
  Object.assign(w.dispatcher as object, { logger });
  Object.assign(w.rt as object, { logger });
  const prt = new PaymentsRuntime({ env: w.env, logger });
  storage = w.app.get<ObjectStorage>(OBJECT_STORAGE, { strict: false });
  const invoicing = new InvoicingRuntime({
    env: w.env,
    clock: w.clock,
    storage,
    provider: new SimulatorEInvoicingProvider({
      now: () => w.clock.now(),
      callbackSecrets: async () => [CALLBACK_SECRET],
    }),
    logger,
  });
  const push = new CustomerPushRuntime({
    env: w.env,
    sender: new CustomerPushSimulator(() => w.clock.now()),
    logger,
  });
  for (const h of [
    ...customerAccountsJobs({ push, runtime: w.rt as WhatsappRuntime }),
    ...paymentsOnlineJobs({ runtime: prt }),
    ...subscriptionsJobs({ runtime: prt }),
    ...invoicingJobs({ runtime: invoicing }),
  ])
    w.dispatcher.register(h);
  for (const [i, role] of ROLES.entries()) {
    const u = await w.db.query<{ id: string }>(
      `INSERT INTO platform_users (phone_e164, full_name, role, secret_hash, must_change_secret, mfa_enabled, mfa_secret_enc)
       VALUES ($1, $2, $3, 'x', false, true, 'x') RETURNING id`,
      [`+96655999100${i}`, `حساب ${role}`, role],
    );
    const tok = `v2-security-session-${role}-0123456789`;
    await w.db.query(
      `INSERT INTO platform_sessions (platform_user_id, token_hash, mfa_verified, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, true, $3, $3, $3::timestamptz + interval '400 days')`,
      [u.rows[0]!.id, sha256Hex(tok), w.clock.now()],
    );
    cookies[role] = `${w.env.PLATFORM_SESSION_COOKIE_NAME}=${tok}`;
    if (role === 'platform_owner')
      await w.db.query(
        `INSERT INTO venue_public_profiles (venue_id, org_id, status, category, subscriptions_enabled, approved_by,
                                            approved_at)
         VALUES ($1, $2, 'approved', 'office', true, $3, now())
         ON CONFLICT (venue_id) DO UPDATE SET status = 'approved', category = 'office', subscriptions_enabled = true`,
        [RMS, ORG, u.rows[0]!.id],
      );
  }
  await touch();
  const p = await w
    .http()
    .post('/v1/platform/plans')
    .set(CSRF)
    .set('Cookie', cookies.platform_finance)
    .set('Idempotency-Key', newKey())
    .send({ venue_id: RMS, name_ar: 'سيارة واحدة', vehicles_included: 1, monthly_price_halalas: MONTHLY });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  planId = p.body.data.plan_id;
}, 180_000);

afterAll(async () => {
  await sim?.close();
  await w?.close();
});

// ---------------------------------------------------------------------------------------------
// T-01 IDOR across customer accounts
// ---------------------------------------------------------------------------------------------

describe('T-01 — IDOR: an account never reads or changes another account’s resources', () => {
  let a: Account;
  let b: Account;
  let rb: Resources;
  let aTicket: AppTicket;
  let aVehicle: string;

  beforeAll(async () => {
    a = await account();
    b = await account();
    rb = await resourcesOf(b);
    aVehicle = await vehicle(a);
    aTicket = await appTicket(a, aVehicle);
  }, 120_000);

  it('reads by id answer RESOURCE_NOT_FOUND (never 403: the id’s existence is not confirmed)', async () => {
    const reads = [
      `/v1/customer/visits/${rb.ticket.ticketId}`,
      `/v1/customer/visits/${rb.ticket.ticketId}/handover-code`,
      `/v1/customer/payments/${rb.paymentId}`,
      `/v1/customer/invoices/${rb.invoiceId}`,
      `/v1/customer/subscriptions/${rb.subscriptionId}`,
    ];
    for (const path of reads) {
      const r = await cget(a, path);
      expect(errOf(r), path).toEqual(NOT_FOUND);
    }
    // B itself reads them all
    for (const path of reads.filter((p) => !p.endsWith('handover-code')))
      expect((await cget(b, path)).status, path).toBe(200);
  });

  it('the lists of A name none of B’s ids', async () => {
    const lists = await Promise.all(
      [
        CUSTOMER_ROUTES.vehicles.path,
        CUSTOMER_ROUTES.visits.path,
        CUSTOMER_ROUTES.paymentMethods.path,
        CUSTOMER_ROUTES.subscriptions.path,
        CUSTOMER_ROUTES.invoices.path,
        CUSTOMER_ROUTES.home.path,
        CUSTOMER_ROUTES.me.path,
      ].map((p) => cget(a, p)),
    );
    const text = JSON.stringify(lists.map((r) => r.body));
    for (const id of [
      rb.vehicleId,
      rb.ticket.ticketId,
      rb.paymentId,
      rb.invoiceId,
      rb.methodId,
      rb.subscriptionId,
      b.id,
    ])
      expect(text).not.toContain(id);
    expect(text).not.toContain(b.phone);
  });

  it('commands on B’s ids answer RESOURCE_NOT_FOUND and change nothing', async () => {
    const before = await w.db.query(
      `SELECT (SELECT count(*) FROM retrieval_cycles WHERE ticket_id = $1)::int AS cycles,
              (SELECT count(*) FROM online_payments WHERE ticket_id = $1)::int AS payments,
              (SELECT removed_at FROM customer_vehicles WHERE id = $2) AS vehicle_removed,
              (SELECT removed_at FROM customer_payment_methods WHERE id = $3) AS card_removed,
              (SELECT is_default FROM customer_payment_methods WHERE id = $3) AS card_default,
              (SELECT status || ':' || cancel_at_period_end || ':' || version FROM subscriptions WHERE id = $4) AS sub`,
      [rb.ticket.ticketId, rb.vehicleId, rb.methodId, rb.subscriptionId],
    );
    const t = rb.ticket.ticketId;
    const commands: Array<[method: 'post' | 'put' | 'patch' | 'delete', path: string, body: unknown]> = [
      ['post', `/v1/customer/visits/${t}/request`, {}],
      ['post', `/v1/customer/visits/${t}/rating`, { stars: 1 }],
      ['post', `/v1/customer/visits/${t}/pay`, { source: { type: 'token', token: await token() } }],
      ['delete', `/v1/customer/vehicles/${rb.vehicleId}`, {}],
      ['patch', `/v1/customer/payment-methods/${rb.methodId}`, { is_default: true }],
      ['delete', `/v1/customer/payment-methods/${rb.methodId}`, {}],
      ['post', `/v1/customer/subscriptions/${rb.subscriptionId}/cancel`, {}],
      ['post', `/v1/customer/subscriptions/${rb.subscriptionId}/resume`, {}],
      [
        'post',
        `/v1/customer/subscriptions/${rb.subscriptionId}/pay`,
        { source: { type: 'token', token: await token() } },
      ],
      ['put', `/v1/customer/subscriptions/${rb.subscriptionId}/vehicles`, { vehicle_ids: [aVehicle] }],
    ];
    for (const [method, path, body] of commands) {
      const r = await csend(a, method, path, body);
      expect(errOf(r), `${method.toUpperCase()} ${path} ${JSON.stringify(r.body)}`).toEqual(NOT_FOUND);
    }
    await settle();
    const after = await w.db.query(
      `SELECT (SELECT count(*) FROM retrieval_cycles WHERE ticket_id = $1)::int AS cycles,
              (SELECT count(*) FROM online_payments WHERE ticket_id = $1)::int AS payments,
              (SELECT removed_at FROM customer_vehicles WHERE id = $2) AS vehicle_removed,
              (SELECT removed_at FROM customer_payment_methods WHERE id = $3) AS card_removed,
              (SELECT is_default FROM customer_payment_methods WHERE id = $3) AS card_default,
              (SELECT status || ':' || cancel_at_period_end || ':' || version FROM subscriptions WHERE id = $4) AS sub`,
      [rb.ticket.ticketId, rb.vehicleId, rb.methodId, rb.subscriptionId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('B’s saved card and B’s vehicles cannot be used in A’s own commands', async () => {
    // A pays A's own visit with B's saved card
    const pay = await csend(a, 'post', `/v1/customer/visits/${aTicket.ticketId}/pay`, {
      source: { type: 'saved', payment_method_id: rb.methodId },
    });
    expect(errOf(pay)).toEqual(NOT_FOUND);
    expect(pay.body.error.details).toMatchObject({ resource: 'payment_method' });
    // A subscribes with B's card, then with B's vehicle
    const withCard = await csend(a, 'post', CUSTOMER_ROUTES.subscribe.path, {
      plan_id: planId,
      billing_cycle: 'monthly',
      vehicle_ids: [aVehicle],
      source: { type: 'saved', payment_method_id: rb.methodId },
    });
    expect(withCard.status, JSON.stringify(withCard.body)).toBeGreaterThanOrEqual(400);
    expect(withCard.status).toBeLessThan(500);
    const withVehicle = await csend(a, 'post', CUSTOMER_ROUTES.subscribe.path, {
      plan_id: planId,
      billing_cycle: 'monthly',
      vehicle_ids: [rb.vehicleId],
      source: { type: 'token', token: await token() },
      save_card: true,
      card_on_file_version: CARD_VERSION,
    });
    expect(withVehicle.status, JSON.stringify(withVehicle.body)).toBeGreaterThanOrEqual(400);
    expect(withVehicle.status).toBeLessThan(500);
    await settle();
    const charged = await w.db.query(
      `SELECT count(*)::int AS n FROM online_payments
        WHERE account_id = $1 OR (payment_method_id = $2 AND account_id <> $3)`,
      [a.id, rb.methodId, b.id],
    );
    expect(charged.rows[0].n, 'nothing was charged to A, and B’s card only paid B’s own').toBe(0);
    expect(
      (await w.db.query(`SELECT count(*)::int AS n FROM subscriptions WHERE account_id = $1`, [a.id])).rows[0]
        .n,
    ).toBe(0);
  });

  it('a pass token built with A’s secret but naming B’s account (or vehicle) opens no ticket', async () => {
    const pa = await passOf(a);
    for (const [accountId, vehicleId] of [
      [b.id, rb.vehicleId],
      [a.id, rb.vehicleId],
    ] as const) {
      const driver = await freshDriver(w);
      const d = await newDraft(w, driver, EVT_R1);
      const forged = generatePassToken({
        secret: pa.secret,
        accountId,
        vehicleId,
        step: passStep(w.clock.now().getTime()),
      });
      const r = await w.command('post', '/v1/tickets/intake-pass', {
        as: driver,
        body: { pass_token: forged, ticket_id: d.ticketId, expected_version: d.version },
      });
      expect(r.status, JSON.stringify(r.body)).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      const t = (await w.db.query(`SELECT customer_id FROM tickets WHERE id = $1`, [d.ticketId])).rows[0];
      expect(t.customer_id).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// T-02 token confusion between the three kinds of sessions
// ---------------------------------------------------------------------------------------------

describe('T-02 — token confusion: staff cookie, platform cookie and customer Bearer never stand in for each other', () => {
  it('each kind of credential opens only its own routes', async () => {
    const a = await account();
    const staff = await w.sessionFor('OWN1');
    await touch();
    // a staff or platform cookie on the customer API
    for (const cookie of [staff, cookies.platform_owner]) {
      const r = await w.http().get(CUSTOMER_ROUTES.me.path).set('Cookie', cookie);
      expect(errOf(r)).toEqual({ status: 401, code: 'AUTH_UNAUTHENTICATED' });
    }
    // the customer Bearer token on a staff route and on a platform route (alone, and beside the other cookie)
    expect(errOf(await w.http().get('/v1/me').set(bearer(a)))).toMatchObject({ status: 401 });
    expect(errOf(await w.http().get('/v1/platform/me').set(bearer(a)))).toEqual({
      status: 401,
      code: 'PLATFORM_AUTH_REQUIRED',
    });
    // the staff cookie on the platform, the platform cookie on staff routes
    expect(errOf(await w.http().get('/v1/platform/me').set('Cookie', staff))).toEqual({
      status: 401,
      code: 'PLATFORM_AUTH_REQUIRED',
    });
    expect((await w.http().get('/v1/me').set('Cookie', cookies.platform_owner)).status).toBe(401);
    // a refresh token or a re-verification proof is not an access token
    for (const t of [a.refresh, newCustomerToken('reauth', a.sessionId), `${a.access}x`, 'Bearer'])
      expect(errOf(await w.http().get(CUSTOMER_ROUTES.me.path).set(bearer(t))).status).toBe(401);
    // the customer's own token works
    expect((await cget(a, CUSTOMER_ROUTES.me.path)).status).toBe(200);
  });

  it('a platform session without MFA reaches platform.self only; an unverified MFA challenge reaches nothing', async () => {
    const mk = async (mfaEnabled: boolean, phone: string) => {
      const u = await w.db.query<{ id: string }>(
        `INSERT INTO platform_users (phone_e164, full_name, role, secret_hash, must_change_secret, mfa_enabled, mfa_secret_enc)
         VALUES ($1, 'بلا تحقق', 'platform_owner', 'x', false, $2, CASE WHEN $2 THEN 'x' END) RETURNING id`,
        [phone, mfaEnabled],
      );
      const tok = `v2-security-nomfa-${randomUUID()}`;
      await w.db.query(
        `INSERT INTO platform_sessions (platform_user_id, token_hash, mfa_verified, created_at, last_seen_at, expires_at)
         VALUES ($1, $2, false, $3, $3, $3::timestamptz + interval '1 day')`,
        [u.rows[0]!.id, sha256Hex(tok), w.clock.now()],
      );
      return `${w.env.PLATFORM_SESSION_COOKIE_NAME}=${tok}`;
    };
    const setup = await mk(false, '+966559991901');
    expect(errOf(await w.http().get('/v1/platform/operators').set('Cookie', setup))).toEqual({
      status: 403,
      code: 'AUTH_MFA_SETUP_REQUIRED',
    });
    expect(errOf(await w.http().get('/v1/platform/customers').set('Cookie', setup)).code).toBe(
      'AUTH_MFA_SETUP_REQUIRED',
    );
    expect((await w.http().get('/v1/platform/me').set('Cookie', setup)).status).toBe(200);
    const challenge = await mk(true, '+966559991902');
    for (const path of ['/v1/platform/me', '/v1/platform/operators'])
      expect(errOf(await w.http().get(path).set('Cookie', challenge))).toEqual({
        status: 401,
        code: 'PLATFORM_AUTH_REQUIRED',
      });
  });

  it('a platform role outside the matrix is refused (support issues no refund, finance edits no operator)', async () => {
    await touch();
    const refund = await w
      .http()
      .post(`/v1/platform/payments/${randomUUID()}/refunds`)
      .set(CSRF)
      .set('Cookie', cookies.platform_support)
      .set('Idempotency-Key', newKey())
      .send({ amount_halalas: 100, reason: 'اختبار' });
    expect(errOf(refund)).toEqual({ status: 403, code: 'PERMISSION_DENIED' });
    const suspend = await w
      .http()
      .post(`/v1/platform/operators/${ORG}/suspend`)
      .set(CSRF)
      .set('Cookie', cookies.platform_finance)
      .set('Idempotency-Key', newKey())
      .send({ reason: 'اختبار' });
    expect(errOf(suspend)).toEqual({ status: 403, code: 'PERMISSION_DENIED' });
  });

  it('a cookie-authenticated platform command without the CSRF headers is refused before anything runs', async () => {
    await touch();
    const r = await w
      .http()
      .post('/v1/platform/plans')
      .set('Cookie', cookies.platform_finance)
      .set('Idempotency-Key', newKey())
      .send({ venue_id: RMS, name_ar: 'خطة', vehicles_included: 1, monthly_price_halalas: 100 });
    expect(errOf(r)).toEqual({ status: 403, code: 'PERMISSION_DENIED' });
    expect(r.body.error.details).toMatchObject({ reason: 'csrf' });
  });
});

// ---------------------------------------------------------------------------------------------
// T-03 the sign-in code: brute force, limits, enumeration
// ---------------------------------------------------------------------------------------------

describe('T-03 — the WhatsApp sign-in code (C-02/C-03)', () => {
  let deviceSeq = 0;
  const device = () => ({ device_id: `sec-device-${String(++deviceSeq).padStart(4, '0')}`, platform: 'ios' });
  const requestCode = (phone: string, dev = device()) =>
    w
      .http()
      .post(CUSTOMER_ROUTES.otpRequest.path)
      .send({ phone_e164: phone, ...dev });
  const verify = (phone: string, code: string, dev = device()) =>
    w
      .http()
      .post(CUSTOMER_ROUTES.otpVerify.path)
      .send({ phone_e164: phone, code, ...dev });
  async function codeFor(phone: string): Promise<string> {
    await w.drain();
    const last = (await w.sim.client.listMessages({ to: phone }))
      .filter((m) => m.templateName === WA_CUSTOMER_OTP_TEMPLATE_NAME)
      .sort((x, y) => x.seq - y.seq)
      .at(-1);
    if (!last) throw new Error('no code');
    secretsSeen.add(last.bodyParams[0]!);
    return last.bodyParams[0]!;
  }
  const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

  it('the auth routes are in the per-address auth class (07 §1.9)', () => {
    for (const path of ['/v1/customer/auth/otp', '/v1/customer/auth/verify', '/v1/customer/auth/refresh'])
      expect(rateLimitClassOf('POST', path), path).toBe('auth');
  });

  it('answers the same for a known and an unknown number: no account enumeration', async () => {
    const known = await account();
    const unknown = nextPhone();
    const rk = await requestCode(known.phone);
    const ru = await requestCode(unknown);
    expect([rk.status, ru.status]).toEqual([200, 200]);
    expect(Object.keys(rk.body.data).sort()).toEqual(Object.keys(ru.body.data).sort());
    expect(rk.body.data.attempts_left).toBe(ru.body.data.attempts_left);
    expect(JSON.stringify(rk.body)).not.toContain(known.phone);
    const ck = await codeFor(known.phone);
    const cu = await codeFor(unknown);
    const vk = await verify(known.phone, wrong(ck));
    const vu = await verify(unknown, wrong(cu));
    expect(errOf(vk).code).toBe('CUSTOMER_OTP_INVALID');
    expect(errOf(vu)).toEqual(errOf(vk));
    expect(vk.body.error.details).toEqual(vu.body.error.details);
    // the code never travels back in an answer
    expect(JSON.stringify([rk.body, ru.body, vk.body, vu.body])).not.toMatch(new RegExp(`${ck}|${cu}`));
  });

  it('brute force: five wrong codes lock 15 min; the third lock within a day lasts 24 h (DEC-560)', async () => {
    const phone = nextPhone();
    const locks: string[] = [];
    for (let round = 1; round <= 3; round++) {
      const r = await requestCode(phone);
      expect(r.status, `round ${round} ${JSON.stringify(r.body)}`).toBe(200);
      const code = await codeFor(phone);
      let last: any;
      for (let i = 0; i < 5; i++) last = await verify(phone, wrong(code));
      expect(errOf(last).code).toBe('CUSTOMER_OTP_LOCKED');
      locks.push(last.body.error.details.locked_until);
      // even the right code is refused during the lock, and so is a new code
      expect(errOf(await verify(phone, code)).code).toBe('CUSTOMER_OTP_LOCKED');
      expect(errOf(await requestCode(phone)).code).toBe('CUSTOMER_OTP_LOCKED');
      const until = Date.parse(last.body.error.details.locked_until);
      const expected =
        round < 3 ? CUSTOMER_OTP_LOCK_MINUTES * 60_000 : CUSTOMER_OTP_DAILY_LOCK_HOURS * 3_600_000;
      expect(until - w.clock.now().getTime(), `round ${round}`).toBe(expected);
      if (round < 3) w.clock.set(new Date(until + 1000));
    }
    // 15 guesses in total; the number stays locked until a day after the third lock
    w.clock.advance(23 * 3_600_000);
    expect(errOf(await requestCode(phone)).code).toBe('CUSTOMER_OTP_LOCKED');
    w.clock.advance(3_600_000 + 1000);
    expect((await requestCode(phone)).status).toBe(200);
    const audits = await w.db.query(
      `SELECT count(*)::int AS n FROM customer_audit_log WHERE action = 'customer.auth.otp_failed'
          AND metadata->>'phone_masked' = $1`,
      [`05${'•'.repeat(5)}${phone.slice(-3)}`],
    );
    expect(audits.rows[0].n).toBe(12); // 4 failures + the locking one, three times (the lock is its own action)
  });

  it('codes per number per hour are limited, whatever device asks (RATE_LIMITED scope phone)', async () => {
    const phone = nextPhone();
    for (let i = 0; i < w.env.CUSTOMER_OTP_PER_PHONE_PER_HOUR; i++) {
      expect((await requestCode(phone)).status, `code ${i + 1}`).toBe(200);
      w.clock.advance(61_000); // past the resend wait
    }
    const r = await requestCode(phone);
    expect(errOf(r)).toEqual({ status: 429, code: 'RATE_LIMITED' });
    expect(r.body.error.details.scope).toBe('phone');
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    w.clock.advance(3_600_000);
  });

  it('a resend inside 60 s is refused; the new code keeps the attempts already used (C-03)', async () => {
    const phone = nextPhone();
    await requestCode(phone);
    const code = await codeFor(phone);
    await verify(phone, wrong(code));
    await verify(phone, wrong(code));
    expect(errOf(await requestCode(phone))).toEqual({ status: 429, code: 'RATE_LIMITED' });
    w.clock.advance(61_000);
    const again = await requestCode(phone);
    expect(again.body.data.attempts_left).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------
// T-04 webhooks: signatures, replays, forged content
// ---------------------------------------------------------------------------------------------

describe('T-04 — webhooks: Moyasar and the e-invoicing provider', () => {
  const moyasar = (body: unknown) =>
    w
      .http()
      .post('/webhooks/payments/moyasar')
      .set('Content-Type', 'application/json')
      .send(typeof body === 'string' ? body : JSON.stringify(body));
  const events = async () =>
    (await w.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM gateway_webhook_events`)).rows[0]!.n;

  it('no secret, a wrong secret or a non-JSON body: refused, nothing stored', async () => {
    const before = await events();
    const fake = { id: randomUUID(), type: 'payment_paid', data: { id: randomUUID(), status: 'paid' } };
    for (const body of [
      fake,
      { ...fake, secret_token: 'wrong' },
      { ...fake, secret_token: '' },
      'not json',
    ]) {
      const r = await moyasar(body);
      expect(r.status, JSON.stringify(r.body)).toBe(401);
      expect(r.body.error.code).toBe('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
    }
    expect(await events()).toBe(before);
  });

  it('a replayed delivery is stored once and processed once; a forged «paid» with the right secret is checked at the gateway', async () => {
    const a = await account();
    const v = await vehicle(a);
    const t = await appTicket(a, v);
    // a 3-D Secure payment the customer never completes
    const pay = await csend(a, 'post', `/v1/customer/visits/${t.ticketId}/pay`, {
      source: { type: 'token', token: await token(TEST_CARDS.threeDs) },
    });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    expect(pay.body.data.status).toBe('initiated');
    await settle();
    const gp = (
      await w.db.query<{ gateway_payment_id: string }>(
        `SELECT gateway_payment_id FROM online_payments WHERE id = $1`,
        [pay.body.data.payment_id],
      )
    ).rows[0]!.gateway_payment_id;
    // an attacker who learned the shared secret sends «paid» for it: stored, but the gateway's own record decides
    const forged = {
      id: randomUUID(),
      type: 'payment_paid',
      created_at: w.clock.now().toISOString(),
      secret_token: DEFAULT_WEBHOOK_SECRET,
      live: false,
      data: { id: gp, status: 'paid', amount: FEE, currency: 'SAR' },
    };
    expect((await moyasar(forged)).status).toBe(200);
    await settle();
    const row = await w.db.query(`SELECT status FROM online_payments WHERE id = $1`, [
      pay.body.data.payment_id,
    ]);
    expect(row.rows[0].status).toBe('initiated');
    const ticket = await w.db.query(`SELECT payment_status, entitlement FROM tickets WHERE id = $1`, [
      t.ticketId,
    ]);
    expect(ticket.rows[0]).toMatchObject({ payment_status: 'due', entitlement: 'none' });
    // the same body again (a replay): one row, processed once
    expect((await moyasar(forged)).status).toBe(200);
    await settle();
    const stored = await w.db.query(
      `SELECT count(*)::int AS n, count(processed_at)::int AS done FROM gateway_webhook_events WHERE event_id = $1`,
      [forged.id],
    );
    expect(stored.rows[0]).toEqual({ n: 1, done: 1 });
    // a real paid event replayed by the gateway: still one paid transition, one invoice
    await sim.client.complete3ds(gp, 'success' as never);
    await settle();
    const deliveries = (await sim.client.deliveries()).filter(
      (d: any) => d.paymentId === gp || d.payment_id === gp,
    );
    for (const d of deliveries) await sim.client.replay((d as any).eventId ?? (d as any).event_id);
    await settle();
    const paid = await w.db.query(
      `SELECT count(*)::int AS n FROM customer_audit_log WHERE entity_id = $1 AND action = 'online_payment.paid'`,
      [pay.body.data.payment_id],
    );
    expect(paid.rows[0].n).toBe(1);
    const invoices = await w.db.query(
      `SELECT count(*)::int AS n FROM invoices WHERE online_payment_id = $1`,
      [pay.body.data.payment_id],
    );
    expect(invoices.rows[0].n).toBe(1);
  });

  it('e-invoicing: no, a wrong or a foreign signature is refused; a replayed or late callback changes nothing', async () => {
    const inv = (
      await w.db.query<{ id: string; zatca_uuid: string; zatca_status: string }>(
        `SELECT id, zatca_uuid, zatca_status FROM invoices ORDER BY icv LIMIT 1`,
      )
    ).rows[0]!;
    const send = (body: string, sig?: string) => {
      const r = w.http().post('/webhooks/einvoicing').set('Content-Type', 'application/json');
      return (sig ? r.set('X-Einvoice-Signature', sig) : r).send(body);
    };
    const body = JSON.stringify({ invoice_uuid: inv.zatca_uuid, status: 'rejected', codes: [] });
    for (const sig of [
      undefined,
      'sha256=00',
      SimulatorEInvoicingProvider.sign(body, 'another-secret'),
      SimulatorEInvoicingProvider.sign(`${body} `, CALLBACK_SECRET),
      SimulatorEInvoicingProvider.sign(body, CALLBACK_SECRET).toUpperCase(),
    ]) {
      const r = await send(body, sig);
      expect(errOf(r), String(sig)).toEqual({ status: 401, code: 'EINVOICE_WEBHOOK_SIGNATURE_INVALID' });
    }
    // the provider already answered (the submit job): a signed late «rejected» is recorded and ignored
    await settle();
    const status = (await w.db.query(`SELECT zatca_status FROM invoices WHERE id = $1`, [inv.id])).rows[0]
      .zatca_status;
    expect(status).not.toBe('pending');
    for (let i = 0; i < 2; i++)
      expect((await send(body, SimulatorEInvoicingProvider.sign(body, CALLBACK_SECRET))).status).toBe(200);
    expect(
      (await w.db.query(`SELECT zatca_status FROM invoices WHERE id = $1`, [inv.id])).rows[0].zatca_status,
    ).toBe(status);
    const ignored = await w.db.query(
      `SELECT outcome FROM invoice_provider_events WHERE invoice_id = $1 AND kind = 'callback'`,
      [inv.id],
    );
    expect(ignored.rows.map((r) => r.outcome)).toEqual(['ignored', 'ignored']);
  });
});

// ---------------------------------------------------------------------------------------------
// T-05 mass assignment, T-06 price tampering
// ---------------------------------------------------------------------------------------------

describe('T-05 / T-06 — mass assignment and price tampering', () => {
  it('fields the server owns are refused in every customer body (strict schemas)', async () => {
    const a = await account();
    const v = await vehicle(a);
    const t = await appTicket(a, v);
    const tries: Array<[method: 'post' | 'patch' | 'put', path: string, body: unknown]> = [
      [
        'patch',
        CUSTOMER_ROUTES.mePatch.path,
        { display_name: 'س', status: 'active', phone_e164: '+966500000001' },
      ],
      ['patch', CUSTOMER_ROUTES.mePatch.path, { locale: 'ar', id: randomUUID() }],
      [
        'post',
        CUSTOMER_ROUTES.vehicleCreate.path,
        { plate: { country: 'SA', digits: '9911', letters_ar: 'ب ح د' }, account_id: randomUUID() },
      ],
      [
        'post',
        `/v1/customer/visits/${t.ticketId}/pay`,
        { source: { type: 'token', token: await token() }, amount_halalas: 100 },
      ],
      [
        'post',
        `/v1/customer/visits/${t.ticketId}/pay`,
        { source: { type: 'token', token: await token(), amount: 100 } },
      ],
      [
        'post',
        CUSTOMER_ROUTES.subscribe.path,
        {
          plan_id: planId,
          billing_cycle: 'monthly',
          vehicle_ids: [v],
          source: { type: 'token', token: await token() },
          save_card: true,
          card_on_file_version: CARD_VERSION,
          price_halalas: 100,
        },
      ],
      [
        'post',
        CUSTOMER_ROUTES.paymentMethodCreate.path,
        { token: await token(), card_on_file_version: CARD_VERSION, last4: '0000', brand: 'mada' },
      ],
      ['post', `/v1/customer/visits/${t.ticketId}/rating`, { stars: 5, account_id: randomUUID() }],
    ];
    for (const [method, path, body] of tries) {
      const r = await csend(a, method, path, body);
      expect(errOf(r), `${method} ${path} ${JSON.stringify(body)} → ${JSON.stringify(r.body)}`).toEqual({
        status: 422,
        code: 'VALIDATION_FAILED',
      });
    }
    // a raw card number is never accepted as a token
    const pan = await csend(a, 'post', `/v1/customer/visits/${t.ticketId}/pay`, {
      source: { type: 'token', token: TEST_CARDS.success.number },
    });
    expect(errOf(pan)).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    await settle();
    expect(
      (await w.db.query(`SELECT count(*)::int AS n FROM online_payments WHERE account_id = $1`, [a.id]))
        .rows[0].n,
    ).toBe(0);
    const me = await cget(a, CUSTOMER_ROUTES.me.path);
    expect(me.body.data).toMatchObject({ phone_e164: a.phone });
  });

  it('the gateway is charged the ticket’s fee and the plan’s price, whatever the app sends', async () => {
    const a = await account();
    const v = await vehicle(a);
    const t = await appTicket(a, v);
    const pay = await csend(a, 'post', `/v1/customer/visits/${t.ticketId}/pay`, {
      source: { type: 'token', token: await token() },
    });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    expect(pay.body.data.amount_halalas).toBe(FEE);
    const sub = await csend(a, 'post', CUSTOMER_ROUTES.subscribe.path, {
      plan_id: planId,
      billing_cycle: 'monthly',
      vehicle_ids: [await vehicle(a)],
      source: { type: 'token', token: await token() },
      save_card: true,
      card_on_file_version: CARD_VERSION,
    });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    await settle();
    const rows = (
      await w.db.query<{ purpose: string; amount: number; gateway_payment_id: string }>(
        `SELECT purpose, amount_halalas::int AS amount, gateway_payment_id FROM online_payments
          WHERE account_id = $1 ORDER BY created_at`,
        [a.id],
      )
    ).rows;
    expect(rows.map((r) => [r.purpose, r.amount])).toEqual([
      ['visit', FEE],
      ['subscription', MONTHLY],
    ]);
    for (const r of rows) expect((await sim.client.payment(r.gateway_payment_id)).amount).toBe(r.amount);
    // the same visit cannot be paid twice (the second command is refused, nothing more is charged)
    const twice = await csend(a, 'post', `/v1/customer/visits/${t.ticketId}/pay`, {
      source: { type: 'token', token: await token() },
    });
    expect(errOf(twice).code).toBe('PAYMENT_ALREADY_RECORDED');
  });
});

// ---------------------------------------------------------------------------------------------
// T-07 the handover code and T-08 personal data in logs
// ---------------------------------------------------------------------------------------------

describe('T-07 / T-08 — the handover code and full phone numbers never leak', () => {
  it('the code reaches the account’s own C-12 only: not staff reads, not push payloads, not any table in clear', async () => {
    const a = await account();
    const v = await vehicle(a);
    const t = await appTicket(a, v);
    await w.db.query(`UPDATE tickets SET payment_status = 'not_required', fee_halalas = 0 WHERE id = $1`, [
      t.ticketId,
    ]);
    ok(await csend(a, 'post', `/v1/customer/visits/${t.ticketId}/request`), 201);
    const offer = (
      await w.db.query<{ id: string; task_id: string; user_id: string }>(
        `SELECT o.id, o.task_id, r.user_id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id
           JOIN tasks k ON k.id = o.task_id WHERE k.ticket_id = $1 AND o.status = 'active'`,
        [t.ticketId],
      )
    ).rows[0]!;
    ok(await accept(w, offer.user_id, offer.id));
    ok(await keyPickup(w, offer.user_id, offer.task_id, t.slotId));
    ok(await startRetrieval(w, offer.user_id, offer.task_id));
    ok(await markReady(w, offer.user_id, offer.task_id));
    await w.drain();
    const shown = await cget(a, `/v1/customer/visits/${t.ticketId}/handover-code`);
    expect(shown.status, JSON.stringify(shown.body)).toBe(200);
    const code = String(shown.body.data.code);
    expect(code).toMatch(/^[0-9]{4,8}$/);
    secretsSeen.add(code);
    expect(shown.headers['cache-control']).toContain('no-store');
    // the staff side: the driver's and the supervisor's reads of the ticket, the board
    const staffReads = [
      await w.get(`/v1/tickets/${t.ticketId}`, offer.user_id),
      await w.get(`/v1/tickets/${t.ticketId}`, 'SUP-R'),
      await w.get(`/v1/tickets/${t.ticketId}/timeline`, 'SUP-R'),
      await w.get(`/v1/me/home`, offer.user_id),
    ];
    for (const r of staffReads) expect(JSON.stringify(r.body)).not.toContain(`"${code}"`);
    // the customer's other reads
    const detail = await cget(a, `/v1/customer/visits/${t.ticketId}`);
    expect(JSON.stringify(detail.body)).not.toContain(`"${code}"`);
    // push payloads and every table (the only copy is claim_codes.code_ciphertext, encrypted)
    const pushes = await w.db.query(
      `SELECT to_jsonb(p)::text AS x FROM customer_push_messages p WHERE account_id = $1`,
      [a.id],
    );
    for (const p of pushes.rows) expect(p.x).not.toMatch(new RegExp(`(^|[^0-9])${code}([^0-9]|$)`));
    expect(await tablesContaining(w, code, new RegExp(`"${code}"|[:=] ?${code}\\b`))).toEqual([]);
  });

  it('no log line of the api or the worker holds a full phone number, a sign-in code or a handover code', async () => {
    await settle();
    expect(apiLog.length).toBeGreaterThan(50);
    expect(workerLog.length).toBeGreaterThan(5);
    const lines = [...apiLog, ...workerLog];
    const phones = lines.filter((l) => /(\+|\b)9665[0-9]{8}\b|\b05[0-9]{8}\b/.test(l));
    expect(phones.slice(0, 3)).toEqual([]);
    // a code standing alone inside a JSON string (ISO times removed: a 4-digit code would match a year)
    const cleaned = lines.map((l) => l.replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/g, ''));
    for (const s of secretsSeen) {
      const re = new RegExp(`"[^"]*(?<![0-9A-Za-z])${s}(?![0-9A-Za-z])[^"]*"`);
      const hits = cleaned.filter((l) => re.test(l));
      expect(hits.slice(0, 2), `secret ${s.length} digits`).toEqual([]);
    }
    expect(secretsSeen.size).toBeGreaterThan(3);
  });
});

// ---------------------------------------------------------------------------------------------
// T-09 the status webhooks of a sign-in code (found by the V2 load profile, DEC-564)
// ---------------------------------------------------------------------------------------------

describe('T-09 — the statuses of a sign-in code are known messages, not orphans (DEC-564)', () => {
  it('sent/delivered/read are acknowledged at once; a failed status marks the delivery failed', async () => {
    const phone = nextPhone();
    const sent = await w
      .http()
      .post(CUSTOMER_ROUTES.otpRequest.path)
      .send({ phone_e164: phone, device_id: 'sec-status-device-01', platform: 'android' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await w.drain();
    const ch = (
      await w.db.query<{ id: string; wa_message_id: string; delivery_status: string }>(
        `SELECT id, wa_message_id, delivery_status FROM customer_otp_challenges WHERE phone_e164 = $1`,
        [phone],
      )
    ).rows[0]!;
    expect(ch).toMatchObject({ delivery_status: 'sent' });
    expect(ch.wa_message_id).toBeTruthy();
    const jobs = async () =>
      (
        await w.db.query<{ status: string; attempts: number }>(
          `SELECT o.status, o.attempts FROM outbox_events o
             JOIN whatsapp_inbound_events e ON o.payload->>'inbound_event_id' = e.id::text
            WHERE o.type = 'job.wa_process_inbound' AND e.raw_body LIKE $1`,
          [`%${ch.wa_message_id}%`],
        )
      ).rows;
    await w.sim.client.emitStatuses({
      wamid: ch.wa_message_id,
      statuses: ['sent', 'delivered', 'read'],
      timestamp: w.ts(),
    });
    await w.drain();
    const done = await jobs();
    expect(done.length).toBeGreaterThan(0);
    expect(
      done.every((j) => j.status === 'done' && j.attempts === 1),
      JSON.stringify(done),
    ).toBe(true);
    await w.sim.client.emitStatuses({
      wamid: ch.wa_message_id,
      statuses: ['failed'],
      errorCode: 131026,
      timestamp: w.ts(),
    });
    await w.drain();
    const after = (
      await w.db.query(
        `SELECT delivery_status, delivery_error_code FROM customer_otp_challenges WHERE id = $1`,
        [ch.id],
      )
    ).rows[0];
    expect(after).toEqual({ delivery_status: 'failed', delivery_error_code: '131026' });
    expect((await jobs()).every((j) => j.status === 'done' && j.attempts === 1)).toBe(true);
  });
});
