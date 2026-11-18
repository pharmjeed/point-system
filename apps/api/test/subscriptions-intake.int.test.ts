import { randomUUID } from 'node:crypto';
import { SEED_IDS } from '@point/db/seed';
import { newCustomerToken, sha256Hex } from '@point/server';
import {
  CUSTOMER_ROUTES,
  CustomerPassSchema,
  CustomerVisitListSchema,
  generatePassToken,
  passStep,
  successEnvelopeSchema,
  type CustomerPass,
} from '@point/shared/customer';
import { riyadhMidnight } from '@point/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCustomerApp, freshDriver, type CustomerApp } from './customer-harness.js';
import {
  addPhotos,
  EVT_R2,
  newDraft,
  ok,
  PAPER_DRAFT,
  patchIntake,
  submitIntake,
} from './dispatch-fixtures.js';

/**
 * V2-033 (docs/v2/04 §2 rule 1, docs/v2/01 §4; DEC-535) — the entitlement `subscription` at intake for each channel
 * on a real PostgreSQL: the app pass (by the account's vehicle), WhatsApp and paper (by the plate of a covered
 * vehicle of the account the operator's customers row is linked to), a vehicle the subscription does not cover, a
 * second open ticket of the same vehicle, a plate changed before «إتمام التسجيل», a subscription that is not active,
 * and the account's visits. The event EVT-R2 is priced per vehicle (2000): a covered visit owes nothing.
 */

const ORG = SEED_IDS.org;
const RMS = SEED_IDS.venues.RMS;
const FEE = 2000;
let w: CustomerApp;
let planId: string;
let phoneSeq = 0;
const nextPhone = () => `+9665${String(74000000 + ++phoneSeq)}`;
let plateSeq = 0;

interface Account {
  id: string;
  phone: string;
  access: string;
}

async function account(): Promise<Account> {
  const phone = nextPhone();
  const id = (
    await w.db.query<{ id: string }>(
      `INSERT INTO customer_accounts (phone_e164, display_name) VALUES ($1, 'فهد الشمري') RETURNING id`,
      [phone],
    )
  ).rows[0]!.id;
  const sid = randomUUID();
  const access = newCustomerToken('access', sid);
  await w.db.query(
    `INSERT INTO customer_account_sessions (id, account_id, device_id, platform, refresh_hash, access_hash,
            access_expires_at, refresh_expires_at, created_at)
     VALUES ($1, $2, $3, 'ios', $4, $5, $6::timestamptz + interval '1 day', $6::timestamptz + interval '60 days', $6)`,
    [sid, id, `device-${sid}`, sha256Hex(newCustomerToken('refresh', sid)), sha256Hex(access), w.clock.now()],
  );
  return { id, phone, access };
}

/** A vehicle of the account (normalized as `POST /v1/customer/vehicles` stores it). */
async function vehicle(a: Account): Promise<{ id: string; digits: string }> {
  const digits = String(5100 + ++plateSeq);
  const r = await w.db.query<{ id: string }>(
    `INSERT INTO customer_vehicles (account_id, plate_digits, plate_letters_ar, plate_letters_en, vehicle_make,
            vehicle_color, vehicle_type)
     VALUES ($1, $2, 'ب ح د', 'B H D', 'toyota', 'white', 'sedan') RETURNING id`,
    [a.id, digits],
  );
  return { id: r.rows[0]!.id, digits };
}

/** An active subscription of the account at RMS covering the vehicles (its billing is the other suite's). */
async function subscription(a: Account, vehicles: string[], status = 'active'): Promise<string> {
  const now = w.clock.now();
  const end = new Date(now.getTime() + 30 * 86_400_000);
  const live = status === 'active';
  const r = await w.db.query<{ id: string }>(
    `INSERT INTO subscriptions (account_id, plan_id, org_id, venue_id, billing_cycle, status, price_halalas,
            vehicles_included, cycle_anchor_at, periods_paid, current_period_start, current_period_end, activated_at,
            ended_at, ended_reason, grace_ends_at)
     VALUES ($1, $2, $3, $4, 'monthly', $5, 30000, 2, $6, 1, $6, $7, $6, $8, $9, $10) RETURNING id`,
    [
      a.id,
      planId,
      ORG,
      RMS,
      status,
      now,
      end,
      status === 'expired' ? now : null,
      status === 'expired' ? 'grace_expired' : null,
      status === 'past_due' ? end : null,
    ],
  );
  expect(live || status === 'expired' || status === 'past_due').toBe(true);
  for (const v of vehicles)
    await w.db.query(
      `INSERT INTO subscription_vehicles (subscription_id, account_id, customer_vehicle_id) VALUES ($1, $2, $3)`,
      [r.rows[0]!.id, a.id, v],
    );
  return r.rows[0]!.id;
}

async function passOf(a: Account): Promise<CustomerPass> {
  const r = await w.http().get(CUSTOMER_ROUTES.pass.path).set('Authorization', `Bearer ${a.access}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return successEnvelopeSchema(CustomerPassSchema).parse(r.body).data;
}

/** A scan of C-11 at the next pass step (a used step is refused: the clock moves 30 s first). */
async function scan(
  driver: string,
  d: { ticketId: string; version: number },
  p: CustomerPass,
  vehicleId: string,
) {
  w.clock.advance(31_000);
  const pass_token = generatePassToken({
    secret: p.secret,
    accountId: p.account_id,
    vehicleId,
    step: passStep(w.clock.now().getTime()),
  });
  return w.command('post', '/v1/tickets/intake-pass', {
    as: driver,
    body: { pass_token, ticket_id: d.ticketId, expected_version: d.version },
  });
}

const ticket = async (id: string) =>
  (
    await w.db.query(
      `SELECT entitlement, subscription_id, payment_status, fee_halalas::int AS fee, channel, version
         FROM tickets WHERE id = $1`,
      [id],
    )
  ).rows[0];

/** D-05 «التالي» and D-06 for an app draft: key tag, photos, submit. */
async function finishApp(
  driver: string,
  ticketId: string,
  version: number,
  extra: Record<string, unknown> = {},
) {
  const patched = ok(
    await patchIntake(w, driver, ticketId, {
      expected_version: version,
      key_tag: `KS-${++plateSeq}`,
      ...extra,
    }),
  );
  await addPhotos(w.db, ticketId, driver);
  return ok(await submitIntake(w, driver, ticketId, { expected_version: patched.version }));
}

beforeAll(async () => {
  w = await createCustomerApp();
  const owner = (
    await w.db.query<{ id: string }>(
      `INSERT INTO platform_users (phone_e164, full_name, role, secret_hash) VALUES ('+966558880099', 'مالك', 'platform_owner', 'x')
       RETURNING id`,
    )
  ).rows[0]!.id;
  await w.db.query(
    `INSERT INTO venue_public_profiles (venue_id, org_id, status, category, subscriptions_enabled, approved_by, approved_at)
     VALUES ($1, $2, 'approved', 'office', true, $3, now())`,
    [RMS, ORG, owner],
  );
  planId = (
    await w.db.query<{ id: string }>(
      `INSERT INTO subscription_plans (org_id, venue_id, name_ar, vehicles_included, monthly_price_halalas, created_by)
       VALUES ($1, $2, 'سيارتان', 2, 30000, $3) RETURNING id`,
      [ORG, RMS, owner],
    )
  ).rows[0]!.id;
}, 120_000);
afterAll(async () => w?.close());

describe('V2-033 — the entitlement `subscription` at intake (docs/v2/04 §2)', () => {
  it('app pass: the covered vehicle → «مشترك بوينت», nothing due; kept at «إتمام التسجيل»; in the timeline', async () => {
    const a = await account();
    const v = await vehicle(a);
    const sub = await subscription(a, [v.id]);
    const driver = await freshDriver(w);
    const d = await newDraft(w, driver, EVT_R2);
    expect(await ticket(d.ticketId)).toMatchObject({ entitlement: 'none', payment_status: 'due', fee: FEE });
    const r = ok(await scan(driver, d, await passOf(a), v.id));
    expect(r.customer).toMatchObject({ vehicle_prefilled: true, subscription: 'covered' });
    expect(r.ticket).toMatchObject({ entitlement: 'subscription', payment_status: 'not_required' });
    expect(await ticket(d.ticketId)).toMatchObject({
      entitlement: 'subscription',
      subscription_id: sub,
      payment_status: 'not_required',
      fee: 0,
      channel: 'app',
    });
    const submitted = await finishApp(driver, d.ticketId, r.ticket.version);
    expect(submitted).toMatchObject({ status: 'parking', entitlement: 'subscription' });
    const ev = await w.db.query(
      `SELECT data AS payload FROM ticket_events WHERE ticket_id = $1 AND type = 'ticket.intake_submitted'`,
      [d.ticketId],
    );
    expect(ev.rows[0].payload).toMatchObject({ entitlement: 'subscription', subscription_id: sub });
    // the customer's visits (listAccountVisits) say it
    const visits = await w.http().get('/v1/customer/visits').set('Authorization', `Bearer ${a.access}`);
    const list = successEnvelopeSchema(CustomerVisitListSchema).parse(visits.body).data;
    expect(list.items.find((x) => x.ticket_id === d.ticketId)?.payment).toMatchObject({
      entitlement: 'subscription',
      payable_in_app: false,
    });

    // the same vehicle again while that visit is open: one open ticket per covered vehicle → a paid visit
    const driver2 = await freshDriver(w);
    const d2 = await newDraft(w, driver2, EVT_R2);
    const again = ok(await scan(driver2, d2, await passOf(a), v.id));
    expect(again.customer.subscription).toBe('open_ticket');
    expect(await ticket(d2.ticketId)).toMatchObject({ entitlement: 'none', payment_status: 'due', fee: FEE });
  });

  it('a vehicle the subscription does not cover: «مشترك — هذه السيارة غير مشمولة», a paid visit (01 §4)', async () => {
    const a = await account();
    const covered = await vehicle(a);
    const other = await vehicle(a);
    await subscription(a, [covered.id]);
    const driver = await freshDriver(w);
    const d = await newDraft(w, driver, EVT_R2);
    const r = ok(await scan(driver, d, await passOf(a), other.id));
    expect(r.customer.subscription).toBe('vehicle_not_covered');
    expect(await ticket(d.ticketId)).toMatchObject({ entitlement: 'none', payment_status: 'due', fee: FEE });
  });

  it('another plate typed before «إتمام التسجيل»: the visit is the event’s again, its fee taken from the event', async () => {
    const a = await account();
    const v = await vehicle(a);
    await subscription(a, [v.id]);
    const driver = await freshDriver(w);
    const d = await newDraft(w, driver, EVT_R2);
    const r = ok(await scan(driver, d, await passOf(a), v.id));
    expect(r.ticket.entitlement).toBe('subscription');
    const submitted = await finishApp(driver, d.ticketId, r.ticket.version, {
      plate: { digits: '9988', letters_ar: 'ب ح د' },
    });
    expect(submitted).toMatchObject({ entitlement: 'none', payment_status: 'due' });
    expect(await ticket(d.ticketId)).toMatchObject({ subscription_id: null, fee: FEE });
  });

  it('WhatsApp: the plate of a covered vehicle of the account the customers row is linked to', async () => {
    const a = await account();
    const v = await vehicle(a);
    const sub = await subscription(a, [v.id]);
    // an earlier pass intake at this operator linked the operator's row of this phone to the account (DEC-501)
    await w.db.query(`INSERT INTO customers (org_id, phone_e164, customer_account_id) VALUES ($1, $2, $3)`, [
      ORG,
      a.phone,
      a.id,
    ]);
    const driver = await freshDriver(w);
    const d = await newDraft(w, driver, EVT_R2);
    const p = ok(
      await patchIntake(w, driver, d.ticketId, {
        expected_version: d.version,
        ...PAPER_DRAFT('X', `KW-${++plateSeq}`, v.digits),
        channel: 'whatsapp',
        paper_serial: null,
        customer_phone: a.phone,
        consent: { method: 'verbal_staff_confirmed', confirmed: true },
      }),
    );
    await addPhotos(w.db, d.ticketId, driver);
    const s = ok(await submitIntake(w, driver, d.ticketId, { expected_version: p.version }));
    expect(s).toMatchObject({
      channel: 'whatsapp',
      entitlement: 'subscription',
      payment_status: 'not_required',
    });
    expect((await ticket(d.ticketId)).subscription_id).toBe(sub);
  });

  it('WhatsApp of a phone whose operator row is not linked to the account: a paid visit', async () => {
    const a = await account();
    const v = await vehicle(a);
    await subscription(a, [v.id]);
    const driver = await freshDriver(w);
    const d = await newDraft(w, driver, EVT_R2);
    const p = ok(
      await patchIntake(w, driver, d.ticketId, {
        expected_version: d.version,
        ...PAPER_DRAFT('X', `KW-${++plateSeq}`, v.digits),
        channel: 'whatsapp',
        paper_serial: null,
        customer_phone: a.phone,
        consent: { method: 'verbal_staff_confirmed', confirmed: true },
      }),
    );
    await addPhotos(w.db, d.ticketId, driver);
    const s = ok(await submitIntake(w, driver, d.ticketId, { expected_version: p.version }));
    expect(s).toMatchObject({ entitlement: 'none', payment_status: 'due' });
  });

  it('paper: covered when the stub’s customer is linked to the account before «إتمام التسجيل»', async () => {
    const a = await account();
    const v = await vehicle(a);
    const sub = await subscription(a, [v.id]);
    const c = await w.db.query<{ id: string }>(
      `INSERT INTO customers (org_id, phone_e164, customer_account_id) VALUES ($1, $2, $3) RETURNING id`,
      [ORG, a.phone, a.id],
    );
    const driver = await freshDriver(w);
    const d = await newDraft(w, driver, EVT_R2);
    const p = ok(
      await patchIntake(w, driver, d.ticketId, {
        expected_version: d.version,
        ...PAPER_DRAFT(`PS-${++plateSeq}`, `KP-${plateSeq}`, v.digits),
      }),
    );
    // the stub's WhatsApp link completed during the intake (the link service sets the customer)
    await w.db.query(`UPDATE tickets SET customer_id = $2 WHERE id = $1`, [d.ticketId, c.rows[0]!.id]);
    await addPhotos(w.db, d.ticketId, driver);
    const s = ok(await submitIntake(w, driver, d.ticketId, { expected_version: p.version }));
    expect(s).toMatchObject({ channel: 'paper', entitlement: 'subscription' });
    expect((await ticket(d.ticketId)).subscription_id).toBe(sub);
    // a paper stub without a customer is the event's
    const driver2 = await freshDriver(w);
    const d2 = await newDraft(w, driver2, EVT_R2);
    const p2 = ok(
      await patchIntake(w, driver2, d2.ticketId, {
        expected_version: d2.version,
        ...PAPER_DRAFT(`PS-${++plateSeq}`, `KP-${plateSeq}`, '4455'),
      }),
    );
    await addPhotos(w.db, d2.ticketId, driver2);
    expect(ok(await submitIntake(w, driver2, d2.ticketId, { expected_version: p2.version }))).toMatchObject({
      entitlement: 'none',
    });
  });

  it('a subscription that is not active covers nothing (past due, expired)', async () => {
    for (const status of ['past_due', 'expired']) {
      const a = await account();
      const v = await vehicle(a);
      await subscription(a, [v.id], status);
      const driver = await freshDriver(w);
      const d = await newDraft(w, driver, EVT_R2);
      const r = ok(await scan(driver, d, await passOf(a), v.id));
      expect(r.customer.subscription, status).toBeNull();
      expect(await ticket(d.ticketId)).toMatchObject({ entitlement: 'none', payment_status: 'due' });
    }
  });
});

/**
 * V2-036 (docs/v2/04 §7; DEC-592; the subscriptions annex clauses 1 and 2): a counted-day term at intake — from its
 * first counted day, on its service weekdays (Sunday … Thursday), one covered visit a Riyadh day; any other visit is
 * a normal one of the venue (its fee from the event), never a refused intake.
 */
describe('V2-036 — a counted-day term at intake (DEC-592)', () => {
  let studentPlan: string;

  async function countedSubscription(a: Account, vehicles: string[], startOn: string, endOn: string) {
    const r = await w.db.query<{ id: string }>(
      `INSERT INTO subscriptions (account_id, plan_id, org_id, venue_id, billing_cycle, status, price_halalas,
              vehicles_included, cycle_anchor_at, periods_paid, current_period_start, current_period_end, activated_at,
              service_start_on, service_end_on)
       VALUES ($1, $2, $3, $4, 'monthly', 'active', 17250, 2, $5, 1, $6, $7, $5, $8, $9) RETURNING id`,
      [
        a.id,
        studentPlan,
        ORG,
        RMS,
        w.clock.now(),
        riyadhMidnight(startOn),
        riyadhMidnight(endOn),
        startOn,
        endOn,
      ],
    );
    for (const v of vehicles)
      await w.db.query(
        `INSERT INTO subscription_vehicles (subscription_id, account_id, customer_vehicle_id) VALUES ($1, $2, $3)`,
        [r.rows[0]!.id, a.id, v],
      );
    return r.rows[0]!.id;
  }

  beforeAll(async () => {
    const owner = (await w.db.query<{ id: string }>(`SELECT id FROM platform_users LIMIT 1`)).rows[0]!.id;
    studentPlan = (
      await w.db.query<{ id: string }>(
        `INSERT INTO subscription_plans (org_id, venue_id, name_ar, vehicles_included, monthly_price_halalas, created_by,
                                         term_kind, service_days, service_weekdays_mask, renewal_mode,
                                         daily_visit_limit, refund_policy, closure_policy, freeze_max_times,
                                         freeze_max_days, eligibility)
         VALUES ($1, $2, 'باقة الطالب', 2, 17250, $3, 'service_days', 22, 31, 'manual', 1, 'non_refundable',
                 'continue', 1, 5, 'student_id_review') RETURNING id`,
        [ORG, RMS, owner],
      )
    ).rows[0]!.id;
    w.clock.set('2026-11-01T06:00:00.000Z'); // Sunday 09:00 Asia/Riyadh
  });

  /** a pass scan by a fresh driver on a new draft of EVT-R2: the customer badge and the ticket's entitlement */
  async function scanNow(a: Account, vehicleId: string) {
    const driver = await freshDriver(w);
    const d = await newDraft(w, driver, EVT_R2);
    const r = ok(await scan(driver, d, await passOf(a), vehicleId));
    return { badge: r.customer.subscription, ticket: await ticket(d.ticketId) };
  }

  it('one covered visit a day: a second car the same day is a paid visit; the next day is covered again', async () => {
    const a = await account();
    const v1 = await vehicle(a);
    const v2 = await vehicle(a);
    const sub = await countedSubscription(a, [v1.id, v2.id], '2026-11-01', '2026-11-30');
    const first = await scanNow(a, v1.id);
    expect(first.badge).toBe('covered');
    expect(first.ticket).toMatchObject({ entitlement: 'subscription', subscription_id: sub, fee: 0 });
    // the same day, the other covered car: the day's visit is used (daily_visit_limit = 1), the event's fee
    const second = await scanNow(a, v2.id);
    expect(second.badge).toBeNull();
    expect(second.ticket).toMatchObject({ entitlement: 'none', payment_status: 'due', fee: FEE });
    // the next day is a new counted day (a third covered car: the two others still have their open visits)
    const v3 = await vehicle(a);
    await w.db.query(
      `INSERT INTO subscription_vehicles (subscription_id, account_id, customer_vehicle_id) VALUES ($1, $2, $3)`,
      [sub, a.id, v3.id],
    );
    w.clock.set('2026-11-02T05:00:00.000Z');
    const nextDay = await scanNow(a, v3.id);
    expect(nextDay.ticket).toMatchObject({ entitlement: 'subscription', subscription_id: sub });
  });

  it('Friday and Saturday serve nothing of the term; a term not begun covers nothing yet', async () => {
    w.clock.set('2026-11-06T06:00:00.000Z'); // Friday
    const a = await account();
    const v = await vehicle(a);
    await countedSubscription(a, [v.id], '2026-11-01', '2026-11-30');
    const friday = await scanNow(a, v.id);
    expect(friday.badge).toBeNull();
    expect(friday.ticket).toMatchObject({ entitlement: 'none', payment_status: 'due' });
    w.clock.set('2026-11-08T05:00:00.000Z'); // Sunday 08:00
    const b = await account();
    const vb = await vehicle(b);
    const vb2 = await vehicle(b);
    await countedSubscription(b, [vb.id, vb2.id], '2026-11-09', '2026-12-08'); // its first counted day is Monday
    expect((await scanNow(b, vb.id)).ticket).toMatchObject({ entitlement: 'none' });
    w.clock.set('2026-11-09T04:30:00.000Z');
    expect((await scanNow(b, vb2.id)).ticket).toMatchObject({ entitlement: 'subscription' });
  });
});
