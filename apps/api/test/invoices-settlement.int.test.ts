import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  createLogger,
  FakeClock,
  InvoicingRuntime,
  invoicingJobs,
  newCustomerToken,
  OBJECT_STORAGE,
  OnlinePayments,
  OutboxDispatcher,
  PaymentsRuntime,
  paymentsOnlineJobs,
  runMonthly,
  scheduleSettlement,
  settlementJobs,
  sha256Hex,
  SimulatorEInvoicingProvider,
  decodeTlv,
  type ObjectStorage,
} from '@point/server';
import { createSessionCookie } from '@point/server/testing';
import { FIRST_PREVIOUS_INVOICE_HASH, roundHalfUpDiv, type PlatformRole } from '@point/shared';
import {
  CUSTOMER_ROUTES,
  CustomerInvoiceDetailSchema,
  CustomerInvoiceListSchema,
  successEnvelopeSchema,
} from '@point/shared/customer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SECRET_KEY,
  DEFAULT_WEBHOOK_SECRET,
  TEST_CARDS,
  startPaymentSimulator,
  type RunningPaymentSimulator,
} from '../../../tools/payment-simulator/src/index.js';
import { CSRF, SEED_IDS, createTestApp, newKey, type TestApp } from './harness.js';

/**
 * V5 — invoices and operator settlement (V2-040 … V2-042; docs/v2/04 §4–§5; DEC-540 … DEC-549) on the payment
 * simulator and the e-invoicing simulator: a simplified invoice for every paid online payment and a credit note for
 * every refund (gapless chain, immutable), the provider's answers, the PDFs and their private links, C-17 / P-10 /
 * O-06 reads; and gate H5 — a simulated month across two operators with subscriber visits, app payments, refunds,
 * SaaS fees and an adjustment, whose statements equal the sum of their source rows to the halala.
 */

const ORG_A = SEED_IDS.org;
const RMS = SEED_IDS.venues.RMS;
const LYL = SEED_IDS.venues.LYL;
const ORG_B = '00000000-0000-4000-8000-0000000b0001';
const B_VENUE = '00000000-0000-4000-8000-0000000b0002';
const B_POOL = '00000000-0000-4000-8000-0000000b0003';
const B_EVENT = '00000000-0000-4000-8000-0000000b0004';
const B_OWNER = '00000000-0000-4000-8000-0000000b0005';
const ROLES: PlatformRole[] = ['platform_owner', 'platform_admin', 'platform_finance', 'platform_support'];
const CALLBACK_SECRET = 'einvoice-callback-test-secret';

const clock = new FakeClock('2026-09-01T09:00:00.000Z');
let sim: RunningPaymentSimulator;
let t: TestApp;
let pay: OnlinePayments;
let dispatcher: OutboxDispatcher;
let provider: SimulatorEInvoicingProvider;
let storage: ObjectStorage;
const cookies = {} as Record<PlatformRole, string>;
let platformUserId: string;
let phoneSeq = 0;
let displaySeq = 900;

interface Account {
  id: string;
  access: string;
}

async function account(): Promise<Account> {
  const phone = `+9665${String(72000000 + ++phoneSeq)}`;
  const id = (
    await t.db.query<{ id: string }>(`INSERT INTO customer_accounts (phone_e164) VALUES ($1) RETURNING id`, [
      phone,
    ])
  ).rows[0]!.id;
  const sid = randomUUID();
  const access = newCustomerToken('access', sid);
  await t.db.query(
    `INSERT INTO customer_account_sessions (id, account_id, device_id, platform, refresh_hash, access_hash,
            access_expires_at, refresh_expires_at, created_at)
     VALUES ($1, $2, $3, 'ios', $4, $5, $6::timestamptz + interval '400 days', $6::timestamptz + interval '400 days', $6)`,
    [sid, id, `device-${sid}`, sha256Hex(newCustomerToken('refresh', sid)), sha256Hex(access), clock.now()],
  );
  return { id, access };
}

/** A ticket of a venue owing `fee` (the visit payment collects it, DEC-521). */
async function ticket(
  org: string,
  venue: string,
  opts: { fee?: number; delivered?: string; sub?: boolean } = {},
) {
  const pool = venue === B_VENUE ? B_POOL : SEED_IDS.defaultPoolByVenue[venue === LYL ? 'LYL' : 'RMS'];
  const event =
    venue === B_VENUE ? B_EVENT : venue === LYL ? SEED_IDS.events['EVT-L1'] : SEED_IDS.events['EVT-R1'];
  const creator = org === ORG_B ? B_OWNER : SEED_IDS.users.DRV1;
  const delivered = opts.delivered ?? null;
  const r = await t.db.query<{ id: string }>(
    `INSERT INTO tickets (org_id, venue_id, event_id, dispatch_pool_id, display_number, status, channel, paper_serial,
            plate_digits, plate_letters_ar, vehicle_holder_type, key_holder_type, created_by, submitted_at, parked_at,
            payment_status, fee_halalas, entitlement, delivered_at, delivered_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'paper', $7, '4821', 'ب ح د', $8, $8, $9, now(), now(), $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      org,
      venue,
      event,
      pool,
      ++displaySeq,
      delivered ? 'delivered' : 'parked',
      `H5-${displaySeq}`,
      delivered ? 'customer' : 'unknown',
      creator,
      opts.fee ? 'due' : 'not_required',
      opts.fee ?? 0,
      opts.sub ? 'subscription' : 'none',
      delivered,
      delivered ? creator : null,
    ],
  );
  return r.rows[0]!.id;
}

/** Pays a visit with a frictionless card at the clock's time. */
async function payVisit(a: Account, org: string, venue: string, amount: number) {
  const ticketId = await ticket(org, venue, { fee: amount });
  const token = await sim.client.tokenize(TEST_CARDS.success.number);
  const r = await pay.start({
    accountId: a.id,
    purpose: 'visit',
    ticketId,
    orgId: org,
    venueId: venue,
    amountHalalas: amount,
    source: { type: 'token', token },
    callbackUrl: 'https://app.example.test/pay/return',
  });
  expect(r.payment.status).toBe('paid');
  return r.payment.id;
}

const settle = async () => {
  await sim.client.flush();
  for (let i = 0; i < 8; i++) if ((await dispatcher.drain(200)) === 0) break;
};

const touch = () => t.db.query(`UPDATE platform_sessions SET last_seen_at = $1`, [clock.now()]);

async function platform(method: 'get' | 'post', path: string, role: PlatformRole, body?: object) {
  await touch();
  const req = t.http()[method](path).set('Cookie', cookies[role]);
  if (method === 'get') return req;
  return req
    .set(CSRF)
    .set('Idempotency-Key', newKey())
    .send(body ?? {});
}

const customerGet = (path: string, a: Account) =>
  t.http().get(path).set('Authorization', `Bearer ${a.access}`);

async function refund(paymentId: string, amount?: number) {
  const r = await platform('post', `/v1/platform/payments/${paymentId}/refunds`, 'platform_finance', {
    ...(amount ? { amount_halalas: amount } : {}),
    reason: 'طلب العميل',
  });
  expect(r.status).toBe(201);
  await settle();
  return r.body.data.refund.id as string;
}

const invoices = (where = 'true', params: unknown[] = []) =>
  t.db
    .query<{
      id: string;
      number: string;
      series: string;
      kind: string;
      icv: number;
      previous_hash: string;
      invoice_hash: string;
      total_halalas: number;
      vat_halalas: number;
      subtotal_halalas: number;
      zatca_status: string;
      pdf_storage_key: string | null;
      online_payment_id: string | null;
      refund_id: string | null;
      original_invoice_id: string | null;
      org_id: string | null;
      account_id: string | null;
      qr_payload: string;
    }>(
      `SELECT id, number, series, kind, icv::float8 AS icv, previous_hash, invoice_hash, total_halalas::float8 AS total_halalas,
              vat_halalas::float8 AS vat_halalas, subtotal_halalas::float8 AS subtotal_halalas, zatca_status,
              pdf_storage_key, online_payment_id, refund_id, original_invoice_id, org_id, account_id, qr_payload
         FROM invoices WHERE ${where} ORDER BY series, icv`,
      params,
    )
    .then((r) => r.rows);

beforeAll(async () => {
  process.env.MOYASAR_SECRET_KEY = DEFAULT_SECRET_KEY;
  process.env.MOYASAR_WEBHOOK_SECRET = DEFAULT_WEBHOOK_SECRET;
  process.env.EINVOICE_WEBHOOK_SECRET = CALLBACK_SECRET;
  sim = await startPaymentSimulator({ env: {}, now: () => clock.now() });
  t = await createTestApp({ clock, env: { MOYASAR_BASE_URL: sim.url, MOYASAR_HTTP_TIMEOUT_MS: '3000' } });
  await t.app.listen(0, '127.0.0.1');
  const apiUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
  await sim.client.configure({ webhookUrl: `${apiUrl}/webhooks/payments/moyasar`, autoWebhooks: true });
  const logger = createLogger({ level: 'silent' });
  const rt = new PaymentsRuntime({ env: t.env, logger });
  pay = new OnlinePayments(t.db, rt);
  storage = t.app.get<ObjectStorage>(OBJECT_STORAGE, { strict: false });
  provider = new SimulatorEInvoicingProvider({ now: () => clock.now() });
  const invoicing = new InvoicingRuntime({ env: t.env, clock, storage, provider, logger });
  dispatcher = new OutboxDispatcher(t.db, t.clock, logger, {
    workerId: 'v5-worker',
    batchSize: 50,
    concurrency: 1,
  });
  for (const h of [
    ...paymentsOnlineJobs({ runtime: rt }),
    ...invoicingJobs({ runtime: invoicing }),
    ...settlementJobs(),
  ])
    dispatcher.register(h);
  for (const [i, role] of ROLES.entries()) {
    const u = await t.db.query<{ id: string }>(
      `INSERT INTO platform_users (phone_e164, full_name, role, secret_hash, must_change_secret, mfa_enabled, mfa_secret_enc)
       VALUES ($1, $2, $3, 'x', false, true, 'x') RETURNING id`,
      [`+96655777000${i}`, `حساب ${role}`, role],
    );
    if (role === 'platform_owner') platformUserId = u.rows[0]!.id;
    const token = `v5-test-session-${role}-0123456789`;
    await t.db.query(
      `INSERT INTO platform_sessions (platform_user_id, token_hash, mfa_verified, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, true, $3, $3, $3::timestamptz + interval '400 days')`,
      [u.rows[0]!.id, sha256Hex(token), clock.now()],
    );
    cookies[role] = `${t.env.PLATFORM_SESSION_COOKIE_NAME}=${token}`;
  }
  // operator A = the seed's organization (legal data for its tax invoice); operator B built here
  await t.db.query(
    `UPDATE organizations SET legal_name = 'شركة المشغل الأول المحدودة', vat_number = '310000000000003',
            cr_number = '1010000001' WHERE id = $1`,
    [ORG_A],
  );
  await t.db.query(`UPDATE venues SET created_at = '2026-01-01T00:00:00Z' WHERE org_id = $1`, [ORG_A]);
  await t.db.query(
    `INSERT INTO organizations (id, name_ar, operator_status, legal_name, vat_number, cr_number)
     VALUES ($1, 'المشغل الثاني', 'active', 'شركة المشغل الثاني', '320000000000003', '1010000002')`,
    [ORG_B],
  );
  await t.db.query(
    `INSERT INTO users (id, org_id, employee_code, full_name, phone_e164, role, secret_kind, secret_hash,
                        must_change_secret, mfa_enabled, mfa_secret_enc)
     VALUES ($1, $2, 'O-0001', 'مالك المشغل الثاني', '+966500077001', 'owner', 'password', 'x', false, true, 'x')`,
    [B_OWNER, ORG_B],
  );
  await t.db.query(`INSERT INTO role_scopes (org_id, user_id, scope_type) VALUES ($1, $2, 'org')`, [
    ORG_B,
    B_OWNER,
  ]);
  await t.db.query(
    `INSERT INTO venues (id, org_id, code, name_ar, name_en, created_at) VALUES ($1, $2, 'GRD', 'برج جراند', 'Grand Tower', '2026-10-11T00:00:00+03:00')`,
    [B_VENUE, ORG_B],
  );
  await t.db.query(
    `INSERT INTO dispatch_pools (id, org_id, venue_id, name, is_default) VALUES ($1, $2, $3, 'الافتراضية', true)`,
    [B_POOL, ORG_B, B_VENUE],
  );
  await t.db.query(
    `INSERT INTO events (id, org_id, venue_id, dispatch_pool_id, name_ar, event_date, status, created_by)
     VALUES ($1, $2, $3, $4, 'تشغيل يومي', '2026-10-01', 'open', $5)`,
    [B_EVENT, ORG_B, B_VENUE, B_POOL, B_OWNER],
  );
  // contracts: A changes terms on 16 October (monthly fee, payout and commission); B pays a yearly fee
  const contract = (
    org: string,
    fee: number,
    cycle: string,
    payout: number,
    bp: number,
    from: string,
    to: string | null,
  ) =>
    t.db.query(
      `INSERT INTO operator_contracts (org_id, saas_fee_halalas_per_venue, saas_cycle, subscriber_visit_payout_halalas,
                                       app_payment_commission_bp, starts_on, ends_on, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [org, fee, cycle, payout, bp, from, to, platformUserId],
    );
  await contract(ORG_A, 50_000, 'monthly', 700, 1000, '2026-01-01', '2026-10-16');
  await contract(ORG_A, 60_000, 'monthly', 800, 1250, '2026-10-16', null);
  await contract(ORG_B, 1_200_000, 'yearly', 500, 800, '2026-01-01', null);
}, 120_000);

afterAll(async () => {
  await sim?.close();
  await t?.close();
});

describe('V2-040 — invoices of the online payments', () => {
  let a: Account;
  let other: Account;
  let paymentId: string;

  it('a paid visit gets a simplified invoice, reported by the provider, with its PDF behind a private link', async () => {
    a = await account();
    other = await account();
    clock.set('2026-09-02T10:00:00.000Z');
    paymentId = await payVisit(a, ORG_A, RMS, 2300);
    const [inv] = await invoices('online_payment_id = $1', [paymentId]);
    expect(inv).toMatchObject({
      series: 'simplified',
      kind: 'customer_simplified',
      number: 'PS-00000001',
      icv: 1,
      previous_hash: FIRST_PREVIOUS_INVOICE_HASH,
      total_halalas: 2300,
      vat_halalas: 300,
      subtotal_halalas: 2000,
      zatca_status: 'pending',
      account_id: a.id,
      org_id: null,
    });
    // QR tags 1–5: seller name, VAT number, time, total and VAT
    const qr = decodeTlv(inv!.qr_payload);
    expect(qr.get(2)).toMatch(/^3[0-9]{13}3$/);
    expect([qr.get(4), qr.get(5)]).toEqual(['23.00', '3.00']);
    await settle();
    const [after] = await invoices('id = $1', [inv!.id]);
    expect(after).toMatchObject({
      zatca_status: 'reported',
      pdf_storage_key: 'invoices/simplified/PS-00000001.pdf',
    });
    const pdf = await storage.get(after!.pdf_storage_key!);
    expect(pdf?.subarray(0, 5).toString()).toBe('%PDF-');
    expect(provider.submitted.map((s) => [s.number, s.via])).toEqual([['PS-00000001', 'report']]);

    const list = await customerGet(CUSTOMER_ROUTES.invoices.path, a);
    expect(list.status).toBe(200);
    const items = successEnvelopeSchema(CustomerInvoiceListSchema).parse(list.body).data.items;
    expect(items).toEqual([
      expect.objectContaining({
        number: 'PS-00000001',
        status: 'reported',
        venue_name_ar: expect.any(String),
      }),
    ]);
    const detail = await customerGet(`/v1/customer/invoices/${inv!.id}`, a);
    const d = successEnvelopeSchema(CustomerInvoiceDetailSchema).parse(detail.body).data;
    expect(d).toMatchObject({
      type_code: 388,
      total_halalas: 2300,
      vat_halalas: 300,
      subtotal_halalas: 2000,
    });
    expect(d.pdf_url).toEqual(expect.any(String));
    expect(detail.headers['cache-control']).toBe('private, no-store');
    // another account learns nothing (as for an id that does not exist)
    const foreign = await customerGet(`/v1/customer/invoices/${inv!.id}`, other);
    const missing = await customerGet(`/v1/customer/invoices/${randomUUID()}`, other);
    expect([foreign.status, foreign.body.error.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    expect(foreign.body.error.details).toEqual(missing.body.error.details);
    expect(
      successEnvelopeSchema(CustomerInvoiceListSchema).parse(
        (await customerGet(CUSTOMER_ROUTES.invoices.path, other)).body,
      ).data.items,
    ).toEqual([]);
  });

  it('refunds get credit notes that add up to the invoice exactly (partial, then the rest)', async () => {
    clock.set('2026-09-03T10:00:00.000Z');
    const p = await payVisit(a, ORG_A, RMS, 2345);
    await settle();
    const r1 = await refund(p, 1001);
    const r2 = await refund(p);
    const [inv] = await invoices(`online_payment_id = $1 AND kind = 'customer_simplified'`, [p]);
    const notes = await invoices(`original_invoice_id = $1`, [inv!.id]);
    expect(notes.map((n) => [n.refund_id, n.kind, n.total_halalas])).toEqual([
      [r1, 'credit_note', 1001],
      [r2, 'credit_note', 1344],
    ]);
    expect(notes.reduce((s, n) => s + n.vat_halalas, 0)).toBe(inv!.vat_halalas);
    expect(notes.reduce((s, n) => s + n.subtotal_halalas, 0)).toBe(inv!.subtotal_halalas);
    expect(notes.every((n) => n.zatca_status === 'reported' && n.pdf_storage_key)).toBe(true);
    // the chain: gapless counters, each previous hash the hash before it
    const chain = await invoices(`series = 'simplified'`);
    chain.forEach((c, i) => {
      expect(c.icv).toBe(i + 1);
      expect(c.previous_hash).toBe(i === 0 ? FIRST_PREVIOUS_INVOICE_HASH : chain[i - 1]!.invoice_hash);
    });
  });

  it('an invoice is never edited nor deleted (a correction is a credit note)', async () => {
    const [inv] = await invoices(`series = 'simplified'`);
    await expect(
      t.db.query(`UPDATE invoices SET total_halalas = 1 WHERE id = $1`, [inv!.id]),
    ).rejects.toThrow(/never edited|ck_invoices/);
    await expect(
      t.db.query(`UPDATE invoices SET zatca_status = 'pending' WHERE id = $1`, [inv!.id]),
    ).rejects.toThrow(/final/);
    const c = await t.db.query(`SELECT 1 FROM invoice_series WHERE series = 'simplified'`);
    expect(c.rowCount).toBe(1);
    await expect(
      t.db.query(`UPDATE invoice_series SET last_icv = last_icv - 1 WHERE series = 'simplified'`),
    ).rejects.toThrow(/advances by one/);
  });

  it('a rejected document stays in the chain with an alert; an outage retries then alerts', async () => {
    clock.set('2026-09-04T10:00:00.000Z');
    provider.failNext('rejected');
    const p = await payVisit(a, ORG_A, LYL, 1500);
    await settle();
    const [inv] = await invoices('online_payment_id = $1', [p]);
    expect(inv).toMatchObject({ zatca_status: 'rejected', pdf_storage_key: null });
    const alerts = await t.db.query(`SELECT type, status FROM platform_alerts WHERE dedupe_key = $1`, [
      `einvoice_rejected:${inv!.id}`,
    ]);
    expect(alerts.rows).toEqual([{ type: 'einvoice_rejected', status: 'open' }]);

    for (let i = 0; i < 8; i++) provider.failNext('unavailable');
    const p2 = await payVisit(a, ORG_A, LYL, 1500);
    for (let i = 0; i < 10; i++) {
      await settle();
      clock.advance(3_600_000);
    }
    const [inv2] = await invoices('online_payment_id = $1', [p2]);
    expect(inv2!.zatca_status).toBe('pending');
    const failed = await t.db.query(`SELECT status FROM platform_alerts WHERE dedupe_key = $1`, [
      `einvoice_submit_failed:${inv2!.id}`,
    ]);
    expect(failed.rows).toEqual([{ status: 'open' }]);
    const events = await t.db.query(
      `SELECT kind, outcome FROM invoice_provider_events WHERE invoice_id = $1`,
      [inv2!.id],
    );
    expect(events.rows.length).toBeGreaterThanOrEqual(8);
    expect(events.rows.every((e) => e.outcome === 'error')).toBe(true);

    // the provider's callback (signed) answers the pending document; a wrong signature is refused first
    const body = JSON.stringify({
      invoice_uuid: (await t.db.query(`SELECT zatca_uuid FROM invoices WHERE id = $1`, [inv2!.id])).rows[0]
        .zatca_uuid,
      status: 'reported',
      reference: 'cb-1',
    });
    const bad = await t
      .http()
      .post('/webhooks/einvoicing')
      .set('Content-Type', 'application/json')
      .set('X-Einvoice-Signature', 'sha256=00')
      .send(body);
    expect([bad.status, bad.body.error?.code]).toEqual([401, 'EINVOICE_WEBHOOK_SIGNATURE_INVALID']);
    const good = await t
      .http()
      .post('/webhooks/einvoicing')
      .set('Content-Type', 'application/json')
      .set('X-Einvoice-Signature', SimulatorEInvoicingProvider.sign(body, CALLBACK_SECRET))
      .send(body);
    expect(good.status).toBe(200);
    const [answered] = await invoices('id = $1', [inv2!.id]);
    expect(answered!.zatca_status).toBe('reported');
    // the same callback again changes nothing
    const again = await t
      .http()
      .post('/webhooks/einvoicing')
      .set('Content-Type', 'application/json')
      .set('X-Einvoice-Signature', SimulatorEInvoicingProvider.sign(body, CALLBACK_SECRET))
      .send(body);
    expect(again.status).toBe(200);
    const outcomes = await t.db.query(
      `SELECT outcome FROM invoice_provider_events WHERE invoice_id = $1 AND kind = 'callback' ORDER BY id`,
      [inv2!.id],
    );
    expect(outcomes.rows.map((r) => r.outcome)).toEqual(['accepted', 'ignored']);
    await settle();
  });

  it('P-10: finance and the owner read every document with its provider timeline; admin and support do not', async () => {
    for (const role of ['platform_admin', 'platform_support'] as const) {
      const r = await platform('get', '/v1/platform/invoices', role);
      expect([r.status, r.body.error.code]).toEqual([403, 'PERMISSION_DENIED']);
    }
    const list = await platform('get', '/v1/platform/invoices?series=simplified&limit=2', 'platform_finance');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.meta.next_cursor).toEqual(expect.any(String));
    expect(list.body.data[0].account.phone_masked).toMatch(/•/);
    expect(JSON.stringify(list.body)).not.toMatch(/\+9665/);
    const id = list.body.data[0].id;
    const d = await platform('get', `/v1/platform/invoices/${id}`, 'platform_owner');
    expect(d.status).toBe(200);
    expect(d.body.data).toMatchObject({ id, provider: 'simulator', provider_events: expect.any(Array) });
    expect(
      (await platform('get', `/v1/platform/invoices/${randomUUID()}`, 'platform_owner')).body.error.code,
    ).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('V2-041 / V2-042 — gate H5: a simulated month across two operators, to the halala', () => {
  const visits: { org: string; ticket: string; day: string }[] = [];
  const payments: { org: string; id: string; amount: number; day: string }[] = [];
  const refunds: { org: string; id: string; amount: number; paidDay: string }[] = [];
  let stA: string;
  let stB: string;

  it('builds the month: subscriber visits, app payments, refunds (and noise outside it)', async () => {
    const c = await account();
    // subscriber visits, delivered on Riyadh days of October (the first one at 00:30 on the 1st, Riyadh)
    const deliveries: [string, string, string][] = [
      [ORG_A, RMS, '2026-09-30T21:30:00Z'], // 2026-10-01 Riyadh → old contract
      [ORG_A, RMS, '2026-10-10T12:00:00Z'],
      [ORG_A, LYL, '2026-10-16T08:00:00Z'], // new contract
      [ORG_A, LYL, '2026-10-31T20:59:00Z'], // 23:59 Riyadh, still October
      [ORG_B, B_VENUE, '2026-10-12T10:00:00Z'],
      [ORG_B, B_VENUE, '2026-10-20T10:00:00Z'],
    ];
    for (const [org, venue, at] of deliveries) {
      const id = await ticket(org, venue, { delivered: at, sub: true });
      visits.push({
        org,
        ticket: id,
        day: new Date(Date.parse(at) + 3 * 3_600_000).toISOString().slice(0, 10),
      });
    }
    // outside the month: Riyadh 1 November, and a September delivery; a non-subscriber visit
    await ticket(ORG_A, RMS, { delivered: '2026-10-31T21:00:00Z', sub: true });
    await ticket(ORG_A, RMS, { delivered: '2026-09-15T10:00:00Z', sub: true });
    await ticket(ORG_A, RMS, { delivered: '2026-10-15T10:00:00Z' });
    // app payments on both sides of A's contract change, and on B
    const at = async (iso: string, org: string, venue: string, amount: number) => {
      clock.set(iso);
      const id = await payVisit(c, org, venue, amount);
      payments.push({
        org,
        id,
        amount,
        day: new Date(Date.parse(iso) + 3 * 3_600_000).toISOString().slice(0, 10),
      });
      return id;
    };
    const pA1 = await at('2026-10-05T10:00:00.000Z', ORG_A, RMS, 2345);
    await at('2026-10-17T10:00:00.000Z', ORG_A, LYL, 2300);
    const pB1 = await at('2026-10-21T10:00:00.000Z', ORG_B, B_VENUE, 2300);
    await settle();
    // refunds: a partial one of A's old-contract payment, the whole of B's payment
    clock.set('2026-10-25T10:00:00.000Z');
    refunds.push({ org: ORG_A, id: await refund(pA1, 1001), amount: 1001, paidDay: '2026-10-05' });
    refunds.push({ org: ORG_B, id: await refund(pB1), amount: 2300, paidDay: '2026-10-21' });
    expect(visits).toHaveLength(6);
  });

  /** The statement computed by hand from the source rows (an independent reading of docs/v2/04 §5). */
  function expected(org: string) {
    const terms = (day: string) =>
      org === ORG_B
        ? { payout: 500, bp: 800 }
        : day < '2026-10-16'
          ? { payout: 700, bp: 1000 }
          : { payout: 800, bp: 1250 };
    const v = visits.filter((x) => x.org === org);
    const p = payments.filter((x) => x.org === org);
    const r = refunds.filter((x) => x.org === org);
    const payout = v.reduce((s, x) => s + terms(x.day).payout, 0);
    const gross = p.reduce((s, x) => s + x.amount, 0);
    const commission = p.reduce((s, x) => s + roundHalfUpDiv(x.amount * terms(x.day).bp, 10_000), 0);
    const refunded = r.reduce((s, x) => s + x.amount, 0);
    const back = r.reduce((s, x) => s + roundHalfUpDiv(x.amount * terms(x.paidDay).bp, 10_000), 0);
    // SaaS: A's two venues, 15 days at 500.00 then 16 days at 600.00 (31-day month); B's venue from 11 October:
    // 21 days of a twelfth of 12,000.00
    const shares =
      org === ORG_A
        ? [roundHalfUpDiv(50_000 * 15, 31), roundHalfUpDiv(60_000 * 16, 31)].flatMap((x) => [x, x])
        : [roundHalfUpDiv(1_200_000 * 21, 31 * 12)];
    const saas = shares.reduce((s, x) => s + x, 0);
    const vat = shares.reduce((s, x) => s + roundHalfUpDiv(x * 1500, 10_000), 0);
    return {
      subscriber_visit_count: v.length,
      subscriber_payout_halalas: payout,
      app_payment_count: p.length,
      app_gross_halalas: gross,
      app_commission_halalas: commission,
      app_refund_halalas: refunded,
      app_refund_commission_halalas: back,
      saas_fee_halalas: saas,
      saas_vat_halalas: vat,
      net_payable_halalas: payout + gross - commission - refunded + back - saas - vat,
    };
  }

  it('job.settlement_monthly on 1 November drafts October for both operators, equal to the source rows', async () => {
    clock.set('2026-10-31T20:00:00.000Z'); // still October in Riyadh: the month is not closed
    await expect(runMonthly(t.db, clock, '2026-10', 1500)).rejects.toThrow();
    const early = await platform('post', '/v1/platform/settlements/generate', 'platform_finance', {
      period: '2026-10',
    });
    expect(early.body.error).toMatchObject({ code: 'VALIDATION_FAILED' });
    // the worker keeps one run scheduled: the 1st at 00:15 UTC (03:15 Riyadh) for the month before
    const queued = await t.db.transaction((tx) => scheduleSettlement(tx, '15 0 1 * *', clock.now()));
    const at = await t.db.query<{ available_at: Date }>(
      `SELECT available_at FROM outbox_events WHERE id = $1`,
      [queued],
    );
    expect(at.rows[0]!.available_at.toISOString()).toBe('2026-11-01T00:15:00.000Z');
    clock.set('2026-11-01T00:15:00.000Z');
    await settle();
    const failedJobs = await t.db.query(
      `SELECT type, last_error FROM outbox_events WHERE last_error IS NOT NULL`,
    );
    expect(failedJobs.rows).toEqual([]);
    // and it scheduled the next month's run
    const next = await t.db.query<{ available_at: Date }>(
      `SELECT available_at FROM outbox_events WHERE type = 'job.settlement_monthly' AND status = 'pending'`,
    );
    expect(next.rows.map((r) => r.available_at.toISOString())).toEqual(['2026-12-01T00:15:00.000Z']);
    const rows = await t.db.query<{ id: string; org_id: string; status: string }>(
      `SELECT id, org_id, status FROM settlement_statements WHERE period_start = '2026-10-01' ORDER BY org_id`,
    );
    expect(rows.rows.map((r) => [r.org_id, r.status])).toEqual(
      expect.arrayContaining([
        [ORG_A, 'draft'],
        [ORG_B, 'draft'],
      ]),
    );
    stA = rows.rows.find((r) => r.org_id === ORG_A)!.id;
    stB = rows.rows.find((r) => r.org_id === ORG_B)!.id;
    for (const [id, org] of [
      [stA, ORG_A],
      [stB, ORG_B],
    ] as const) {
      const d = await platform('get', `/v1/platform/settlements/${id}`, 'platform_finance');
      expect(d.status).toBe(200);
      expect(d.body.data).toMatchObject({ ...expected(org), adjustments_halalas: 0, status: 'draft' });
      // every line traced to one source row, counted once
      const keys = d.body.data.lines.map((l: { id: string }) => l.id);
      expect(new Set(keys).size).toBe(keys.length);
      const sum = d.body.data.lines.reduce(
        (s: number, l: { amount_halalas: number }) => s + l.amount_halalas,
        0,
      );
      expect(sum).toBe(expected(org).net_payable_halalas);
    }
    // a rerun recomputes the drafts to the same amounts (nothing counted twice)
    const rerun = await runMonthly(t.db, clock, '2026-10', 1500);
    expect(rerun.recomputed).toBeGreaterThanOrEqual(2);
    const again = await platform('get', `/v1/platform/settlements/${stA}`, 'platform_finance');
    expect(again.body.data).toMatchObject(expected(ORG_A));
    expect(
      again.body.data.lines.filter((l: { released_at: string | null }) => l.released_at).length,
    ).toBeGreaterThan(0);
  });

  it('P-09: an adjustment, the issue with the SaaS tax invoice, the dispute, its resolution, the payment', async () => {
    let s = (await platform('get', `/v1/platform/settlements/${stA}`, 'platform_finance')).body.data;
    for (const role of ['platform_admin', 'platform_support'] as const)
      expect((await platform('get', '/v1/platform/settlements', role)).status).toBe(403);
    const noReason = await platform(
      'post',
      `/v1/platform/settlements/${stA}/adjustments`,
      'platform_finance',
      {
        expected_version: s.version,
        amount_halalas: -1234,
        reason: ' ',
      },
    );
    expect(noReason.body.error.code).toBe('REASON_REQUIRED');
    const adj = await platform('post', `/v1/platform/settlements/${stA}/adjustments`, 'platform_finance', {
      expected_version: s.version,
      amount_halalas: -1234,
      reason: 'زيارة مكررة في الكشف',
    });
    expect(adj.status).toBe(200);
    s = adj.body.data.statement;
    expect(s.adjustments_halalas).toBe(-1234);
    expect(s.net_payable_halalas).toBe(expected(ORG_A).net_payable_halalas - 1234);
    // the operator does not see a draft
    const ownerA = (await createSessionCookie(t.db, SEED_IDS.users.OWN1, { now: clock.now(), hours: 48 }))
      .cookie;
    const hidden = await t.http().get(`/v1/settlement-statements/${stA}`).set('Cookie', ownerA);
    expect(hidden.body.error.code).toBe('RESOURCE_NOT_FOUND');
    const stale = await platform('post', `/v1/platform/settlements/${stA}/issue`, 'platform_finance', {
      expected_version: s.version - 1,
    });
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const issued = await platform('post', `/v1/platform/settlements/${stA}/issue`, 'platform_finance', {
      expected_version: s.version,
    });
    expect(issued.status).toBe(200);
    expect(issued.body.data.saas_invoice.number).toBe('PB-00000001');
    s = issued.body.data.statement;
    await settle();
    // V2-042: the B2B invoice equals the statement's SaaS fee and VAT, cleared by the provider
    const [saas] = await invoices(`id = $1`, [issued.body.data.saas_invoice.id]);
    expect(saas).toMatchObject({
      series: 'standard',
      kind: 'operator_standard',
      org_id: ORG_A,
      subtotal_halalas: expected(ORG_A).saas_fee_halalas,
      vat_halalas: expected(ORG_A).saas_vat_halalas,
      zatca_status: 'cleared',
    });
    expect(saas!.pdf_storage_key).toBe('invoices/standard/PB-00000001.pdf');
    // amounts are frozen once issued
    const late = await platform('post', `/v1/platform/settlements/${stA}/adjustments`, 'platform_finance', {
      expected_version: s.version,
      amount_halalas: 1,
      reason: 'متأخر',
    });
    expect(late.body.error.code).toBe('INVALID_STATE_TRANSITION');
    await expect(
      t.db.query(`UPDATE settlement_statements SET net_payable_halalas = 0 WHERE id = $1`, [stA]),
    ).rejects.toThrow();

    // O-05: the operator's owner reads it and disputes it with a reason; O-06 shows the invoice and its PDF
    const list = await t.http().get('/v1/settlement-statements').set('Cookie', ownerA);
    expect(list.body.data.map((x: { id: string }) => x.id)).toEqual([stA]);
    const mine = await t.http().get(`/v1/settlement-statements/${stA}`).set('Cookie', ownerA);
    expect(mine.body.data).toMatchObject({ net_payable_halalas: s.net_payable_halalas, status: 'issued' });
    const sub = await t.http().get('/v1/system-subscription').set('Cookie', ownerA);
    expect(sub.body.data.contract).toMatchObject({ saas_fee_halalas_per_venue: 60_000, state: 'current' });
    expect(sub.body.data.invoices.map((i: { number: string }) => i.number)).toEqual(['PB-00000001']);
    const invDetail = await t
      .http()
      .get(`/v1/system-subscription/invoices/${saas!.id}`)
      .set('Cookie', ownerA);
    expect(invDetail.body.data.pdf_url).toEqual(expect.any(String));
    // operator B sees nothing of A
    const ownerB = (await createSessionCookie(t.db, B_OWNER, { now: clock.now(), hours: 48 })).cookie;
    expect(
      (await t.http().get(`/v1/settlement-statements/${stA}`).set('Cookie', ownerB)).body.error.code,
    ).toBe('RESOURCE_NOT_FOUND');
    expect(
      (await t.http().get(`/v1/system-subscription/invoices/${saas!.id}`).set('Cookie', ownerB)).body.error
        .code,
    ).toBe('RESOURCE_NOT_FOUND');
    // a supervisor holds no settlement permission
    const sup = await t.get('/v1/settlement-statements', 'SUP-R');
    expect(sup.body.error.code).toBe('PERMISSION_DENIED');
    const dispute = await t
      .http()
      .post(`/v1/settlement-statements/${stA}/dispute`)
      .set(CSRF)
      .set('Cookie', ownerA)
      .set('Idempotency-Key', newKey())
      .send({ expected_version: s.version, reason: 'عدد الزيارات أقل من الفعلي' });
    expect(dispute.status).toBe(200);
    expect(dispute.body.data.status).toBe('disputed');
    s = dispute.body.data;
    // the platform adjusts while disputed, then resolves it back to issued
    const adj2 = await platform('post', `/v1/platform/settlements/${stA}/adjustments`, 'platform_finance', {
      expected_version: s.version,
      amount_halalas: 800,
      reason: 'زيارة مشترك لم تُحتسب',
    });
    s = adj2.body.data.statement;
    const resolved = await platform(
      'post',
      `/v1/platform/settlements/${stA}/resolve-dispute`,
      'platform_finance',
      {
        expected_version: s.version,
        reason: 'أُضيفت الزيارة الناقصة',
      },
    );
    expect(resolved.body.data.statement.status).toBe('issued');
    s = resolved.body.data.statement;
    expect(s.net_payable_halalas).toBe(expected(ORG_A).net_payable_halalas - 1234 + 800);
    const paid = await platform(
      'post',
      `/v1/platform/settlements/${stA}/record-payment`,
      'platform_finance',
      {
        expected_version: s.version,
        reference: 'TRX-2026-11-0042',
        paid_on: '2026-11-03',
      },
    );
    expect(paid.body.data.statement).toMatchObject({ status: 'paid', paid_reference: 'TRX-2026-11-0042' });
    // final
    const afterPaid = await platform('post', `/v1/platform/settlements/${stA}/void`, 'platform_finance', {
      expected_version: paid.body.data.statement.version,
      reason: 'خطأ',
    });
    expect(afterPaid.body.error.code).toBe('INVALID_STATE_TRANSITION');
    // the job leaves a statement that is no longer a draft alone
    const rerun = await runMonthly(t.db, clock, '2026-10', 1500);
    expect(rerun.skipped).toBeGreaterThanOrEqual(1);
    const audit = await t.db.query<{ action: string }>(
      `SELECT action FROM platform_audit_log WHERE entity_id = $1 ORDER BY id`,
      [stA],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'settlement.generate',
      'settlement.recompute',
      'settlement.adjust',
      'settlement.issue',
      'settlement.adjust',
      'settlement.resolve_dispute',
      'settlement.record_payment',
    ]);
    const operatorAudit = await t.db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity_id = $1 AND org_id = $2 ORDER BY id`,
      [stA, ORG_A],
    );
    expect(operatorAudit.rows.map((r) => r.action)).toContain('settlement.dispute');
  });

  it('a voided statement takes back its SaaS invoice and frees its month; the new draft counts each row once', async () => {
    let s = (await platform('get', `/v1/platform/settlements/${stB}`, 'platform_finance')).body.data;
    const issued = await platform('post', `/v1/platform/settlements/${stB}/issue`, 'platform_finance', {
      expected_version: s.version,
    });
    s = issued.body.data.statement;
    await settle();
    const voided = await platform('post', `/v1/platform/settlements/${stB}/void`, 'platform_finance', {
      expected_version: s.version,
      reason: 'عقد خاطئ في الكشف',
    });
    expect(voided.body.data.statement.status).toBe('void');
    expect(voided.body.data.credit_note.number).toMatch(/^PB-/);
    await settle();
    const [credit] = await invoices(`id = $1`, [voided.body.data.credit_note.id]);
    const [original] = await invoices(`id = $1`, [issued.body.data.saas_invoice.id]);
    expect(credit).toMatchObject({
      kind: 'credit_note',
      original_invoice_id: original!.id,
      total_halalas: original!.total_halalas,
      zatca_status: 'cleared',
    });
    const regen = await platform('post', '/v1/platform/settlements/generate', 'platform_finance', {
      period: '2026-10',
      org_id: ORG_B,
    });
    expect(regen.status).toBe(200);
    const fresh = regen.body.data.results[0];
    expect(fresh.outcome).toBe('created');
    expect(fresh.statement).toMatchObject(expected(ORG_B));
    expect(fresh.statement.id).not.toBe(stB);
    // invoices reconcile with the money: invoices − credit notes of the month = gross − refunds, both operators
    const docs = await t.db.query<{ kind: string; total: number }>(
      `SELECT i.kind, sum(i.total_halalas)::float8 AS total FROM invoices i
         JOIN online_payments p ON p.id = i.online_payment_id
        WHERE p.id = ANY($1::uuid[]) GROUP BY i.kind`,
      [payments.map((p) => p.id)],
    );
    const by = Object.fromEntries(docs.rows.map((r) => [r.kind, r.total]));
    expect(by.customer_simplified! - by.credit_note!).toBe(
      payments.reduce((x, p) => x + p.amount, 0) - refunds.reduce((x, r) => x + r.amount, 0),
    );
  });
});
