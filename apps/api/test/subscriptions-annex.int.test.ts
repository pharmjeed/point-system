import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  createLogger,
  FakeClock,
  newCustomerToken,
  OutboxDispatcher,
  PaymentsRuntime,
  paymentsOnlineJobs,
  sha256Hex,
  subscriptionLifecycleEffects,
  subscriptionsJobs,
} from '@point/server';
import {
  addDays,
  nthServiceDay,
  PLATFORM_ROUTES,
  riyadhMidnight,
  SUNDAY_TO_THURSDAY_MASK,
  type PlatformRole,
} from '@point/shared';
import {
  CUSTOMER_ROUTES,
  CustomerComplaintSchema,
  CustomerLocationDetailSchema,
  CustomerSubscriptionCheckoutSchema,
  CustomerSubscriptionSchema,
  SUBSCRIPTION_TERMS_VERSION,
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
import { CSRF, createTestApp, newKey, SEED_IDS, type TestApp } from './harness.js';

/**
 * V2-036 / V2-037 — the subscriptions annex (docs/v2/04 §7; DEC-590 … DEC-604) on a real PostgreSQL, the payment
 * simulator and an injected clock that starts on Sunday 2026-11-01 09:00 Riyadh: a student plan of 22 counted days
 * Sunday … Thursday, renewed by hand, non-refundable, checked for eligibility, one visit a day, one freeze of 5
 * counted days per term, a capacity, continuing through a closure; the eligibility review and the eligible list, the
 * purchase consent, the counted-day term and its end, the customer's freeze (scheduled, started, returned, early
 * reactivation), the closures calendar, the exceptional refund, the capacity, and the complaints with a reference.
 */

const ORG = SEED_IDS.org;
const RMS = SEED_IDS.venues.RMS;
const PRICE = 17_250; // 150.00 SAR before VAT + 15% = 172.50
const TERMS = SUBSCRIPTION_TERMS_VERSION;
const PRIVACY = '2026-11-01';
const ROLES: PlatformRole[] = ['platform_owner', 'platform_admin', 'platform_finance', 'platform_support'];
const M = SUNDAY_TO_THURSDAY_MASK;

let sim: RunningPaymentSimulator;
let t: TestApp;
let dispatcher: OutboxDispatcher;
const cookies = {} as Record<PlatformRole, string>;
let planId: string;
let phoneSeq = 0;
const nextPhone = () => `+9665${String(76000000 + ++phoneSeq)}`;
let numberSeq = 0;
const studentNumber = () => `44${String(1000000 + ++numberSeq)}`;

interface Account {
  id: string;
  access: string;
}

async function account(): Promise<Account> {
  const id = (
    await t.db.query<{ id: string }>(
      `INSERT INTO customer_accounts (phone_e164, display_name) VALUES ($1, 'طالب') RETURNING id`,
      [nextPhone()],
    )
  ).rows[0]!.id;
  const sid = randomUUID();
  const access = newCustomerToken('access', sid);
  await t.db.query(
    `INSERT INTO customer_account_sessions (id, account_id, device_id, platform, refresh_hash, access_hash, push_token,
            push_provider, push_registered_at, access_expires_at, refresh_expires_at, created_at)
     VALUES ($1, $2, $3, 'ios', $4, $5, $6, 'expo', $7, $7::timestamptz + interval '900 days',
             $7::timestamptz + interval '900 days', $7)`,
    [
      sid,
      id,
      `device-${sid}`,
      sha256Hex(newCustomerToken('refresh', sid)),
      sha256Hex(access),
      `ExponentPushToken[annex-${sid.slice(0, 8)}]`,
      t.clock.now(),
    ],
  );
  return { id, access };
}

let plateSeq = 0;
async function vehicle(a: Account): Promise<string> {
  const r = await cmd(a, 'post', CUSTOMER_ROUTES.vehicleCreate.path, {
    plate: { country: 'SA', digits: String(7000 + ++plateSeq), letters_ar: 'ب ح د' },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.id as string;
}

const bearer = (a: Account) => ({ Authorization: `Bearer ${a.access}` });
function cmd(a: Account, method: 'post' | 'put', path: string, body: unknown, key: string = newKey()) {
  const server = t.http();
  const req = method === 'post' ? server.post(path) : server.put(path);
  return req
    .set(bearer(a))
    .set('Idempotency-Key', key)
    .send(body as object);
}
const errOf = (r: { status: number; body: any }) => ({
  status: r.status,
  code: r.body?.error?.code,
  details: r.body?.error?.details,
});
const subOf = async (a: Account, id: string) => {
  const r = await t.http().get(`/v1/customer/subscriptions/${id}`).set(bearer(a));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return successEnvelopeSchema(CustomerSubscriptionSchema).parse(r.body).data;
};
const row = async (id: string) =>
  (
    await t.db.query(
      `SELECT status, frozen_reason, frozen_remaining_days, service_start_on::text AS start_on,
              service_end_on::text AS end_on, current_period_start, current_period_end, ended_reason, refund_due_at
         FROM subscriptions WHERE id = $1`,
      [id],
    )
  ).rows[0];
const pushes = async (accountId: string) =>
  (
    await t.db.query<{ kind: string }>(
      `SELECT kind FROM customer_push_messages WHERE account_id = $1 ORDER BY created_at, id`,
      [accountId],
    )
  ).rows.map((r) => r.kind);
const settle = async () => {
  for (let round = 0; round < 3; round++) {
    await sim.client.flush();
    for (let i = 0; i < 10; i++) if ((await dispatcher.drain(200)) === 0) break;
  }
};
const goTo = async (at: Date) => {
  if (at.getTime() > t.clock.now().getTime()) t.clock.set(at);
  await settle();
};
const touch = () => t.db.query(`UPDATE platform_sessions SET last_seen_at = $1`, [t.clock.now()]);
async function platformGet(path: string, role: PlatformRole = 'platform_finance') {
  await touch();
  return t.http().get(path).set('Cookie', cookies[role]);
}
async function platformPost(path: string, role: PlatformRole, body: object, key: string = newKey()) {
  await touch();
  return t.http().post(path).set(CSRF).set('Cookie', cookies[role]).set('Idempotency-Key', key).send(body);
}
const consent = {
  terms_version: TERMS,
  privacy_version: PRIVACY,
  non_refundable: true,
  valuables_notice: true,
};
const token = (card: { number: string } = TEST_CARDS.success) => sim.client.tokenize(card.number);
async function pay(a: Account, subscriptionId: string, withConsent = true) {
  return cmd(a, 'post', `/v1/customer/subscriptions/${subscriptionId}/pay`, {
    // a plan renewed by hand takes a card that is not kept (DEC-595)
    source: { type: 'token', token: await token() },
    ...(withConsent ? { purchase_consent: consent } : {}),
  });
}
async function apply(a: Account, number = studentNumber(), vehicles?: string[]) {
  return cmd(a, 'post', CUSTOMER_ROUTES.subscriptionApply.path, {
    plan_id: planId,
    vehicle_ids: vehicles ?? [await vehicle(a)],
    student_number: number,
    student_name: 'طالب تجريبي',
  });
}
/** An application approved by P-07 and paid: the subscription id. */
async function activeSubscription(a: Account): Promise<string> {
  const r = await apply(a);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const id = r.body.data.subscription_id as string;
  const ok = await platformPost(`/v1/platform/subscriptions/${id}/eligibility`, 'platform_finance', {
    decision: 'approve',
  });
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  const paid = await pay(a, id);
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  await settle();
  expect((await subOf(a, id)).status).toBe('active');
  return id;
}

beforeAll(async () => {
  process.env.MOYASAR_SECRET_KEY = DEFAULT_SECRET_KEY;
  process.env.MOYASAR_WEBHOOK_SECRET = DEFAULT_WEBHOOK_SECRET;
  const clock = new FakeClock('2026-11-01T06:00:00.000Z'); // Sunday 09:00 Asia/Riyadh
  sim = await startPaymentSimulator({ env: {}, now: () => clock.now() });
  t = await createTestApp({ clock, env: { MOYASAR_BASE_URL: sim.url, MOYASAR_HTTP_TIMEOUT_MS: '3000' } });
  (t.db.config as { lockTimeoutMs?: number }).lockTimeoutMs = 20000;
  await t.app.listen(0, '127.0.0.1');
  const apiUrl = `http://127.0.0.1:${(t.app.getHttpServer() as { address(): AddressInfo }).address().port}`;
  await sim.client.configure({ webhookUrl: `${apiUrl}/webhooks/payments/moyasar`, autoWebhooks: true });
  const logger = createLogger({ level: 'silent' });
  const rt = new PaymentsRuntime({ env: t.env, logger });
  dispatcher = new OutboxDispatcher(t.db, t.clock, logger, { workerId: 'annex-worker', batchSize: 50 });
  for (const h of [...paymentsOnlineJobs({ runtime: rt }), ...subscriptionsJobs({ runtime: rt })])
    dispatcher.register(h);
  for (const [i, role] of ROLES.entries()) {
    const u = await t.db.query<{ id: string }>(
      `INSERT INTO platform_users (phone_e164, full_name, role, secret_hash, must_change_secret, mfa_enabled, mfa_secret_enc)
       VALUES ($1, $2, $3, 'x', false, true, 'x') RETURNING id`,
      [`+96655777000${i}`, `حساب ${role}`, role],
    );
    const tok = `annex-test-session-${role}-0123456789`;
    await t.db.query(
      `INSERT INTO platform_sessions (platform_user_id, token_hash, mfa_verified, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, true, $3, $3, $3::timestamptz + interval '900 days')`,
      [u.rows[0]!.id, sha256Hex(tok), t.clock.now()],
    );
    cookies[role] = `${t.env.PLATFORM_SESSION_COOKIE_NAME}=${tok}`;
    if (role === 'platform_owner')
      await t.db.query(
        `INSERT INTO venue_public_profiles (venue_id, org_id, status, category, subscriptions_enabled, approved_by,
                                            approved_at)
         VALUES ($1, $2, 'approved', 'other', true, $3, now())`,
        [RMS, ORG, u.rows[0]!.id],
      );
  }
}, 120_000);
afterAll(async () => {
  await sim?.close();
  await t?.close();
});

describe('V2-036 — the student plan as data (P-05, 04 §7, DEC-590)', () => {
  it('registers the annex routes with their permissions', () => {
    expect(
      PLATFORM_ROUTES.filter((r) => r.ticket === 'V2-036' || r.ticket === 'V2-037').map(
        (r) => `${r.method} ${r.path} ${r.permission}`,
      ),
    ).toEqual([
      'POST /v1/platform/subscriptions/{subscriptionId}/eligibility platform.subscription_manage',
      'POST /v1/platform/subscriptions/{subscriptionId}/exceptional-refund platform.refund_issue',
      'GET /v1/platform/venues/{venueId}/eligible-students platform.subscription_manage',
      'POST /v1/platform/venues/{venueId}/eligible-students platform.subscription_manage',
      'GET /v1/platform/venue-closures platform.plan_manage',
      'POST /v1/platform/venue-closures platform.plan_manage',
      'POST /v1/platform/venue-closures/{closureId}/cancel platform.plan_manage',
      'GET /v1/platform/complaints platform.complaint_manage',
      'GET /v1/platform/complaints/{complaintId} platform.complaint_manage',
      'POST /v1/platform/complaints/{complaintId}/status platform.complaint_manage',
    ]);
  });

  it('refuses incoherent policies: a counted-day term sold yearly, renewed automatically, or a freeze without one', async () => {
    const base = { venue_id: RMS, name_ar: 'باقة', vehicles_included: 1, monthly_price_halalas: PRICE };
    for (const extra of [
      {
        term_kind: 'service_days',
        service_days: 22,
        service_weekdays: [0, 1, 2, 3, 4],
        yearly_price_halalas: 100_000,
      },
      {
        term_kind: 'service_days',
        service_days: 22,
        service_weekdays: [0, 1, 2, 3, 4],
        renewal_mode: 'auto',
      },
      { term_kind: 'service_days' },
      { freeze_max_times: 1, freeze_max_days: 5 },
      { service_days: 22 },
    ]) {
      const r = await platformPost('/v1/platform/plans', 'platform_finance', { ...base, ...extra });
      expect(errOf(r), JSON.stringify(extra)).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    }
  });

  it('P-05 creates the student plan with its policies', async () => {
    const r = await platformPost('/v1/platform/plans', 'platform_finance', {
      venue_id: RMS,
      name_ar: 'باقة الطالب الشهرية',
      vehicles_included: 1,
      monthly_price_halalas: PRICE,
      term_kind: 'service_days',
      service_days: 22,
      service_weekdays: [0, 1, 2, 3, 4],
      renewal_mode: 'manual',
      daily_visit_limit: 1,
      refund_policy: 'non_refundable',
      closure_policy: 'continue',
      freeze_max_times: 1,
      freeze_max_days: 5,
      eligibility: 'student_id_review',
      capacity: 6,
      audience_ar: 'طلاب وطالبات الجامعة',
      vehicle_change: 'any_time',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    planId = r.body.data.plan_id;
    expect(r.body.data).toMatchObject({
      term_kind: 'service_days',
      service_days: 22,
      service_weekdays: [0, 1, 2, 3, 4],
      renewal_mode: 'manual',
      daily_visit_limit: 1,
      refund_policy: 'non_refundable',
      closure_policy: 'continue',
      freeze_max_times: 1,
      freeze_max_days: 5,
      eligibility: 'student_id_review',
      capacity: 6,
      seats_taken: 0,
      vehicle_change: 'any_time',
    });
    const db = await t.db.query(`SELECT service_weekdays_mask FROM subscription_plans WHERE id = $1`, [
      planId,
    ]);
    expect(db.rows[0].service_weekdays_mask).toBe(M);
  });

  it('C-08 shows the net price, the VAT and the total, the 22 counted days if paid now, and the closures', async () => {
    const closure = await platformPost('/v1/platform/venue-closures', 'platform_finance', {
      venue_id: RMS,
      kind: 'holiday',
      starts_on: '2026-11-22',
      ends_on: '2026-11-26',
      reason_ar: 'إجازة منتصف الفصل',
    });
    expect(closure.status, JSON.stringify(closure.body)).toBe(201);
    const a = await account();
    const r = await t.http().get(`/v1/customer/locations/${RMS}`).set(bearer(a));
    const l = successEnvelopeSchema(CustomerLocationDetailSchema).parse(r.body).data;
    const plan = l.plans.find((p) => p.plan_id === planId)!;
    expect(plan).toMatchObject({
      monthly_price_halalas: PRICE,
      monthly_breakdown: { net_halalas: 15_000, vat_halalas: 2_250, total_halalas: PRICE, vat_rate_bp: 1500 },
      sold_out: false,
      terms_version: TERMS,
      privacy_version: PRIVACY,
      audience_ar: 'طلاب وطالبات الجامعة',
      // paid now (Sunday 09:00, before the 12:00 cutoff): day 1 today, day 22 Monday 2026-11-30
      term_preview: { starts_on: '2026-11-01', ends_on: '2026-11-30' },
    });
    expect(plan.policy).toMatchObject({ term_kind: 'service_days', refund_policy: 'non_refundable' });
    expect(l.closures).toEqual([
      expect.objectContaining({ kind: 'holiday', starts_on: '2026-11-22', ends_on: '2026-11-26' }),
    ]);
    // a holiday does not move a counted day: the preview's end is the same with it
    expect(nthServiceDay('2026-11-01', 22, M)).toBe('2026-11-30');
  });
});

describe('V2-036 — eligibility, the purchase consent and the counted-day term (DEC-591, DEC-596, DEC-601)', () => {
  it('the plan is applied for, never paid directly; a rejection needs a reason and ends the application', async () => {
    const a = await account();
    const v = await vehicle(a);
    const direct = await cmd(a, 'post', CUSTOMER_ROUTES.subscribe.path, {
      plan_id: planId,
      billing_cycle: 'monthly',
      vehicle_ids: [v],
      source: { type: 'token', token: await token() },
      purchase_consent: consent,
    });
    expect(errOf(direct)).toMatchObject({ status: 422, code: 'SUBSCRIPTION_ELIGIBILITY_REQUIRED' });
    const r = await apply(a, 'S-1001', [v]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const s = successEnvelopeSchema(CustomerSubscriptionSchema).parse(r.body).data;
    expect(s).toMatchObject({
      status: 'pending_eligibility',
      can_pay: false,
      can_cancel: true,
      eligibility: { status: 'pending', student_number_masked: '•••001' },
    });
    // nothing to pay before the decision
    expect(errOf(await pay(a, s.subscription_id))).toMatchObject({ code: 'SUBSCRIPTION_NOT_ACTIVE' });
    // P-07's queue: the application in full for the reviewer, masked in the list
    const list = await platformGet('/v1/platform/subscriptions?status=pending_eligibility');
    expect(list.body.data.find((x: any) => x.subscription_id === s.subscription_id)).toMatchObject({
      eligibility_status: 'pending',
      student_number_masked: '•••001',
    });
    const detail = await platformGet(`/v1/platform/subscriptions/${s.subscription_id}`);
    expect(detail.body.data.eligibility).toMatchObject({
      student_number: 'S-1001',
      student_name: 'طالب تجريبي',
    });
    // only the platform roles of P-07 decide
    for (const role of ['platform_admin', 'platform_support'] as const) {
      const denied = await platformPost(`/v1/platform/subscriptions/${s.subscription_id}/eligibility`, role, {
        decision: 'approve',
      });
      expect(denied.status).toBe(403);
    }
    const bare = await platformPost(
      `/v1/platform/subscriptions/${s.subscription_id}/eligibility`,
      'platform_finance',
      {
        decision: 'reject',
      },
    );
    expect(errOf(bare).code).toBe('REASON_REQUIRED');
    const no = await platformPost(
      `/v1/platform/subscriptions/${s.subscription_id}/eligibility`,
      'platform_finance',
      {
        decision: 'reject',
        reason: 'الرقم غير مسجل',
      },
    );
    expect(no.status, JSON.stringify(no.body)).toBe(200);
    expect(await subOf(a, s.subscription_id)).toMatchObject({
      status: 'canceled',
      ended_reason: 'eligibility_rejected',
      eligibility: { status: 'rejected', reason: 'الرقم غير مسجل' },
    });
    expect(await pushes(a.id)).toContain('subscription_eligibility_rejected');
    // the audit never holds the number or the name
    const audit = await t.db.query(
      `SELECT metadata::text AS m FROM platform_audit_log WHERE entity_id = $1`,
      [s.subscription_id],
    );
    expect(audit.rows.map((x) => x.m).join(' ')).not.toMatch(/S-1001|طالب تجريبي/);
  });

  it('approved → paid with the purchase consent → 22 counted days from today, invoiced, non-refundable', async () => {
    const a = await account();
    const r = await apply(a);
    const id = r.body.data.subscription_id as string;
    const ok = await platformPost(`/v1/platform/subscriptions/${id}/eligibility`, 'platform_owner', {
      decision: 'approve',
    });
    expect(ok.body.data).toMatchObject({ status: 'pending_payment', eligibility_status: 'approved' });
    expect(await pushes(a.id)).toContain('subscription_eligibility_approved');
    const before = await subOf(a, id);
    // seven days to pay an approval (DEC-596)
    expect(Date.parse(before.pending_expires_at!) - t.clock.now().getTime()).toBe(7 * 86_400_000);
    expect(errOf(await pay(a, id, false))).toMatchObject({
      status: 422,
      code: 'CUSTOMER_CONSENT_REQUIRED',
      details: { kind: 'subscription_terms' },
    });
    const stale = await cmd(a, 'post', `/v1/customer/subscriptions/${id}/pay`, {
      source: { type: 'token', token: await token() },
      purchase_consent: { ...consent, terms_version: '2020-01-01' },
    });
    expect(errOf(stale).code).toBe('CUSTOMER_CONSENT_VERSION_STALE');
    const paid = await pay(a, id);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const c = successEnvelopeSchema(CustomerSubscriptionCheckoutSchema).parse(paid.body).data;
    expect(c.payment).toMatchObject({ status: 'paid', amount_halalas: PRICE, vat_halalas: 2_250 });
    await settle();
    const s = await subOf(a, id);
    expect(s).toMatchObject({
      status: 'active',
      service_start_on: '2026-11-01',
      service_end_on: '2026-11-30',
      remaining_days: 22,
      can_cancel: false,
      can_resume: false,
      can_freeze: true,
      freezes_left: 1,
    });
    expect(await row(id)).toMatchObject({
      current_period_start: riyadhMidnight('2026-11-01'),
      current_period_end: riyadhMidnight('2026-12-01'),
    });
    const consents = await t.db.query(
      `SELECT terms_version, price_halalas::int AS price, net_halalas::int AS net, vat_halalas::int AS vat,
              non_refundable, valuables_notice
         FROM subscription_purchase_consents WHERE subscription_id = $1`,
      [id],
    );
    expect(consents.rows).toEqual([
      {
        terms_version: TERMS,
        price: PRICE,
        net: 15_000,
        vat: 2_250,
        non_refundable: true,
        valuables_notice: true,
      },
    ]);
    const invoice = await t.db.query(
      `SELECT kind, total_halalas::int AS total FROM invoices WHERE online_payment_id = $1`,
      [c.payment.payment_id],
    );
    expect(invoice.rows[0]).toMatchObject({ total: PRICE });
    // nothing to cancel: no renewal, no refund on a change of mind (DEC-595, DEC-600)
    const cancel = await cmd(a, 'post', `/v1/customer/subscriptions/${id}/cancel`, {});
    expect(errOf(cancel).code).toBe('SUBSCRIPTION_NOT_ACTIVE');
  });

  it('the eligible list approves the waiting applications and the next ones at once; a renewal reuses an approval', async () => {
    const a = await account();
    const number = studentNumber();
    const r = await apply(a, number);
    const id = r.body.data.subscription_id as string;
    expect(r.body.data.status).toBe('pending_eligibility');
    const imported = await platformPost(`/v1/platform/venues/${RMS}/eligible-students`, 'platform_finance', {
      mode: 'add',
      student_numbers: [number, 'X-1', 'X-2'],
    });
    expect(imported.status, JSON.stringify(imported.body)).toBe(200);
    expect(imported.body.data).toMatchObject({ changed: 3, approved: 1, listed: 3 });
    expect((await subOf(a, id)).eligibility).toMatchObject({ status: 'approved', source: 'list' });
    const summary = await platformGet(`/v1/platform/venues/${RMS}/eligible-students`);
    expect(summary.body.data).toMatchObject({ listed: 3 });
    const b = await account();
    const listed = await apply(b, 'x-2');
    expect(listed.body.data).toMatchObject({ status: 'pending_payment', eligibility: { source: 'list' } });
    // the number is personal: another account cannot apply with it while it is live
    const c = await account();
    const twice = await apply(c, number);
    expect(errOf(twice).details?.fields?.[0]).toMatchObject({ field: 'student_number', issue: 'in_use' });
    const removed = await platformPost(`/v1/platform/venues/${RMS}/eligible-students`, 'platform_finance', {
      mode: 'remove',
      student_numbers: ['X-1'],
    });
    expect(removed.body.data).toMatchObject({ changed: 1, listed: 2 });
    // withdrawn by the customers before paying (no seat held by a forgotten approval)
    for (const [acc, sid] of [
      [a, id],
      [b, listed.body.data.subscription_id],
    ] as const)
      expect((await cmd(acc, 'post', `/v1/customer/subscriptions/${sid}/cancel`, {})).status).toBe(200);
  });
});

describe('V2-036 — the customer freeze (annex clause 4, DEC-593, DEC-594)', () => {
  let a: Account;
  let id: string;

  it('validates the request: in advance, service days, at most 5 counted days', async () => {
    a = await account();
    id = await activeSubscription(a);
    const freeze = (starts_on: string, returns_on: string) =>
      cmd(a, 'post', `/v1/customer/subscriptions/${id}/freeze`, { starts_on, returns_on });
    expect(errOf(await freeze('2026-11-01', '2026-11-03')).details).toMatchObject({
      issue: 'not_in_advance',
    });
    expect(errOf(await freeze('2026-11-06', '2026-11-09')).details).toMatchObject({
      issue: 'start_not_service_day',
    });
    expect(errOf(await freeze('2026-11-09', '2026-11-17'))).toMatchObject({
      status: 422,
      code: 'SUBSCRIPTION_FREEZE_INVALID',
      details: { issue: 'too_long', max_days: 5 },
    });
  });

  it('Monday 11-09 → Monday 11-16: 5 counted days (Fri/Sat not counted); the end moves to Monday 12-07', async () => {
    const r = await cmd(a, 'post', `/v1/customer/subscriptions/${id}/freeze`, {
      starts_on: '2026-11-09',
      returns_on: '2026-11-16',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const s = successEnvelopeSchema(CustomerSubscriptionSchema).parse(r.body).data;
    expect(s.freeze).toMatchObject({
      status: 'scheduled',
      days: 5,
      projected_end_on: '2026-12-07',
    });
    expect(s).toMatchObject({ can_freeze: false, can_unfreeze: true, freezes_left: 0 });
    // one at a time
    const again = await cmd(a, 'post', `/v1/customer/subscriptions/${id}/freeze`, {
      starts_on: '2026-11-18',
      returns_on: '2026-11-19',
    });
    expect(errOf(again)).toMatchObject({ status: 409, code: 'SUBSCRIPTION_FREEZE_UNAVAILABLE' });
    // it starts at the Riyadh midnight of its first day: the service and the count stop
    await goTo(riyadhMidnight('2026-11-09'));
    expect(await row(id)).toMatchObject({
      status: 'frozen',
      frozen_reason: 'customer_freeze',
      frozen_remaining_days: 16,
    });
    expect((await subOf(a, id)).remaining_days).toBe(16);
    // back on the return day: 16 counted days from Monday 11-16 → Monday 12-07
    await goTo(riyadhMidnight('2026-11-16'));
    expect(await row(id)).toMatchObject({ status: 'active', end_on: '2026-12-07' });
    const after = await subOf(a, id);
    expect(after).toMatchObject({
      freeze: { status: 'completed', used_days: 5 },
      can_freeze: false,
      freezes_left: 0,
      service_end_on: '2026-12-07',
    });
    // used for this term
    const used = await cmd(a, 'post', `/v1/customer/subscriptions/${id}/freeze`, {
      starts_on: '2026-11-23',
      returns_on: '2026-11-24',
    });
    expect(errOf(used).details).toMatchObject({ reason: 'used' });
  });

  it('a renewal notice 3 days before the end says it ends (no charge); at the end: expired, renew offered', async () => {
    await goTo(new Date(riyadhMidnight('2026-12-08').getTime() - 3 * 86_400_000 + 1000));
    expect(await pushes(a.id)).toContain('subscription_ending');
    const payments = async () =>
      (await t.db.query(`SELECT count(*)::int AS n FROM online_payments WHERE subscription_id = $1`, [id]))
        .rows[0].n;
    const n = await payments();
    await goTo(new Date(riyadhMidnight('2026-12-08').getTime() + 1000));
    expect(await row(id)).toMatchObject({ status: 'expired', ended_reason: 'term_completed' });
    expect(await payments()).toBe(n); // nothing charged without a new explicit request
    const s = await subOf(a, id);
    expect(s.renew_plan_id).toBe(planId);
    expect(await pushes(a.id)).toContain('subscription_expired');
    // the renewal: a new application, approved at once (the same number here within 180 days)
    const number = (
      await t.db.query(`SELECT student_number FROM subscription_eligibility WHERE subscription_id = $1`, [id])
    ).rows[0].student_number;
    const renewed = await apply(a, number);
    expect(renewed.body.data).toMatchObject({ status: 'pending_payment', eligibility: { source: 'reuse' } });
    await cmd(a, 'post', `/v1/customer/subscriptions/${renewed.body.data.subscription_id}/cancel`, {});
  });

  it('an early reactivation resumes the same day and uses the freeze', async () => {
    const b = await account();
    const sid = await activeSubscription(b);
    const start = addDays('2026-12-08', 6); // Monday 2026-12-14 (the clock is on 12-08)
    const r = await cmd(b, 'post', `/v1/customer/subscriptions/${sid}/freeze`, {
      starts_on: start,
      returns_on: addDays(start, 3),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const before = (await row(sid)).end_on as string;
    await goTo(riyadhMidnight(start));
    // Tuesday 10:00: back today — Monday frozen, Tuesday counts again; the end moves by one counted day
    await goTo(new Date(riyadhMidnight(addDays(start, 1)).getTime() + 10 * 3_600_000));
    const back = await cmd(b, 'post', `/v1/customer/subscriptions/${sid}/unfreeze`, {});
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const s = successEnvelopeSchema(CustomerSubscriptionSchema).parse(back.body).data;
    expect(s).toMatchObject({
      status: 'active',
      freeze: { status: 'completed', used_days: 1 },
      freezes_left: 0,
    });
    expect(s.service_end_on).toBe(nthServiceDay(addDays(before, 1), 1, M));
    await goTo(riyadhMidnight(addDays(start, 3)));
    expect((await row(sid)).end_on).toBe(s.service_end_on); // the scheduled return found it ended early
  });
});

describe('V2-036 — closure, exceptional refund, capacity (DEC-598 … DEC-600)', () => {
  it('a venue out of service keeps a «continue» plan counting and tells the subscriber', async () => {
    const a = await account();
    const id = await activeSubscription(a);
    await t.db.transaction((tx) =>
      subscriptionLifecycleEffects.onVenueStatusChanged(tx, {
        orgId: ORG,
        venueId: RMS,
        from: 'active',
        to: 'inactive',
        requestId: null,
      }),
    );
    expect(await row(id)).toMatchObject({ status: 'active', frozen_reason: null });
    expect(await pushes(a.id)).toContain('subscription_venue_closure');
  });

  it('the exceptional refund returns the remaining counted days out of 22 and ends it, due in 12 days', async () => {
    const a = await account();
    const id = await activeSubscription(a);
    const s = await subOf(a, id);
    // denied to admin and support (money goes out)
    expect(
      (
        await platformPost(`/v1/platform/subscriptions/${id}/exceptional-refund`, 'platform_support', {
          reason: 'إغلاق دائم للموقع',
        })
      ).status,
    ).toBe(403);
    const bare = await platformPost(
      `/v1/platform/subscriptions/${id}/exceptional-refund`,
      'platform_finance',
      {},
    );
    expect(errOf(bare).code).toBe('REASON_REQUIRED');
    const r = await platformPost(`/v1/platform/subscriptions/${id}/exceptional-refund`, 'platform_finance', {
      reason: 'استحالة تقديم الخدمة',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // the term began today (before the cutoff) or tomorrow: the days left from tomorrow
    const left = r.body.data.remaining_days as number;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(22);
    expect(r.body.data.amount_halalas).toBe(Math.floor((PRICE * left) / 22));
    expect(r.body.data.subscription).toMatchObject({
      status: 'canceled',
      ended_reason: 'exceptional_refund',
    });
    const due = (await row(id)).refund_due_at as Date;
    expect(due.getTime() - t.clock.now().getTime()).toBe(12 * 86_400_000);
    await settle();
    const refunds = await t.db.query(
      `SELECT r.status, r.kind, r.amount_halalas::int AS amount FROM refunds r
         JOIN online_payments p ON p.id = r.online_payment_id WHERE p.subscription_id = $1`,
      [id],
    );
    expect(refunds.rows).toEqual([
      { status: 'succeeded', kind: 'manual', amount: r.body.data.amount_halalas },
    ]);
    const credit = await t.db.query(
      `SELECT count(*)::int AS n FROM invoices i JOIN online_payments p ON p.id = i.online_payment_id
        WHERE p.subscription_id = $1 AND i.kind = 'credit_note'`,
      [id],
    );
    expect(credit.rows[0].n).toBe(1);
    expect((await subOf(a, id)).refund_due_at).toBe(due.toISOString());
    expect(s.status).toBe('active');
  });

  it('no seat left: «اكتملت المقاعد» on C-08, the application and the payment refused', async () => {
    // the plan holds 6 seats; fill what is left with paid subscriptions
    const seats = async () =>
      (await platformGet(`/v1/platform/plans?venue_id=${RMS}`)).body.data[0].plans.find(
        (p: any) => p.plan_id === planId,
      ).seats_taken as number;
    const approved: [Account, string][] = [];
    while ((await seats()) < 6) {
      const a = await account();
      const r = await apply(a);
      const id = r.body.data.subscription_id as string;
      await platformPost(`/v1/platform/subscriptions/${id}/eligibility`, 'platform_finance', {
        decision: 'approve',
      });
      approved.push([a, id]);
    }
    const [last, lastId] = approved.pop()!;
    for (const [a, id] of approved) expect((await pay(a, id)).status).toBe(201);
    await settle();
    // an approved application waiting for its payment holds a seat: the last one may still pay
    expect(await seats()).toBe(6);
    const late = await account();
    expect(errOf(await apply(late))).toMatchObject({ status: 409, code: 'SUBSCRIPTION_CAPACITY_REACHED' });
    const loc = await t.http().get(`/v1/customer/locations/${RMS}`).set(bearer(late));
    expect(loc.body.data.plans.find((p: any) => p.plan_id === planId).sold_out).toBe(true);
    expect((await pay(last, lastId)).status).toBe(201);
  });
});

describe('V2-037 — complaints with a reference number (C-21/C-22, P-13; DEC-603, DEC-604)', () => {
  it('a complaint gets its reference at once; the platform moves it with a note the customer reads', async () => {
    const a = await account();
    const sub = (
      await t.db.query(`SELECT id FROM subscriptions WHERE venue_id = $1 ORDER BY created_at LIMIT 1`, [RMS])
    ).rows[0].id;
    const other = await cmd(a, 'post', CUSTOMER_ROUTES.complaintCreate.path, {
      category: 'subscription',
      body: 'لم يُقبل اشتراكي عند البوابة اليوم',
      subscription_id: sub,
    });
    expect(errOf(other)).toMatchObject({ status: 404, code: 'RESOURCE_NOT_FOUND' });
    const card = await cmd(a, 'post', CUSTOMER_ROUTES.complaintCreate.path, {
      category: 'payment',
      body: 'خصم مرتين من بطاقتي 4111111111111111',
    });
    expect(errOf(card).code).toBe('VALIDATION_FAILED');
    const r = await cmd(a, 'post', CUSTOMER_ROUTES.complaintCreate.path, {
      category: 'delay',
      body: 'تأخر إحضار السيارة أكثر من نصف ساعة',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const c = successEnvelopeSchema(CustomerComplaintSchema).parse(r.body).data;
    expect(c.reference).toMatch(/^PT-C-\d{6}$/);
    expect(c.status).toBe('open');
    const list = await platformGet(`/v1/platform/complaints?q=${c.reference}`, 'platform_support');
    expect(list.body.data.map((x: any) => x.complaint_id)).toEqual([c.complaint_id]);
    expect(list.body.data[0].phone_masked).not.toContain('76');
    const moved = await platformPost(`/v1/platform/complaints/${c.complaint_id}/status`, 'platform_support', {
      status: 'resolved',
      note: 'نعتذر، تمت مراجعة المناوبة',
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const final = await platformPost(`/v1/platform/complaints/${c.complaint_id}/status`, 'platform_admin', {
      status: 'in_progress',
      note: 'إعادة فتح',
    });
    expect(errOf(final)).toMatchObject({ status: 409, code: 'INVALID_STATE_TRANSITION' });
    const mine = await t.http().get(CUSTOMER_ROUTES.complaints.path).set(bearer(a));
    expect(mine.body.data.items[0]).toMatchObject({
      reference: c.reference,
      status: 'resolved',
      resolution_note: 'نعتذر، تمت مراجعة المناوبة',
    });
    const audit = await t.db.query(
      `SELECT action, metadata::text AS m FROM platform_audit_log WHERE entity_id = $1 ORDER BY id`,
      [c.complaint_id],
    );
    expect(audit.rows.map((x) => x.action)).toEqual(['complaint.create', 'complaint.resolved']);
    expect(audit.rows.map((x) => x.m).join(' ')).not.toContain('تأخر إحضار');
  });
});
