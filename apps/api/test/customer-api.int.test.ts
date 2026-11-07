import { SEED_IDS } from '@point/db/seed';
import { customerAccountsJobs, sha256Hex } from '@point/server';
import { WA_CUSTOMER_OTP_TEMPLATE_NAME } from '@point/shared';
import {
  CUSTOMER_ROUTES,
  CustomerAuthResultSchema,
  CustomerHomeSchema,
  CustomerLocationDetailSchema,
  CustomerLocationListSchema,
  CustomerMeSchema,
  CustomerOtpChallengeSchema,
  CustomerTokensSchema,
  CustomerVehicleSchema,
  successEnvelopeSchema,
} from '@point/shared/customer';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCustomerApp, tablesContaining, type CustomerApp } from './customer-harness.js';
import { newKey } from './harness.js';
import { createTicket } from './wa-harness.js';

/**
 * V2-010 — the customer API `/v1/customer/*` on a real PostgreSQL, with the WhatsApp simulator as the Point number
 * and the worker's `job.customer_otp_send`. The R1 journey (C-02 → C-06) is driven by the customer app's own client
 * (`apps/customer/src/api/client.ts` over its `httpTransport`), unchanged, against the API listening on a port: the
 * app switches from its fake backend to this server by configuration only (CUSTOMER_API_BASE_URL).
 */

const RMS = SEED_IDS.venues.RMS;
const LYL = SEED_IDS.venues.LYL;
const ORG = SEED_IDS.org;
/** The app install of the current test case (reset before each: the per-device code limit is tested on its own). */
let DEVICE: { device_id: string; platform: 'ios' | 'android' } = {
  device_id: 'device-test-0001',
  platform: 'ios',
};

/** The app's client, loaded by path: apps/customer is an Expo project with its own module resolution. */
interface AppClientModule {
  createCustomerApi(opts: {
    transport: unknown;
    tokens: unknown;
    device: { id: string; platform: 'ios' | 'android' };
    newKey: () => string;
    now?: () => number;
  }): any;
}
const appModule = <T>(rel: string): Promise<T> => import(new URL(rel, import.meta.url).href) as Promise<T>;

let w: CustomerApp;
let phoneSeq = 0;
const nextPhone = () => `+9665${String(70000000 + ++phoneSeq).padStart(8, '0')}`;

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  w
    .http()
    .post(path)
    .set(headers)
    .send(body as object);
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const getAs = (path: string, token: string) => w.http().get(path).set(bearer(token));
const err = (r: request.Response) => r.body?.error as { code: string; details: Record<string, unknown> };

/** The code the simulator received for a phone (the latest sign-in template). */
async function codeFor(phone: string): Promise<string> {
  await w.drain();
  const msgs = (await w.sim.client.listMessages({ to: phone })).filter(
    (m) => m.templateName === WA_CUSTOMER_OTP_TEMPLATE_NAME,
  );
  const last = msgs.sort((a, b) => a.seq - b.seq).at(-1);
  if (!last) throw new Error(`no sign-in code reached ${phone}`);
  return last.bodyParams[0]!;
}

async function signIn(phone = nextPhone(), device = DEVICE) {
  const r = await post(CUSTOMER_ROUTES.otpRequest.path, { phone_e164: phone, ...device });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const v = await post(CUSTOMER_ROUTES.otpVerify.path, {
    phone_e164: phone,
    code: await codeFor(phone),
    ...device,
  });
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  return {
    phone,
    ...(v.body.data as { access_token: string; refresh_token: string; account: { id: string } }),
  };
}

async function listVenue(
  venueId: string,
  o: { status?: string; hours?: unknown; lat?: number; lng?: number; photos?: string[]; subs?: boolean } = {},
) {
  const approver = (
    await w.db.query<{ id: string }>(
      `INSERT INTO platform_users (phone_e164, full_name, role, secret_hash, must_change_secret)
       VALUES ($1, 'مراجع', 'platform_admin', 'x', false) ON CONFLICT (phone_e164) DO UPDATE SET full_name = EXCLUDED.full_name
       RETURNING id`,
      ['+966500009901'],
    )
  ).rows[0]!.id;
  const status = o.status ?? 'approved';
  await w.db.query(
    `INSERT INTO venue_public_profiles (venue_id, org_id, status, category, lat, lng, opening_hours, photo_asset_ids,
            subscriptions_enabled, pay_per_visit_halalas, approved_by, approved_at)
     SELECT id, org_id, $2, 'hall', $3, $4, $5, $6, $7, 2300, $8, CASE WHEN $8::uuid IS NULL THEN NULL ELSE now() END
       FROM venues WHERE id = $1
     ON CONFLICT (venue_id) DO UPDATE SET status = EXCLUDED.status, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
       opening_hours = EXCLUDED.opening_hours, photo_asset_ids = EXCLUDED.photo_asset_ids,
       subscriptions_enabled = EXCLUDED.subscriptions_enabled, approved_by = EXCLUDED.approved_by,
       approved_at = EXCLUDED.approved_at`,
    [
      venueId,
      status,
      o.lat ?? null,
      o.lng ?? null,
      JSON.stringify(o.hours ?? { always_open: true }),
      o.photos ?? [],
      o.subs ?? false,
      status === 'approved' ? approver : null,
    ],
  );
}

beforeAll(async () => {
  w = await createCustomerApp();
  for (const h of customerAccountsJobs({ runtime: w.rt })) w.dispatcher.register(h);
}, 120_000);
afterAll(async () => w?.close());
let deviceSeq = 0;
beforeEach(() => {
  DEVICE = { device_id: `device-case-${String(++deviceSeq).padStart(4, '0')}`, platform: 'ios' };
});

describe('V2-010 — R1 journey through the customer app client (C-02 → C-06)', () => {
  it('code over WhatsApp → verify → name → consents → vehicle → home, with no change to the app', async () => {
    await listVenue(RMS, { lat: 24.7136, lng: 46.6753, photos: ['3f1d8a2e-5b6c-4d7e-8f90-a1b2c3d4e5f6'] });
    const { createCustomerApi } = await appModule<AppClientModule>('../../customer/src/api/client.ts');
    const { httpTransport } = await appModule<{ httpTransport(o: { baseUrl: string }): unknown }>(
      '../../customer/src/api/transport.ts',
    );
    const { memoryTokenStore } = await appModule<{ memoryTokenStore(): { peek(): unknown } }>(
      '../../customer/src/session/tokenStore.ts',
    );
    const tokens = memoryTokenStore();
    const api = createCustomerApi({
      transport: httpTransport({ baseUrl: w.apiUrl }), // the app's CUSTOMER_API_BASE_URL
      tokens,
      device: { id: 'device-r1-journey', platform: 'android' },
      newKey,
      now: () => w.clock.now().getTime(),
    });
    const phone = '+966512340001';

    // C-02: the code is sent over WhatsApp only, after COMMIT, by the worker
    const challenge = await api.requestOtp(phone, 'ar');
    expect(challenge).toMatchObject({ channel: 'whatsapp', phone_masked: '05•••••001', attempts_left: 5 });
    expect(Date.parse(challenge.expires_at) - w.clock.now().getTime()).toBe(300_000);
    expect(Date.parse(challenge.resend_available_at) - w.clock.now().getTime()).toBe(60_000);
    expect(await w.sim.client.listMessages({ to: phone })).toEqual([]); // nothing sent inside the transaction
    const code = await codeFor(phone);
    expect(code).toMatch(/^[0-9]{6}$/);
    const [msg] = (await w.sim.client.listMessages({ to: phone })).filter(
      (m) => m.templateName === WA_CUSTOMER_OTP_TEMPLATE_NAME,
    );
    expect(msg).toMatchObject({ templateLanguage: 'ar', purpose: 'C-OTP' });
    expect(msg!.buttons).toEqual([{ index: 0, subType: 'url', payload: code, text: 'نسخ الرمز' }]);
    expect(msg!.renderedText).toContain(code);

    // C-03: the account is created by the first verified sign-in
    const auth = await api.verifyOtp(phone, code);
    expect(CustomerAuthResultSchema.parse(auth).is_new_account).toBe(true);
    expect(auth.account).toMatchObject({ phone_e164: phone, display_name: null, profile_complete: false });

    // C-04: name, then terms + privacy at their current version (marketing separate)
    const named = await api.updateMe({ display_name: '  نورة   العتيبي ' });
    expect(named.display_name).toBe('نورة العتيبي');
    expect(named.profile_complete).toBe(false);
    const v = named.consents.terms.current_version;
    const me = await api.submitConsents({
      consents: [
        { kind: 'terms', version: v, granted: true },
        { kind: 'privacy', version: named.consents.privacy.current_version, granted: true },
        { kind: 'marketing', version: named.consents.marketing.current_version, granted: false },
      ],
    });
    expect(me.profile_complete).toBe(true);
    expect(me.consents.marketing).toMatchObject({ granted: false, answered_version: v });

    // C-05: a Saudi plate as typed, normalised by the rule of tickets
    const car = await api.addVehicle({
      plate: { country: 'SA', digits: '٤٨٢١', letters_ar: 'بحد' },
      vehicle_make: 'toyota',
      vehicle_color: 'white',
      vehicle_type: 'sedan',
    });
    expect(car.plate).toEqual({
      country: 'SA',
      digits: '4821',
      letters_ar: 'ب ح د',
      letters_en: 'B J D',
      raw: null,
      display: '4821 ب ح د',
    });
    expect(await api.vehicles()).toHaveLength(1);

    // C-06: one read — the listed location nearby, no visit, no subscription yet
    const home = await api.home({ lat: 24.71, lng: 46.67 });
    expect(home).toMatchObject({
      display_name: 'نورة العتيبي',
      current_visit: null,
      subscriptions: [],
      vehicles_count: 1,
    });
    expect(home.nearby_locations.map((l: { venue_id: string }) => l.venue_id)).toEqual([RMS]);
    expect(home.nearby_locations[0]).toMatchObject({ pay_per_visit_halalas: 2300, open_now: true });
    const detail = await api.location(RMS);
    expect(detail.photo_urls).toHaveLength(1);
    expect(detail.photo_urls[0]).toContain(RMS); // a presigned link of the private bucket (V2-004, DEC-494)

    // the session survives an expired access token: the client refreshes once and retries with the same key
    w.clock.advance(16 * 60_000);
    expect((await api.me()).id).toBe(auth.account.id);
    await api.logout();
    expect(tokens.peek()).toBeNull();
  });
});

describe('V2-010 — sign-in codes over WhatsApp (C-02/C-03, DEC-482, DEC-496)', () => {
  it('the code is stored hashed only: the encrypted copy is wiped once sent, and no table holds the code', async () => {
    const phone = nextPhone();
    await post(CUSTOMER_ROUTES.otpRequest.path, { phone_e164: phone, ...DEVICE });
    const before = (
      await w.db.query(
        `SELECT code_ciphertext, delivery_status FROM customer_otp_challenges WHERE phone_e164 = $1`,
        [phone],
      )
    ).rows[0];
    expect(before.code_ciphertext).not.toBeNull(); // the single encrypted copy the worker needs
    expect(before.delivery_status).toBe('queued');
    const code = await codeFor(phone);
    const row = (
      await w.db.query(
        `SELECT code_hash, code_ciphertext, delivery_status, wa_message_id, sent_at FROM customer_otp_challenges
          WHERE phone_e164 = $1`,
        [phone],
      )
    ).rows[0];
    expect(row).toMatchObject({ code_ciphertext: null, delivery_status: 'sent' });
    expect(row.wa_message_id).toMatch(/^wamid\./);
    expect(row.code_hash).not.toContain(code);
    expect(await tablesContaining(w, code, new RegExp(`(?<![0-9A-Za-z])${code}(?![0-9A-Za-z])`))).toEqual([]);
    // the outbox row names the challenge only
    const job = (
      await w.db.query(
        `SELECT org_id, payload FROM outbox_events WHERE type = 'job.customer_otp_send' ORDER BY seq DESC LIMIT 1`,
      )
    ).rows[0];
    expect(Object.keys(job.payload).sort()).toEqual(['challenge_id', 'channel_id']);
    expect(job.org_id).toBe(ORG);
    // no operator's whatsapp_messages row carries the platform customer's sign-in (DEC-496)
    expect(
      (
        await w.db.query(`SELECT 1 FROM whatsapp_messages WHERE template_name = $1`, [
          WA_CUSTOMER_OTP_TEMPLATE_NAME,
        ])
      ).rowCount,
    ).toBe(0);
  });

  it('resend after 60 s only (RATE_LIMITED + retry_after_s), a new code keeps the attempts, the old code dies', async () => {
    const phone = nextPhone();
    const body = { phone_e164: phone, ...DEVICE };
    expect((await post(CUSTOMER_ROUTES.otpRequest.path, body)).status).toBe(200);
    const first = await codeFor(phone);
    w.clock.advance(20_000);
    const early = await post(CUSTOMER_ROUTES.otpRequest.path, body);
    expect(early.status).toBe(429);
    expect(err(early)).toMatchObject({ code: 'RATE_LIMITED', details: { retry_after_s: 40 } });
    expect(early.headers['retry-after']).toBe('40');
    const wrong = first === '000000' ? '111111' : '000000';
    const bad = await post(CUSTOMER_ROUTES.otpVerify.path, { phone_e164: phone, code: wrong, ...DEVICE });
    expect(bad.status).toBe(422);
    expect(err(bad)).toMatchObject({ code: 'CUSTOMER_OTP_INVALID', details: { attempts_left: 4 } });
    w.clock.advance(41_000);
    const again = await post(CUSTOMER_ROUTES.otpRequest.path, body);
    expect(again.status).toBe(200);
    expect(CustomerOtpChallengeSchema.parse(again.body.data).attempts_left).toBe(4); // not reset by a resend
    const second = await codeFor(phone);
    if (second !== first) {
      const old = await post(CUSTOMER_ROUTES.otpVerify.path, { phone_e164: phone, code: first, ...DEVICE });
      expect(err(old)).toMatchObject({ code: 'CUSTOMER_OTP_INVALID', details: { attempts_left: 3 } });
    }
    const ok = await post(CUSTOMER_ROUTES.otpVerify.path, { phone_e164: phone, code: second, ...DEVICE });
    expect(ok.status).toBe(200);
    // a used code cannot be used twice
    const reuse = await post(CUSTOMER_ROUTES.otpVerify.path, { phone_e164: phone, code: second, ...DEVICE });
    expect(err(reuse).code).toBe('CUSTOMER_OTP_EXPIRED');
  });

  it('the 5th wrong code locks the number 15 minutes for request and verify alike', async () => {
    const phone = nextPhone();
    await post(CUSTOMER_ROUTES.otpRequest.path, { phone_e164: phone, ...DEVICE });
    const code = await codeFor(phone);
    const wrong = code === '999999' ? '888888' : '999999';
    for (let left = 4; left >= 1; left--) {
      const r = await post(CUSTOMER_ROUTES.otpVerify.path, { phone_e164: phone, code: wrong, ...DEVICE });
      expect(err(r)).toMatchObject({ code: 'CUSTOMER_OTP_INVALID', details: { attempts_left: left } });
    }
    const locked = await post(CUSTOMER_ROUTES.otpVerify.path, { phone_e164: phone, code: wrong, ...DEVICE });
    expect(locked.status).toBe(423);
    const until = new Date(w.clock.now().getTime() + 15 * 60_000).toISOString();
    expect(err(locked)).toEqual(
      expect.objectContaining({ code: 'CUSTOMER_OTP_LOCKED', details: { locked_until: until } }),
    );
    // the right code no longer helps, and no new code is sent during the lock
    expect(err(await post(CUSTOMER_ROUTES.otpVerify.path, { phone_e164: phone, code, ...DEVICE })).code).toBe(
      'CUSTOMER_OTP_LOCKED',
    );
    w.clock.advance(5 * 60_000);
    const req = await post(CUSTOMER_ROUTES.otpRequest.path, { phone_e164: phone, ...DEVICE });
    expect(req.status).toBe(423);
    expect(err(req).details).toEqual({ locked_until: until });
    w.clock.advance(10 * 60_000 + 1000);
    const after = await post(CUSTOMER_ROUTES.otpRequest.path, { phone_e164: phone, ...DEVICE });
    expect(after.status).toBe(200);
    expect(after.body.data.attempts_left).toBe(5);
    const audit = (
      await w.db.query<{ action: string; metadata: Record<string, unknown> }>(
        `SELECT action, metadata FROM customer_audit_log WHERE action LIKE 'customer.auth.otp_%' ORDER BY id`,
      )
    ).rows;
    expect(audit.some((a) => a.action === 'customer.auth.otp_locked')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(phone); // masked only (canon rule 8)
  });

  it('an expired code → CUSTOMER_OTP_EXPIRED (410); never a code without a request', async () => {
    const phone = nextPhone();
    const none = await post(CUSTOMER_ROUTES.otpVerify.path, { phone_e164: phone, code: '123456', ...DEVICE });
    expect(none.status).toBe(410);
    expect(err(none).code).toBe('CUSTOMER_OTP_EXPIRED');
    await post(CUSTOMER_ROUTES.otpRequest.path, { phone_e164: phone, ...DEVICE });
    const code = await codeFor(phone);
    w.clock.advance(300_000);
    const r = await post(CUSTOMER_ROUTES.otpVerify.path, { phone_e164: phone, code, ...DEVICE });
    expect(err(r).code).toBe('CUSTOMER_OTP_EXPIRED');
  });

  it('rate limits per number (hourly) and per device, on top of the resend wait', async () => {
    const phone = nextPhone();
    for (let i = 0; i < 5; i++) {
      expect((await post(CUSTOMER_ROUTES.otpRequest.path, { phone_e164: phone, ...DEVICE })).status).toBe(
        200,
      );
      w.clock.advance(61_000);
    }
    const sixth = await post(CUSTOMER_ROUTES.otpRequest.path, { phone_e164: phone, ...DEVICE });
    expect(err(sixth)).toMatchObject({ code: 'RATE_LIMITED', details: { scope: 'phone' } });
    expect(Number(err(sixth).details.retry_after_s)).toBeGreaterThan(0);
    w.clock.advance(3_600_000);
    const device = { device_id: 'device-spray-0001', platform: 'android' as const };
    for (let i = 0; i < 10; i++)
      expect(
        (await post(CUSTOMER_ROUTES.otpRequest.path, { phone_e164: nextPhone(), ...device })).status,
      ).toBe(200);
    const eleventh = await post(CUSTOMER_ROUTES.otpRequest.path, { phone_e164: nextPhone(), ...device });
    expect(err(eleventh)).toMatchObject({ code: 'RATE_LIMITED', details: { scope: 'device' } });
  });

  it('PHONE_INVALID for a number that is not a Saudi mobile; VALIDATION_FAILED for the rest', async () => {
    const r = await post(CUSTOMER_ROUTES.otpRequest.path, { phone_e164: '+447911123456', ...DEVICE });
    expect(r.status).toBe(422);
    expect(err(r)).toMatchObject({ code: 'PHONE_INVALID', details: { field: 'phone_e164' } });
    const v = await post(CUSTOMER_ROUTES.otpRequest.path, {
      phone_e164: '+966512345678',
      device_id: 'x',
      platform: 'ios',
    });
    expect(err(v).code).toBe('VALIDATION_FAILED');
  });

  it('without the Point number the code cannot be delivered: WA_CHANNEL_UNAVAILABLE and nothing written', async () => {
    await w.db.query(`UPDATE whatsapp_channel SET health_status = 'down' WHERE org_id = $1`, [ORG]);
    try {
      const phone = nextPhone();
      const r = await post(CUSTOMER_ROUTES.otpRequest.path, { phone_e164: phone, ...DEVICE });
      expect(r.status).toBe(503);
      expect(err(r).code).toBe('WA_CHANNEL_UNAVAILABLE');
      expect(
        (await w.db.query(`SELECT 1 FROM customer_otp_challenges WHERE phone_e164 = $1`, [phone])).rowCount,
      ).toBe(0);
    } finally {
      await w.db.query(`UPDATE whatsapp_channel SET health_status = 'healthy' WHERE org_id = $1`, [ORG]);
    }
  });
});

describe('V2-010 — sessions (DEC-482, DEC-497)', () => {
  it('a second sign-in finds the account; refresh rotates both tokens; reuse of a rotated refresh token revokes', async () => {
    const s1 = await signIn();
    w.clock.advance(61_000);
    const again = await signIn(s1.phone, { device_id: 'device-second-0001', platform: 'android' });
    expect(again.account.id).toBe(s1.account.id);

    const r1 = await post(CUSTOMER_ROUTES.refresh.path, {
      refresh_token: s1.refresh_token,
      device_id: DEVICE.device_id,
    });
    expect(r1.status).toBe(200);
    const t1 = CustomerTokensSchema.parse(r1.body.data);
    expect(t1.refresh_token).not.toBe(s1.refresh_token);
    expect(t1.access_token).not.toBe(s1.access_token);
    // the replaced access token is «expired» (a call that crossed the refresh retries once)
    expect(err(await getAs(CUSTOMER_ROUTES.me.path, s1.access_token)).code).toBe('AUTH_SESSION_EXPIRED');
    expect((await getAs(CUSTOMER_ROUTES.me.path, t1.access_token)).status).toBe(200);

    // the stolen, rotated refresh token comes back: the whole session is revoked
    const stolen = await post(CUSTOMER_ROUTES.refresh.path, {
      refresh_token: s1.refresh_token,
      device_id: DEVICE.device_id,
    });
    expect(stolen.status).toBe(401);
    expect(err(stolen).code).toBe('AUTH_SESSION_REVOKED');
    expect(err(await getAs(CUSTOMER_ROUTES.me.path, t1.access_token)).code).toBe('AUTH_SESSION_REVOKED');
    expect(
      err(
        await post(CUSTOMER_ROUTES.refresh.path, {
          refresh_token: t1.refresh_token,
          device_id: DEVICE.device_id,
        }),
      ).code,
    ).toBe('AUTH_SESSION_REVOKED');
    const row = (
      await w.db.query(
        `SELECT revoked_reason FROM customer_account_sessions WHERE account_id = $1 AND device_id = $2`,
        [s1.account.id, DEVICE.device_id],
      )
    ).rows;
    expect(row).toEqual([{ revoked_reason: 'refresh_reuse' }]);
    // the other device is untouched
    expect((await getAs(CUSTOMER_ROUTES.me.path, again.access_token)).status).toBe(200);
  });

  it('access token: 15 minutes, then AUTH_SESSION_EXPIRED; a refresh token from another device revokes', async () => {
    const s = await signIn();
    w.clock.advance(15 * 60_000);
    const r = await getAs(CUSTOMER_ROUTES.me.path, s.access_token);
    expect(r.status).toBe(401);
    expect(err(r).code).toBe('AUTH_SESSION_EXPIRED');
    const wrongDevice = await post(CUSTOMER_ROUTES.refresh.path, {
      refresh_token: s.refresh_token,
      device_id: 'device-other-0009',
    });
    expect(err(wrongDevice).code).toBe('AUTH_SESSION_REVOKED');
    expect(
      err(
        await post(CUSTOMER_ROUTES.refresh.path, {
          refresh_token: s.refresh_token,
          device_id: DEVICE.device_id,
        }),
      ).code,
    ).toBe('AUTH_SESSION_REVOKED');
  });

  it('the refresh token lives 60 days from the sign-in and is stored hashed', async () => {
    const s = await signIn();
    const row = (
      await w.db.query(
        `SELECT refresh_hash, access_hash, refresh_expires_at, created_at FROM customer_account_sessions WHERE account_id = $1`,
        [s.account.id],
      )
    ).rows[0];
    expect(row.refresh_hash).toBe(sha256Hex(s.refresh_token));
    expect(row.access_hash).toBe(sha256Hex(s.access_token));
    expect(row.refresh_expires_at.getTime() - row.created_at.getTime()).toBe(60 * 86_400_000);
    expect(await tablesContaining(w, s.refresh_token)).toEqual([]);
    w.clock.advance(60 * 86_400_000);
    expect(
      err(
        await post(CUSTOMER_ROUTES.refresh.path, {
          refresh_token: s.refresh_token,
          device_id: DEVICE.device_id,
        }),
      ).code,
    ).toBe('AUTH_SESSION_REVOKED');
  });

  it('logout revokes this device only', async () => {
    const s = await signIn();
    const r = await post(
      CUSTOMER_ROUTES.logout.path,
      { refresh_token: s.refresh_token },
      bearer(s.access_token),
    );
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ logged_out: true });
    expect(err(await getAs(CUSTOMER_ROUTES.me.path, s.access_token)).code).toBe('AUTH_SESSION_REVOKED');
  });
});

describe('V2-010 — customer, staff and platform identities never cross (DEC-462 pattern, DEC-497)', () => {
  let s: Awaited<ReturnType<typeof signIn>>;
  let staffCookie: string;
  let staffToken: string;
  let platformCookie: string;
  beforeAll(async () => {
    s = await signIn();
    staffCookie = await w.sessionFor('OWN1');
    staffToken = staffCookie.split('=')[1]!;
    const u = await w.db.query<{ id: string }>(
      `INSERT INTO platform_users (phone_e164, full_name, role, secret_hash, must_change_secret, mfa_enabled, mfa_secret_enc)
       VALUES ('+966551119201', 'مالك المنصة', 'platform_owner', 'x', false, true, 'x') RETURNING id`,
    );
    const token = 'customer-isolation-platform-session-0001';
    await w.db.query(
      `INSERT INTO platform_sessions (platform_user_id, token_hash, mfa_verified, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, true, $3, $3, $3::timestamptz + interval '48 hours')`,
      [u.rows[0]!.id, sha256Hex(token), w.clock.now()],
    );
    platformCookie = `${w.env.PLATFORM_SESSION_COOKIE_NAME}=${token}`;
  });

  it('a customer token opens no staff and no platform route', async () => {
    for (const path of ['/v1/me', '/v1/venues', `/v1/venues/${RMS}`, '/v1/tickets?limit=5']) {
      const r = await getAs(path, s.access_token);
      expect(r.status, path).toBe(401);
      expect(err(r).code, path).toBe('AUTH_UNAUTHENTICATED');
    }
    const p = await getAs('/v1/platform/me', s.access_token);
    expect(p.status).toBe(401);
    expect(err(p).code).toBe('PLATFORM_AUTH_REQUIRED');
  });

  it('a staff or platform session opens no customer route (nor as a Bearer token)', async () => {
    for (const path of [CUSTOMER_ROUTES.me.path, CUSTOMER_ROUTES.home.path, CUSTOMER_ROUTES.vehicles.path]) {
      for (const cookie of [staffCookie, platformCookie]) {
        const r = await w.http().get(path).set('Cookie', cookie);
        expect(r.status, path).toBe(401);
        expect(err(r).code, path).toBe('AUTH_UNAUTHENTICATED');
      }
      expect(err(await getAs(path, staffToken)).code).toBe('AUTH_UNAUTHENTICATED');
      // a refresh token is not an access token
      expect(err(await getAs(path, s.refresh_token)).code).toBe('AUTH_UNAUTHENTICATED');
    }
    // a staff cookie next to the customer token changes nothing: the customer route reads its Bearer only
    const both = await w
      .http()
      .get(CUSTOMER_ROUTES.me.path)
      .set('Cookie', staffCookie)
      .set(bearer(s.access_token));
    expect(both.body.data.id).toBe(s.account.id);
  });

  it('the customer writes need no CSRF headers (Bearer, no cookie); staff writes still do', async () => {
    const r = await w
      .http()
      .patch(CUSTOMER_ROUTES.mePatch.path)
      .set(bearer(s.access_token))
      .set('Idempotency-Key', newKey())
      .send({ locale: 'en' });
    expect(r.status).toBe(200);
    expect(r.headers['set-cookie']).toBeUndefined();
    const staff = await w.http().post('/v1/auth/logout').set('Cookie', staffCookie).send({});
    expect(err(staff)).toMatchObject({ code: 'PERMISSION_DENIED', details: { reason: 'csrf' } });
  });
});

describe('V2-010 — account, consents, idempotency', () => {
  let s: Awaited<ReturnType<typeof signIn>>;
  beforeEach(async () => {
    s = await signIn();
  });
  const write = (method: 'patch' | 'post', path: string, body: unknown, key: string | null = newKey()) => {
    let req = w.http()[method](path).set(bearer(s.access_token));
    if (key) req = req.set('Idempotency-Key', key);
    return req.send(body as object);
  };

  it('Idempotency-Key: required, replayed byte for byte, refused for another body; kept per account', async () => {
    const missing = await write('patch', CUSTOMER_ROUTES.mePatch.path, { display_name: 'سارة' }, null);
    expect(err(missing).code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const key = newKey();
    const a = await write('patch', CUSTOMER_ROUTES.mePatch.path, { display_name: 'سارة' }, key);
    const b = await write('patch', CUSTOMER_ROUTES.mePatch.path, { display_name: 'سارة' }, key);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.data).toEqual(a.body.data);
    const c = await write('patch', CUSTOMER_ROUTES.mePatch.path, { display_name: 'ريم' }, key);
    expect(err(c).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(
      (
        await w.db.query(
          `SELECT operation FROM customer_idempotency_keys WHERE account_id = $1 AND key = $2`,
          [s.account.id, key],
        )
      ).rows,
    ).toEqual([{ operation: 'PATCH /v1/customer/me' }]);
  });

  it('consents: append-only rows with the version shown; a stale version is refused; a new version reopens C-04', async () => {
    const me = CustomerMeSchema.parse((await getAs(CUSTOMER_ROUTES.me.path, s.access_token)).body.data);
    const stale = await write('post', CUSTOMER_ROUTES.consents.path, {
      consents: [{ kind: 'terms', version: '2020-01-01', granted: true }],
    });
    expect(stale.status).toBe(409);
    expect(err(stale)).toMatchObject({
      code: 'CUSTOMER_CONSENT_VERSION_STALE',
      details: { kind: 'terms', current_version: me.consents.terms.current_version },
    });
    const refused = await write('post', CUSTOMER_ROUTES.consents.path, {
      consents: [{ kind: 'terms', version: me.consents.terms.current_version, granted: false }],
    });
    expect(err(refused).code).toBe('VALIDATION_FAILED');
    await write('patch', CUSTOMER_ROUTES.mePatch.path, { display_name: 'سارة' });
    const done = await write('post', CUSTOMER_ROUTES.consents.path, {
      consents: [
        { kind: 'terms', version: me.consents.terms.current_version, granted: true },
        { kind: 'privacy', version: me.consents.privacy.current_version, granted: true },
      ],
    });
    expect(done.body.data.profile_complete).toBe(true);
    const rows = (
      await w.db.query(
        `SELECT kind, version, granted FROM customer_account_consents WHERE account_id = $1 ORDER BY id`,
        [s.account.id],
      )
    ).rows;
    expect(rows.map((r) => r.kind)).toEqual(['terms', 'privacy']);
    // the owner publishes a new version of the terms: profile_complete falls back to false (the app shows C-04)
    const { buildCustomerMe, consentTexts } = await import('@point/server');
    const texts = consentTexts({ ...w.env, CUSTOMER_TERMS_VERSION: '2027-01-01' });
    const after = await buildCustomerMe(w.db, texts, s.account.id);
    expect(after.profile_complete).toBe(false);
    expect(after.consents.terms).toMatchObject({
      granted: null,
      answered_version: me.consents.terms.current_version,
    });
  });

  it('vehicles: PLATE_INVALID with field/reason, a duplicate in another spelling, the limit of five', async () => {
    const add = (digits: string, letters_ar: string) =>
      write('post', CUSTOMER_ROUTES.vehicleCreate.path, { plate: { digits, letters_ar } });
    const invalid = await add('12345', 'ب ح د');
    expect(invalid.status).toBe(422);
    expect(err(invalid)).toMatchObject({
      code: 'PLATE_INVALID',
      details: { field: 'plate.digits', reason: 'digits' },
    });
    expect(err(await add('12', 'ب ح')).details).toEqual({ field: 'plate.letters_ar', reason: 'letters' });
    const first = await add('1', 'ب ح د');
    expect(first.status).toBe(201);
    CustomerVehicleSchema.parse(first.body.data);
    const dup = await add('١', 'بـحد');
    expect(dup.status).toBe(409);
    expect(err(dup).code).toBe('CUSTOMER_VEHICLE_DUPLICATE');
    for (const d of ['2', '3', '4', '5']) {
      w.clock.advance(1000); // «oldest first»
      expect((await add(d, 'ب ح د')).status).toBe(201);
    }
    const sixth = await add('6', 'ب ح د');
    expect(sixth.status).toBe(422);
    expect(err(sixth)).toMatchObject({ code: 'CUSTOMER_VEHICLE_LIMIT', details: { max: 5 } });
    const list = await getAs(CUSTOMER_ROUTES.vehicles.path, s.access_token);
    expect(list.body.data.items.map((v: { plate: { digits: string } }) => v.plate.digits)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
    expect((await getAs(CUSTOMER_ROUTES.me.path, s.access_token)).body.data.vehicles_count).toBe(5);
    const audit = (
      await w.db.query(
        `SELECT count(*)::int AS n FROM customer_audit_log WHERE account_id = $1 AND action = 'customer.vehicle.add'`,
        [s.account.id],
      )
    ).rows[0];
    expect(audit.n).toBe(5);
  });

  it('home: the visit in progress of a linked customers row (V2-D12), without key slot or spot', async () => {
    const car = await write('post', CUSTOMER_ROUTES.vehicleCreate.path, {
      plate: { digits: '4821', letters_ar: 'ب ح د' },
    });
    expect(car.body.data.in_active_visit).toBe(false);
    const cus = (
      await w.db.query<{ id: string }>(
        `INSERT INTO customers (org_id, phone_e164, customer_account_id) VALUES ($1, $2, $3) RETURNING id`,
        [ORG, s.phone, s.account.id],
      )
    ).rows[0]!.id;
    const t = await createTicket(w, { customerId: cus, status: 'parked' });
    const home = CustomerHomeSchema.parse((await getAs(CUSTOMER_ROUTES.home.path, s.access_token)).body.data);
    expect(home.current_visit).toMatchObject({
      ticket_id: t.id,
      venue_id: RMS,
      status: 'parked',
      plate_display: '4821 ب ح د',
    });
    expect(Object.keys(home.current_visit!)).not.toContain('key_slot');
    const cars = await getAs(CUSTOMER_ROUTES.vehicles.path, s.access_token);
    expect(cars.body.data.items[0].in_active_visit).toBe(true);
  });
});

describe('V2-010 — listed locations (C-06 … C-08)', () => {
  let s: Awaited<ReturnType<typeof signIn>>;
  beforeAll(async () => {
    s = await signIn();
  });

  it('approved profile + active venue + active operator only; anything else is VENUE_NOT_LISTED', async () => {
    await listVenue(RMS, { lat: 24.7136, lng: 46.6753, subs: true });
    await listVenue(LYL, { status: 'submitted' });
    const list = CustomerLocationListSchema.parse(
      (await getAs(CUSTOMER_ROUTES.locations.path, s.access_token)).body.data,
    );
    expect(list.items.map((l) => l.venue_id)).toEqual([RMS]);
    const hidden = await getAs(`/v1/customer/locations/${LYL}`, s.access_token);
    expect(hidden.status).toBe(404);
    expect(err(hidden).code).toBe('VENUE_NOT_LISTED');
    expect(
      err(await getAs('/v1/customer/locations/00000000-0000-4000-8000-0000deadbeef', s.access_token)).code,
    ).toBe('VENUE_NOT_LISTED');
    expect(err(await getAs('/v1/customer/locations/not-a-uuid', s.access_token)).code).toBe(
      'VENUE_NOT_LISTED',
    );
    await w.db.query(`UPDATE organizations SET operator_status = 'suspended' WHERE id = $1`, [ORG]);
    try {
      expect((await getAs(CUSTOMER_ROUTES.locations.path, s.access_token)).body.data.items).toEqual([]);
      expect(err(await getAs(`/v1/customer/locations/${RMS}`, s.access_token)).code).toBe('VENUE_NOT_LISTED');
    } finally {
      await w.db.query(`UPDATE organizations SET operator_status = 'active' WHERE id = $1`, [ORG]);
    }
  });

  it('open_now in the venue time zone, distance, search, filters and cursor paging', async () => {
    // 16:00Z = 19:00 Riyadh on Tuesday 2026-10-27
    w.clock.set(new Date('2026-10-27T16:00:00.000Z'));
    s = await signIn();
    await listVenue(RMS, {
      lat: 24.7136,
      lng: 46.6753,
      subs: true,
      hours: { days: { tue: [{ open: '18:00', close: '02:00' }] } },
    });
    await listVenue(LYL, {
      lat: 21.5433,
      lng: 39.1728,
      hours: { days: { tue: [{ open: '08:00', close: '12:00' }] } },
    });
    const all = (await getAs(`${CUSTOMER_ROUTES.locations.path}?lat=21.5&lng=39.2`, s.access_token)).body;
    expect(all.data.items.map((l: { venue_id: string }) => l.venue_id)).toEqual([LYL, RMS]);
    expect(all.data.items[0].distance_m).toBeLessThan(10_000);
    expect(all.data.items.map((l: { open_now: boolean }) => l.open_now)).toEqual([false, true]);
    const open = (await getAs(`${CUSTOMER_ROUTES.locations.path}?filter=open_now`, s.access_token)).body.data
      .items;
    expect(open.map((l: { venue_id: string }) => l.venue_id)).toEqual([RMS]);
    const subs = (await getAs(`${CUSTOMER_ROUTES.locations.path}?filter=subscribable`, s.access_token)).body
      .data.items;
    expect(subs.map((l: { venue_id: string }) => l.venue_id)).toEqual([RMS]);
    const venue = (await w.db.query<{ name_ar: string }>(`SELECT name_ar FROM venues WHERE id = $1`, [LYL]))
      .rows[0]!;
    const found = (
      await getAs(
        `${CUSTOMER_ROUTES.locations.path}?q=${encodeURIComponent(venue.name_ar.slice(-3))}`,
        s.access_token,
      )
    ).body.data.items;
    expect(found.map((l: { venue_id: string }) => l.venue_id)).toContain(LYL);
    const p1 = (await getAs(`${CUSTOMER_ROUTES.locations.path}?limit=1&lat=21.5&lng=39.2`, s.access_token))
      .body;
    expect(p1.data.items).toHaveLength(1);
    expect(p1.meta.next_cursor).toEqual(expect.any(String));
    const p2 = (
      await getAs(
        `${CUSTOMER_ROUTES.locations.path}?limit=1&lat=21.5&lng=39.2&cursor=${p1.meta.next_cursor}`,
        s.access_token,
      )
    ).body;
    expect(p2.data.items.map((l: { venue_id: string }) => l.venue_id)).toEqual([RMS]);
    expect(p2.meta.next_cursor).toBeNull();
    // after midnight the evening interval still runs (02:00 close), the day's own intervals do not
    w.clock.set(new Date('2026-10-27T21:30:00.000Z')); // 00:30 Wednesday in Riyadh
    const night = await signIn();
    const lateRes = await getAs(`/v1/customer/locations/${RMS}`, night.access_token);
    expect(lateRes.status, JSON.stringify(lateRes.body)).toBe(200);
    const late = lateRes.body.data;
    expect(CustomerLocationDetailSchema.parse(late)).toMatchObject({
      open_now: true,
      timezone: 'Asia/Riyadh',
      plans: [],
    });
    expect(err(await getAs(`${CUSTOMER_ROUTES.locations.path}?bogus=1`, night.access_token)).code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('every answer of the R1 routes matches the shared contract', async () => {
    const fresh = await signIn();
    const env = successEnvelopeSchema(CustomerHomeSchema);
    expect(env.safeParse((await getAs(CUSTOMER_ROUTES.home.path, fresh.access_token)).body).success).toBe(
      true,
    );
    const list = successEnvelopeSchema(CustomerLocationListSchema);
    expect(
      list.safeParse((await getAs(CUSTOMER_ROUTES.locations.path, fresh.access_token)).body).success,
    ).toBe(true);
    const me = successEnvelopeSchema(CustomerMeSchema);
    expect(me.safeParse((await getAs(CUSTOMER_ROUTES.me.path, fresh.access_token)).body).success).toBe(true);
  });
});
