import { randomUUID } from 'node:crypto';
import { SEED_IDS } from '@point/db/seed';
import {
  hasVisitInProgress,
  listAccountVisits,
  newCustomerToken,
  parseEncryptionKey,
  PASS_PREVIOUS_GRACE_DAYS,
  PASS_ROTATE_AFTER_DAYS,
  sha256Hex,
  verifyIntakePass,
} from '@point/server';
import {
  CUSTOMER_ROUTES,
  CustomerHomeSchema,
  CustomerPassSchema,
  generatePassToken,
  passStep,
  successEnvelopeSchema,
  type CustomerPass,
} from '@point/shared/customer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCustomerApp, freshDriver, messagesTo, type CustomerApp } from './customer-harness.js';
import { addPhotos, EVT_R1, EVT_R2, newDraft, ok, patchIntake, submitIntake } from './dispatch-fixtures.js';
import { newKey } from './harness.js';

/**
 * V2-013 / V2-014 — the entry pass (C-11, V2-D14) and the intake by pass (O-01, O-02) on a real PostgreSQL, with
 * the worker and the WhatsApp simulator (to prove that no W-01 leaves for an app ticket): `GET /v1/customer/pass`,
 * `POST /v1/tickets/intake-pass`, the entitlement at intake, and `listAccountVisits` (DEC-500 … DEC-504).
 */

const ORG = SEED_IDS.org;
const DAY = 24 * 3600 * 1000;
let w: CustomerApp;
let phoneSeq = 0;
const nextPhone = () => `+9665${String(81000000 + ++phoneSeq)}`;

interface Account {
  id: string;
  phone: string;
  access: string;
}

/** A customer account with a live session on its own device (sign-in itself is V2-010's suite). */
async function account(name: string | null = 'محمد العتيبي'): Promise<Account> {
  const phone = nextPhone();
  const a = await w.db.query<{ id: string }>(
    `INSERT INTO customer_accounts (phone_e164, display_name) VALUES ($1, $2) RETURNING id`,
    [phone, name],
  );
  const id = a.rows[0]!.id;
  return { id, phone, access: await session(id) };
}

async function session(accountId: string): Promise<string> {
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
  return access;
}

async function vehicle(accountId: string, digits: string): Promise<string> {
  const r = await w.db.query<{ id: string }>(
    `INSERT INTO customer_vehicles (account_id, plate_digits, plate_letters_ar, plate_letters_en, vehicle_make,
            vehicle_model, vehicle_color, vehicle_type)
     VALUES ($1, $2, 'ر س ص', 'R S X', 'hyundai', 'سوناتا', 'silver', 'sedan') RETURNING id`,
    [accountId, digits],
  );
  return r.rows[0]!.id;
}

async function passOf(a: Account): Promise<CustomerPass> {
  const r = await w.http().get(CUSTOMER_ROUTES.pass.path).set('Authorization', `Bearer ${a.access}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.headers['cache-control']).toContain('no-store');
  return successEnvelopeSchema(CustomerPassSchema).parse(r.body).data;
}

/** The QR of C-11 at the server's current step (+ offset steps: the device clock off by that much). */
const token = (p: CustomerPass, vehicleId: string | null, offset = 0) =>
  generatePassToken({
    secret: p.secret,
    accountId: p.account_id,
    vehicleId,
    step: passStep(w.clock.now().getTime()) + offset,
  });

const intakePass = (as: string, body: Record<string, unknown>, key?: string) =>
  w.command('post', '/v1/tickets/intake-pass', { as, body, key });

/** A new driver on duty at RMS with his D-04 draft. */
async function draftOf(eventId: string = EVT_R1) {
  const driver = await freshDriver(w);
  const d = await newDraft(w, driver, eventId);
  return { driver, ...d };
}

const errOf = (r: { status: number; body: any }) => ({
  status: r.status,
  code: r.body?.error?.code,
  reason: r.body?.error?.details?.reason,
});

beforeAll(async () => {
  w = await createCustomerApp();
}, 120_000);
afterAll(async () => w?.close());

describe('V2-013 — GET /v1/customer/pass (C-11)', () => {
  it('issues one secret per account, encrypted at rest, never in the audit, with the server time and the vehicles', async () => {
    const a = await account();
    const v = await vehicle(a.id, '4501');
    const p = await passOf(a);
    expect(p).toMatchObject({ scheme: 'P1', account_id: a.id, step_seconds: 30 });
    expect(p.server_time).toBe(w.clock.now().toISOString());
    expect(p.vehicles).toEqual([
      { vehicle_id: v, plate_display: '4501 ر س ص', vehicle_make: 'hyundai', vehicle_color: 'silver' },
    ]);
    expect(new Date(p.refresh_after).getTime() - new Date(p.rotated_at).getTime()).toBe(
      PASS_ROTATE_AFTER_DAYS * DAY,
    );
    // the same secret on the next call; stored only encrypted; the audit names the issue, never the secret
    expect((await passOf(a)).secret).toBe(p.secret);
    const row = (await w.db.query(`SELECT * FROM customer_passes WHERE account_id = $1`, [a.id])).rows[0];
    expect(row.secret_ciphertext).not.toContain(p.secret);
    const audit = await w.db.query(
      `SELECT action, metadata::text AS m FROM customer_audit_log WHERE account_id = $1 ORDER BY id`,
      [a.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['customer.pass.issued']);
    expect(audit.rows[0].m).not.toContain(p.secret);
    const leaks = await w.db.query(
      `SELECT count(*)::int AS n FROM (SELECT payload::text AS t FROM outbox_events UNION ALL SELECT metadata::text FROM audit_log) x
        WHERE t LIKE '%' || $1 || '%'`,
      [p.secret],
    );
    expect(leaks.rows[0].n).toBe(0);
  });

  it('rotates after its period and keeps the previous secret verifying for the grace days, then not', async () => {
    const a = await account();
    const old = await passOf(a);
    const keys = [parseEncryptionKey(w.env.DATA_ENCRYPTION_KEY, w.env.DATA_ENCRYPTION_KEY_ID)];
    const verify = (t: string) => w.db.transaction((tx) => verifyIntakePass(tx, keys, t));
    const start = w.clock.now();
    try {
      w.clock.advance(PASS_ROTATE_AFTER_DAYS * DAY + 60_000);
      const fresh = await passOf({ ...a, access: await session(a.id) });
      expect(fresh.secret).not.toBe(old.secret);
      expect(fresh.rotated_at).toBe(w.clock.now().toISOString());
      // an offline device still shows a QR signed with the cached secret
      expect((await verify(token(old, null))).accountId).toBe(a.id);
      expect((await verify(token(fresh, null))).accountId).toBe(a.id);
      w.clock.advance(PASS_PREVIOUS_GRACE_DAYS * DAY);
      await expect(verify(token(old, null))).rejects.toMatchObject({
        code: 'PASS_INVALID',
        details: { reason: 'bad_signature' },
      });
      expect((await verify(token(fresh, null))).accountId).toBe(a.id);
      const actions = await w.db.query(
        `SELECT action FROM customer_audit_log WHERE account_id = $1 ORDER BY id`,
        [a.id],
      );
      expect(actions.rows.map((r) => r.action)).toEqual(['customer.pass.issued', 'customer.pass.rotated']);
    } finally {
      w.clock.set(start);
    }
  });
});

describe('V2-013 — POST /v1/tickets/intake-pass (O-01)', () => {
  it('happy path: the D-05 draft becomes the app ticket, prefilled from the account, D-05 → D-06 unchanged, no W-01', async () => {
    const a = await account('سارة القحطاني');
    const v = await vehicle(a.id, '7310');
    const p = await passOf(a);
    const d = await draftOf();
    const r = await intakePass(d.driver, {
      pass_token: token(p, v),
      ticket_id: d.ticketId,
      expected_version: d.version,
    });
    const data = ok(r);
    expect(data.customer).toEqual({
      first_name: 'سارة',
      phone_masked: `05•••••${a.phone.slice(-3)}`,
      vehicle_prefilled: true,
      // V2-033: no subscription of the account at this venue
      subscription: null,
    });
    expect(data.task).toBeUndefined();
    expect(data.ticket).toMatchObject({
      id: d.ticketId,
      channel: 'app',
      wa_link_status: 'none',
      entitlement: 'event_included',
      plate: { digits: '7310', letters_ar: 'ر س ص', letters_en: 'R S X' },
      vehicle_detail: { make: 'hyundai', model: 'سوناتا', color: 'silver', type: 'sedan' },
      version: d.version + 1,
    });
    const t = (await w.db.query(`SELECT * FROM tickets WHERE id = $1`, [d.ticketId])).rows[0];
    expect(t).toMatchObject({ channel: 'app', customer_vehicle_id: v, entitlement: 'event_included' });
    // the operator's customers row: linked to the account, the phone and the language only (V2-D12)
    const c = (await w.db.query(`SELECT * FROM customers WHERE id = $1`, [t.customer_id])).rows[0];
    expect(c).toMatchObject({ org_id: ORG, phone_e164: a.phone, customer_account_id: a.id, wa_id: null });

    // D-05 «التالي» and D-06 as for any draft: key tag, photos, submit → parking
    const patched = ok(
      await patchIntake(w, d.driver, d.ticketId, { expected_version: t.version, key_tag: `KP-${phoneSeq}` }),
    );
    await addPhotos(w.db, d.ticketId, d.driver);
    const submitted = ok(await submitIntake(w, d.driver, d.ticketId, { expected_version: patched.version }));
    expect(submitted).toMatchObject({ status: 'parking', channel: 'app', wa_link_status: 'none' });
    await w.flush();
    expect(await messagesTo(w, a.phone)).toEqual([]);
    const notes = await w.db.query(`SELECT count(*)::int AS n FROM notifications WHERE ticket_id = $1`, [
      d.ticketId,
    ]);
    expect(notes.rows[0].n).toBe(0);

    // audit: the command row of the operator, the use of the pass on the account's trail
    const audit = await w.db.query(
      `SELECT action, metadata FROM audit_log WHERE entity_id = $1 AND metadata->>'operation' = 'POST /v1/tickets/intake-pass'`,
      [d.ticketId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: 'ticket.intake',
      metadata: { method: 'pass_draft', vehicle_prefilled: true },
    });
    const used = await w.db.query(
      `SELECT entity_id, metadata FROM customer_audit_log WHERE account_id = $1 AND action = 'customer.pass.used'`,
      [a.id],
    );
    expect(used.rows).toEqual([
      { entity_id: d.ticketId, metadata: expect.objectContaining({ org_id: ORG, vehicle_prefilled: true }) },
    ]);
  });

  it('idempotency: the same key and body replays the answer without a second effect; another key is a replayed step', async () => {
    const a = await account();
    const v = await vehicle(a.id, '1202');
    const p = await passOf(a);
    const d = await draftOf();
    const body = { pass_token: token(p, v), ticket_id: d.ticketId, expected_version: d.version };
    const key = newKey();
    const first = await intakePass(d.driver, body, key);
    const again = await intakePass(d.driver, body, key);
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual(first.body.data);
    const audits = await w.db.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND metadata->>'operation' = 'POST /v1/tickets/intake-pass'`,
      [d.ticketId],
    );
    expect(audits.rows[0].n).toBe(1);
    // a screenshot shown again inside the window: refused, on any draft
    const other = await draftOf();
    expect(
      errOf(
        await intakePass(other.driver, {
          ...body,
          ticket_id: other.ticketId,
          expected_version: other.version,
        }),
      ),
    ).toEqual({ status: 410, code: 'PASS_EXPIRED', reason: 'already_used' });
    // an older step of the same pass too
    expect(
      errOf(
        await intakePass(other.driver, {
          pass_token: token(p, v, -1),
          ticket_id: other.ticketId,
          expected_version: other.version,
        }),
      ),
    ).toEqual({ status: 410, code: 'PASS_EXPIRED', reason: 'already_used' });
  });

  it('clock skew: the current step ± 1 is accepted, ± 2 is expired', async () => {
    const a = await account();
    const p = await passOf(a);
    for (const [offset, expected] of [
      [-2, { status: 410, code: 'PASS_EXPIRED', reason: 'stale' }],
      [2, { status: 410, code: 'PASS_EXPIRED', reason: 'future' }],
    ] as const) {
      const d = await draftOf();
      expect(
        errOf(
          await intakePass(d.driver, {
            pass_token: token(p, null, offset),
            ticket_id: d.ticketId,
            expected_version: d.version,
          }),
        ),
      ).toEqual(expected);
    }
    // a phone a step behind, then one a step ahead (each step once)
    for (const offset of [-1, 1]) {
      const d = await draftOf();
      const r = await intakePass(d.driver, {
        pass_token: token(p, null, offset),
        ticket_id: d.ticketId,
        expected_version: d.version,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
  });

  it('invalid passes: malformed, another secret, a suspended or deleted account — the draft is untouched', async () => {
    const a = await account();
    const p = await passOf(a);
    const d = await draftOf();
    const at = (pass_token: string) =>
      intakePass(d.driver, { pass_token, ticket_id: d.ticketId, expected_version: d.version });
    expect(errOf(await at('not a pass'))).toEqual({ status: 422, code: 'PASS_INVALID', reason: 'malformed' });
    const forged = generatePassToken({
      secret: 'A'.repeat(43),
      accountId: a.id,
      vehicleId: null,
      nowMs: w.clock.now().getTime(),
    });
    expect(errOf(await at(forged))).toEqual({ status: 422, code: 'PASS_INVALID', reason: 'bad_signature' });
    // an account that never fetched its pass has no secret
    const never = await account();
    expect(
      errOf(
        await at(
          generatePassToken({ secret: p.secret, accountId: never.id, vehicleId: null, nowMs: Date.now() }),
        ),
      ),
    ).toMatchObject({ status: 422, code: 'PASS_INVALID' });
    await w.db.query(`UPDATE customer_accounts SET status = 'suspended' WHERE id = $1`, [a.id]);
    expect(errOf(await at(token(p, null)))).toEqual({
      status: 422,
      code: 'PASS_INVALID',
      reason: 'account_unavailable',
    });
    // a deleted account as DELETE /v1/customer/me leaves it (DEC-508): no number, no name, the keyed hash
    await w.db.query(
      `UPDATE customer_accounts SET status = 'deleted', deleted_at = $2, phone_e164 = NULL, display_name = NULL,
              phone_hash = repeat('a', 64)
        WHERE id = $1`,
      [a.id, w.clock.now()],
    );
    expect(errOf(await at(token(p, null)))).toEqual({
      status: 422,
      code: 'PASS_INVALID',
      reason: 'account_unavailable',
    });
    const t = (
      await w.db.query(`SELECT channel, customer_id, version FROM tickets WHERE id = $1`, [d.ticketId])
    ).rows[0];
    expect(t).toEqual({ channel: 'whatsapp', customer_id: null, version: d.version });
  });

  it('the operator suspended: refused with OPERATOR_SUSPENDED, like any new intake', async () => {
    const a = await account();
    const p = await passOf(a);
    const d = await draftOf();
    await w.db.query(`UPDATE organizations SET operator_status = 'suspended' WHERE id = $1`, [ORG]);
    try {
      expect(
        errOf(
          await intakePass(d.driver, {
            pass_token: token(p, null),
            ticket_id: d.ticketId,
            expected_version: d.version,
          }),
        ),
      ).toMatchObject({ status: 409, code: 'OPERATOR_SUSPENDED' });
    } finally {
      await w.db.query(`UPDATE organizations SET operator_status = 'active' WHERE id = $1`, [ORG]);
    }
  });

  it('scope as POST /v1/tickets: another driver’s draft, off duty, another venue’s event, a draft already with a customer', async () => {
    const a = await account();
    const p = await passOf(a);
    const d = await draftOf();
    const other = await freshDriver(w);
    // another driver's draft (scope first: the pass is not even read)
    expect(
      errOf(await intakePass(other, { pass_token: 'x', ticket_id: d.ticketId, expected_version: d.version })),
    ).toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    // a driver of LYL: the RMS draft is out of his venue scope, the RMS event too
    const lyl = await freshDriver(w, 'LYL');
    expect(
      errOf(
        await intakePass(lyl, {
          pass_token: token(p, null),
          ticket_id: d.ticketId,
          expected_version: d.version,
        }),
      ),
    ).toMatchObject({ status: 404, code: 'TICKET_NOT_FOUND' });
    expect(errOf(await intakePass(lyl, { pass_token: token(p, null), event_id: EVT_R1 }))).toMatchObject({
      status: 404,
      code: 'RESOURCE_NOT_FOUND',
    });
    // off duty (an admin holds ticket.intake only through a duty)
    expect(errOf(await intakePass('ADM1', { pass_token: token(p, null), event_id: EVT_R1 }))).toMatchObject({
      code: expect.stringMatching(/^(DUTY_REQUIRED|PERMISSION_DENIED)$/),
    });
    // expected_version is needed with the draft; a stale one is a conflict
    expect(
      errOf(await intakePass(d.driver, { pass_token: token(p, null), ticket_id: d.ticketId })),
    ).toMatchObject({
      status: 422,
      code: 'VALIDATION_FAILED',
    });
    expect(
      errOf(
        await intakePass(d.driver, {
          pass_token: token(p, null),
          ticket_id: d.ticketId,
          expected_version: d.version + 5,
        }),
      ),
    ).toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    // a draft whose customer channel is already set (a phone typed in D-05)
    const typed = ok(
      await patchIntake(w, d.driver, d.ticketId, {
        expected_version: d.version,
        customer_phone: '0551112233',
        consent: { method: 'verbal_staff_confirmed', confirmed: true },
      }),
    );
    expect(
      errOf(
        await intakePass(d.driver, {
          pass_token: token(p, null),
          ticket_id: d.ticketId,
          expected_version: typed.version,
        }),
      ),
    ).toEqual({ status: 409, code: 'INVALID_STATE_TRANSITION', reason: 'customer_channel_set' });
  });

  it('a vehicle that is not in the account: the ticket is the account’s, the driver enters the vehicle by hand', async () => {
    const a = await account();
    const stranger = await account();
    const theirs = await vehicle(stranger.id, '9090');
    const removed = await vehicle(a.id, '9191');
    await w.db.query(`UPDATE customer_vehicles SET removed_at = $2 WHERE id = $1`, [removed, w.clock.now()]);
    const p = await passOf(a);
    for (const [vehicleId, offset] of [
      [theirs, -1],
      [removed, 0],
      [null, 1],
    ] as const) {
      const d = await draftOf();
      const data = ok(
        await intakePass(d.driver, {
          pass_token: token(p, vehicleId, offset),
          ticket_id: d.ticketId,
          expected_version: d.version,
        }),
      );
      expect(data.customer.vehicle_prefilled).toBe(false);
      expect(data.ticket).toMatchObject({
        channel: 'app',
        plate: { digits: null },
        vehicle_detail: { make: null },
      });
      // D-05 manual entry, then the submit
      const patched = ok(
        await patchIntake(w, d.driver, d.ticketId, {
          expected_version: data.ticket.version,
          plate: { digits: String(3000 + phoneSeq), letters_ar: 'ب ح د' },
          vehicle: { make: 'toyota', color: 'white' },
          key_tag: `KM-${phoneSeq}-${offset + 2}`,
        }),
      );
      await addPhotos(w.db, d.ticketId, d.driver);
      expect(
        ok(await submitIntake(w, d.driver, d.ticketId, { expected_version: patched.version })),
      ).toMatchObject({ status: 'parking', channel: 'app' });
      const t = (await w.db.query(`SELECT customer_vehicle_id FROM tickets WHERE id = $1`, [d.ticketId]))
        .rows[0];
      expect(t.customer_vehicle_id).toBeNull();
    }
  });

  it('an app draft keeps its customer: a phone or a paper serial is refused, leaving the app channel unlinks the account', async () => {
    const a = await account();
    const v = await vehicle(a.id, '6060');
    const p = await passOf(a);
    const d = await draftOf();
    const app = ok(
      await intakePass(d.driver, {
        pass_token: token(p, v),
        ticket_id: d.ticketId,
        expected_version: d.version,
      }),
    ).ticket;
    const r = await patchIntake(w, d.driver, d.ticketId, {
      expected_version: app.version,
      customer_phone: '0551234567',
    });
    expect(r.status).toBe(422);
    expect(r.body.error.details.fields).toEqual([{ field: 'customer_phone', issue: 'app_channel' }]);
    const paper = ok(
      await patchIntake(w, d.driver, d.ticketId, {
        expected_version: app.version,
        channel: 'paper',
        paper_serial: `PP-${phoneSeq}`,
      }),
    );
    expect(paper).toMatchObject({ channel: 'paper', customer: null });
    const t = (
      await w.db.query(`SELECT customer_id, customer_vehicle_id FROM tickets WHERE id = $1`, [d.ticketId])
    ).rows[0];
    expect(t).toEqual({ customer_id: null, customer_vehicle_id: null });
  });

  it('without ticket_id the ticket is created as by POST /v1/tickets (201, the park task and the driver state)', async () => {
    const a = await account('خالد');
    const v = await vehicle(a.id, '5151');
    const p = await passOf(a);
    const driver = await freshDriver(w);
    const r = await intakePass(driver, { pass_token: token(p, v), event_id: EVT_R1 });
    const data = ok(r, 201);
    expect(data.task).toMatchObject({ type: 'park', status: 'in_progress' });
    expect(data.driver_state).toBeDefined();
    expect(data.ticket).toMatchObject({ status: 'received', channel: 'app', entitlement: 'event_included' });
    expect(data.customer).toMatchObject({ first_name: 'خالد', vehicle_prefilled: true });
    // the same customers row of the operator for a second visit of the account
    const rows = await w.db.query(`SELECT count(*)::int AS n FROM customers WHERE customer_account_id = $1`, [
      a.id,
    ]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('links an earlier WhatsApp customer of the operator with the same phone instead of a second row', async () => {
    const a = await account();
    await w.db.query(`INSERT INTO customers (org_id, phone_e164) VALUES ($1, $2)`, [ORG, a.phone]);
    const p = await passOf(a);
    const d = await draftOf();
    ok(
      await intakePass(d.driver, {
        pass_token: token(p, null),
        ticket_id: d.ticketId,
        expected_version: d.version,
      }),
    );
    const rows = await w.db.query(
      `SELECT customer_account_id FROM customers WHERE org_id = $1 AND phone_e164 = $2`,
      [ORG, a.phone],
    );
    expect(rows.rows).toEqual([{ customer_account_id: a.id }]);
  });
});

describe('V2-014 — entitlement at intake (docs/v2/04 §2) and the account’s visits', () => {
  it('event_included for an included event, none for per_vehicle — paper, WhatsApp and app alike', async () => {
    const included = await draftOf(EVT_R1);
    const perVehicle = await draftOf(EVT_R2);
    const ent = async (id: string) =>
      (await w.db.query(`SELECT entitlement, payment_status FROM tickets WHERE id = $1`, [id])).rows[0];
    expect(await ent(included.ticketId)).toEqual({
      entitlement: 'event_included',
      payment_status: 'not_required',
    });
    expect(await ent(perVehicle.ticketId)).toEqual({ entitlement: 'none', payment_status: 'due' });
    // the app intake keeps the entitlement decided at creation
    const a = await account();
    const p = await passOf(a);
    const r = ok(
      await intakePass(perVehicle.driver, {
        pass_token: token(p, null),
        ticket_id: perVehicle.ticketId,
        expected_version: perVehicle.version,
      }),
    );
    expect(r.ticket).toMatchObject({ entitlement: 'none', payment_status: 'due' });
    // the driver's task card carries the badge only when there is one (O-02)
    const card = ok(await w.get('/v1/me/home', included.driver)).current_task;
    expect(card.task.id).toBe(included.taskId);
    expect(card.ticket.entitlement).toBe('event_included');
    const due = ok(await w.get('/v1/me/home', perVehicle.driver)).current_task;
    expect(due.ticket.entitlement).toBeUndefined();
    expect(due.payment_due).toMatchObject({ amount_halalas: 2000 });
  });

  it('listAccountVisits: the account’s tickets across operators, newest first; home.current_visit is the open one', async () => {
    const a = await account();
    const v = await vehicle(a.id, '8080');
    const p = await passOf(a);
    const d = await draftOf();
    ok(
      await intakePass(d.driver, {
        pass_token: token(p, v),
        ticket_id: d.ticketId,
        expected_version: d.version,
      }),
    );

    // a visit of the same account at another operator (a second organization, minimal rows)
    const org2 = randomUUID();
    const venue2 = randomUUID();
    const pool2 = randomUUID();
    const user2 = randomUUID();
    const event2 = randomUUID();
    const customer2 = randomUUID();
    const ticket2 = randomUUID();
    await w.db.query(`INSERT INTO organizations (id, name_ar) VALUES ($1, 'مشغل آخر')`, [org2]);
    await w.db.query(`INSERT INTO venues (id, org_id, code, name_ar) VALUES ($1, $2, 'OTH', 'قاعة أخرى')`, [
      venue2,
      org2,
    ]);
    await w.db.query(
      `INSERT INTO dispatch_pools (id, org_id, venue_id, name, is_default) VALUES ($1, $2, $3, 'الافتراضية', true)`,
      [pool2, org2, venue2],
    );
    await w.db.query(
      `INSERT INTO users (id, org_id, employee_code, full_name, phone_e164, role, secret_kind, secret_hash)
       VALUES ($1, $2, 'O-0001', 'مالك آخر', '+966500077001', 'owner', 'password', 'x')`,
      [user2, org2],
    );
    await w.db
      .query(
        `INSERT INTO events (id, org_id, venue_id, dispatch_pool_id, name_ar, event_date, status, created_by)
       VALUES ($1, $2, $3, $4, 'حفل آخر', current_date, 'closed', $5)`,
        [event2, org2, venue2, pool2, user2],
      )
      .catch(async () =>
        w.db.query(
          `INSERT INTO events (id, org_id, venue_id, dispatch_pool_id, name_ar, event_date, status, created_by)
         VALUES ($1, $2, $3, $4, 'حفل آخر', current_date, 'open', $5)`,
          [event2, org2, venue2, pool2, user2],
        ),
      );
    await w.db.query(
      `INSERT INTO customers (id, org_id, phone_e164, customer_account_id) VALUES ($1, $2, $3, $4)`,
      [customer2, org2, a.phone, a.id],
    );
    await w.db.query(
      `INSERT INTO tickets (id, org_id, venue_id, event_id, dispatch_pool_id, display_number, status, channel,
              customer_id, created_by, created_at, delivered_at, delivered_by, vehicle_holder_type, key_holder_type)
       VALUES ($1, $2, $3, $4, $5, 1, 'delivered', 'whatsapp', $6, $7, $8, $8, $7, 'customer', 'customer')`,
      [ticket2, org2, venue2, event2, pool2, customer2, user2, new Date(w.clock.now().getTime() - DAY)],
    );

    const visits = await listAccountVisits(w.db, a.id);
    expect(visits.map((x) => [x.ticket_id, x.org_id, x.open, x.channel])).toEqual([
      [d.ticketId, ORG, true, 'app'],
      [ticket2, org2, false, 'whatsapp'],
    ]);
    expect(visits[0]).toMatchObject({
      customer_vehicle_id: v,
      entitlement: 'event_included',
      plate_display: '8080 ر س ص',
    });
    expect(Object.keys(visits[0]!)).not.toContain('key_tag');
    expect(await listAccountVisits(w.db, a.id, { openOnly: true })).toHaveLength(1);
    // another account sees none of them
    const b = await account();
    expect(await listAccountVisits(w.db, b.id)).toEqual([]);

    const home = await w.http().get(CUSTOMER_ROUTES.home.path).set('Authorization', `Bearer ${a.access}`);
    expect(home.status).toBe(200);
    const h = successEnvelopeSchema(CustomerHomeSchema).parse(home.body).data;
    expect(h.current_visit).toMatchObject({
      ticket_id: d.ticketId,
      venue_id: SEED_IDS.venues.RMS,
      status: 'received',
    });
    // the vehicle shows as in a visit (C-15 cannot remove it)
    const vehicles = await w
      .http()
      .get(CUSTOMER_ROUTES.vehicles.path)
      .set('Authorization', `Bearer ${a.access}`);
    expect(vehicles.body.data.items.find((x: { id: string }) => x.id === v).in_active_visit).toBe(true);
    // C-15 / C-20 see the app-intake visit: the car cannot be removed, the account cannot be deleted (DEC-505, DEC-508)
    const removal = await w
      .http()
      .delete(`/v1/customer/vehicles/${v}`)
      .set('Authorization', `Bearer ${a.access}`)
      .set('Idempotency-Key', newKey());
    expect(removal.body.error?.code).toBe('CUSTOMER_VEHICLE_IN_ACTIVE_VISIT');
    expect(await hasVisitInProgress(w.db, a.id)).toBe(true);
    expect(await hasVisitInProgress(w.db, b.id)).toBe(false);
  });
});
