import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  createLogger,
  issueSystemRefund,
  newCustomerToken,
  OutboxDispatcher,
  paymentById,
  PaymentsRuntime,
  paymentsOnlineJobs,
  sha256Hex,
} from '@point/server';
import { rooms, vatOfInclusive } from '@point/shared';
import {
  CUSTOMER_ROUTES,
  CustomerPaymentMethodListSchema,
  CustomerVisitPaymentSchema,
  successEnvelopeSchema,
} from '@point/shared/customer';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SECRET_KEY,
  DEFAULT_WEBHOOK_SECRET,
  TEST_CARDS,
  startPaymentSimulator,
  type RunningPaymentSimulator,
} from '../../../tools/payment-simulator/src/index.js';
import { captureRealtime } from './dispatch-s4-fixtures.js';
import {
  accept,
  createDrivers,
  EVT_R1,
  EVT_R2,
  keyPickup,
  markReady,
  ok,
  parkedPaperTicket,
  requestRetrieval,
  startDuty,
  startRetrieval,
} from './dispatch-fixtures.js';
import { createTestApp, newKey, SEED_IDS, type TestApp } from './harness.js';
import { CASH, deliver, FEE, pay as cashPay, type ReadyTicket } from './payments-fixtures.js';

/**
 * V2-022 / V2-023 (docs/v2/04 §2, §3; O-03; DEC-521 … DEC-525) on the payment simulator: paying a visit in the app
 * (3-D Secure or not), declines, replays, other accounts, entitlements, the one-payment-per-ticket rule in both
 * commands and in the database, the extended handover gate, the automatic refund of a late double payment, the VAT,
 * and the saved cards (C-18) with their consent and their tokens deleted at the gateway.
 */

const ORG = SEED_IDS.org;
let sim: RunningPaymentSimulator;
let t: TestApp;
let dispatcher: OutboxDispatcher;
let phoneSeq = 0;
const nextPhone = () => `+9665${String(71000000 + ++phoneSeq)}`;
const CARD_VERSION = '2026-11-01';

interface Account {
  id: string;
  phone: string;
  access: string;
}

async function account(): Promise<Account> {
  const phone = nextPhone();
  const a = await t.db.query<{ id: string }>(
    `INSERT INTO customer_accounts (phone_e164, display_name) VALUES ($1, 'نورة') RETURNING id`,
    [phone],
  );
  const id = a.rows[0]!.id;
  const sid = randomUUID();
  const access = newCustomerToken('access', sid);
  await t.db.query(
    `INSERT INTO customer_account_sessions (id, account_id, device_id, platform, refresh_hash, access_hash,
            access_expires_at, refresh_expires_at, created_at)
     VALUES ($1, $2, $3, 'ios', $4, $5, $6::timestamptz + interval '1 day', $6::timestamptz + interval '60 days', $6)`,
    [sid, id, `device-${sid}`, sha256Hex(newCustomerToken('refresh', sid)), sha256Hex(access), t.clock.now()],
  );
  return { id, phone, access };
}

/** The operator's customers row of the account carries the link (DEC-504), as an app intake writes it. */
async function link(ticketId: string, a: Account) {
  const c = await t.db.query<{ id: string }>(
    `INSERT INTO customers (org_id, phone_e164, customer_account_id) VALUES ($1, $2, $3)
     ON CONFLICT (org_id, phone_e164) DO UPDATE SET customer_account_id = EXCLUDED.customer_account_id
     RETURNING id`,
    [ORG, a.phone, a.id],
  );
  await t.db.query(`UPDATE tickets SET customer_id = $2 WHERE id = $1`, [ticketId, c.rows[0]!.id]);
}

let driverPool: string[] = [];
async function driver(): Promise<string> {
  const [id] = await createDrivers(t.db, 1);
  ok(await startDuty(t, id!), 201);
  driverPool.push(id!);
  return id!;
}

/**
 * A paper ticket of `eventId` brought to `ready` (the S2 path of the handover), whichever on-duty driver the
 * retrieval was offered to (drivers of earlier tests stay on duty); `driver` is the one at the handover.
 */
async function readyTicket(
  _t: TestApp,
  parker: string,
  opts: { eventId?: string } = {},
): Promise<ReadyTicket & { driver: string }> {
  const p = await parkedPaperTicket(t, parker, { eventId: opts.eventId ?? EVT_R2 });
  const r = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
  const offer = (
    await t.db.query<{ id: string; user_id: string }>(
      `SELECT o.id, r.user_id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id
        WHERE o.task_id = $1 AND o.status = 'active' ORDER BY r.user_id LIMIT 1`,
      [r.task.id],
    )
  ).rows[0]!;
  ok(await accept(t, offer.user_id, offer.id));
  ok(await keyPickup(t, offer.user_id, r.task.id, p.slotId));
  ok(await startRetrieval(t, offer.user_id, r.task.id));
  const ready = ok(await markReady(t, offer.user_id, r.task.id));
  return {
    ticketId: p.ticketId,
    displayNumber: p.displayNumber,
    serial: p.serial,
    spotId: p.spotId,
    slotId: p.slotId,
    retrieveTaskId: r.task.id,
    cycleId: r.cycle.id,
    version: ready.ticket.version,
    driver: offer.user_id,
  };
}

/** A parked per_vehicle visit of the account (EVT-R2, 2000 halalas VAT included). */
async function parkedVisit(a: Account, eventId = EVT_R2) {
  const p = await parkedPaperTicket(t, await driver(), { eventId });
  await link(p.ticketId, a);
  return p;
}

const bearer = (a: Account) => ({ Authorization: `Bearer ${a.access}` });
const payVisit = (a: Account, ticketId: string, body: unknown, key: string = newKey()) =>
  t
    .http()
    .post(CUSTOMER_ROUTES.visitPay.path.replace('{ticketId}', ticketId))
    .set(bearer(a))
    .set('Idempotency-Key', key)
    .send(body as object);
const getPayment = (a: Account, id: string) => t.http().get(`/v1/customer/payments/${id}`).set(bearer(a));
const cards = async (a: Account) => {
  const r = await t.http().get('/v1/customer/payment-methods').set(bearer(a));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return successEnvelopeSchema(CustomerPaymentMethodListSchema).parse(r.body).data.items;
};
const cardCmd = (
  a: Account,
  method: 'post' | 'patch' | 'delete',
  path: string,
  body?: unknown,
  key = newKey(),
) => {
  const server = t.http();
  const req =
    method === 'post' ? server.post(path) : method === 'patch' ? server.patch(path) : server.delete(path);
  return req
    .set(bearer(a))
    .set('Idempotency-Key', key)
    .send((body ?? {}) as object);
};

const paid = (r: { status: number; body: any }, status = 201) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return successEnvelopeSchema(CustomerVisitPaymentSchema).parse(r.body).data;
};
const errOf = (r: { status: number; body: any }) => ({
  status: r.status,
  code: r.body?.error?.code,
  details: r.body?.error?.details,
});
const tokenOf = (card: { number: string }) => sim.client.tokenize(card.number);
const settle = async () => {
  await sim.client.flush();
  for (let i = 0; i < 6; i++) if ((await dispatcher.drain(200)) === 0) break;
  await sim.client.flush();
  for (let i = 0; i < 6; i++) if ((await dispatcher.drain(200)) === 0) break;
};
const ticketOf = async (id: string) =>
  (
    await t.db.query(
      `SELECT status, payment_status, entitlement, version, fee_halalas::int AS fee FROM tickets WHERE id = $1`,
      [id],
    )
  ).rows[0];
const onlineOf = (ticketId: string) =>
  t.db.query<{ id: string; status: string; refunded_halalas: number }>(
    `SELECT id, status, refunded_halalas::int AS refunded_halalas FROM online_payments WHERE ticket_id = $1
      ORDER BY created_at, id`,
    [ticketId],
  );
const timeline = async (ticketId: string) =>
  (
    await t.db.query<{ type: string }>(`SELECT type FROM ticket_events WHERE ticket_id = $1 ORDER BY id`, [
      ticketId,
    ])
  ).rows.map((r) => r.type);
const outboxTypes = async (ticketId: string) =>
  (
    await t.db.query<{ type: string }>(
      `SELECT type FROM outbox_events WHERE aggregate_id = $1 AND type LIKE 'payment.%' ORDER BY seq`,
      [ticketId],
    )
  ).rows.map((r) => r.type);

beforeAll(async () => {
  process.env.MOYASAR_SECRET_KEY = DEFAULT_SECRET_KEY;
  process.env.MOYASAR_WEBHOOK_SECRET = DEFAULT_WEBHOOK_SECRET;
  const clockStart = new Date('2026-10-27T16:00:00.000Z');
  let simNow = () => clockStart;
  sim = await startPaymentSimulator({ env: {}, now: () => simNow() });
  t = await createTestApp({ env: { MOYASAR_BASE_URL: sim.url, MOYASAR_HTTP_TIMEOUT_MS: '3000' } });
  simNow = () => t.clock.now();
  (t.db.config as { lockTimeoutMs?: number }).lockTimeoutMs = 20000;
  (t.app.getHttpServer() as { setMaxListeners(n: number): unknown }).setMaxListeners(64);
  await t.app.listen(0, '127.0.0.1');
  const apiUrl = `http://127.0.0.1:${(t.app.getHttpServer() as { address(): AddressInfo }).address().port}`;
  await sim.client.configure({ webhookUrl: `${apiUrl}/webhooks/payments/moyasar`, autoWebhooks: true });
  const logger = createLogger({ level: 'silent' });
  const rt = new PaymentsRuntime({ env: t.env, logger });
  dispatcher = new OutboxDispatcher(t.db, t.clock, logger, { workerId: 'visit-pay-worker', batchSize: 50 });
  for (const h of paymentsOnlineJobs({ runtime: rt })) dispatcher.register(h);
}, 120_000);
afterAll(async () => {
  await sim?.close();
  await t?.close();
});
beforeEach(() => {
  driverPool = [];
});

describe('V2-022 — POST /v1/customer/visits/{ticketId}/pay (C-12 → C-10)', () => {
  it('a frictionless card: paid at once, the ticket collected «مدفوع في التطبيق», events, audit and the receipt', async () => {
    const a = await account();
    const p = await parkedVisit(a);
    const before = await ticketOf(p.ticketId);
    const r = await payVisit(a, p.ticketId, {
      source: { type: 'token', token: await tokenOf(TEST_CARDS.success) },
    });
    const pay = paid(r);
    expect(pay).toMatchObject({
      ticket_id: p.ticketId,
      status: 'paid',
      amount_halalas: FEE,
      vat_halalas: vatOfInclusive(FEE),
      currency: 'SAR',
      card_last4: '1111',
      transaction_url: null,
      callback_url: t.env.CUSTOMER_PAY_CALLBACK_URL,
    });
    // VAT apart on the receipt (C-17 data, nothing stored for it): 2000 = 1739 + 261
    expect(pay.receipt).toMatchObject({
      payment_id: pay.payment_id,
      amount_halalas: 2000,
      net_halalas: 1739,
      vat_halalas: 261,
      vat_rate_bp: 1500,
      seller_name_ar: t.env.BRAND_CUSTOMER_NAME_AR,
      description: 'visit',
    });
    expect(await ticketOf(p.ticketId)).toMatchObject({
      payment_status: 'collected',
      entitlement: 'app_paid',
      version: before.version + 1,
    });
    expect(await timeline(p.ticketId)).toContain('payment.online_paid');
    expect(await outboxTypes(p.ticketId)).toEqual(['payment.online_paid']);
    // the operator's audit names the payment (POINT collected, no staff member)
    const audit = await t.db.query(
      `SELECT action FROM audit_log WHERE entity_id = $1 AND org_id = $2 ORDER BY id`,
      [pay.payment_id, ORG],
    );
    expect(audit.rows.map((x) => x.action)).toEqual(['online_payment.initiated', 'online_payment.paid']);
    const caudit = await t.db.query(
      `SELECT action FROM customer_audit_log WHERE account_id = $1 AND entity_id = $2 ORDER BY id`,
      [a.id, pay.payment_id],
    );
    expect(caudit.rows.map((x) => x.action)).toEqual([
      'online_payment.initiated',
      'online_payment.paid',
      'customer.visit.pay',
    ]);
    // the poll reads the same
    expect(paid(await getPayment(a, pay.payment_id), 200)).toMatchObject({ status: 'paid' });
  });

  it('3-D Secure: initiated with the page; the return changes nothing; the webhook (re-fetched) pays it', async () => {
    const a = await account();
    const p = await parkedVisit(a);
    const r = paid(
      await payVisit(a, p.ticketId, { source: { type: 'token', token: await tokenOf(TEST_CARDS.threeDs) } }),
    );
    expect(r.status).toBe('initiated');
    expect(r.transaction_url).toMatch(/\/sim\/3ds\//);
    expect((await ticketOf(p.ticketId)).payment_status).toBe('due');
    const gp = (await paymentById(t.db, r.payment_id))!.gateway_payment_id!;
    await sim.client.complete3ds(gp, 'success');
    // before the worker ran nothing changed (the customer's return is not a signal)
    expect(paid(await getPayment(a, r.payment_id), 200).status).toBe('initiated');
    await settle();
    expect(paid(await getPayment(a, r.payment_id), 200)).toMatchObject({ status: 'paid' });
    expect(await ticketOf(p.ticketId)).toMatchObject({
      payment_status: 'collected',
      entitlement: 'app_paid',
    });
    // a second payment of the visit: PAYMENT_ALREADY_RECORDED with the online payment
    const again = await payVisit(a, p.ticketId, {
      source: { type: 'token', token: await tokenOf(TEST_CARDS.success) },
    });
    expect(errOf(again)).toMatchObject({
      status: 409,
      code: 'PAYMENT_ALREADY_RECORDED',
      details: { online_payment_id: r.payment_id, method: 'app' },
    });
  });

  it('a decline is PAYMENT_FAILED after failed is saved; the key replays it; a new card pays', async () => {
    const a = await account();
    const p = await parkedVisit(a);
    const key = newKey();
    const body = { source: { type: 'token', token: await tokenOf(TEST_CARDS.declined) } };
    const r = await payVisit(a, p.ticketId, body, key);
    expect(errOf(r)).toMatchObject({ status: 402, code: 'PAYMENT_FAILED' });
    const replay = await payVisit(a, p.ticketId, body, key);
    expect(errOf(replay)).toMatchObject({ status: 402, code: 'PAYMENT_FAILED' });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect((await onlineOf(p.ticketId)).rows.map((x) => x.status)).toEqual(['failed']);
    expect((await ticketOf(p.ticketId)).payment_status).toBe('due');
    const ok2 = paid(
      await payVisit(a, p.ticketId, { source: { type: 'token', token: await tokenOf(TEST_CARDS.success) } }),
    );
    expect(ok2.status).toBe('paid');
  });

  it('a replay with the same key answers the same payment and never charges twice (concurrent too)', async () => {
    const a = await account();
    const p = await parkedVisit(a);
    const key = newKey();
    const body = { source: { type: 'token', token: await tokenOf(TEST_CARDS.success) } };
    const [x, y] = await Promise.all([
      payVisit(a, p.ticketId, body, key),
      payVisit(a, p.ticketId, body, key),
    ]);
    const ids = [x, y].filter((r) => r.status === 201).map((r) => r.body.data.payment_id);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ids).size).toBe(1);
    const z = await payVisit(a, p.ticketId, body, key);
    expect(paid(z).payment_id).toBe(ids[0]);
    expect(z.headers['idempotent-replayed']).toBe('true');
    expect((await onlineOf(p.ticketId)).rows).toHaveLength(1);
    const atGateway = (await sim.client.payments()).filter((g) => g.metadata?.ticket_id === p.ticketId);
    expect(atGateway).toHaveLength(1);
  });

  it('another account’s visit and payment are RESOURCE_NOT_FOUND (no other account’s data reachable)', async () => {
    const a = await account();
    const b = await account();
    const p = await parkedVisit(a);
    const r = await payVisit(b, p.ticketId, {
      source: { type: 'token', token: await tokenOf(TEST_CARDS.success) },
    });
    expect(errOf(r)).toMatchObject({
      status: 404,
      code: 'RESOURCE_NOT_FOUND',
      details: { resource: 'visit' },
    });
    const mine = paid(
      await payVisit(a, p.ticketId, { source: { type: 'token', token: await tokenOf(TEST_CARDS.success) } }),
    );
    expect(errOf(await getPayment(b, mine.payment_id))).toMatchObject({
      status: 404,
      code: 'RESOURCE_NOT_FOUND',
    });
    // a ticket of nobody's account
    const loose = await parkedPaperTicket(t, await driver(), { eventId: EVT_R2 });
    expect(
      errOf(
        await payVisit(a, loose.ticketId, {
          source: { type: 'token', token: await tokenOf(TEST_CARDS.success) },
        }),
      ).code,
    ).toBe('RESOURCE_NOT_FOUND');
  });

  it('nothing to pay: an included event, a waived fee, a delivered or voided visit → VISIT_NOT_PAYABLE', async () => {
    const a = await account();
    const inc = await parkedVisit(a, EVT_R1);
    const body = async () => ({ source: { type: 'token', token: await tokenOf(TEST_CARDS.success) } });
    expect(errOf(await payVisit(a, inc.ticketId, await body()))).toMatchObject({
      status: 409,
      code: 'VISIT_NOT_PAYABLE',
      details: { reason: 'entitlement' },
    });
    const waived = await parkedVisit(a);
    ok(
      await t.command('post', `/v1/tickets/${waived.ticketId}/payment-waiver`, {
        as: 'SUP-R',
        body: { reason: 'ضيف المضيف' },
      }),
    );
    expect(errOf(await payVisit(a, waived.ticketId, await body())).details).toEqual({ reason: 'not_due' });
    const r = await readyTicket(t, await driver());
    const d = r.driver;
    await link(r.ticketId, a);
    ok(await deliver(t, d, r, CASH));
    expect(errOf(await payVisit(a, r.ticketId, await body())).details).toEqual({ reason: 'delivered' });
    const v = await parkedVisit(a);
    await t.db.query(
      `UPDATE tickets SET status = 'voided', voided_at = now(), void_reason = 'test', voided_by = $2 WHERE id = $1`,
      [v.ticketId, SEED_IDS.users['SUP-R']],
    );
    expect(errOf(await payVisit(a, v.ticketId, await body())).details).toEqual({ reason: 'voided' });
  });

  it('3-D Secure pending blocks a second payment for its window (PAYMENT_IN_PROGRESS), then not', async () => {
    const a = await account();
    const p = await parkedVisit(a);
    const first = paid(
      await payVisit(a, p.ticketId, { source: { type: 'token', token: await tokenOf(TEST_CARDS.threeDs) } }),
    );
    const second = await payVisit(a, p.ticketId, {
      source: { type: 'token', token: await tokenOf(TEST_CARDS.success) },
    });
    expect(errOf(second)).toMatchObject({
      status: 409,
      code: 'PAYMENT_IN_PROGRESS',
      details: { online_payment_id: first.payment_id },
    });
    expect(second.body.error.details.retry_after_s).toBeGreaterThan(0);
    const start = t.clock.now();
    try {
      t.clock.advance(t.env.VISIT_PAYMENT_PENDING_S * 1000 + 1000);
      const third = paid(
        await payVisit(a, p.ticketId, {
          source: { type: 'token', token: await tokenOf(TEST_CARDS.success) },
        }),
      );
      expect(third.status).toBe('paid');
      // the abandoned 3-D Secure payment completes after all: it is held and refunded in full (DEC-523)
      const gp = (await paymentById(t.db, first.payment_id))!.gateway_payment_id!;
      await sim.client.complete3ds(gp, 'success');
      await settle();
      const rows = (await onlineOf(p.ticketId)).rows;
      expect(rows.find((x) => x.id === first.payment_id)).toMatchObject({ status: 'refunded' });
      expect(rows.find((x) => x.id === third.payment_id)).toMatchObject({ status: 'paid' });
      const refund = await t.db.query(
        `SELECT kind, reason, status FROM refunds WHERE online_payment_id = $1`,
        [first.payment_id],
      );
      expect(refund.rows).toEqual([{ kind: 'system', reason: 'double_payment', status: 'succeeded' }]);
    } finally {
      t.clock.set(start);
    }
  });
});

describe('V2-022 — one payment per ticket (DEC-522)', () => {
  it('cash/POS first: the app refuses PAYMENT_ALREADY_RECORDED with the cash payment', async () => {
    const a = await account();
    const r = await readyTicket(t, await driver());
    const d = r.driver;
    await link(r.ticketId, a);
    const cash = ok(await cashPay(t, d, r.ticketId, CASH), 201);
    const res = await payVisit(a, r.ticketId, {
      source: { type: 'token', token: await tokenOf(TEST_CARDS.success) },
    });
    expect(errOf(res)).toMatchObject({
      status: 409,
      code: 'PAYMENT_ALREADY_RECORDED',
      details: { payment_id: cash.payment.id, method: 'cash' },
    });
  });

  it('online first: the driver’s collection is refused PAYMENT_ALREADY_RECORDED (separate and inline)', async () => {
    const a = await account();
    const r = await readyTicket(t, await driver());
    const d = r.driver;
    await link(r.ticketId, a);
    const p = paid(
      await payVisit(a, r.ticketId, { source: { type: 'token', token: await tokenOf(TEST_CARDS.success) } }),
    );
    for (const res of [await cashPay(t, d, r.ticketId, CASH), await deliver(t, d, r, CASH)])
      expect(errOf(res)).toMatchObject({
        status: 409,
        code: 'PAYMENT_ALREADY_RECORDED',
        details: { online_payment_id: p.payment_id, method: 'app' },
      });
    expect((await t.db.query(`SELECT 1 FROM payments WHERE ticket_id = $1`, [r.ticketId])).rowCount).toBe(0);
  });

  it('the database refuses a recorded cash payment next to a counting online one (uq_ticket_single_payment)', async () => {
    const a = await account();
    const r = await readyTicket(t, await driver());
    const d = r.driver;
    await link(r.ticketId, a);
    paid(
      await payVisit(a, r.ticketId, { source: { type: 'token', token: await tokenOf(TEST_CARDS.success) } }),
    );
    const tk = (await t.db.query(`SELECT * FROM tickets WHERE id = $1`, [r.ticketId])).rows[0];
    await expect(
      t.db.transaction((tx) =>
        tx.query(
          `INSERT INTO payments (org_id, venue_id, event_id, ticket_id, cycle_id, method, amount_halalas, collected_by)
           VALUES ($1, $2, $3, $4, $5, 'cash', $6, $7)`,
          [tk.org_id, tk.venue_id, tk.event_id, tk.id, r.cycleId, FEE, d],
        ),
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'uq_ticket_single_payment' });
  });

  it('cash while the online one waits for 3-D Secure, then it succeeds: refunded in full as a double payment', async () => {
    const a = await account();
    const r = await readyTicket(t, await driver());
    const d = r.driver;
    await link(r.ticketId, a);
    const p = paid(
      await payVisit(a, r.ticketId, { source: { type: 'token', token: await tokenOf(TEST_CARDS.threeDs) } }),
    );
    // initiated = unpaid: the driver collects and hands over
    ok(await deliver(t, d, r, CASH));
    await sim.client.complete3ds((await paymentById(t.db, p.payment_id))!.gateway_payment_id!, 'success');
    await settle();
    expect((await onlineOf(r.ticketId)).rows).toEqual([
      { id: p.payment_id, status: 'refunded', refunded_halalas: FEE },
    ]);
    expect(await ticketOf(r.ticketId)).toMatchObject({
      status: 'delivered',
      payment_status: 'collected',
      entitlement: 'none',
    });
    const refund = await t.db.query(
      `SELECT kind, reason, status, issued_by FROM refunds WHERE online_payment_id = $1`,
      [p.payment_id],
    );
    expect(refund.rows).toEqual([
      { kind: 'system', reason: 'double_payment', status: 'succeeded', issued_by: null },
    ]);
    const alert = await t.db.query(`SELECT severity, details FROM platform_alerts WHERE dedupe_key = $1`, [
      `payment_double:${p.payment_id}`,
    ]);
    expect(alert.rows[0]).toMatchObject({ severity: 'warning', details: { reason: 'double_payment' } });
  });

  it('races: cash and online at the same moment, both orders, never two counting payments', async () => {
    for (let i = 0; i < 6; i++) {
      const a = await account();
      const r = await readyTicket(t, await driver());
      const d = r.driver;
      await link(r.ticketId, a);
      const token = await tokenOf(TEST_CARDS.success);
      const calls = [
        () => cashPay(t, d, r.ticketId, CASH),
        () => payVisit(a, r.ticketId, { source: { type: 'token', token } }),
      ];
      if (i % 2) calls.reverse();
      const res = await Promise.all(calls.map((c) => c()));
      await settle();
      const cash = (
        await t.db.query(`SELECT 1 FROM payments WHERE ticket_id = $1 AND status = 'recorded'`, [r.ticketId])
      ).rowCount;
      const online = (await onlineOf(r.ticketId)).rows;
      const counting = online.filter((o) => o.status === 'paid' || o.status === 'partially_refunded');
      const tk = await ticketOf(r.ticketId);
      expect(tk.payment_status).toBe('collected');
      // exactly one counts: the cash, or the online one (a late online success is given back)
      expect((cash ?? 0) + counting.length).toBe(1);
      if (cash) expect(tk.entitlement).toBe('none');
      else expect(tk.entitlement).toBe('app_paid');
      for (const x of res) expect([200, 201, 402, 409]).toContain(x.status);
    }
  });
});

describe('V2-022 — the handover gate (O-03, DEC-210 extended)', () => {
  it('app_paid passes without cash; included passes; due with an initiated online payment still asks (PAYMENT_PENDING)', async () => {
    const a = await account();
    const r1 = await readyTicket(t, await driver());
    const d1 = r1.driver;
    await link(r1.ticketId, a);
    const home0 = ok(await t.get('/v1/me/home', d1));
    expect(home0.current_task.payment_due).toMatchObject({ amount_halalas: FEE });
    const rt = await captureRealtime(t);
    try {
      const token = await tokenOf(TEST_CARDS.success);
      paid(await payVisit(a, r1.ticketId, { source: { type: 'token', token } }));
      await rt.settle();
      // realtime tells the driver at D-11: a newer TaskCard without the fee (RT-2)
      const updates = rt
        .of('task.updated', rooms.user(d1))
        .filter((m) => m.message.data.task?.id === r1.retrieveTaskId);
      expect(updates.at(-1)?.message.data).toMatchObject({ cause: 'payment.online_paid', payment_due: null });
    } finally {
      await rt.stop();
    }
    // the D-11 card no longer asks for the fee, and shows «مدفوع في التطبيق»
    const home = ok(await t.get('/v1/me/home', d1));
    expect(home.current_task.payment_due ?? null).toBeNull();
    expect(home.current_task.ticket.entitlement).toBe('app_paid');
    const done = ok(await deliver(t, d1, r1));
    expect(done.ticket).toMatchObject({ status: 'delivered', payment_status: 'collected' });
    expect(done.payment ?? null).toBeNull();

    const r2 = await readyTicket(t, await driver(), { eventId: EVT_R1 });
    const d2 = r2.driver;
    ok(await deliver(t, d2, r2));

    const r3 = await readyTicket(t, await driver());
    const d3 = r3.driver;
    await link(r3.ticketId, a);
    paid(
      await payVisit(a, r3.ticketId, { source: { type: 'token', token: await tokenOf(TEST_CARDS.threeDs) } }),
    );
    const pending = await deliver(t, d3, r3);
    expect(pending.body.error.code).toBe('PAYMENT_PENDING');
  });

  it('a counting payment refunded in full before the handover: the fee is due again', async () => {
    const a = await account();
    const r = await readyTicket(t, await driver());
    const d = r.driver;
    await link(r.ticketId, a);
    const p = paid(
      await payVisit(a, r.ticketId, { source: { type: 'token', token: await tokenOf(TEST_CARDS.success) } }),
    );
    await t.db.transaction(async (tx) => {
      const row = (await paymentById(tx, p.payment_id, true))!;
      await issueSystemRefund(tx, row, 'not_due');
    });
    await settle();
    expect(await ticketOf(r.ticketId)).toMatchObject({ payment_status: 'due', entitlement: 'none' });
    expect(await timeline(r.ticketId)).toContain('payment.online_refunded');
    expect((await deliver(t, d, r)).body.error.code).toBe('PAYMENT_PENDING');
    ok(await deliver(t, d, r, CASH));
  });
});

describe('V2-023 — saved cards (C-18)', () => {
  it('«حفظ البطاقة» needs the card_on_file consent at the version in force', async () => {
    const a = await account();
    const p = await parkedVisit(a);
    const token = await tokenOf(TEST_CARDS.success);
    expect(
      errOf(await payVisit(a, p.ticketId, { source: { type: 'token', token }, save_card: true })),
    ).toMatchObject({
      status: 422,
      code: 'CUSTOMER_CONSENT_REQUIRED',
      details: { kind: 'card_on_file', current_version: CARD_VERSION },
    });
    expect(
      errOf(
        await payVisit(a, p.ticketId, {
          source: { type: 'token', token },
          save_card: true,
          card_on_file_version: '2020-01-01',
        }),
      ),
    ).toMatchObject({ status: 409, code: 'CUSTOMER_CONSENT_VERSION_STALE' });
    expect(errOf(await cardCmd(a, 'post', '/v1/customer/payment-methods', { token }))).toMatchObject({
      status: 422,
      code: 'CUSTOMER_CONSENT_REQUIRED',
    });
    expect((await onlineOf(p.ticketId)).rows).toHaveLength(0);
  });

  it('saved with a payment: pending until paid, then on file (default), with the gateway’s brand/last4/expiry', async () => {
    const a = await account();
    const p = await parkedVisit(a);
    const token = await tokenOf(TEST_CARDS.threeDs);
    const r = paid(
      await payVisit(a, p.ticketId, {
        source: { type: 'token', token },
        save_card: true,
        card_on_file_version: CARD_VERSION,
      }),
    );
    expect(await cards(a)).toEqual([]); // pending: hidden, never charged
    await sim.client.complete3ds((await paymentById(t.db, r.payment_id))!.gateway_payment_id!, 'success');
    await settle();
    const list = await cards(a);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ last4: '0002', expires_month: 12, expires_year: 2030, is_default: true });
    expect(paid(await getPayment(a, r.payment_id), 200).saved_payment_method_id).toBe(list[0]!.id);
    const consent = await t.db.query(
      `SELECT version, granted FROM customer_account_consents WHERE account_id = $1 AND kind = 'card_on_file'`,
      [a.id],
    );
    expect(consent.rows).toEqual([{ version: CARD_VERSION, granted: true }]);
    // no token leaves the server: the list shows no token, the audit holds none
    expect(JSON.stringify(list)).not.toContain(token);
    const leak = await t.db.query(
      `SELECT count(*)::int AS n FROM customer_audit_log WHERE metadata::text LIKE $1`,
      [`%${token}%`],
    );
    expect(leak.rows[0].n).toBe(0);
    // the next visit pays with it (the gateway decides on 3-D Secure for the token: this test card asks for it)
    const p2 = await parkedVisit(a);
    const again = paid(
      await payVisit(a, p2.ticketId, { source: { type: 'saved', payment_method_id: list[0]!.id } }),
    );
    expect(again).toMatchObject({ status: 'initiated', amount_halalas: FEE });
    expect(again.transaction_url).toBeTruthy();
    expect((await paymentById(t.db, again.payment_id))!.payment_method_id).toBe(list[0]!.id);
  });

  it('a failed payment drops the card saved with it and deletes its token at the gateway', async () => {
    const a = await account();
    const p = await parkedVisit(a);
    const token = await tokenOf(TEST_CARDS.threeDsDeclined);
    const r = paid(
      await payVisit(a, p.ticketId, {
        source: { type: 'token', token },
        save_card: true,
        card_on_file_version: CARD_VERSION,
      }),
    );
    await sim.client.complete3ds((await paymentById(t.db, r.payment_id))!.gateway_payment_id!, 'fail');
    await settle();
    expect(paid(await getPayment(a, r.payment_id), 200).status).toBe('failed');
    expect(await cards(a)).toEqual([]);
    expect((await sim.client.tokens()).deleted).toContain(token);
  });

  it('C-18: add with consent, set the default, remove (token deleted at the gateway), replays, other accounts', async () => {
    const a = await account();
    const b = await account();
    const t1 = await tokenOf(TEST_CARDS.success);
    const t2 = await tokenOf(TEST_CARDS.mada);
    const key = newKey();
    const add1 = await cardCmd(
      a,
      'post',
      '/v1/customer/payment-methods',
      { token: t1, card_on_file_version: CARD_VERSION },
      key,
    );
    expect(add1.status, JSON.stringify(add1.body)).toBe(201);
    expect(add1.body.data).toMatchObject({ last4: '1111', is_default: true });
    const replay = await cardCmd(
      a,
      'post',
      '/v1/customer/payment-methods',
      { token: t1, card_on_file_version: CARD_VERSION },
      key,
    );
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const add2 = await cardCmd(a, 'post', '/v1/customer/payment-methods', {
      token: t2,
      card_on_file_version: CARD_VERSION,
    });
    expect(add2.body.data).toMatchObject({ brand: 'mada', last4: '0008', is_default: false });
    const id1 = add1.body.data.id as string;
    const id2 = add2.body.data.id as string;
    // B can neither see nor touch A's cards
    expect(await cards(b)).toEqual([]);
    expect(
      errOf(await cardCmd(b, 'patch', `/v1/customer/payment-methods/${id2}`, { is_default: true })),
    ).toMatchObject({
      status: 404,
      code: 'RESOURCE_NOT_FOUND',
    });
    expect(errOf(await cardCmd(b, 'delete', `/v1/customer/payment-methods/${id1}`))).toMatchObject({
      status: 404,
    });
    const p = await parkedVisit(a);
    expect(
      errOf(await payVisit(b, p.ticketId, { source: { type: 'saved', payment_method_id: id1 } })).code,
    ).toBe('RESOURCE_NOT_FOUND');
    // default
    expect(
      ok(await cardCmd(a, 'patch', `/v1/customer/payment-methods/${id2}`, { is_default: true })),
    ).toMatchObject({
      id: id2,
      is_default: true,
    });
    expect((await cards(a)).map((c) => [c.id, c.is_default])).toEqual([
      [id2, true],
      [id1, false],
    ]);
    // remove the default: the other one becomes the default; the token leaves the gateway after COMMIT
    const del = ok(await cardCmd(a, 'delete', `/v1/customer/payment-methods/${id2}`));
    expect(del.payment_method_id).toBe(id2);
    expect((await cards(a)).map((c) => [c.id, c.is_default])).toEqual([[id1, true]]);
    expect((await sim.client.tokens()).deleted).not.toContain(t2);
    await settle();
    expect((await sim.client.tokens()).deleted).toContain(t2);
    const gone = await t.db.query(`SELECT gateway_deleted_at FROM customer_payment_methods WHERE id = $1`, [
      id2,
    ]);
    expect(gone.rows[0].gateway_deleted_at).not.toBeNull();
    expect(errOf(await cardCmd(a, 'delete', `/v1/customer/payment-methods/${id2}`))).toMatchObject({
      status: 404,
    });
  });

  it('a token the gateway does not know is refused; deleting the account deletes the tokens at the gateway', async () => {
    const a = await account();
    expect(
      errOf(
        await cardCmd(a, 'post', '/v1/customer/payment-methods', {
          token: 'token_unknownunknown',
          card_on_file_version: CARD_VERSION,
        }),
      ),
    ).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    const tok = await tokenOf(TEST_CARDS.success);
    ok(
      await cardCmd(a, 'post', '/v1/customer/payment-methods', {
        token: tok,
        card_on_file_version: CARD_VERSION,
      }),
      201,
    );
    // C-20 with a fresh re-verification proof (DEC-507)
    const sid = (
      await t.db.query<{ id: string }>(`SELECT id FROM customer_account_sessions WHERE account_id = $1`, [
        a.id,
      ])
    ).rows[0]!.id;
    const proof = newCustomerToken('reauth', sid);
    await t.db.query(
      `UPDATE customer_account_sessions SET reauth_hash = $2, reauth_expires_at = $3::timestamptz + interval '5 minutes'
        WHERE id = $1`,
      [sid, sha256Hex(proof), t.clock.now()],
    );
    const del = await t
      .http()
      .delete('/v1/customer/me')
      .set(bearer(a))
      .set('Idempotency-Key', newKey())
      .send({ reauth_token: proof });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    await settle();
    expect((await sim.client.tokens()).deleted).toContain(tok);
  });
});
