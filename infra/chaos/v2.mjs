// V2-051 (DEC-561): the kill points of the V2 critical paths — money and documents — in the chaos framework of
// PNT-098 (infra/chaos/run.mjs). Each scenario runs on the stage of run.mjs with the payment simulator as a fourth
// process (stage option `v2`), kills the api or the worker at its point with SIGKILL, restarts it unarmed and checks
// that nothing was charged, paid, issued or settled twice and nothing was lost:
//   kp6  payment_webhook_after_commit_before_done (worker): the webhook's job committed, its row not done
//   kp7  online_payment_after_gateway_ok_before_record (worker): a renewal charged at the gateway, not recorded
//   kp8  invoice_issued_before_commit (api): the invoice row of a paid visit written, the transaction not committed;
//        then ten customers pay at once — the simplified series stays one gapless chain
//   kp9  settlement_after_operator_commit (worker): job.settlement_monthly dies between two operators
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { importDist } from '../harness/deps.mjs';
import {
  CARDS,
  CARD_VERSION,
  CustomerClient,
  customerAccount,
  linkTicket,
  listedVenueWithPlan,
  platformSession,
  tokenize,
} from '../harness/v2.mjs';

const count = (rows) => Number(rows[0]?.n ?? 0);
const killed = (p, point) => p.exit?.signal === 'SIGKILL' && p.killPoint === point;

/** A parked WhatsApp ticket of the first venue, linked to a new customer account, its fee due (2300). */
async function payable(st) {
  const drv = await st.driver(st.payableDriver ?? 0);
  const t = await st.parked(drv);
  const account = await customerAccount(st.pool, { phone: t.phone });
  await linkTicket(st.pool, { ticketId: t.ticketId, accountId: account.id });
  return { t, account, c: new CustomerClient(st.base, account, { label: `cust-${t.ticketId.slice(0, 4)}` }) };
}

/** Waits until every stored payment webhook is processed and the simulator has nothing in flight. */
async function webhooksSettled(st) {
  await st.paySim.flush();
  await st.waitFor(
    async () =>
      count(
        await st.rows(`SELECT count(*)::int AS n FROM gateway_webhook_events WHERE processed_at IS NULL`),
      ) === 0 &&
      count(
        await st.rows(
          `SELECT count(*)::int AS n FROM outbox_events WHERE type = 'job.payment_webhook_process'
            AND status IN ('pending','processing')`,
        ),
      ) === 0,
    60_000,
    'payment webhooks processed',
  );
}

/** The gateway's redeliveries of every event of a payment (Moyasar retries a delivery that got no 2xx). */
async function redeliver(st, gatewayPaymentId) {
  const ds = (await st.paySim.deliveries()).filter((d) => d.payment_id === gatewayPaymentId);
  for (const d of ds) await st.paySim.replay(d.event_id);
  return ds.length;
}

/** One gapless chain per series: icv 1..n, each previous_hash the hash before it, the series row at the end. */
async function chainChecks(st, label) {
  const { FIRST_PREVIOUS_INVOICE_HASH } = await importDist('packages/shared/dist/index.js');
  const rows = await st.rows(
    `SELECT series, icv::int AS icv, previous_hash, invoice_hash FROM invoices ORDER BY series, icv`,
  );
  const series = await st.rows(`SELECT series, last_icv::int AS last_icv, last_hash FROM invoice_series`);
  const problems = [];
  for (const s of series) {
    const chain = rows.filter((r) => r.series === s.series);
    chain.forEach((r, i) => {
      if (r.icv !== i + 1) problems.push(`${s.series}: icv ${r.icv} at position ${i + 1}`);
      const prev = i === 0 ? FIRST_PREVIOUS_INVOICE_HASH : chain[i - 1].invoice_hash;
      if (r.previous_hash !== prev) problems.push(`${s.series}: previous_hash of icv ${r.icv}`);
    });
    if (s.last_icv !== chain.length) problems.push(`${s.series}: last_icv ${s.last_icv} ≠ ${chain.length}`);
    if (chain.length && s.last_hash !== chain.at(-1).invoice_hash) problems.push(`${s.series}: last_hash`);
  }
  st.check(
    `${label}: each invoice series is one gapless chain (icv 1..n, previous_hash, invoice_series)`,
    problems.length === 0,
    problems.length ? problems.slice(0, 5) : `${rows.length} invoice(s)`,
  );
}

// ------------------------------------------------------------------------------------------------ KP-6

/** KP-6: the worker dies after the webhook job committed the paid payment, before its outbox row is done. */
export async function kp6(st) {
  const { t, c } = await payable(st);
  const pay = await c.command('POST', `/v1/customer/visits/${t.ticketId}/pay`, {
    source: { type: 'token', token: await tokenize(st.payBase, CARDS.threeDs) },
  });
  st.check(
    'the visit pay with a 3-D Secure card answers 201 initiated',
    pay.status === 201 && pay.data?.status === 'initiated',
    {
      status: pay.status,
      code: pay.error?.code,
    },
  );
  const paymentId = pay.data.payment_id;
  const gp = (await st.rows(`SELECT gateway_payment_id FROM online_payments WHERE id = $1`, [paymentId]))[0]
    .gateway_payment_id;
  await webhooksSettled(st);
  await st.worker.stop();
  await st.startWorker({ CHAOS_KILL_AT: 'payment_webhook_after_commit_before_done' });
  await st.paySim.complete3ds(gp, 'success'); // the customer answers the bank's page: payment_paid is sent
  await st.worker.waitExit(60_000);
  st.check(
    'worker killed at KP-6 payment_webhook_after_commit_before_done (SIGKILL)',
    killed(st.worker, 'payment_webhook_after_commit_before_done'),
    st.worker.exit,
  );
  const atCrash = (await st.rows(`SELECT status FROM online_payments WHERE id = $1`, [paymentId]))[0];
  const job = async () =>
    (
      await st.rows(
        `SELECT o.status, o.attempts FROM outbox_events o
           JOIN gateway_webhook_events e ON o.payload->>'webhook_event_id' = e.id::text
          WHERE o.type = 'job.payment_webhook_process' AND e.gateway_payment_id = $1 AND e.event_type = 'payment_paid'`,
        [gp],
      )
    )[0];
  const jobAtCrash = await job();
  st.check(
    'at the crash: the payment is paid (committed) and its webhook job still processing',
    atCrash?.status === 'paid' && jobAtCrash?.status === 'processing',
    { payment: atCrash?.status, job: jobAtCrash },
  );
  await st.startWorker();
  const done = await st.waitFor(
    async () => ((await job())?.status === 'done' ? await job() : null),
    60_000,
    'the webhook job done after the lease expired',
  );
  st.check(
    'the webhook job ran again after the lease and completed (attempts = 2)',
    done.attempts === 2,
    done,
  );
  const redelivered = await redeliver(st, gp);
  await webhooksSettled(st);
  await sleep(1000);
  const events = await st.rows(
    `SELECT count(*)::int AS n, count(DISTINCT event_id)::int AS distinct_ids FROM gateway_webhook_events
      WHERE gateway_payment_id = $1`,
    [gp],
  );
  st.check(
    `the gateway's redeliveries (${redelivered}) stored once each (gateway, event_id)`,
    events[0].n === events[0].distinct_ids,
    events[0],
  );
  const paid = await st.rows(
    `SELECT count(*)::int AS n FROM customer_audit_log WHERE entity_id = $1 AND action = 'online_payment.paid'`,
    [paymentId],
  );
  st.check('one online_payment.paid transition', count(paid) === 1, `${count(paid)}`);
  const inv = await st.rows(`SELECT count(*)::int AS n FROM invoices WHERE online_payment_id = $1`, [
    paymentId,
  ]);
  st.check('one simplified invoice for the payment', count(inv) === 1, `${count(inv)}`);
  const ticket = (
    await st.rows(`SELECT payment_status, entitlement FROM tickets WHERE id = $1`, [t.ticketId])
  )[0];
  st.check(
    'the ticket is collected by the app payment once',
    ticket.payment_status === 'collected' && ticket.entitlement === 'app_paid',
    ticket,
  );
  await chainChecks(st, 'KP-6');
  await st.consistent();
}

// ------------------------------------------------------------------------------------------------ KP-7

/** Moves a subscription's current period so that it ends `msAgo` before now (the renewal is due now). */
async function endPeriodNow(st, subscriptionId, msAgo = 5_000) {
  const s = (
    await st.rows(`SELECT current_period_end FROM subscriptions WHERE id = $1`, [subscriptionId])
  )[0];
  const shiftMs = new Date(s.current_period_end).getTime() - (Date.now() - msAgo);
  const shift = `${shiftMs} milliseconds`;
  await st.pool.query(
    `UPDATE subscriptions SET cycle_anchor_at = cycle_anchor_at - $2::interval,
            current_period_start = current_period_start - $2::interval,
            current_period_end = current_period_end - $2::interval,
            activated_at = activated_at - $2::interval, created_at = created_at - $2::interval
      WHERE id = $1`,
    [subscriptionId, shift],
  );
  await st.pool.query(
    `UPDATE subscription_periods SET starts_at = starts_at - $2::interval, ends_at = ends_at - $2::interval
      WHERE subscription_id = $1`,
    [subscriptionId, shift],
  );
  // the timers of the period follow it (their payload names the period end: samePeriod)
  const end = (
    await st.rows(`SELECT current_period_end FROM subscriptions WHERE id = $1`, [subscriptionId])
  )[0].current_period_end;
  await st.pool.query(
    `UPDATE outbox_events SET available_at = available_at - $2::interval,
            payload = jsonb_set(payload, '{period_end}', to_jsonb($3::text))
      WHERE payload->>'subscription_id' = $1::text AND status = 'pending' AND payload ? 'period_end'`,
    [subscriptionId, shift, new Date(end).toISOString()],
  );
}

/** KP-7: a renewal charged at the gateway, the worker dead before the answer is recorded; never charged twice. */
export async function kp7(st) {
  const owner = await platformSession(st.pool, {
    phone: '+966559990701',
    cookieName: st.srv.PLATFORM_SESSION_COOKIE_NAME ?? 'point_platform_sid',
  });
  const planId = await listedVenueWithPlan(st.pool, {
    venueId: st.venue.id,
    orgId:
      st.world.orgId ?? (await st.rows(`SELECT org_id FROM venues WHERE id = $1`, [st.venue.id]))[0].org_id,
    approver: owner.userId,
  });
  const account = await customerAccount(st.pool, { phone: '+966579990701' });
  const c = new CustomerClient(st.base, account, { label: 'subscriber' });
  const v = await c.command('POST', '/v1/customer/vehicles', {
    plate: { country: 'SA', digits: '7701', letters_ar: 'ب ح د' },
    vehicle_make: 'toyota',
    vehicle_color: 'white',
    vehicle_type: 'sedan',
  });
  const sub = await c.command('POST', '/v1/customer/subscriptions', {
    plan_id: planId,
    billing_cycle: 'monthly',
    vehicle_ids: [v.data?.id],
    source: { type: 'token', token: await tokenize(st.payBase, CARDS.success) },
    save_card: true,
    card_on_file_version: CARD_VERSION,
  });
  st.check('the subscription checkout answers 201', sub.status === 201, {
    status: sub.status,
    code: sub.error?.code,
  });
  const subscriptionId = sub.data?.subscription?.subscription_id ?? sub.data?.subscription?.id;
  await webhooksSettled(st);
  const active = await st.waitFor(
    async () =>
      (await st.rows(`SELECT status, periods_paid FROM subscriptions WHERE id = $1`, [subscriptionId]))[0]
        ?.status === 'active',
    30_000,
    'the subscription active',
  );
  st.check('the first period is paid (active)', !!active);
  await st.worker.stop();
  await endPeriodNow(st, subscriptionId);
  // the renewal is due at once: the armed worker may die before its metrics port is up (no readiness wait)
  st.worker.start({ CHAOS_KILL_AT: 'online_payment_after_gateway_ok_before_record' });
  await st.worker.waitExit(60_000);
  st.check(
    'worker killed at KP-7 online_payment_after_gateway_ok_before_record (SIGKILL)',
    killed(st.worker, 'online_payment_after_gateway_ok_before_record'),
    st.worker.exit,
  );
  const renewal = async () =>
    st.rows(
      `SELECT id, status, given_id, gateway_payment_id FROM online_payments
        WHERE subscription_id = $1 AND subscription_period_seq = 2 ORDER BY created_at`,
      [subscriptionId],
    );
  const atCrash = await renewal();
  const atGateway = (await st.paySim.payments()).filter(
    (p) => p.metadata?.online_payment_id === atCrash[0]?.id,
  );
  st.check(
    'at the crash: the gateway charged the renewal; the platform has it initiated with no gateway id',
    atCrash.length === 1 &&
      atCrash[0].status === 'initiated' &&
      !atCrash[0].gateway_payment_id &&
      atGateway.length === 1 &&
      atGateway[0].status === 'paid',
    { local: atCrash, gateway: atGateway.map((p) => p.status) },
  );
  await st.startWorker();
  await st.waitFor(
    async () =>
      (await st.rows(`SELECT periods_paid FROM subscriptions WHERE id = $1`, [subscriptionId]))[0]
        ?.periods_paid === 2,
    90_000,
    'the second period paid',
  );
  await st.waitFor(
    async () =>
      count(
        await st.rows(
          `SELECT count(*)::int AS n FROM outbox_events WHERE type = 'job.subscription_renew'
            AND payload->>'subscription_id' = $1::text AND status IN ('pending','processing')
            AND available_at <= now()`,
          [subscriptionId],
        ),
      ) === 0,
    60_000,
    'the renewal job settled',
  );
  await webhooksSettled(st);
  await sleep(1500);
  const rows = await renewal();
  const charges = (await st.paySim.payments()).filter((p) => p.metadata?.subscription_id === subscriptionId);
  st.check(
    'one renewal payment, paid, under one given_id (renewalGivenId) — the gateway charged once',
    rows.length === 1 && rows[0].status === 'paid' && charges.filter((p) => p.status === 'paid').length === 2,
    { local: rows.map((r) => r.status), gateway: charges.map((p) => `${p.status}:${p.amount}`) },
  );
  const sub2 = (
    await st.rows(`SELECT status, periods_paid, renewal_attempts FROM subscriptions WHERE id = $1`, [
      subscriptionId,
    ])
  )[0];
  st.check(
    'the subscription renewed once (active, two periods, no failed attempt)',
    sub2.status === 'active' && sub2.periods_paid === 2 && sub2.renewal_attempts === 0,
    sub2,
  );
  const periods = await st.rows(
    `SELECT count(*)::int AS n FROM subscription_periods WHERE subscription_id = $1`,
    [subscriptionId],
  );
  st.check('two subscription_periods rows', count(periods) === 2, `${count(periods)}`);
  const inv = await st.rows(`SELECT count(*)::int AS n FROM invoices WHERE online_payment_id = $1`, [
    rows[0]?.id,
  ]);
  st.check('one invoice for the renewal', count(inv) === 1, `${count(inv)}`);
  await chainChecks(st, 'KP-7');
  await st.consistent();
}

// ------------------------------------------------------------------------------------------------ KP-8

/** KP-8: the api dies inside the transaction that issues the invoice of a paid visit; then ten pay at once. */
export async function kp8(st) {
  const first = await payable(st);
  await st.api.stop();
  await st.startApi({ CHAOS_KILL_AT: 'invoice_issued_before_commit' });
  const key = `chaos-${randomUUID()}`;
  const body = { source: { type: 'token', token: await tokenize(st.payBase, CARDS.success) } };
  const lost = await first.c.request('POST', `/v1/customer/visits/${first.t.ticketId}/pay`, {
    body,
    key,
    timeoutMs: 15_000,
  });
  await st.api.waitExit(20_000);
  st.check(
    'api killed at KP-8 invoice_issued_before_commit (SIGKILL)',
    killed(st.api, 'invoice_issued_before_commit'),
    st.api.exit,
  );
  st.check('the client got no answer', lost.status === 0, lost.error);
  const p0 = (
    await st.rows(`SELECT id, status, gateway_payment_id FROM online_payments WHERE ticket_id = $1`, [
      first.t.ticketId,
    ])
  )[0];
  const invAtCrash = await st.rows(`SELECT count(*)::int AS n FROM invoices WHERE online_payment_id = $1`, [
    p0?.id,
  ]);
  st.check(
    'at the crash: nothing of the paid answer committed (initiated, no gateway id, no invoice)',
    p0?.status === 'initiated' && !p0.gateway_payment_id && count(invAtCrash) === 0,
    { payment: p0, invoices: count(invAtCrash) },
  );
  await chainChecks(st, 'KP-8 at the crash');
  await st.startApi();
  // the app retries with the same Idempotency-Key: the same given_id reaches the gateway, which charged once
  const retry = await first.c.command('POST', `/v1/customer/visits/${first.t.ticketId}/pay`, body, { key });
  st.check(
    'the retry with the same key answers the same payment, paid',
    retry.status === 201 && retry.data?.payment_id === p0.id && retry.data?.status === 'paid',
    { status: retry.status, code: retry.error?.code, payment: retry.data?.payment_id === p0.id },
  );
  const gp = (await st.rows(`SELECT gateway_payment_id FROM online_payments WHERE id = $1`, [p0.id]))[0]
    .gateway_payment_id;
  await redeliver(st, gp);
  await webhooksSettled(st);
  const charges = (await st.paySim.payments()).filter((p) => p.metadata?.online_payment_id === p0.id);
  st.check(
    'the gateway holds one payment for it',
    charges.length === 1 && charges[0].status === 'paid',
    charges.length,
  );
  const inv = await st.rows(`SELECT count(*)::int AS n FROM invoices WHERE online_payment_id = $1`, [p0.id]);
  st.check('one invoice for it after the recovery', count(inv) === 1, `${count(inv)}`);

  // ten customers pay at the same moment: one counter row, one chain, no number twice, no gap
  const others = [];
  for (let i = 0; i < 10; i++) {
    st.payableDriver = 1 + (i % 3);
    others.push(await payable(st));
  }
  const tokens = await Promise.all(others.map(() => tokenize(st.payBase, CARDS.success)));
  const answers = await Promise.all(
    others.map((o, i) =>
      o.c.command('POST', `/v1/customer/visits/${o.t.ticketId}/pay`, {
        source: { type: 'token', token: tokens[i] },
      }),
    ),
  );
  st.check(
    'ten concurrent visit payments answered 201 paid',
    answers.every((a) => a.status === 201 && a.data?.status === 'paid'),
    answers.map((a) => a.status).join(','),
  );
  await webhooksSettled(st);
  const issued = await st.rows(
    `SELECT count(*)::int AS n FROM invoices i JOIN online_payments p ON p.id = i.online_payment_id
      WHERE p.ticket_id = ANY($1::uuid[]) AND i.kind <> 'credit_note'`,
    [others.map((o) => o.t.ticketId)],
  );
  st.check('one invoice per concurrent payment', count(issued) === 10, `${count(issued)}`);
  const dup = await st.rows(
    `SELECT count(*)::int AS n FROM (SELECT number FROM invoices GROUP BY number HAVING count(*) > 1) d`,
  );
  st.check('no invoice number twice', count(dup) === 0);
  await chainChecks(st, 'KP-8 after ten concurrent issues');
  await st.consistent();
}

// ------------------------------------------------------------------------------------------------ KP-9

const RIYADH_MS = 3 * 3_600_000;
function previousMonth(now = new Date()) {
  const d = new Date(now.getTime() + RIYADH_MS);
  const y = d.getUTCMonth() === 0 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
  const m = d.getUTCMonth() === 0 ? 12 : d.getUTCMonth();
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** KP-9: job.settlement_monthly dies after the first operator's statement committed; the rerun settles each once. */
export async function kp9(st) {
  const owner = await platformSession(st.pool, {
    phone: '+966559990901',
    cookieName: st.srv.PLATFORM_SESSION_COOKIE_NAME ?? 'point_platform_sid',
  });
  const period = previousMonth();
  const startsOn = `${period}-01`;
  const orgB = randomUUID();
  await st.pool.query(
    `INSERT INTO organizations (id, name_ar, operator_status, legal_name, vat_number, cr_number)
     VALUES ($1, 'مشغل الفوضى', 'active', 'شركة مشغل الفوضى', '320000000000003', '1010000099')`,
    [orgB],
  );
  const orgs = (
    await st.rows(`SELECT id FROM organizations WHERE is_platform_operated = false ORDER BY created_at, id`)
  ).map((r) => r.id);
  for (const org of orgs)
    await st.pool.query(
      `INSERT INTO operator_contracts (org_id, saas_fee_halalas_per_venue, saas_cycle, subscriber_visit_payout_halalas,
                                       app_payment_commission_bp, starts_on, created_by)
       VALUES ($1, 15000, 'monthly', 1500, 1000, $2, $3)`,
      [org, startsOn, owner.userId],
    );
  await st.worker.stop();
  await st.startWorker({ CHAOS_KILL_AT: 'settlement_after_operator_commit' });
  const platformOrg = (
    await st.rows(`SELECT id FROM organizations ORDER BY is_platform_operated DESC, created_at, id LIMIT 1`)
  )[0].id;
  const job = (
    await st.rows(
      `INSERT INTO outbox_events (org_id, type, payload, available_at, max_attempts)
       VALUES ($1, 'job.settlement_monthly', $2, now(), 5) RETURNING id`,
      [platformOrg, JSON.stringify({ period, reschedule: false })],
    )
  )[0].id;
  await st.worker.waitExit(60_000);
  st.check(
    'worker killed at KP-9 settlement_after_operator_commit (SIGKILL)',
    killed(st.worker, 'settlement_after_operator_commit'),
    st.worker.exit,
  );
  const statements = () =>
    st.rows(
      `SELECT s.id, s.org_id, s.status, s.net_payable_halalas::float8 AS net,
              (SELECT count(*)::int FROM settlement_lines l WHERE l.statement_id = s.id AND l.released_at IS NULL) AS lines
         FROM settlement_statements s WHERE s.period_start = $1 AND s.status <> 'void' ORDER BY s.org_id`,
      [startsOn],
    );
  const atCrash = await statements();
  st.check(
    `at the crash: one operator settled of ${orgs.length}`,
    atCrash.length === 1 && orgs.length >= 2,
    atCrash.map((s) => ({ org: s.org_id.slice(0, 8), lines: s.lines, net: s.net })),
  );
  await st.startWorker();
  const done = await st.waitFor(
    async () => {
      const r = (await st.rows(`SELECT status, attempts FROM outbox_events WHERE id = $1`, [job]))[0];
      return r?.status === 'done' ? r : null;
    },
    90_000,
    'job.settlement_monthly done after the lease',
  );
  st.check('the job ran again after the lease and completed (attempts = 2)', done.attempts === 2, done);
  const after = await statements();
  st.check(
    'one statement per operator for the month',
    after.length === orgs.length && new Set(after.map((s) => s.org_id)).size === orgs.length,
    after.map((s) => ({ org: s.org_id.slice(0, 8), lines: s.lines, net: s.net })),
  );
  const firstBefore = atCrash[0];
  const firstAfter = after.find((s) => s.id === firstBefore?.id);
  st.check(
    'the operator settled before the crash: same statement, recomputed to the same lines and total',
    !!firstAfter && firstAfter.lines === firstBefore.lines && firstAfter.net === firstBefore.net,
    { before: firstBefore, after: firstAfter },
  );
  const audits = await st.rows(
    `SELECT org_id, action, count(*)::int AS n FROM platform_audit_log
      WHERE action IN ('settlement.generate','settlement.recompute') AND metadata->>'period' = $1
      GROUP BY 1, 2 ORDER BY 1, 2`,
    [period],
  );
  const generated = audits.filter((a) => a.action === 'settlement.generate');
  st.check(
    'settlement.generate once per operator (the rerun recomputed the first one)',
    generated.length === orgs.length && generated.every((a) => a.n === 1),
    audits,
  );
  await st.consistent();
}

export const V2_SCENARIOS = {
  kp6: {
    fn: kp6,
    title: 'KP-6 payment_webhook_after_commit_before_done (V2: the payment webhook processed once)',
  },
  kp7: {
    fn: kp7,
    title: 'KP-7 online_payment_after_gateway_ok_before_record (V2: a renewal charged once, given_id)',
  },
  kp8: {
    fn: kp8,
    title: 'KP-8 invoice_issued_before_commit (V2: the invoice chain, then ten concurrent issues)',
  },
  kp9: {
    fn: kp9,
    title: 'KP-9 settlement_after_operator_commit (V2: job.settlement_monthly settles each operator once)',
  },
};
