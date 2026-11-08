import type { AddressInfo } from 'node:net';
import {
  FakeClock,
  OnlinePayments,
  OutboxDispatcher,
  PaymentWebhookIntake,
  PaymentsRuntime,
  createLogger,
  paymentsOnlineJobs,
  sha256Hex,
  type OnlinePaymentRow,
} from '@point/server';
import type { PlatformRole } from '@point/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SECRET_KEY,
  DEFAULT_WEBHOOK_SECRET,
  TEST_CARDS,
  startPaymentSimulator,
  type RunningPaymentSimulator,
} from '../../../tools/payment-simulator/src/index.js';
import { CSRF, SEED_IDS, createTestApp, newKey, type TestApp } from './harness.js';
import { createTicket } from './wa-harness.js';

/**
 * V2-020 / V2-021 (docs/v2/04 §3, DEC-510 … DEC-514) on the payment simulator: the Moyasar adapter, the online
 * payment machine, the signed webhook processed once by the worker, refunds by the platform and the daily
 * reconciliation. The API listens on a port (the simulator delivers its webhooks to it) and the worker's
 * OutboxDispatcher runs the real payment jobs on the same FakeClock.
 */

const CALLBACK = 'https://app.example.test/pay/return';
const ORG = SEED_IDS.org;
const RMS = SEED_IDS.venues.RMS;
const ROLES: PlatformRole[] = ['platform_owner', 'platform_admin', 'platform_finance', 'platform_support'];

describe('online payments on the payment simulator (V2-020 / V2-021)', () => {
  let sim: RunningPaymentSimulator;
  let t: TestApp;
  let rt: PaymentsRuntime;
  let pay: OnlinePayments;
  let dispatcher: OutboxDispatcher;
  let apiUrl: string;
  let accountId: string;
  const logLines: string[] = [];
  const clock = new FakeClock('2026-10-27T16:00:00.000Z');
  const cookies = {} as Record<PlatformRole, string>;

  beforeAll(async () => {
    process.env.MOYASAR_SECRET_KEY = DEFAULT_SECRET_KEY;
    process.env.MOYASAR_WEBHOOK_SECRET = DEFAULT_WEBHOOK_SECRET;
    sim = await startPaymentSimulator({ env: {}, now: () => clock.now() });
    t = await createTestApp({ clock, env: { MOYASAR_BASE_URL: sim.url, MOYASAR_HTTP_TIMEOUT_MS: '3000' } });
    await t.app.listen(0, '127.0.0.1');
    apiUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
    await sim.client.configure({ webhookUrl: `${apiUrl}/webhooks/payments/moyasar` });
    // the worker side, its log lines kept (no card number may ever reach them)
    const logger = createLogger({
      level: 'debug',
      destination: { write: (l: string) => void logLines.push(l) },
    });
    rt = new PaymentsRuntime({ env: t.env, logger });
    pay = new OnlinePayments(t.db, rt);
    dispatcher = new OutboxDispatcher(t.db, t.clock, logger, {
      workerId: 'payments-test-worker',
      batchSize: 50,
      concurrency: 1,
    });
    for (const h of paymentsOnlineJobs({ runtime: rt })) dispatcher.register(h);
    accountId = (
      await t.db.query<{ id: string }>(
        `INSERT INTO customer_accounts (phone_e164) VALUES ('+966551110001') RETURNING id`,
      )
    ).rows[0]!.id;
    for (const [i, role] of ROLES.entries()) {
      const u = await t.db.query<{ id: string }>(
        `INSERT INTO platform_users (phone_e164, full_name, role, secret_hash, must_change_secret, mfa_enabled, mfa_secret_enc)
         VALUES ($1, $2, $3, 'x', false, true, 'x') RETURNING id`,
        [`+96655888000${i}`, `حساب ${role}`, role],
      );
      const token = `payments-test-session-${role}-0123456789`;
      await t.db.query(
        `INSERT INTO platform_sessions (platform_user_id, token_hash, mfa_verified, created_at, last_seen_at, expires_at)
         VALUES ($1, $2, true, $3, $3, $3::timestamptz + interval '400 days')`,
        [u.rows[0]!.id, sha256Hex(token), clock.now()],
      );
      cookies[role] = `${t.env.PLATFORM_SESSION_COOKIE_NAME}=${token}`;
    }
  });
  afterAll(async () => {
    await sim?.close();
    await t?.close();
  });
  beforeEach(async () => {
    await sim.client.configure({ autoWebhooks: true, webhookSecret: DEFAULT_WEBHOOK_SECRET });
  });

  /** Waits for the simulator's webhooks, then runs every due outbox row. */
  const settle = async () => {
    await sim.client.flush();
    for (let i = 0; i < 5; i++) if ((await dispatcher.drain(200)) === 0) break;
  };
  const visit = async (amount = 2300) => {
    const ticket = await createTicket(t, { venue: 'RMS' });
    return { ticket, amount };
  };
  const start = async (card: string, amount = 2300) => {
    const { ticket } = await visit(amount);
    const token = await sim.client.tokenize(card);
    return pay.start({
      accountId,
      purpose: 'visit',
      ticketId: ticket.id,
      orgId: ORG,
      venueId: RMS,
      amountHalalas: amount,
      source: { type: 'token', token },
      callbackUrl: CALLBACK,
    });
  };
  const row = async (id: string) =>
    (
      await t.db.query<OnlinePaymentRow>(
        `SELECT *, amount_halalas::float8 AS amount_halalas, refunded_halalas::float8 AS refunded_halalas,
                vat_halalas::float8 AS vat_halalas FROM online_payments WHERE id = $1`,
        [id],
      )
    ).rows[0]!;
  const events = (gatewayPaymentId: string) =>
    t.db.query<{ event_type: string; outcome: string | null; processed_at: Date | null; payload: any }>(
      `SELECT event_type, outcome, processed_at, payload FROM gateway_webhook_events WHERE gateway_payment_id = $1 ORDER BY id`,
      [gatewayPaymentId],
    );
  const audits = (table: 'platform_audit_log' | 'customer_audit_log' | 'audit_log', entityId: string) =>
    t.db.query<{ action: string; metadata: any }>(
      `SELECT action, metadata FROM ${table} WHERE entity_id = $1 ORDER BY id`,
      [entityId],
    );
  const alerts = (type: string) =>
    t.db.query<{ dedupe_key: string; details: any; status: string; occurrences: number }>(
      `SELECT dedupe_key, details, status, occurrences FROM platform_alerts WHERE type = $1 ORDER BY raised_at, id`,
      [type],
    );
  const touch = () => t.db.query(`UPDATE platform_sessions SET last_seen_at = $1`, [clock.now()]);
  const refund = async (
    paymentId: string,
    role: PlatformRole,
    body: object,
    key: string | null = newKey(),
  ) => {
    await touch();
    let r = t
      .http()
      .post(`/v1/platform/payments/${paymentId}/refunds`)
      .set(CSRF)
      .set('Cookie', cookies[role]);
    if (key) r = r.set('Idempotency-Key', key);
    return r.send(body);
  };
  const postWebhook = (body: string | Buffer) =>
    t.http().post('/webhooks/payments/moyasar').set('Content-Type', 'application/json').send(body);

  // ------------------------------------------------------------------------------------------- payments

  it('a frictionless card is paid at once from our own call; its signed webhook is processed once and changes nothing', async () => {
    const started = await start(TEST_CARDS.success.number);
    expect(started.actionUrl).toBeNull();
    expect(started.payment).toMatchObject({
      status: 'paid',
      amount_halalas: 2300,
      vat_halalas: 300,
      refunded_halalas: 0,
      card_brand: 'visa',
      card_last4: '1111',
      source_type: 'token',
      org_id: ORG,
      venue_id: RMS,
    });
    const gid = started.payment.gateway_payment_id!;
    // the gateway was given our idempotency key and ids only
    const atGateway = await sim.client.payment(gid);
    expect(atGateway.metadata).toEqual({
      online_payment_id: started.payment.id,
      purpose: 'visit',
      ticket_id: started.payment.ticket_id,
    });
    await settle();
    expect((await events(gid)).rows).toEqual([
      expect.objectContaining({
        event_type: 'payment_paid',
        outcome: 'unchanged',
        processed_at: expect.any(Date),
      }),
    ]);
    expect((await audits('platform_audit_log', started.payment.id)).rows.map((r) => r.action)).toEqual([
      'online_payment.initiated',
      'online_payment.paid',
    ]);
    // the operator of the visit sees it in its own audit_log; the customer in theirs
    expect((await audits('audit_log', started.payment.id)).rows.map((r) => r.action)).toEqual([
      'online_payment.initiated',
      'online_payment.paid',
    ]);
    expect((await audits('customer_audit_log', started.payment.id)).rows.map((r) => r.action)).toEqual([
      'online_payment.initiated',
      'online_payment.paid',
    ]);
  });

  it('a declined card: PAYMENT_FAILED, the payment failed with the gateway code', async () => {
    const err = await start(TEST_CARDS.declined.number).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PAYMENT_FAILED', details: { failure_code: '51' } });
    const id = (err as { details: { online_payment_id: string } }).details.online_payment_id;
    expect(await row(id)).toMatchObject({
      status: 'failed',
      failure_code: '51',
      failed_at: expect.any(Date),
    });
    await settle();
    const r = await row(id);
    expect((await events(r.gateway_payment_id!)).rows).toEqual([
      expect.objectContaining({ event_type: 'payment_failed', outcome: 'unchanged' }),
    ]);
    expect((await audits('platform_audit_log', id)).rows.at(-1)).toMatchObject({
      action: 'online_payment.failed',
      metadata: expect.objectContaining({ failure_code: '51', from_status: 'initiated' }),
    });
  });

  it('a gateway that cannot be reached leaves the payment initiated; resuming sends the same given_id once', async () => {
    const { ticket } = await visit();
    const token = await sim.client.tokenize(TEST_CARDS.success.number);
    const down = new OnlinePayments(
      t.db,
      new PaymentsRuntime({
        env: { ...t.env, MOYASAR_BASE_URL: 'http://127.0.0.1:9', MOYASAR_HTTP_TIMEOUT_MS: 500 },
        logger: createLogger({ level: 'silent' }),
      }),
    );
    const input = {
      accountId,
      purpose: 'visit' as const,
      ticketId: ticket.id,
      orgId: ORG,
      venueId: RMS,
      amountHalalas: 1500,
      source: { type: 'token' as const, token },
      callbackUrl: CALLBACK,
    };
    const err = (await down.start(input).catch((e: unknown) => e)) as {
      code: string;
      details: { online_payment_id: string };
    };
    expect(err.code).toBe('SERVICE_UNAVAILABLE');
    const id = err.details.online_payment_id;
    expect(await row(id)).toMatchObject({ status: 'initiated', gateway_payment_id: null });
    const resumed = await pay.resume(id, { source: input.source, callbackUrl: CALLBACK });
    expect(resumed.payment).toMatchObject({ id, status: 'paid' });
    const atGateway = (await sim.client.payments()).filter((p) => p.metadata?.online_payment_id === id);
    expect(atGateway).toHaveLength(1);
    await expect(pay.resume(id, { source: input.source, callbackUrl: CALLBACK })).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });
  });

  it('3-D Secure: initiated with the page; the return to the callback changes nothing; the signed webhook pays it', async () => {
    await sim.client.configure({ autoWebhooks: false });
    const started = await start(TEST_CARDS.threeDs.number, 4600);
    expect(started.payment.status).toBe('initiated');
    const gid = started.payment.gateway_payment_id!;
    expect(started.actionUrl).toBe(`${sim.url}/sim/3ds/${gid}`);
    // the customer passes the challenge and comes back to the app's callback: no call reaches the server
    const done = await sim.client.complete3ds(gid);
    expect(done.redirect_url).toContain(`${CALLBACK}?id=${gid}&status=paid`);
    await settle();
    expect((await row(started.payment.id)).status).toBe('initiated');
    // the gateway's webhook is what moves it
    expect((await sim.client.webhook(gid, { type: 'payment_paid' })).status).toBe(200);
    await settle();
    expect(await row(started.payment.id)).toMatchObject({
      status: 'paid',
      paid_at: expect.any(Date),
      version: 3,
    });
  });

  it('a webhook replayed (and redelivered) is stored and processed once', async () => {
    const started = await start(TEST_CARDS.success.number);
    await settle();
    const gid = started.payment.gateway_payment_id!;
    const d = (await sim.client.deliveries()).find((x) => x.payment_id === gid)!;
    const outboxBefore = await t.db.query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE type = 'job.payment_webhook_process'`,
    );
    for (let i = 0; i < 3; i++) expect((await sim.client.replay(d.event_id)).status).toBe(200);
    expect((await postWebhook(d.body)).status).toBe(200);
    await settle();
    expect((await events(gid)).rows).toHaveLength(1);
    const outboxAfter = await t.db.query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE type = 'job.payment_webhook_process'`,
    );
    expect(outboxAfter.rows[0].n).toBe(outboxBefore.rows[0].n);
    expect((await audits('platform_audit_log', started.payment.id)).rows).toHaveLength(2);
  });

  it('a forged or malformed delivery is refused and nothing is stored', async () => {
    const started = await start(TEST_CARDS.success.number);
    const gid = started.payment.gateway_payment_id!;
    const genuine = (await sim.client.webhook(gid, { type: 'payment_refunded', deliver: false })).body;
    const forged = JSON.stringify({
      ...JSON.parse(genuine),
      id: 'forged-event',
      secret_token: 'not-the-secret',
    });
    const noSecret = JSON.stringify({
      ...JSON.parse(genuine),
      id: 'no-secret-event',
      secret_token: undefined,
    });
    for (const body of [forged, noSecret, 'not json at all', '[]']) {
      const r = await postWebhook(body);
      expect(r.status, body.slice(0, 20)).toBe(401);
      expect(r.body.error.code).toBe('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
    }
    const noId = JSON.stringify({ ...JSON.parse(genuine), id: undefined });
    expect((await postWebhook(noId)).body.error.code).toBe('VALIDATION_FAILED');
    expect((await events(gid)).rows.filter((e) => e.event_type === 'payment_refunded')).toEqual([]);
    // a secret being rotated out is still accepted (MOYASAR_WEBHOOK_SECRET_PREVIOUS_REF)
    const rotated = new PaymentsRuntime({
      env: { ...t.env, MOYASAR_WEBHOOK_SECRET_PREVIOUS_REF: 'env://MOYASAR_WEBHOOK_SECRET_OLD' },
      secretEnv: {
        ...process.env,
        MOYASAR_WEBHOOK_SECRET: 'the-new-secret',
        MOYASAR_WEBHOOK_SECRET_OLD: DEFAULT_WEBHOOK_SECRET,
      },
    });
    expect(await new PaymentWebhookIntake(rotated, t.db).receive(Buffer.from(genuine))).toMatchObject({
      duplicate: false,
    });
  });

  it('out-of-order and late events converge on the gateway record and never move the payment back', async () => {
    await sim.client.configure({ autoWebhooks: false });
    const started = await start(TEST_CARDS.threeDs.number, 5000);
    const gid = started.payment.gateway_payment_id!;
    await sim.client.complete3ds(gid);
    const paidEvent = (await sim.client.webhook(gid, { type: 'payment_paid', deliver: false })).body;
    // a stale "failed" built from an older state
    const lateFailed = (
      await sim.client.webhook(gid, { type: 'payment_failed', status: 'failed', deliver: false })
    ).body;
    // money given back on the gateway's side before its first event arrives
    await fetch(`${sim.url}/v1/payments/${gid}/refund`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${DEFAULT_SECRET_KEY}:`).toString('base64')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ amount: 2000 }),
    });
    const refundedEvent = (await sim.client.webhook(gid, { type: 'payment_refunded', deliver: false })).body;
    for (const body of [refundedEvent, paidEvent, lateFailed])
      expect((await postWebhook(body)).status).toBe(200);
    await settle();
    expect(await row(started.payment.id)).toMatchObject({
      status: 'partially_refunded',
      refunded_halalas: 2000,
    });
    expect((await events(gid)).rows.map((e) => [e.event_type, e.outcome])).toEqual([
      ['payment_refunded', 'applied'],
      ['payment_paid', 'unchanged'],
      ['payment_failed', 'unchanged'],
    ]);
    expect((await audits('platform_audit_log', started.payment.id)).rows.map((r) => r.action)).toEqual([
      'online_payment.initiated',
      'online_payment.partially_refunded',
    ]);
  });

  it('a payment POINT does not know is recorded and alerted', async () => {
    const external = await sim.client.externalPayment(7700);
    await settle();
    expect((await events(external.id)).rows).toEqual([
      expect.objectContaining({ outcome: 'unknown_payment' }),
    ]);
    expect((await alerts('payment_unknown')).rows).toContainEqual(
      expect.objectContaining({
        dedupe_key: `payment_unknown:${external.id}`,
        status: 'open',
        details: expect.objectContaining({ reason: 'unknown_at_point', amount_halalas: 7700 }),
      }),
    );
  });

  // ------------------------------------------------------------------------------------------- refunds

  it('refunds: partial then the rest, never more than paid, finance and owner only, idempotent', async () => {
    const started = await start(TEST_CARDS.success.number, 2300);
    const id = started.payment.id;
    await settle();
    for (const role of ['platform_admin', 'platform_support'] as const) {
      const r = await refund(id, role, { amount_halalas: 100, reason: 'خطأ في السعر' });
      expect(r.status, role).toBe(403);
      expect(r.body.error.code).toBe('PERMISSION_DENIED');
    }
    const staff = await t
      .http()
      .post(`/v1/platform/payments/${id}/refunds`)
      .set(CSRF)
      .set('Cookie', await t.sessionFor('OWN1'))
      .set('Idempotency-Key', newKey())
      .send({ reason: 'خطأ في السعر' });
    expect(staff.body.error.code).toBe('PLATFORM_AUTH_REQUIRED');
    expect((await refund(id, 'platform_finance', { reason: 'xx' })).body.error.code).toBe('REASON_REQUIRED');
    expect(
      (await refund('00000000-0000-4000-8000-0000000fffff', 'platform_finance', { reason: 'خطأ في السعر' }))
        .body.error.code,
    ).toBe('RESOURCE_NOT_FOUND');
    const over = await refund(id, 'platform_finance', { amount_halalas: 2400, reason: 'خطأ في السعر' });
    expect(over.status).toBe(409);
    expect(over.body.error).toMatchObject({
      code: 'REFUND_AMOUNT_EXCEEDS_PAID',
      details: { refundable_halalas: 2300 },
    });

    const key = newKey();
    const part = await refund(id, 'platform_finance', { amount_halalas: 1000, reason: 'تأخر التسليم' }, key);
    expect(part.status).toBe(201);
    expect(part.body.data.refund).toMatchObject({
      status: 'requested',
      amount_halalas: 1000,
      reason: 'تأخر التسليم',
    });
    const again = await refund(id, 'platform_finance', { amount_halalas: 1000, reason: 'تأخر التسليم' }, key);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.data.refund.id).toBe(part.body.data.refund.id);
    // a pending refund counts: only 1300 is left before the worker sends it
    const tooMuch = await refund(id, 'platform_owner', { amount_halalas: 1301, reason: 'تعويض إضافي' });
    expect(tooMuch.body.error.details).toMatchObject({ refundable_halalas: 1300 });
    await settle();
    expect(await row(id)).toMatchObject({ status: 'partially_refunded', refunded_halalas: 1000 });
    expect((await sim.client.payment(started.payment.gateway_payment_id!)).refunded).toBe(1000);

    const rest = await refund(id, 'platform_owner', { reason: 'إلغاء الزيارة' });
    expect(rest.body.data.refund.amount_halalas).toBe(1300);
    await settle();
    expect(await row(id)).toMatchObject({ status: 'refunded', refunded_halalas: 2300 });
    expect((await refund(id, 'platform_finance', { reason: 'مرة أخرى' })).body.error.code).toBe(
      'PAYMENT_NOT_REFUNDABLE',
    );
    const refunds = await t.db.query(
      `SELECT status, amount_halalas::int AS a FROM refunds WHERE online_payment_id = $1 ORDER BY created_at`,
      [id],
    );
    expect(refunds.rows).toEqual([
      { status: 'succeeded', a: 1000 },
      { status: 'succeeded', a: 1300 },
    ]);
    const issued = (
      await t.db.query(`SELECT id FROM refunds WHERE online_payment_id = $1 ORDER BY created_at`, [id])
    ).rows;
    for (const { id: rid } of issued) {
      expect((await audits('platform_audit_log', rid)).rows.map((r) => r.action)).toEqual([
        'refund.issue',
        'refund.succeeded',
      ]);
      expect((await audits('audit_log', rid)).rows.map((r) => r.action)).toEqual([
        'refund.issue',
        'refund.succeeded',
      ]);
      expect((await audits('customer_audit_log', rid)).rows.map((r) => r.action)).toEqual([
        'refund.issue',
        'refund.succeeded',
      ]);
    }
    // a failed payment is not refundable
    const failed = await start(TEST_CARDS.declined.number).catch(
      (e: { details: { online_payment_id: string } }) => e,
    );
    expect(
      (
        await refund(
          (failed as { details: { online_payment_id: string } }).details.online_payment_id,
          'platform_finance',
          { reason: 'خطأ في السعر' },
        )
      ).body.error.code,
    ).toBe('PAYMENT_NOT_REFUNDABLE');
  });

  it('a refund whose answer was lost is not sent twice; money refunded outside POINT is not guessed at', async () => {
    const started = await start(TEST_CARDS.success.number, 3000);
    await settle();
    const gid = started.payment.gateway_payment_id!;
    const r = await refund(started.payment.id, 'platform_finance', { amount_halalas: 500, reason: 'تعويض' });
    // the worker sent it, the gateway applied it, the answer never came back (simulated)
    await t.db.query(`UPDATE refunds SET sent_at = $2 WHERE id = $1`, [r.body.data.refund.id, clock.now()]);
    await sim.state.refund(gid, 500);
    await settle();
    expect((await sim.client.payment(gid)).refunded).toBe(500);
    expect(await row(started.payment.id)).toMatchObject({
      status: 'partially_refunded',
      refunded_halalas: 500,
    });
    expect(
      (await t.db.query(`SELECT status FROM refunds WHERE id = $1`, [r.body.data.refund.id])).rows[0].status,
    ).toBe('succeeded');

    // someone refunds on the gateway's dashboard, then finance issues a refund in P-08
    sim.state.refund(gid, 700);
    const second = await refund(started.payment.id, 'platform_finance', {
      amount_halalas: 300,
      reason: 'تعويض',
    });
    await settle();
    expect(
      (
        await t.db.query(`SELECT status, failure_code FROM refunds WHERE id = $1`, [
          second.body.data.refund.id,
        ])
      ).rows[0],
    ).toEqual({
      status: 'failed',
      failure_code: 'gateway_already_refunded',
    });
    expect((await sim.client.payment(gid)).refunded).toBe(1200);
    expect((await alerts('payment_mismatch')).rows).toContainEqual(
      expect.objectContaining({ dedupe_key: `payment_mismatch:${started.payment.id}` }),
    );
    expect((await alerts('payment_refund_failed')).rows).toContainEqual(
      expect.objectContaining({ dedupe_key: `payment_refund_failed:${second.body.data.refund.id}` }),
    );
  });

  // ------------------------------------------------------------------------------------------- reconciliation

  it('the daily reconciliation matches a clean day, then finds every kind of difference', async () => {
    clock.set('2026-10-29T09:00:00.000Z'); // a fresh Riyadh day
    await touch();
    const a = await start(TEST_CARDS.success.number, 1000);
    const b = await start(TEST_CARDS.success.number, 2000);
    await settle();
    const runJob = async (date: string) => {
      await t.db.transaction((tx) =>
        tx.query(
          `INSERT INTO outbox_events (org_id, type, payload, available_at, created_at)
           VALUES ($1, 'job.payments_reconcile', $2, $3, $3)`,
          [ORG, JSON.stringify({ run_date: date, reschedule: false }), tx.now],
        ),
      );
      await dispatcher.drain(50);
      return (
        await t.db.query(
          `SELECT * FROM payment_reconciliation_runs WHERE run_date = $1 ORDER BY started_at DESC, id DESC LIMIT 1`,
          [date],
        )
      ).rows[0];
    };
    const clean = await runJob('2026-10-29');
    expect(clean).toMatchObject({
      status: 'matched',
      gateway_count: 2,
      local_count: 2,
      matched_count: 2,
      mismatch_count: 0,
    });
    expect(Number(clean.gateway_paid_halalas)).toBe(3000);
    expect(Number(clean.local_paid_halalas)).toBe(3000);

    // the gateway's records drift: a lost webhook (paid there, initiated here), a changed amount, a payment POINT
    // never made, one of ours the gateway lost
    await sim.client.configure({ autoWebhooks: false });
    clock.advanceSeconds(60); // the second run starts later than the first
    await touch();
    const c = await start(TEST_CARDS.threeDs.number, 3000);
    await sim.client.complete3ds(c.payment.gateway_payment_id!);
    await sim.client.mutate(b.payment.gateway_payment_id!, { amount: 2100 });
    const ext = await sim.client.externalPayment(900, { emit: false });
    sim.state.payments.delete(a.payment.gateway_payment_id!);
    const run = await runJob('2026-10-29');
    expect(run).toMatchObject({ status: 'mismatched', mismatch_count: 4 });
    const kinds = (
      run.mismatches as { kind: string; online_payment_id: string | null; synced?: boolean }[]
    ).map((m) => [m.kind, m.online_payment_id, m.synced ?? false]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ['status', c.payment.id, true],
        ['amount', b.payment.id, false],
        ['unknown_at_point', null, false],
        ['missing_at_gateway', a.payment.id, false],
      ]),
    );
    // the lost webhook was caught up (forward move only), the rest is for finance
    expect((await row(c.payment.id)).status).toBe('paid');
    expect((await row(b.payment.id)).status).toBe('paid');
    const mismatch = (await alerts('payment_mismatch')).rows.map((r) => r.dedupe_key);
    for (const p of [a, b, c]) expect(mismatch).toContain(`payment_mismatch:${p.payment.id}`);
    expect((await alerts('payment_unknown')).rows.map((r) => r.dedupe_key)).toContain(
      `payment_unknown:${ext.id}`,
    );
    expect(
      (await t.db.query(`SELECT action FROM platform_audit_log WHERE entity_id = $1`, [run.id])).rows.map(
        (r) => r.action,
      ),
    ).toEqual(['payments.reconcile']);
  });

  it('a gateway that cannot be read: retried, then the run failed and payment_reconcile_failed raised', async () => {
    const dead = new PaymentsRuntime({
      env: { ...t.env, MOYASAR_BASE_URL: 'http://127.0.0.1:9', MOYASAR_HTTP_TIMEOUT_MS: 500 },
      logger: createLogger({ level: 'silent' }),
    });
    const d = new OutboxDispatcher(t.db, t.clock, createLogger({ level: 'silent' }), {
      workerId: 'payments-dead-worker',
    });
    for (const h of paymentsOnlineJobs({ runtime: dead })) d.register(h);
    await t.db.query(
      `INSERT INTO outbox_events (org_id, type, payload, available_at, created_at, max_attempts)
       VALUES ($1, 'job.payments_reconcile', $2, $3, $3, 2)`,
      [ORG, JSON.stringify({ run_date: '2026-10-30', reschedule: false }), clock.now()],
    );
    await d.drain(10);
    clock.advanceSeconds(30);
    await d.drain(10);
    const runs = await t.db.query(
      `SELECT status, failure_reason FROM payment_reconciliation_runs WHERE run_date = '2026-10-30'`,
    );
    expect(runs.rows).toEqual([
      { status: 'failed', failure_reason: 'gateway_network' },
      { status: 'failed', failure_reason: 'gateway_network' },
    ]);
    expect((await alerts('payment_reconcile_failed')).rows).toEqual([
      expect.objectContaining({ dedupe_key: 'payment_reconcile_failed:2026-10-30', status: 'open' }),
    ]);
  });

  it('the worker keeps one daily reconciliation scheduled', async () => {
    await t.db.query(
      `DELETE FROM outbox_events WHERE type = 'job.payments_reconcile' AND status IN ('pending','processing')`,
    );
    const { ensureReconcileScheduled } = await import('@point/server');
    await t.db.transaction((tx) => ensureReconcileScheduled(tx, t.env.PAYMENTS_RECONCILE_CRON_UTC));
    await t.db.transaction((tx) => ensureReconcileScheduled(tx, t.env.PAYMENTS_RECONCILE_CRON_UTC));
    const pending = await t.db.query<{ available_at: Date; dedupe_key: string }>(
      `SELECT available_at, dedupe_key FROM outbox_events WHERE type = 'job.payments_reconcile' AND status = 'pending'`,
    );
    expect(pending.rows).toHaveLength(1);
    expect(pending.rows[0]!.available_at.toISOString()).toMatch(/T00:30:00.000Z$/);
  });

  // ------------------------------------------------------------------------------------------- PCI / logs

  it('no card number is ever stored or logged (docs/v2/04 §6)', async () => {
    const cards = Object.values(TEST_CARDS).map((c) => c.number);
    const tables = (
      await t.db.query<{ t: string }>(
        `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
      )
    ).rows.map((r) => r.t);
    for (const table of tables) {
      const dump = (
        await t.db.query<{ x: string }>(
          `SELECT coalesce(string_agg(r::text, E'\\n'), '') AS x FROM ${table} r`,
        )
      ).rows[0]!.x;
      for (const n of cards) expect(dump.includes(n), `${table} holds a card number`).toBe(false);
    }
    const stored = await t.db.query<{ x: string }>(
      `SELECT string_agg(payload::text, ' ') AS x FROM gateway_webhook_events`,
    );
    expect(stored.rows[0]!.x).not.toMatch(/[0-9]{13,}/);
    expect(stored.rows[0]!.x).not.toContain(DEFAULT_WEBHOOK_SECRET);
    expect(stored.rows[0]!.x).not.toContain('TEST CARD');
    expect(logLines.length).toBeGreaterThan(0);
    const logs = logLines.join('\n');
    for (const n of cards) expect(logs).not.toContain(n);
    expect(logs).not.toContain(DEFAULT_SECRET_KEY);
    expect(logs).not.toContain(DEFAULT_WEBHOOK_SECRET);
    expect(logs).not.toMatch(/[0-9]{13,}/);
  });
});
