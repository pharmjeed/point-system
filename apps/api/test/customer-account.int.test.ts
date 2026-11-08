import { SEED_IDS } from '@point/db/seed';
import { customerAccountsJobs, deletedPhoneHash, sha256Hex } from '@point/server';
import { WA_CUSTOMER_OTP_TEMPLATE_NAME } from '@point/shared';
import {
  CUSTOMER_ROUTES,
  CustomerAccountDeletedSchema,
  CustomerReauthSchema,
  CustomerVehicleRemovedSchema,
} from '@point/shared/customer';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCustomerApp, tablesContaining, type CustomerApp } from './customer-harness.js';
import { newKey } from './harness.js';
import { createTicket } from './wa-harness.js';

/**
 * V2-012 (C-15) and V2-017 (C-20) — removing a vehicle, re-verifying with a fresh WhatsApp code and deleting the
 * account, on a real PostgreSQL with the WhatsApp simulator as the Point number (DEC-505, DEC-507, DEC-508). The
 * deletion journey is also driven by the customer app's own client over its `httpTransport`.
 */

const ORG = SEED_IDS.org;

let w: CustomerApp;
let phoneSeq = 0;
const nextPhone = () => `+9665${String(71000000 + ++phoneSeq).padStart(8, '0')}`;
let deviceSeq = 0;
let DEVICE = { device_id: 'device-acct-0000', platform: 'ios' as 'ios' | 'android' };

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const err = (r: request.Response) => r.body?.error as { code: string; details: Record<string, unknown> };
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  w
    .http()
    .post(path)
    .set(headers)
    .send(body as object);
const getAs = (path: string, token: string) => w.http().get(path).set(bearer(token));
const del = (path: string, token: string, body?: unknown, key: string | null = newKey()) => {
  let req = w.http().delete(path).set(bearer(token));
  if (key) req = req.set('Idempotency-Key', key);
  return body === undefined ? req : req.send(body as object);
};

async function codeFor(phone: string): Promise<string> {
  await w.drain();
  const msgs = (await w.sim.client.listMessages({ to: phone })).filter(
    (m) => m.templateName === WA_CUSTOMER_OTP_TEMPLATE_NAME,
  );
  const last = msgs.sort((a, b) => a.seq - b.seq).at(-1);
  if (!last) throw new Error(`no code reached ${phone}`);
  return last.bodyParams[0]!;
}

interface Signed {
  phone: string;
  device: typeof DEVICE;
  access_token: string;
  refresh_token: string;
  account: { id: string };
  is_new_account: boolean;
}

async function signIn(phone = nextPhone(), device = DEVICE): Promise<Signed> {
  const r = await post(CUSTOMER_ROUTES.otpRequest.path, { phone_e164: phone, ...device });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const v = await post(CUSTOMER_ROUTES.otpVerify.path, {
    phone_e164: phone,
    code: await codeFor(phone),
    ...device,
  });
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  return { phone, device, ...v.body.data };
}

/** C-20 steps 1–2: a fresh code for the account's own number, then the proof. */
async function reauth(s: Signed): Promise<string> {
  w.clock.advance(61_000); // past the resend wait of a previous code of the number
  const r = await post(CUSTOMER_ROUTES.otpRequest.path, { phone_e164: s.phone, ...s.device });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const v = await post(
    CUSTOMER_ROUTES.reauthVerify.path,
    { code: await codeFor(s.phone) },
    bearer(s.access_token),
  );
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  return CustomerReauthSchema.parse(v.body.data).reauth_token;
}

async function addVehicle(s: Signed, digits: string, letters_ar = 'ب ح د') {
  const r = await w
    .http()
    .post(CUSTOMER_ROUTES.vehicleCreate.path)
    .set(bearer(s.access_token))
    .set('Idempotency-Key', newKey())
    .send({ plate: { digits, letters_ar } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as { id: string; in_active_visit: boolean };
}

/** An operator's `customers` row linked to the account (V2-D12) with an open ticket of plate 4821 ب ح د. */
async function visitInProgress(s: Signed) {
  const cus = (
    await w.db.query<{ id: string }>(
      `INSERT INTO customers (org_id, phone_e164, customer_account_id) VALUES ($1, $2, $3) RETURNING id`,
      [ORG, s.phone, s.account.id],
    )
  ).rows[0]!.id;
  const ticket = await createTicket(w, { customerId: cus, status: 'parked' });
  return { customerId: cus, ticketId: ticket.id };
}

beforeAll(async () => {
  // the re-verification tests ask for several codes per number within the hour (the limit itself: customer-api)
  w = await createCustomerApp({
    env: { CUSTOMER_OTP_PER_PHONE_PER_HOUR: '50', CUSTOMER_OTP_PER_DEVICE_PER_HOUR: '50' },
  });
  for (const h of customerAccountsJobs({ runtime: w.rt })) w.dispatcher.register(h);
}, 120_000);
afterAll(async () => w?.close());
beforeEach(() => {
  DEVICE = { device_id: `device-acct-${String(++deviceSeq).padStart(4, '0')}`, platform: 'ios' };
});

describe('V2-012 — C-15 remove a vehicle (DEC-505)', () => {
  it('soft remove with removed_at and an audit row; the plate can be added again; the key replays', async () => {
    const s = await signIn();
    const car = await addVehicle(s, '77');
    const key = newKey();
    const path = `/v1/customer/vehicles/${car.id}`;
    const r = await del(path, s.access_token, undefined, key);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(CustomerVehicleRemovedSchema.parse(r.body.data)).toEqual({
      vehicle_id: car.id,
      removed_at: w.clock.now().toISOString(),
    });
    const replay = await del(path, s.access_token, undefined, key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data).toEqual(r.body.data);
    // never a hard delete: the row stays with removed_at
    const row = (
      await w.db.query(`SELECT removed_at, plate_digits FROM customer_vehicles WHERE id = $1`, [car.id])
    ).rows[0];
    expect(row).toMatchObject({ plate_digits: '77', removed_at: expect.any(Date) });
    expect((await getAs(CUSTOMER_ROUTES.vehicles.path, s.access_token)).body.data.items).toEqual([]);
    expect((await getAs(CUSTOMER_ROUTES.me.path, s.access_token)).body.data.vehicles_count).toBe(0);
    // already removed, with a new key: not found
    const again = await del(path, s.access_token);
    expect(again.status).toBe(404);
    expect(err(again)).toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
      details: { resource: 'customer_vehicle' },
    });
    // the plate is free again (uq_customer_vehicles_plate is partial on removed_at)
    expect((await addVehicle(s, '77')).id).not.toBe(car.id);
    const audit = (
      await w.db.query(
        `SELECT action, entity_id FROM customer_audit_log WHERE account_id = $1 AND action = 'customer.vehicle.remove'`,
        [s.account.id],
      )
    ).rows;
    expect(audit).toEqual([{ action: 'customer.vehicle.remove', entity_id: car.id }]);
  });

  it("another account's vehicle, an unknown id or a malformed one: RESOURCE_NOT_FOUND, nothing changes", async () => {
    const owner = await signIn();
    const car = await addVehicle(owner, '88');
    DEVICE = { device_id: `device-acct-${String(++deviceSeq).padStart(4, '0')}`, platform: 'android' };
    const other = await signIn();
    for (const id of [car.id, '00000000-0000-4000-8000-0000deadbeef', 'not-a-uuid']) {
      const r = await del(`/v1/customer/vehicles/${id}`, other.access_token);
      expect(r.status, id).toBe(404);
      expect(err(r).code, id).toBe('RESOURCE_NOT_FOUND');
    }
    expect(
      (await w.db.query(`SELECT removed_at FROM customer_vehicles WHERE id = $1`, [car.id])).rows[0]
        .removed_at,
    ).toBeNull();
    expect((await getAs(CUSTOMER_ROUTES.vehicles.path, owner.access_token)).body.data.items).toHaveLength(1);
  });

  it('a vehicle in a visit in progress is refused (in_active_visit) until the visit ends', async () => {
    const s = await signIn();
    const car = await addVehicle(s, '4821');
    w.clock.advance(1000); // «oldest first»: distinct created_at
    const other = await addVehicle(s, '12');
    const { ticketId } = await visitInProgress(s);
    const listed = (await getAs(CUSTOMER_ROUTES.vehicles.path, s.access_token)).body.data.items as {
      id: string;
      in_active_visit: boolean;
    }[];
    expect(listed.map((v) => [v.id, v.in_active_visit])).toEqual([
      [car.id, true],
      [other.id, false],
    ]);
    const r = await del(`/v1/customer/vehicles/${car.id}`, s.access_token);
    expect(r.status).toBe(409);
    expect(err(r).code).toBe('CUSTOMER_VEHICLE_IN_ACTIVE_VISIT');
    expect(
      (await w.db.query(`SELECT removed_at FROM customer_vehicles WHERE id = $1`, [car.id])).rows[0]
        .removed_at,
    ).toBeNull();
    // the other car of the account is not in the visit
    expect((await del(`/v1/customer/vehicles/${other.id}`, s.access_token)).status).toBe(200);
    await w.db.query(
      `UPDATE tickets SET status = 'voided', voided_at = now(), void_reason = 'test' WHERE id = $1`,
      [ticketId],
    );
    expect((await del(`/v1/customer/vehicles/${car.id}`, s.access_token)).status).toBe(200);
  });

  it('Idempotency-Key is required', async () => {
    const s = await signIn();
    const car = await addVehicle(s, '99');
    const r = await del(`/v1/customer/vehicles/${car.id}`, s.access_token, undefined, null);
    expect(r.status).toBe(428);
    expect(err(r).code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

describe('V2-017 — C-20 re-verification proof (DEC-507)', () => {
  it('the deletion needs a fresh proof of this very session: missing, invalid, another session, expired', async () => {
    const s = await signIn();
    const missing = await del(CUSTOMER_ROUTES.meDelete.path, s.access_token, {});
    expect(missing.status).toBe(403);
    expect(err(missing)).toMatchObject({ code: 'CUSTOMER_REAUTH_REQUIRED', details: { reason: 'missing' } });
    const forged = await del(CUSTOMER_ROUTES.meDelete.path, s.access_token, {
      reauth_token: `pcv.${s.account.id}.${'A'.repeat(43)}`,
    });
    expect(err(forged)).toMatchObject({ code: 'CUSTOMER_REAUTH_REQUIRED', details: { reason: 'invalid' } });
    // a proof of another device's session of the same account does not count here
    const otherDevice = {
      device_id: `device-acct-${String(++deviceSeq).padStart(4, '0')}`,
      platform: 'android' as const,
    };
    w.clock.advance(61_000);
    const second = await signIn(s.phone, otherDevice);
    const foreign = await reauth(second);
    const cross = await del(CUSTOMER_ROUTES.meDelete.path, s.access_token, { reauth_token: foreign });
    expect(err(cross)).toMatchObject({ code: 'CUSTOMER_REAUTH_REQUIRED', details: { reason: 'invalid' } });
    // stored as sha256 only
    const stored = (
      await w.db.query(
        `SELECT reauth_hash FROM customer_account_sessions WHERE account_id = $1 AND reauth_hash IS NOT NULL`,
        [s.account.id],
      )
    ).rows;
    expect(stored).toEqual([{ reauth_hash: sha256Hex(foreign) }]);
    // expired after 300 s
    const mine = await reauth(s);
    w.clock.advance(301_000);
    const late = await del(CUSTOMER_ROUTES.meDelete.path, s.access_token, { reauth_token: mine });
    expect(err(late)).toMatchObject({ code: 'CUSTOMER_REAUTH_REQUIRED', details: { reason: 'expired' } });
    // a newer proof replaces the previous one
    const first = await reauth(s);
    const newer = await reauth(s);
    const replaced = await del(CUSTOMER_ROUTES.meDelete.path, s.access_token, { reauth_token: first });
    expect(err(replaced).details).toEqual({ reason: 'invalid' });
    expect(newer).not.toBe(first);
    expect((await getAs(CUSTOMER_ROUTES.me.path, s.access_token)).body.data.status).toBe('active');
  });

  it('the code rules of the sign-in apply: wrong code costs an attempt, unknown → expired; Bearer required', async () => {
    const s = await signIn();
    w.clock.advance(61_000);
    await post(CUSTOMER_ROUTES.otpRequest.path, { phone_e164: s.phone, ...s.device });
    const code = await codeFor(s.phone);
    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await post(CUSTOMER_ROUTES.reauthVerify.path, { code: wrong }, bearer(s.access_token));
    expect(bad.status).toBe(422);
    expect(err(bad)).toMatchObject({ code: 'CUSTOMER_OTP_INVALID', details: { attempts_left: 4 } });
    const anon = await post(CUSTOMER_ROUTES.reauthVerify.path, { code });
    expect(err(anon).code).toBe('AUTH_UNAUTHENTICATED');
    const good = await post(CUSTOMER_ROUTES.reauthVerify.path, { code }, bearer(s.access_token));
    expect(good.status).toBe(200);
    expect(Date.parse(good.body.data.expires_at) - w.clock.now().getTime()).toBe(300_000);
    // the code is consumed: a second use is CUSTOMER_OTP_EXPIRED
    const reused = await post(CUSTOMER_ROUTES.reauthVerify.path, { code }, bearer(s.access_token));
    expect(reused.status).toBe(410);
    expect(err(reused).code).toBe('CUSTOMER_OTP_EXPIRED');
    const audit = (
      await w.db.query(
        `SELECT action, actor_type FROM customer_audit_log WHERE account_id = $1 AND action LIKE 'customer.auth.%'
          ORDER BY id`,
        [s.account.id],
      )
    ).rows.map((r) => r.action);
    expect(audit).toEqual([
      'customer.auth.signed_in',
      'customer.auth.otp_failed',
      'customer.auth.reauth_verified',
    ]);
  });
});

describe('V2-017 — C-20 delete the account (DEC-508)', () => {
  it('scrubs the account, removes vehicles, revokes every session and push token, keeps audit and operator rows', async () => {
    const s = await signIn();
    await w
      .http()
      .patch(CUSTOMER_ROUTES.mePatch.path)
      .set(bearer(s.access_token))
      .set('Idempotency-Key', newKey())
      .send({
        display_name: 'ريم الحذف',
      });
    await addVehicle(s, '31');
    await addVehicle(s, '32');
    const otherDevice = {
      device_id: `device-acct-${String(++deviceSeq).padStart(4, '0')}`,
      platform: 'android' as const,
    };
    w.clock.advance(61_000);
    const second = await signIn(s.phone, otherDevice);
    await w.db.query(
      `UPDATE customer_account_sessions SET push_token = 'fcm-token-x' WHERE account_id = $1`,
      [s.account.id],
    );
    // an operator's own row of this customer (V2-D12), from a past visit, closed
    const { customerId, ticketId } = await visitInProgress(s);
    await w.db.query(
      `UPDATE tickets SET status = 'voided', voided_at = now(), void_reason = 'test' WHERE id = $1`,
      [ticketId],
    );

    const proof = await reauth(s);
    const key = newKey();
    const r = await del(CUSTOMER_ROUTES.meDelete.path, s.access_token, { reauth_token: proof }, key);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(CustomerAccountDeletedSchema.parse(r.body.data)).toEqual({
      deleted: true,
      deleted_at: w.clock.now().toISOString(),
    });

    const acct = (await w.db.query(`SELECT * FROM customer_accounts WHERE id = $1`, [s.account.id])).rows[0];
    expect(acct).toMatchObject({
      status: 'deleted',
      phone_e164: null,
      display_name: null,
      phone_hash: deletedPhoneHash(w.env.CODE_PEPPER, s.phone),
      deleted_at: expect.any(Date),
    });
    expect(
      (
        await w.db.query(
          `SELECT count(*)::int AS n FROM customer_vehicles WHERE account_id = $1 AND removed_at IS NULL`,
          [s.account.id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await w.db.query(
          `SELECT revoked_reason, push_token, reauth_hash FROM customer_account_sessions WHERE account_id = $1 AND device_id = ANY($2)`,
          [s.account.id, [s.device.device_id, otherDevice.device_id]],
        )
      ).rows,
    ).toEqual([
      { revoked_reason: 'account_closed', push_token: null, reauth_hash: null },
      { revoked_reason: 'account_closed', push_token: null, reauth_hash: null },
    ]);
    // the operator's data is the operator's: untouched
    expect(
      (await w.db.query(`SELECT phone_e164, customer_account_id FROM customers WHERE id = $1`, [customerId]))
        .rows[0],
    ).toEqual({ phone_e164: s.phone, customer_account_id: s.account.id });
    // audit and consents kept; the audit row carries counts only
    const audit = (
      await w.db.query(
        `SELECT metadata FROM customer_audit_log WHERE account_id = $1 AND action = 'customer.account.deleted'`,
        [s.account.id],
      )
    ).rows;
    expect(audit).toEqual([
      { metadata: { vehicles_removed: 2, sessions_revoked: 2, operator_customer_rows_kept: 1 } },
    ]);
    expect(
      (
        await w.db.query(`SELECT count(*)::int AS n FROM customer_audit_log WHERE account_id = $1`, [
          s.account.id,
        ])
      ).rows[0].n,
    ).toBeGreaterThan(5);
    // the full number and the name survive only in the operator's row and the sign-in codes (retention purges them)
    expect(
      (await tablesContaining(w, s.phone.slice(1))).filter(
        (t) => t !== 'customers' && t !== 'customer_otp_challenges',
      ),
    ).toEqual([]);
    expect(await tablesContaining(w, 'ريم الحذف')).toEqual([]);

    // every token of the account is dead: the current ones say why
    for (const t of [s.access_token, second.access_token]) {
      const me = await getAs(CUSTOMER_ROUTES.me.path, t);
      expect(me.status).toBe(410);
      expect(err(me).code).toBe('ACCOUNT_DELETED');
    }
    const refresh = await post(CUSTOMER_ROUTES.refresh.path, {
      refresh_token: s.refresh_token,
      device_id: s.device.device_id,
    });
    expect(err(refresh).code).toBe('ACCOUNT_DELETED');
    // a retry with the same key meets the guard first: ACCOUNT_DELETED (the app takes it as done)
    const retry = await del(CUSTOMER_ROUTES.meDelete.path, s.access_token, { reauth_token: proof }, key);
    expect(err(retry).code).toBe('ACCOUNT_DELETED');
  });

  it('the same number signs up again as a new, empty account', async () => {
    const s = await signIn();
    await addVehicle(s, '41');
    const proof = await reauth(s);
    expect((await del(CUSTOMER_ROUTES.meDelete.path, s.access_token, { reauth_token: proof })).status).toBe(
      200,
    );
    w.clock.advance(61_000);
    const again = await signIn(s.phone);
    expect(again.is_new_account).toBe(true);
    expect(again.account.id).not.toBe(s.account.id);
    const me = (await getAs(CUSTOMER_ROUTES.me.path, again.access_token)).body.data;
    expect(me).toMatchObject({
      phone_e164: s.phone,
      display_name: null,
      profile_complete: false,
      vehicles_count: 0,
    });
    // the old row still holds only the hash
    expect(
      (await w.db.query(`SELECT phone_e164, status FROM customer_accounts WHERE id = $1`, [s.account.id]))
        .rows[0],
    ).toEqual({ phone_e164: null, status: 'deleted' });
  });

  it('refused while a visit is in progress; nothing written, the proof stays usable after the visit', async () => {
    const s = await signIn();
    const { ticketId } = await visitInProgress(s);
    const proof = await reauth(s);
    const r = await del(CUSTOMER_ROUTES.meDelete.path, s.access_token, { reauth_token: proof });
    expect(r.status).toBe(409);
    expect(err(r).code).toBe('CUSTOMER_ACCOUNT_VISIT_ACTIVE');
    expect(
      (await w.db.query(`SELECT status FROM customer_accounts WHERE id = $1`, [s.account.id])).rows[0].status,
    ).toBe('active');
    expect((await getAs(CUSTOMER_ROUTES.me.path, s.access_token)).status).toBe(200);
    await w.db.query(
      `UPDATE tickets SET status = 'voided', voided_at = now(), void_reason = 'test' WHERE id = $1`,
      [ticketId],
    );
    expect((await del(CUSTOMER_ROUTES.meDelete.path, s.access_token, { reauth_token: proof })).status).toBe(
      200,
    );
  });

  it('a customer token opens no staff and no platform route, before and after a deletion', async () => {
    const s = await signIn();
    const check = async () => {
      for (const path of ['/v1/me', '/v1/venues', '/v1/tickets?limit=5']) {
        const r = await getAs(path, s.access_token);
        expect(r.status, path).toBe(401);
        expect(err(r).code, path).toBe('AUTH_UNAUTHENTICATED');
      }
      const p = await getAs('/v1/platform/me', s.access_token);
      expect(err(p).code).toBe('PLATFORM_AUTH_REQUIRED');
      expect(err(await getAs(`/v1/platform/venues/${SEED_IDS.venues.RMS}`, s.access_token)).code).toBe(
        'PLATFORM_AUTH_REQUIRED',
      );
    };
    await check();
    const proof = await reauth(s);
    expect((await del(CUSTOMER_ROUTES.meDelete.path, s.access_token, { reauth_token: proof })).status).toBe(
      200,
    );
    await check();
  });

  it("the app's client drives C-15 and C-20 against the server, and is signed out at the end", async () => {
    const appModule = <T>(rel: string): Promise<T> =>
      import(new URL(rel, import.meta.url).href) as Promise<T>;
    const { createCustomerApi } = await appModule<{ createCustomerApi(o: unknown): any }>(
      '../../customer/src/api/client.ts',
    );
    const { httpTransport } = await appModule<{ httpTransport(o: { baseUrl: string }): unknown }>(
      '../../customer/src/api/transport.ts',
    );
    const { memoryTokenStore } = await appModule<{ memoryTokenStore(): { peek(): unknown } }>(
      '../../customer/src/session/tokenStore.ts',
    );
    const tokens = memoryTokenStore();
    const signedOut: string[] = [];
    const api = createCustomerApi({
      transport: httpTransport({ baseUrl: w.apiUrl }),
      tokens,
      device: { id: `device-app-${++deviceSeq}`, platform: 'ios' },
      newKey,
      now: () => w.clock.now().getTime(),
      onSignedOut: (r: string) => signedOut.push(r),
    });
    const phone = nextPhone();
    await api.requestOtp(phone, 'ar');
    await api.verifyOtp(phone, await codeFor(phone));
    const car = await api.addVehicle({ plate: { country: 'SA', digits: '5', letters_ar: 'ا ب ح' } });
    expect(await api.removeVehicle(car.id)).toMatchObject({ vehicle_id: car.id });
    expect(await api.vehicles()).toEqual([]);
    const me = await api.me();
    w.clock.advance(61_000);
    await api.requestOtp(me.phone_e164, 'ar');
    const proof = await api.reauthVerify(await codeFor(phone));
    expect(await api.deleteAccount(proof.reauth_token)).toEqual({ deletedAt: w.clock.now().toISOString() });
    expect(tokens.peek()).toBeNull();
    expect(await api.hasSession()).toBe(false);
    expect(signedOut).toEqual([]);
  });
});
