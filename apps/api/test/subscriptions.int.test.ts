import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  createLogger,
  newCustomerToken,
  OutboxDispatcher,
  PaymentsRuntime,
  paymentsOnlineJobs,
  renewalGivenId,
  sha256Hex,
  subscriptionLifecycleEffects,
  subscriptionsJobs,
} from '@point/server';
import { addBillingPeriods, PLATFORM_ROUTES, type PlatformRole } from '@point/shared';
import {
  CUSTOMER_ROUTES,
  CustomerHomeSchema,
  CustomerLocationDetailSchema,
  CustomerSubscriptionCheckoutSchema,
  CustomerSubscriptionSchema,
  successEnvelopeSchema,
} from '@point/shared/customer';
import { createSessionCookie } from '@point/server/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SECRET_KEY,
  DEFAULT_WEBHOOK_SECRET,
  TEST_CARDS,
  startPaymentSimulator,
  type RunningPaymentSimulator,
} from '../../../tools/payment-simulator/src/index.js';
import { CSRF, createTestApp, newKey, SEED_IDS, type TestApp } from './harness.js';

/**
 * V2-030 … V2-035 (docs/v2/04 §1–§2, docs/v2/02 P-05 / P-07; DEC-531 … DEC-539) on a real PostgreSQL, the payment
 * simulator and the injectable clock: the plans of P-05 and a price change, the subscription machine end to end —
 * the gate H4 (a month, its renewal, a failed renewal, the grace retries on days 0/1/3, the expiry) — the yearly
 * cycle, cancel at the end and resume, the 30-minute checkout, a declined first payment, one live subscription per
 * venue under a race, renewals that never charge twice, the covered vehicles once per period, the account's
 * deletion, P-07, and last the freeze with the operator (suspension, reactivation with the days added, termination
 * with the prorated refund) and with the venue's closure.
 */

const ORG = SEED_IDS.org;
const RMS = SEED_IDS.venues.RMS;
const LYL = SEED_IDS.venues.LYL;
const DAY = 86_400_000;
const CARD_VERSION = '2026-11-01';
const MONTHLY = 30_000;
const YEARLY = 300_000;
const ROLES: PlatformRole[] = ['platform_owner', 'platform_admin', 'platform_finance', 'platform_support'];

let sim: RunningPaymentSimulator;
let t: TestApp;
let dispatcher: OutboxDispatcher;
const cookies = {} as Record<PlatformRole, string>;
let planId: string; // RMS, one vehicle, monthly + yearly
let lylPlanId: string; // LYL, one vehicle, monthly
let phoneSeq = 0;
const nextPhone = () => `+9665${String(73000000 + ++phoneSeq)}`;

interface Account {
  id: string;
  phone: string;
  access: string;
  sessionId: string;
}

async function account(opts: { push?: boolean } = {}): Promise<Account> {
  const phone = nextPhone();
  const id = (
    await t.db.query<{ id: string }>(
      `INSERT INTO customer_accounts (phone_e164, display_name) VALUES ($1, 'ريم') RETURNING id`,
      [phone],
    )
  ).rows[0]!.id;
  const sid = randomUUID();
  const access = newCustomerToken('access', sid);
  const push = opts.push ? `ExponentPushToken[sub-${sid.slice(0, 8)}]` : null;
  await t.db.query(
    `INSERT INTO customer_account_sessions (id, account_id, device_id, platform, refresh_hash, access_hash, push_token,
            push_provider, push_registered_at, access_expires_at, refresh_expires_at, created_at)
     VALUES ($1, $2, $3, 'ios', $4, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE 'expo' END,
             CASE WHEN $6::text IS NULL THEN NULL ELSE $7::timestamptz END,
             $7::timestamptz + interval '900 days', $7::timestamptz + interval '900 days', $7)`,
    [
      sid,
      id,
      `device-${sid}`,
      sha256Hex(newCustomerToken('refresh', sid)),
      sha256Hex(access),
      push,
      t.clock.now(),
    ],
  );
  return { id, phone, access, sessionId: sid };
}

let plateSeq = 0;
async function vehicle(a: Account): Promise<string> {
  const r = await t
    .http()
    .post(CUSTOMER_ROUTES.vehicleCreate.path)
    .set(bearer(a))
    .set('Idempotency-Key', newKey())
    .send({ plate: { country: 'SA', digits: String(6000 + ++plateSeq), letters_ar: 'ب ح د' } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.id as string;
}

const bearer = (a: Account) => ({ Authorization: `Bearer ${a.access}` });
const cmd = (a: Account, method: 'post' | 'put', path: string, body: unknown, key: string = newKey()) => {
  const server = t.http();
  const req = method === 'post' ? server.post(path) : server.put(path);
  return req
    .set(bearer(a))
    .set('Idempotency-Key', key)
    .send(body as object);
};
const token = (card: { number: string }) => sim.client.tokenize(card.number);
const subscribeBody = async (o: {
  vehicles: string[];
  cycle?: 'monthly' | 'yearly';
  card?: { number: string };
  plan?: string;
}) => ({
  plan_id: o.plan ?? planId,
  billing_cycle: o.cycle ?? 'monthly',
  vehicle_ids: o.vehicles,
  source: { type: 'token', token: await token(o.card ?? TEST_CARDS.success) },
  save_card: true,
  card_on_file_version: CARD_VERSION,
});
const subscribe = async (
  a: Account,
  o: { vehicles: string[]; cycle?: 'monthly' | 'yearly'; card?: { number: string }; plan?: string },
  key?: string,
) => cmd(a, 'post', CUSTOMER_ROUTES.subscribe.path, await subscribeBody(o), key);
const checkout = (r: { status: number; body: any }, status = 201) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return successEnvelopeSchema(CustomerSubscriptionCheckoutSchema).parse(r.body).data;
};
const subOf = async (a: Account, id: string) => {
  const r = await t.http().get(`/v1/customer/subscriptions/${id}`).set(bearer(a));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return successEnvelopeSchema(CustomerSubscriptionSchema).parse(r.body).data;
};
const row = async (id: string) =>
  (
    await t.db.query(
      `SELECT status, periods_paid, renewal_attempts, current_period_start, current_period_end, grace_ends_at,
              cancel_at_period_end, frozen_at, frozen_reason, ended_reason, price_halalas::int AS price,
              next_price_halalas::int AS next_price, plan_id, version, frozen_seconds_total::int AS frozen_s
         FROM subscriptions WHERE id = $1`,
      [id],
    )
  ).rows[0];
const errOf = (r: { status: number; body: any }) => ({
  status: r.status,
  code: r.body?.error?.code,
  details: r.body?.error?.details,
});
const settle = async () => {
  for (let round = 0; round < 3; round++) {
    await sim.client.flush();
    for (let i = 0; i < 10; i++) if ((await dispatcher.drain(200)) === 0) break;
  }
};
/** Moves the clock to `at` (never back) and runs every timer and webhook due by then. */
const goTo = async (at: Date) => {
  if (at.getTime() > t.clock.now().getTime()) t.clock.set(at);
  await settle();
};
const subPayments = async (subscriptionId: string) =>
  (
    await t.db.query<{ status: string; seq: number; amount: number; refunded: number; given_id: string }>(
      `SELECT status, subscription_period_seq AS seq, amount_halalas::int AS amount, refunded_halalas::int AS refunded,
              given_id FROM online_payments WHERE subscription_id = $1 ORDER BY created_at, id`,
      [subscriptionId],
    )
  ).rows;
const pushes = async (accountId: string) =>
  (
    await t.db.query<{ kind: string }>(
      `SELECT kind FROM customer_push_messages WHERE account_id = $1 AND subscription_id IS NOT NULL
        ORDER BY created_at, id`,
      [accountId],
    )
  ).rows.map((r) => r.kind);
const touch = () => t.db.query(`UPDATE platform_sessions SET last_seen_at = $1`, [t.clock.now()]);
async function platformGet(path: string, role: PlatformRole = 'platform_finance') {
  await touch();
  return t.http().get(path).set('Cookie', cookies[role]);
}
async function platformPost(path: string, role: PlatformRole, body: object, key: string = newKey()) {
  await touch();
  return t.http().post(path).set(CSRF).set('Cookie', cookies[role]).set('Idempotency-Key', key).send(body);
}

/** A staff command of the operator's owner with a session opened now (the clock moves by months here). */
async function ownerPatch(path: string, body: object) {
  const { cookie } = await createSessionCookie(t.db, SEED_IDS.users.OWN1, { now: t.clock.now(), hours: 1 });
  return t.http().patch(path).set(CSRF).set('Cookie', cookie).set('Idempotency-Key', newKey()).send(body);
}
async function ownerGet(path: string) {
  const { cookie } = await createSessionCookie(t.db, SEED_IDS.users.OWN1, { now: t.clock.now(), hours: 1 });
  return t.http().get(path).set('Cookie', cookie);
}

async function profile(venueId: string, category: string, enabled: boolean, approver: string) {
  await t.db.query(
    `INSERT INTO venue_public_profiles (venue_id, org_id, status, category, subscriptions_enabled, approved_by,
                                        approved_at)
     VALUES ($1, $2, 'approved', $3, $4, $5, now())
     ON CONFLICT (venue_id) DO UPDATE SET category = EXCLUDED.category, subscriptions_enabled = EXCLUDED.subscriptions_enabled`,
    [venueId, ORG, category, enabled, approver],
  );
}

beforeAll(async () => {
  process.env.MOYASAR_SECRET_KEY = DEFAULT_SECRET_KEY;
  process.env.MOYASAR_WEBHOOK_SECRET = DEFAULT_WEBHOOK_SECRET;
  let simNow = () => new Date('2026-10-27T16:00:00.000Z');
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
  dispatcher = new OutboxDispatcher(t.db, t.clock, logger, {
    workerId: 'subscriptions-worker',
    batchSize: 50,
  });
  for (const h of [...paymentsOnlineJobs({ runtime: rt }), ...subscriptionsJobs({ runtime: rt })])
    dispatcher.register(h);
  for (const [i, role] of ROLES.entries()) {
    const u = await t.db.query<{ id: string }>(
      `INSERT INTO platform_users (phone_e164, full_name, role, secret_hash, must_change_secret, mfa_enabled, mfa_secret_enc)
       VALUES ($1, $2, $3, 'x', false, true, 'x') RETURNING id`,
      [`+96655888000${i}`, `حساب ${role}`, role],
    );
    const tok = `subscriptions-test-session-${role}-0123456789`;
    await t.db.query(
      `INSERT INTO platform_sessions (platform_user_id, token_hash, mfa_verified, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, true, $3, $3, $3::timestamptz + interval '900 days')`,
      [u.rows[0]!.id, sha256Hex(tok), t.clock.now()],
    );
    cookies[role] = `${t.env.PLATFORM_SESSION_COOKIE_NAME}=${tok}`;
    if (role === 'platform_owner') {
      await profile(RMS, 'office', true, u.rows[0]!.id);
      await profile(LYL, 'mall', true, u.rows[0]!.id);
    }
  }
  const p = await platformPost('/v1/platform/plans', 'platform_finance', {
    venue_id: RMS,
    name_ar: 'سيارة واحدة',
    vehicles_included: 1,
    monthly_price_halalas: MONTHLY,
    yearly_price_halalas: YEARLY,
  });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  planId = p.body.data.plan_id;
  const l = await platformPost('/v1/platform/plans', 'platform_owner', {
    venue_id: LYL,
    name_ar: 'سيارة واحدة',
    vehicles_included: 1,
    monthly_price_halalas: 20_000,
  });
  expect(l.status, JSON.stringify(l.body)).toBe(201);
  lylPlanId = l.body.data.plan_id;
}, 120_000);
afterAll(async () => {
  await sim?.close();
  await t?.close();
});

describe('V2-030 — P-05 plans (platform.plan_manage)', () => {
  it('registers the P-05 and P-07 routes', () => {
    expect(
      PLATFORM_ROUTES.filter((r) => r.ticket === 'V2-030' || r.ticket === 'V2-035').map(
        (r) => `${r.method} ${r.path} ${r.permission}`,
      ),
    ).toEqual([
      'GET /v1/platform/plans platform.plan_manage',
      'POST /v1/platform/plans platform.plan_manage',
      'POST /v1/platform/plans/{planId}/retire platform.plan_manage',
      'GET /v1/platform/subscriptions platform.subscription_read',
      'GET /v1/platform/subscriptions/report platform.subscription_read',
      'GET /v1/platform/subscriptions/{subscriptionId} platform.subscription_read',
    ]);
  });

  it('owner and finance manage plans; admin and support are refused (02 §2.1)', async () => {
    for (const role of ROLES) {
      const r = await platformGet('/v1/platform/plans', role);
      const allowed = role === 'platform_owner' || role === 'platform_finance';
      expect(r.status, `${role} ${JSON.stringify(r.body)}`).toBe(allowed ? 200 : 403);
      if (!allowed) expect(r.body.error.code).toBe('PERMISSION_DENIED');
    }
    const r = await platformGet(`/v1/platform/plans?venue_id=${RMS}`, 'platform_owner');
    const venue = r.body.data[0];
    expect(venue).toMatchObject({ venue_id: RMS, subscriptions_enabled: true, subscriptions_allowed: true });
    expect(venue.plans.map((p: any) => p.plan_id)).toContain(planId);
    expect(r.headers['cache-control']).toContain('no-store');
  });

  it('a hall or a venue whose switch is off sells no subscription (V2-D07)', async () => {
    await t.db.query(`UPDATE venue_public_profiles SET category = 'hall' WHERE venue_id = $1`, [LYL]);
    const hall = await platformPost('/v1/platform/plans', 'platform_finance', {
      venue_id: LYL,
      name_ar: 'قاعة',
      vehicles_included: 1,
      monthly_price_halalas: MONTHLY,
    });
    expect(errOf(hall)).toMatchObject({
      status: 422,
      code: 'VALIDATION_FAILED',
      details: { fields: [{ field: 'venue_id', issue: 'not_recurring_venue' }] },
    });
    await t.db.query(
      `UPDATE venue_public_profiles SET category = 'mall', subscriptions_enabled = false WHERE venue_id = $1`,
      [LYL],
    );
    const off = await platformPost('/v1/platform/plans', 'platform_finance', {
      venue_id: LYL,
      name_ar: 'مول',
      vehicles_included: 1,
      monthly_price_halalas: MONTHLY,
    });
    expect(errOf(off).details.fields[0].issue).toBe('subscriptions_disabled');
    await t.db.query(`UPDATE venue_public_profiles SET subscriptions_enabled = true WHERE venue_id = $1`, [
      LYL,
    ]);
    const none = await platformPost('/v1/platform/plans', 'platform_finance', {
      venue_id: LYL,
      name_ar: 'بلا سعر',
      vehicles_included: 1,
    });
    expect(errOf(none).code).toBe('VALIDATION_FAILED');
  });

  it('a price change is a new plan retiring the old one; retire needs a reason and is final', async () => {
    const base = await platformPost('/v1/platform/plans', 'platform_finance', {
      venue_id: RMS,
      name_ar: 'سيارتان',
      vehicles_included: 2,
      monthly_price_halalas: 50_000,
    });
    const old = base.body.data.plan_id as string;
    const noReason = await platformPost('/v1/platform/plans', 'platform_finance', {
      venue_id: RMS,
      name_ar: 'سيارتان',
      vehicles_included: 2,
      monthly_price_halalas: 55_000,
      replaces_plan_id: old,
    });
    expect(errOf(noReason).code).toBe('REASON_REQUIRED');
    const next = await platformPost('/v1/platform/plans', 'platform_finance', {
      venue_id: RMS,
      name_ar: 'سيارتان',
      vehicles_included: 2,
      monthly_price_halalas: 55_000,
      replaces_plan_id: old,
      reason: 'تعديل السعر السنوي',
    });
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    expect(next.body.data).toMatchObject({
      status: 'active',
      replaces_plan_id: old,
      monthly_price_halalas: 55_000,
    });
    const list = await platformGet(`/v1/platform/plans?venue_id=${RMS}`);
    const retired = list.body.data[0].plans.find((p: any) => p.plan_id === old);
    expect(retired).toMatchObject({ status: 'retired', replaced_by_plan_id: next.body.data.plan_id });
    const again = await platformPost(`/v1/platform/plans/${old}/retire`, 'platform_finance', {
      reason: 'مرة ثانية',
    });
    expect(errOf(again)).toMatchObject({ status: 409, code: 'INVALID_STATE_TRANSITION' });
    const bare = await platformPost(
      `/v1/platform/plans/${next.body.data.plan_id}/retire`,
      'platform_finance',
      {},
    );
    expect(errOf(bare).code).toBe('REASON_REQUIRED');
    const audit = await t.db.query(
      `SELECT action FROM platform_audit_log WHERE entity_id = ANY($1) ORDER BY id`,
      [[old, next.body.data.plan_id]],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'subscription_plan.create',
      'subscription_plan.retire',
      'subscription_plan.create',
    ]);
    // the operator sees the plan commands of its venue in its own audit_log (platformAudit with the org)
    const op = await t.db.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND org_id = $2`,
      [old, ORG],
    );
    expect(op.rows[0].n).toBe(2);
    // retired: no longer sold on C-08
    await platformPost(`/v1/platform/plans/${next.body.data.plan_id}/retire`, 'platform_finance', {
      reason: 'إيقاف الباقة',
    });
  });

  it('C-08 shows the plans sold with their prices (VAT included) and the cheapest monthly one', async () => {
    const a = await account();
    const r = await t.http().get(`/v1/customer/locations/${RMS}`).set(bearer(a));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const l = successEnvelopeSchema(CustomerLocationDetailSchema).parse(r.body).data;
    expect(l.plans).toEqual([
      {
        plan_id: planId,
        name_ar: 'سيارة واحدة',
        vehicles_included: 1,
        monthly_price_halalas: MONTHLY,
        yearly_price_halalas: YEARLY,
      },
    ]);
    expect(l.monthly_from_halalas).toBe(MONTHLY);
  });
});

describe('V2-031 / V2-032 — the subscription machine (docs/v2/04 §1)', () => {
  it('H4: a month → its renewal → a failed renewal → grace retries on days 0, 1 and 3 → expired', async () => {
    const a = await account({ push: true });
    const v = await vehicle(a);
    const c = checkout(await subscribe(a, { vehicles: [v] }));
    expect(c.payment).toMatchObject({ status: 'paid', amount_halalas: MONTHLY, card_last4: '1111' });
    expect(c.payment.receipt).toMatchObject({ description: 'subscription', amount_halalas: MONTHLY });
    const id = c.subscription.subscription_id;
    const start = t.clock.now();
    const end1 = addBillingPeriods(start, 'monthly', 1);
    expect(c.subscription).toMatchObject({
      status: 'active',
      billing_cycle: 'monthly',
      price_halalas: MONTHLY,
      current_period_start: start.toISOString(),
      current_period_end: end1.toISOString(),
      renews_at: end1.toISOString(),
      can_cancel: true,
      can_pay: false,
    });
    expect(c.subscription.vehicles).toEqual([
      { vehicle_id: v, plate_display: expect.any(String), removed: false },
    ]);
    // C-06 and C-07 «مشترك فيه»
    const home = successEnvelopeSchema(CustomerHomeSchema).parse(
      (await t.http().get('/v1/customer/home').set(bearer(a))).body,
    ).data;
    expect(home.subscriptions).toEqual([
      expect.objectContaining({
        subscription_id: id,
        status: 'active',
        current_period_end: end1.toISOString(),
      }),
    ]);
    const sub = await t.http().get('/v1/customer/locations?filter=subscribed').set(bearer(a));
    expect(sub.body.data.items.map((x: any) => x.venue_id)).toEqual([RMS]);
    // the timers of the period: the notice 3 days before, the renewal at the end
    const timers = await t.db.query(
      `SELECT type, available_at FROM outbox_events
        WHERE aggregate_id = $1 AND status = 'pending' AND type <> 'job.pending_payment_expire' ORDER BY available_at`,
      [id],
    );
    expect(timers.rows.map((r) => [r.type, new Date(r.available_at).toISOString()])).toEqual([
      ['job.subscription_renewal_notice', new Date(end1.getTime() - 3 * DAY).toISOString()],
      ['job.subscription_renew', end1.toISOString()],
    ]);

    // the renewal notice
    await goTo(new Date(end1.getTime() - 3 * DAY));
    expect(await pushes(a.id)).toEqual(['subscription_renewal']);
    // the renewal: the default card charged, the new period from the old end (no gap, no free day)
    await goTo(end1);
    const end2 = addBillingPeriods(start, 'monthly', 2);
    expect(await row(id)).toMatchObject({ status: 'active', periods_paid: 2, renewal_attempts: 0 });
    expect((await row(id)).current_period_start.toISOString()).toBe(end1.toISOString());
    expect((await row(id)).current_period_end.toISOString()).toBe(end2.toISOString());
    expect((await subPayments(id)).map((p) => [p.seq, p.status])).toEqual([
      [1, 'paid'],
      [2, 'paid'],
    ]);
    const periods = await t.db.query(
      `SELECT seq, starts_at, ends_at FROM subscription_periods WHERE subscription_id = $1 ORDER BY seq`,
      [id],
    );
    expect(periods.rows.map((p) => [p.seq, p.ends_at.toISOString()])).toEqual([
      [1, end1.toISOString()],
      [2, end2.toISOString()],
    ]);

    // the next renewal fails: the default card is now one that declines (C-18)
    const declined = await cmd(a, 'post', CUSTOMER_ROUTES.paymentMethodCreate.path, {
      token: await token(TEST_CARDS.declined),
      card_on_file_version: CARD_VERSION,
      make_default: true,
    });
    expect(declined.status, JSON.stringify(declined.body)).toBe(201);
    await goTo(end2);
    const pastDue = await row(id);
    expect(pastDue).toMatchObject({ status: 'past_due', renewal_attempts: 1 });
    expect(pastDue.grace_ends_at.toISOString()).toBe(new Date(end2.getTime() + 3 * DAY).toISOString());
    // the second notice and the failure are pushed on the same clock tick: compared as a set
    expect((await pushes(a.id)).sort()).toEqual([
      'subscription_payment_failed',
      'subscription_renewal',
      'subscription_renewal',
    ]);
    expect(await subOf(a, id)).toMatchObject({ status: 'past_due', can_pay: true, renews_at: null });
    // day 1: the second attempt
    await goTo(new Date(end2.getTime() + 1 * DAY));
    expect(await row(id)).toMatchObject({ status: 'past_due', renewal_attempts: 2 });
    // day 3: the third attempt fails and the grace ends at once
    await goTo(new Date(end2.getTime() + 3 * DAY));
    expect(await row(id)).toMatchObject({
      status: 'expired',
      ended_reason: 'grace_expired',
      grace_ends_at: null,
    });
    expect((await pushes(a.id)).at(-1)).toBe('subscription_expired');
    // the safety-net timer finds it expired already
    await goTo(new Date(end2.getTime() + 3 * DAY + 2 * 3600_000));
    expect((await row(id)).status).toBe('expired');
    // every charge once: 2 paid periods + 3 declined attempts, each its own given_id (no attempt sent twice)
    const pays = await subPayments(id);
    expect(pays.map((p) => [p.seq, p.status])).toEqual([
      [1, 'paid'],
      [2, 'paid'],
      [3, 'failed'],
      [3, 'failed'],
      [3, 'failed'],
    ]);
    expect(pays.slice(2).map((p) => p.given_id)).toEqual([0, 1, 2].map((n) => renewalGivenId(id, 3, n)));
    const atGateway = (await sim.client.payments()).filter((p) => p.metadata?.subscription_id === id);
    expect(atGateway).toHaveLength(5);
    // the machine in the audit, POINT's and the customer's
    const audit = await t.db.query(
      `SELECT action FROM platform_audit_log WHERE entity_type = 'subscription' AND entity_id = $1 ORDER BY id`,
      [id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'subscription.subscribe',
      'subscription.first_payment_paid',
      'subscription.renewal_notice',
      'subscription.renewal_paid',
      'subscription.renewal_notice',
      'subscription.renewal_failed',
      'subscription.renewal_failed',
      'subscription.grace_expired',
    ]);
    // nothing of the subscription in the operator's audit_log (V2-D12, DEC-534)
    const op = await t.db.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1`, [id]);
    expect(op.rows[0].n).toBe(0);
    // a new subscription is possible again at the venue
    expect(checkout(await subscribe(a, { vehicles: [v] })).subscription.status).toBe('active');
  });

  it('yearly: twelve months, one charge a year at the yearly price', async () => {
    const a = await account();
    const v = await vehicle(a);
    const c = checkout(await subscribe(a, { vehicles: [v], cycle: 'yearly' }));
    const start = t.clock.now();
    const end = addBillingPeriods(start, 'yearly', 1);
    expect(c.subscription).toMatchObject({ billing_cycle: 'yearly', price_halalas: YEARLY });
    expect(c.subscription.current_period_end).toBe(end.toISOString());
    await goTo(end);
    expect(await row(c.subscription.subscription_id)).toMatchObject({ status: 'active', periods_paid: 2 });
    expect((await subPayments(c.subscription.subscription_id)).map((p) => p.amount)).toEqual([
      YEARLY,
      YEARLY,
    ]);
  });

  it('cancel at the end of the period, resume, cancel again: no renewal, canceled at the end', async () => {
    const a = await account();
    const v = await vehicle(a);
    const id = checkout(await subscribe(a, { vehicles: [v] })).subscription.subscription_id;
    const cancel = await cmd(a, 'post', `/v1/customer/subscriptions/${id}/cancel`, {});
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(cancel.body.data).toMatchObject({
      status: 'active',
      cancel_at_period_end: true,
      renews_at: null,
      can_resume: true,
    });
    const resume = await cmd(a, 'post', `/v1/customer/subscriptions/${id}/resume`, {});
    expect(resume.body.data).toMatchObject({ cancel_at_period_end: false, can_resume: false });
    expect((await cmd(a, 'post', `/v1/customer/subscriptions/${id}/cancel`, {})).status).toBe(200);
    const end = (await row(id)).current_period_end as Date;
    await goTo(end);
    expect(await row(id)).toMatchObject({ status: 'canceled', ended_reason: 'period_end' });
    expect(await subPayments(id)).toHaveLength(1);
    // a canceled one is final: resume refused
    expect(errOf(await cmd(a, 'post', `/v1/customer/subscriptions/${id}/resume`, {}))).toMatchObject({
      status: 409,
      code: 'SUBSCRIPTION_NOT_ACTIVE',
    });
    // another account's subscription is not found, the same as an unknown one
    const b = await account();
    expect(errOf(await cmd(b, 'post', `/v1/customer/subscriptions/${id}/cancel`, {}))).toMatchObject({
      status: 404,
      code: 'RESOURCE_NOT_FOUND',
    });
  });

  it('the checkout waits 30 minutes for its payment; a late 3-D Secure payment is refunded', async () => {
    const a = await account();
    const v = await vehicle(a);
    const c = checkout(await subscribe(a, { vehicles: [v], card: TEST_CARDS.threeDs }));
    expect(c.subscription).toMatchObject({ status: 'pending_payment', can_pay: true });
    expect(c.payment).toMatchObject({ status: 'initiated' });
    expect(c.payment.transaction_url).toMatch(/\/sim\/3ds\//);
    const id = c.subscription.subscription_id;
    // the same venue cannot be subscribed again meanwhile
    expect(errOf(await subscribe(a, { vehicles: [v] }))).toMatchObject({
      status: 409,
      code: 'SUBSCRIPTION_ALREADY_EXISTS',
      details: { subscription_id: id, status: 'pending_payment' },
    });
    await goTo(new Date(t.clock.now().getTime() + 31 * 60_000));
    expect(await row(id)).toMatchObject({ status: 'canceled', ended_reason: 'pending_expired' });
    const gp = (
      await t.db.query(`SELECT gateway_payment_id FROM online_payments WHERE id = $1`, [c.payment.payment_id])
    ).rows[0].gateway_payment_id;
    await sim.client.complete3ds(gp, 'success');
    await settle();
    const refunds = await t.db.query(
      `SELECT kind, reason, amount_halalas::int AS amount, status FROM refunds WHERE online_payment_id = $1`,
      [c.payment.payment_id],
    );
    expect(refunds.rows).toEqual([
      { kind: 'system', reason: 'not_due', amount: MONTHLY, status: 'succeeded' },
    ]);
    expect((await row(id)).status).toBe('canceled');
  });

  it('a declined first payment: PAYMENT_FAILED naming the subscription; paid with another card it starts', async () => {
    const a = await account();
    const v = await vehicle(a);
    const r = await subscribe(a, { vehicles: [v], card: TEST_CARDS.declined });
    expect(errOf(r)).toMatchObject({ status: 402, code: 'PAYMENT_FAILED' });
    const id = r.body.error.details.subscription_id as string;
    expect(await subOf(a, id)).toMatchObject({ status: 'pending_payment', can_pay: true });
    // the card of a declined payment is not kept
    expect((await t.http().get('/v1/customer/payment-methods').set(bearer(a))).body.data.items).toEqual([]);
    const apple = await cmd(a, 'post', `/v1/customer/subscriptions/${id}/pay`, {
      source: { type: 'applepay', token: 'apple-pay-token' },
    });
    expect(errOf(apple)).toMatchObject({ status: 422, code: 'SUBSCRIPTION_CARD_REQUIRED' });
    const noSave = await cmd(a, 'post', `/v1/customer/subscriptions/${id}/pay`, {
      source: { type: 'token', token: await token(TEST_CARDS.success) },
    });
    expect(errOf(noSave).code).toBe('SUBSCRIPTION_CARD_REQUIRED');
    const noConsent = await cmd(a, 'post', `/v1/customer/subscriptions/${id}/pay`, {
      source: { type: 'token', token: await token(TEST_CARDS.success) },
      save_card: true,
    });
    expect(errOf(noConsent).code).toBe('CUSTOMER_CONSENT_REQUIRED');
    const paid = checkout(
      await cmd(a, 'post', `/v1/customer/subscriptions/${id}/pay`, {
        source: { type: 'token', token: await token(TEST_CARDS.success) },
        save_card: true,
        card_on_file_version: CARD_VERSION,
      }),
    );
    expect(paid.subscription.status).toBe('active');
    expect(paid.payment.saved_payment_method_id).toEqual(expect.any(String));
    // nothing left to pay
    const more = await cmd(a, 'post', `/v1/customer/subscriptions/${id}/pay`, {
      source: { type: 'saved', payment_method_id: paid.payment.saved_payment_method_id },
    });
    expect(errOf(more)).toMatchObject({ status: 409, code: 'SUBSCRIPTION_NOT_ACTIVE' });
  });

  it('the plan and its cycle must be on sale; the vehicles are the account’s own, up to the plan’s', async () => {
    const a = await account();
    const v = await vehicle(a);
    const w2 = await vehicle(a);
    expect(errOf(await subscribe(a, { vehicles: [v, w2] }))).toMatchObject({
      status: 422,
      code: 'VALIDATION_FAILED',
      details: { fields: [{ field: 'vehicle_ids', issue: 'too_many', max: 1 }] },
    });
    const b = await account();
    const foreign = await vehicle(b);
    expect(errOf(await subscribe(a, { vehicles: [foreign] }))).toMatchObject({
      status: 404,
      code: 'RESOURCE_NOT_FOUND',
      details: { resource: 'customer_vehicle' },
    });
    expect(errOf(await subscribe(a, { vehicles: [v], cycle: 'yearly', plan: lylPlanId }))).toMatchObject({
      status: 409,
      code: 'SUBSCRIPTION_PLAN_UNAVAILABLE',
      details: { reason: 'cycle' },
    });
    expect(errOf(await subscribe(a, { vehicles: [v], plan: randomUUID() }))).toMatchObject({
      status: 404,
      code: 'RESOURCE_NOT_FOUND',
    });
  });

  it('one live subscription per account and venue, under a race of two checkouts', async () => {
    const a = await account();
    const v = await vehicle(a);
    const [x, y] = await Promise.all([subscribe(a, { vehicles: [v] }), subscribe(a, { vehicles: [v] })]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    const loser = x.status === 409 ? x : y;
    expect(loser.body.error.code).toBe('SUBSCRIPTION_ALREADY_EXISTS');
    const live = await t.db.query(
      `SELECT count(*)::int AS n FROM subscriptions WHERE account_id = $1 AND status IN ('pending_payment','active')`,
      [a.id],
    );
    expect(live.rows[0].n).toBe(1);
    // the same key twice: one subscription, one payment, the replay answered as the first
    const b = await account();
    const vb = await vehicle(b);
    const key = newKey();
    const body = await subscribeBody({ vehicles: [vb] });
    const first = checkout(await cmd(b, 'post', CUSTOMER_ROUTES.subscribe.path, body, key));
    const replay = await cmd(b, 'post', CUSTOMER_ROUTES.subscribe.path, body, key);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.subscription.subscription_id).toBe(first.subscription.subscription_id);
    expect(await subPayments(first.subscription.subscription_id)).toHaveLength(1);
  });

  it('a renewal never charges twice: two workers running the same attempt send one given_id', async () => {
    const a = await account();
    const v = await vehicle(a);
    const id = checkout(await subscribe(a, { vehicles: [v] })).subscription.subscription_id;
    const end = (await row(id)).current_period_end as Date;
    // a duplicate of the renewal job (no dedupe key): both run in the same drain
    await t.db.query(
      `INSERT INTO outbox_events (org_id, type, aggregate_type, aggregate_id, payload, available_at)
       SELECT org_id, type, aggregate_type, aggregate_id, payload, available_at FROM outbox_events
        WHERE type = 'job.subscription_renew' AND aggregate_id = $1 AND status = 'pending'`,
      [id],
    );
    await goTo(end);
    const pays = await subPayments(id);
    expect(pays.map((p) => [p.seq, p.status])).toEqual([
      [1, 'paid'],
      [2, 'paid'],
    ]);
    expect((await sim.client.payments()).filter((p) => p.metadata?.subscription_id === id)).toHaveLength(2);
  });

  it('the covered vehicle changes once per period (01 R6)', async () => {
    const a = await account();
    const v = await vehicle(a);
    const w2 = await vehicle(a);
    const id = checkout(await subscribe(a, { vehicles: [v] })).subscription.subscription_id;
    const path = `/v1/customer/subscriptions/${id}/vehicles`;
    const changed = await cmd(a, 'put', path, { vehicle_ids: [w2] });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.data.vehicles.map((x: any) => x.vehicle_id)).toEqual([w2]);
    expect(changed.body.data.can_change_vehicles).toBe(false);
    // the same list again is no change; another one is refused until the next period
    expect((await cmd(a, 'put', path, { vehicle_ids: [w2] })).status).toBe(200);
    expect(errOf(await cmd(a, 'put', path, { vehicle_ids: [v] }))).toMatchObject({
      status: 409,
      code: 'SUBSCRIPTION_VEHICLES_LOCKED',
    });
    await goTo((await row(id)).current_period_end as Date);
    expect((await cmd(a, 'put', path, { vehicle_ids: [v] })).status).toBe(200);
  });

  it('a price change reaches a subscriber at the renewal announced by its notice (DEC-531)', async () => {
    const a = await account({ push: true });
    const v = await vehicle(a);
    const p = await platformPost('/v1/platform/plans', 'platform_finance', {
      venue_id: LYL,
      name_ar: 'مول شهري',
      vehicles_included: 1,
      monthly_price_halalas: 15_000,
    });
    const oldPlan = p.body.data.plan_id as string;
    const id = checkout(await subscribe(a, { vehicles: [v], plan: oldPlan })).subscription.subscription_id;
    const end = (await row(id)).current_period_end as Date;
    const next = await platformPost('/v1/platform/plans', 'platform_finance', {
      venue_id: LYL,
      name_ar: 'مول شهري',
      vehicles_included: 1,
      monthly_price_halalas: 18_000,
      replaces_plan_id: oldPlan,
      reason: 'السعر الجديد',
    });
    // the subscriber keeps its price; the notice announces the new one; the renewal charges it
    expect((await row(id)).price).toBe(15_000);
    await goTo(new Date(end.getTime() - 3 * DAY));
    expect(await row(id)).toMatchObject({ price: 15_000, next_price: 18_000 });
    expect(await subOf(a, id)).toMatchObject({ price_halalas: 15_000, next_price_halalas: 18_000 });
    await goTo(end);
    expect(await row(id)).toMatchObject({ price: 18_000, next_price: null, plan_id: next.body.data.plan_id });
    expect((await subPayments(id)).map((x) => x.amount)).toEqual([15_000, 18_000]);
  });

  it('the account’s deletion cancels its live subscriptions (04 §1), nothing renews after', async () => {
    const a = await account();
    const v = await vehicle(a);
    const id = checkout(await subscribe(a, { vehicles: [v] })).subscription.subscription_id;
    const n = await t.db.transaction((tx) =>
      subscriptionLifecycleEffects.onAccountDeleted(tx, { accountId: a.id, requestId: 'test' }),
    );
    expect(n).toBe(1);
    expect(await row(id)).toMatchObject({ status: 'canceled', ended_reason: 'account_deleted' });
    await goTo((await row(id)).current_period_end as Date);
    expect(await subPayments(id)).toHaveLength(1);
  });
});

describe('V2-035 — P-07 subscriptions and report (platform.subscription_read)', () => {
  it('finance and owner read the list, one subscription and the report; customers masked', async () => {
    for (const role of ROLES) {
      const r = await platformGet('/v1/platform/subscriptions/report', role);
      const allowed = role === 'platform_owner' || role === 'platform_finance';
      expect(r.status, role).toBe(allowed ? 200 : 403);
    }
    const a = await account();
    const v = await vehicle(a);
    const id = checkout(await subscribe(a, { vehicles: [v] })).subscription.subscription_id;
    const list = await platformGet(`/v1/platform/subscriptions?status=active&venue_id=${RMS}&limit=100`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const item = list.body.data.find((x: any) => x.subscription_id === id);
    expect(item).toMatchObject({ status: 'active', venue_id: RMS, price_halalas: MONTHLY });
    expect(item.phone_masked).not.toContain(a.phone.slice(-7, -3));
    expect(JSON.stringify(list.body)).not.toContain(a.phone);
    const one = await platformGet(`/v1/platform/subscriptions/${id}`);
    expect(one.body.data.periods).toHaveLength(1);
    expect(one.body.data.payments[0]).toMatchObject({ status: 'paid', seq: 1 });
    expect(one.body.data.timeline.map((x: any) => x.action)).toEqual([
      'subscription.subscribe',
      'subscription.first_payment_paid',
    ]);
    expect((await platformGet(`/v1/platform/subscriptions/${randomUUID()}`)).status).toBe(404);
    const report = (await platformGet('/v1/platform/subscriptions/report?days=30')).body.data;
    const active = Number(
      (await t.db.query(`SELECT count(*)::int AS n FROM subscriptions WHERE status = 'active'`)).rows[0].n,
    );
    expect(report.active_subscribers).toBe(active);
    const mrr = (
      await t.db.query(
        `SELECT COALESCE(sum(CASE WHEN billing_cycle = 'yearly' THEN round(price_halalas / 12.0) ELSE price_halalas END), 0)::int AS m
           FROM subscriptions WHERE status = 'active'`,
      )
    ).rows[0].m;
    expect(report.mrr_halalas).toBe(mrr);
    expect(report.venues.find((x: any) => x.venue_id === RMS).active).toBeGreaterThan(0);
    expect(report.churn.count).toBeGreaterThanOrEqual(1);
    const due = await platformGet(
      `/v1/platform/subscriptions?renews_before=${encodeURIComponent(new Date(t.clock.now().getTime() + 40 * DAY).toISOString())}`,
    );
    expect(due.body.data.every((x: any) => x.status === 'active' && !x.cancel_at_period_end)).toBe(true);
  });
});

describe('V2-034 — freeze with the operator and the venue (04 §1, 02 §4)', () => {
  it('a closed venue freezes its subscriptions; reopened, the frozen days are added to the period', async () => {
    const a = await account();
    const v = await vehicle(a);
    const id = checkout(await subscribe(a, { vehicles: [v], plan: lylPlanId })).subscription.subscription_id;
    const before = await row(id);
    const venue = await ownerGet(`/v1/venues/${LYL}`);
    const close = await ownerPatch(`/v1/venues/${LYL}`, {
      expected_version: venue.body.data.version,
      status: 'inactive',
    });
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'frozen', frozen_reason: 'venue_inactive' });
    // the old renewal timer passes while frozen: nothing is charged
    await goTo(new Date((before.current_period_end as Date).getTime() + DAY));
    expect(await subPayments(id)).toHaveLength(1);
    const frozenFor = t.clock.now().getTime() - (await row(id)).frozen_at.getTime();
    const open = await ownerPatch(`/v1/venues/${LYL}`, {
      expected_version: close.body.data.version,
      status: 'active',
    });
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    const after = await row(id);
    expect(after.status).toBe('active');
    expect(after.current_period_end.getTime()).toBe(
      (before.current_period_end as Date).getTime() + Math.floor(frozenFor / 1000) * 1000,
    );
    // the renewal runs at the new end
    await goTo(after.current_period_end);
    expect(await row(id)).toMatchObject({ status: 'active', periods_paid: 2 });
  });

  it('operator suspension freezes; reactivation unfreezes with the days added; termination refunds pro rata', async () => {
    const a = await account();
    const v = await vehicle(a);
    const c = checkout(await subscribe(a, { vehicles: [v] }));
    const id = c.subscription.subscription_id;
    const before = await row(id);
    const suspend = await platformPost(`/v1/platform/operators/${ORG}/suspend`, 'platform_owner', {
      reason: 'تأخر دفع اشتراك النظام',
    });
    expect(suspend.status, JSON.stringify(suspend.body)).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'frozen', frozen_reason: 'operator_suspended' });
    expect(await subOf(a, id)).toMatchObject({ status: 'frozen', renews_at: null, can_cancel: true });
    await goTo(new Date(t.clock.now().getTime() + 10 * DAY));
    const reactivate = await platformPost(`/v1/platform/operators/${ORG}/reactivate`, 'platform_owner', {});
    expect(reactivate.status, JSON.stringify(reactivate.body)).toBe(200);
    const after = await row(id);
    expect(after.status).toBe('active');
    expect(after.current_period_end.getTime() - (before.current_period_end as Date).getTime()).toBe(10 * DAY);
    expect(after.frozen_s).toBe(10 * 86_400);
    const ext = await t.db.query(
      `SELECT extended_seconds::int AS s FROM subscription_periods WHERE subscription_id = $1`,
      [id],
    );
    expect(ext.rows[0].s).toBe(10 * 86_400);

    // suspended again, 5 days later terminated: canceled, the unused share refunded by the platform
    await platformPost(`/v1/platform/operators/${ORG}/suspend`, 'platform_owner', {
      reason: 'مخالفة متكررة',
    });
    const frozen = await row(id);
    await goTo(new Date(t.clock.now().getTime() + 5 * DAY));
    const terminate = await platformPost(`/v1/platform/operators/${ORG}/terminate`, 'platform_owner', {
      reason: 'إنهاء العقد',
    });
    expect(terminate.status, JSON.stringify(terminate.body)).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'canceled', ended_reason: 'operator_terminated' });
    const period = (
      await t.db.query(`SELECT starts_at, ends_at FROM subscription_periods WHERE subscription_id = $1`, [id])
    ).rows[0];
    const expected = Math.floor(
      (MONTHLY * (period.ends_at.getTime() - frozen.frozen_at.getTime())) /
        (period.ends_at.getTime() - period.starts_at.getTime()),
    );
    await settle();
    const refunds = await t.db.query(
      `SELECT kind, reason, amount_halalas::int AS amount, status FROM refunds WHERE online_payment_id = $1`,
      [c.payment.payment_id],
    );
    expect(refunds.rows).toEqual([
      { kind: 'system', reason: 'subscription_prorated', amount: expected, status: 'succeeded' },
    ]);
    expect((await subPayments(id))[0]).toMatchObject({ status: 'partially_refunded', refunded: expected });
    // no double-payment alert for a refund that is the rule
    const alerts = await t.db.query(
      `SELECT count(*)::int AS n FROM platform_alerts WHERE online_payment_id = $1`,
      [c.payment.payment_id],
    );
    expect(alerts.rows[0].n).toBe(0);
  });
});
