import { randomUUID } from 'node:crypto';
import { deletedPhoneHash, newCustomerToken, sha256Hex } from '@point/server';
import { PLATFORM_ROUTES, type PlatformRole } from '@point/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF, SEED_IDS, createTestApp, newKey, type TestApp } from './harness.js';
import { createTicket } from './wa-harness.js';

/**
 * V2-024 — the platform console's P-06 «العملاء» and P-08 «المدفوعات والاسترداد» (docs/v2/02 §2, docs/v2/04 §3;
 * DEC-526 … DEC-530) on a real PostgreSQL: every new route for every platform role (allowed or PERMISSION_DENIED),
 * staff and customer credentials refused, the masked phone search, the account view (no token, hash, card token or
 * full phone anywhere), suspend / reactivate / revoke and their effect on the customer's own tokens, the payments
 * list with its filters (Riyadh days), the payment timeline, the refund through P-08, the reconciliation runs, the
 * finance alerts and their resolution — idempotency and audit rows for every command.
 */

const ORG = SEED_IDS.org;
const RMS = SEED_IDS.venues.RMS;
const LYL = SEED_IDS.venues.LYL;
const ROLES: PlatformRole[] = ['platform_owner', 'platform_admin', 'platform_finance', 'platform_support'];
const ROUTES_24 = PLATFORM_ROUTES.filter((r) => r.ticket === 'V2-024');

let t: TestApp;
const cookies = {} as Record<PlatformRole, string>;
const userIds = {} as Record<PlatformRole, string>;
let phoneSeq = 0;
const nextPhone = () => `+9665${String(72000000 + ++phoneSeq)}`;

interface Account {
  id: string;
  phone: string;
  access: string;
  refresh: string;
}

async function account(name: string | null = 'سارة القحطاني'): Promise<Account> {
  const phone = nextPhone();
  const id = (
    await t.db.query<{ id: string }>(
      `INSERT INTO customer_accounts (phone_e164, display_name) VALUES ($1, $2) RETURNING id`,
      [phone, name],
    )
  ).rows[0]!.id;
  return { id, phone, ...(await session(id)) };
}

async function session(accountId: string, push: string | null = null) {
  const sid = randomUUID();
  const access = newCustomerToken('access', sid);
  const refresh = newCustomerToken('refresh', sid);
  await t.db.query(
    // V2-016 (0013): a push token comes with its provider and registration time (ck_customer_sessions_push_pair)
    `INSERT INTO customer_account_sessions (id, account_id, device_id, platform, refresh_hash, access_hash, push_token,
            push_provider, push_registered_at, access_expires_at, refresh_expires_at, created_at)
     VALUES ($1, $2, $3, 'ios', $4, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE 'expo' END,
             CASE WHEN $6::text IS NULL THEN NULL ELSE $7::timestamptz END,
             $7::timestamptz + interval '15 minutes', $7::timestamptz + interval '60 days', $7)`,
    [sid, accountId, `device-${sid}`, sha256Hex(refresh), sha256Hex(access), push, t.clock.now()],
  );
  return { access, refresh };
}

const touch = () => t.db.query(`UPDATE platform_sessions SET last_seen_at = $1`, [t.clock.now()]);

async function get(path: string, role: PlatformRole) {
  await touch();
  return t.http().get(path).set('Cookie', cookies[role]);
}

async function post(path: string, role: PlatformRole, body: object, key: string | null = newKey()) {
  await touch();
  let r = t.http().post(path).set(CSRF).set('Cookie', cookies[role]);
  if (key) r = r.set('Idempotency-Key', key);
  return r.send(body);
}

const customerMe = (access: string) =>
  t.http().get('/v1/customer/me').set('Authorization', `Bearer ${access}`);

let paySeq = 0;
async function payment(o: {
  accountId: string;
  status?: string;
  amount?: number;
  refunded?: number;
  createdAt?: string;
  venue?: 'RMS' | 'LYL';
}) {
  const ticket = await createTicket(t, { venue: o.venue ?? 'RMS', customerId: null, channel: 'paper' });
  const status = o.status ?? 'paid';
  const amount = o.amount ?? 2300;
  const paid = ['paid', 'partially_refunded', 'refunded'].includes(status);
  const r = await t.db.query<{ id: string }>(
    `INSERT INTO online_payments (account_id, purpose, ticket_id, org_id, venue_id, amount_halalas, vat_halalas,
            refunded_halalas, gateway, given_id, gateway_payment_id, source_type, card_brand, card_last4, status,
            paid_at, failed_at, failure_code, created_at)
     VALUES ($1, 'visit', $2, $3, $4, $5, $6, $7, 'moyasar', $8, $9, 'token', 'visa', '1111', $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      o.accountId,
      ticket.id,
      ORG,
      o.venue === 'LYL' ? LYL : RMS,
      amount,
      Math.round(amount - amount / 1.15),
      o.refunded ?? 0,
      randomUUID(),
      status === 'initiated' ? null : `pay_test_${++paySeq}`,
      status,
      paid ? (o.createdAt ?? t.clock.now()) : null,
      status === 'failed' ? (o.createdAt ?? t.clock.now()) : null,
      status === 'failed' ? '51' : null,
      o.createdAt ?? t.clock.now(),
    ],
  );
  return r.rows[0]!.id;
}

const platformAudits = (entityId: string) =>
  t.db.query<{ action: string; reason: string | null; metadata: any; actor_role: string | null }>(
    `SELECT action, reason, metadata, actor_role FROM platform_audit_log WHERE entity_id = $1 ORDER BY id`,
    [entityId],
  );
const customerAudits = (accountId: string) =>
  t.db.query<{ action: string; actor_type: string; metadata: any }>(
    `SELECT action, actor_type, metadata FROM customer_audit_log WHERE account_id = $1 ORDER BY id`,
    [accountId],
  );

beforeAll(async () => {
  t = await createTestApp();
  for (const [i, role] of ROLES.entries()) {
    const u = await t.db.query<{ id: string }>(
      `INSERT INTO platform_users (phone_e164, full_name, role, secret_hash, must_change_secret, mfa_enabled, mfa_secret_enc)
       VALUES ($1, $2, $3, 'x', false, true, 'x') RETURNING id`,
      [`+96655777000${i}`, `حساب ${role}`, role],
    );
    userIds[role] = u.rows[0]!.id;
    const token = `console-test-session-${role}-0123456789`;
    await t.db.query(
      `INSERT INTO platform_sessions (platform_user_id, token_hash, mfa_verified, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, true, $3, $3, $3::timestamptz + interval '400 days')`,
      [u.rows[0]!.id, sha256Hex(token), t.clock.now()],
    );
    cookies[role] = `${t.env.PLATFORM_SESSION_COOKIE_NAME}=${token}`;
  }
});
afterAll(async () => {
  await t?.close();
});

describe('V2-024 routes × platform roles, and foreign credentials', () => {
  const DUMMY = '00000000-0000-4000-8000-00000000dead';
  const call = async (r: (typeof ROUTES_24)[number], headers: Record<string, string>) => {
    const path = r.path.replace(/\{[A-Za-z]+\}/g, DUMMY);
    let req = r.method === 'GET' ? t.http().get(path) : t.http().post(path).set(CSRF);
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    if (r.method !== 'GET') req = req.set('Idempotency-Key', newKey());
    return r.method === 'GET' ? req : req.send({ reason: 'سبب الاختبار', note: undefined });
  };

  it('registers the eleven P-06 / P-08 routes', () => {
    expect(ROUTES_24.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /v1/platform/customers',
      'GET /v1/platform/customers/{accountId}',
      'POST /v1/platform/customers/{accountId}/suspend',
      'POST /v1/platform/customers/{accountId}/reactivate',
      'POST /v1/platform/customers/{accountId}/sessions/revoke',
      'GET /v1/platform/payments',
      'GET /v1/platform/payments/{paymentId}',
      'GET /v1/platform/reconciliation-runs',
      'GET /v1/platform/reconciliation-runs/{runId}',
      'GET /v1/platform/alerts',
      'POST /v1/platform/alerts/{alertId}/resolve',
    ]);
  });

  it('each role is allowed or PERMISSION_DENIED exactly by the matrix of 02 §2.1', async () => {
    const allowed: Record<string, PlatformRole[]> = {
      'platform.customer_read': ['platform_owner', 'platform_finance', 'platform_support'],
      'platform.customer_manage': ['platform_owner', 'platform_finance', 'platform_support'],
      'platform.payment_read': ['platform_owner', 'platform_finance'],
    };
    const problems: string[] = [];
    for (const r of ROUTES_24)
      for (const role of ROLES) {
        await touch();
        const res = await call(r, { Cookie: cookies[role] });
        const may = allowed[r.permission]!.includes(role);
        const denied = res.status === 403 && res.body?.error?.code === 'PERMISSION_DENIED';
        if (may === denied)
          problems.push(`${r.method} ${r.path} ${role}: ${res.status} ${res.body?.error?.code}`);
        if (may && res.status === 200 && r.method === 'GET' && !r.path.includes('{'))
          expect(Array.isArray(res.body.data)).toBe(true);
      }
    expect(problems).toEqual([]);
  });

  it('a staff session, a customer token or nothing opens no V2-024 route (PLATFORM_AUTH_REQUIRED)', async () => {
    const a = await account();
    const staff = await t.sessionFor('OWN1');
    for (const r of ROUTES_24)
      for (const headers of [{}, { Cookie: staff }, { Authorization: `Bearer ${a.access}` }] as Record<
        string,
        string
      >[]) {
        const res = await call(r, headers);
        expect(res.status, `${r.method} ${r.path}`).toBe(401);
        expect(res.body.error.code).toBe('PLATFORM_AUTH_REQUIRED');
      }
  });
});

describe('P-06 customers', () => {
  it('finds an account by its phone in any Saudi format, masked, and audits the search without the number', async () => {
    const a = await account('نورة الشهري');
    const local = `0${a.phone.slice(4)}`;
    for (const q of [a.phone, local, `966${a.phone.slice(4)}`, ` ${local.slice(0, 3)} ${local.slice(3)} `]) {
      const res = await get(`/v1/platform/customers?phone=${encodeURIComponent(q)}`, 'platform_support');
      expect(res.status, q).toBe(200);
      expect(res.body.data).toEqual([
        expect.objectContaining({
          id: a.id,
          display_name: 'نورة الشهري',
          phone_masked: `05•••••${a.phone.slice(-3)}`,
          status: 'active',
          live_sessions: 1,
        }),
      ]);
      expect(JSON.stringify(res.body)).not.toContain(a.phone.slice(4));
      expect(res.headers['cache-control']).toContain('no-store');
    }
    const audit = await t.db.query<{ action: string; metadata: any; entity_id: string; actor_role: string }>(
      `SELECT action, metadata, entity_id, actor_role FROM platform_audit_log WHERE action = 'customer.search'
        AND entity_id = $1 ORDER BY id`,
      [a.id],
    );
    expect(audit.rows).toHaveLength(4);
    expect(audit.rows[0]).toMatchObject({
      actor_role: 'platform_support',
      metadata: { by: 'phone', matches: 1 },
    });
    expect(JSON.stringify(audit.rows)).not.toContain(a.phone.slice(4));
    // an exact search only: another number finds nothing, a number that is not a Saudi mobile is PHONE_INVALID
    const none = await get(`/v1/platform/customers?phone=0599999990`, 'platform_finance');
    expect(none.body.data).toEqual([]);
    const bad = await get(`/v1/platform/customers?phone=12345`, 'platform_owner');
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatchObject({ code: 'PHONE_INVALID', details: { field: 'phone' } });
  });

  it('a deleted account is found by the keyed hash of its number (DEC-508), with no phone or name left', async () => {
    const phone = nextPhone();
    const id = (
      await t.db.query<{ id: string }>(
        `INSERT INTO customer_accounts (phone_e164, phone_hash, display_name, status, deleted_at)
         VALUES (NULL, $1, NULL, 'deleted', $2) RETURNING id`,
        [deletedPhoneHash(t.env.CODE_PEPPER, phone), t.clock.now()],
      )
    ).rows[0]!.id;
    const res = await get(`/v1/platform/customers?phone=${encodeURIComponent(phone)}`, 'platform_support');
    expect(res.body.data).toEqual([
      expect.objectContaining({ id, status: 'deleted', phone_masked: null, display_name: null }),
    ]);
    // and it takes no command
    const s = await post(`/v1/platform/customers/${id}/suspend`, 'platform_support', {
      reason: 'اختبار حساب محذوف',
    });
    expect(s.status).toBe(409);
    expect(s.body.error).toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      details: { current_status: 'deleted' },
    });
  });

  it('lists the newest accounts with a cursor and a status filter, phones masked', async () => {
    for (let i = 0; i < 3; i++) await account(`عميل ${i}`);
    const first = await get(`/v1/platform/customers?limit=2`, 'platform_owner');
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.meta.next_cursor).toEqual(expect.any(String));
    const second = await get(
      `/v1/platform/customers?limit=2&cursor=${encodeURIComponent(first.body.meta.next_cursor)}`,
      'platform_owner',
    );
    const ids = [...first.body.data, ...second.body.data].map((a: { id: string }) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of [...first.body.data, ...second.body.data])
      expect(a.phone_masked === null || /^05•+\d{3}$/.test(a.phone_masked)).toBe(true);
    const tampered = await get(
      `/v1/platform/customers?limit=2&cursor=x${first.body.meta.next_cursor}`,
      'platform_owner',
    );
    expect(tampered.body.error.code).toBe('PAGINATION_CURSOR_INVALID');
    const deleted = await get(`/v1/platform/customers?status=deleted`, 'platform_owner');
    expect(deleted.body.data.every((a: { status: string }) => a.status === 'deleted')).toBe(true);
  });

  it('the account view: consents with versions, vehicles, visits, sessions and payments — no token, hash or card token', async () => {
    const a = await account('خالد الدوسري');
    const push = 'ExponentPushToken[console-test-push-0001]';
    const second = await session(a.id, push);
    await t.db.query(
      `INSERT INTO customer_account_consents (account_id, kind, version, granted) VALUES
        ($1, 'terms', $2, true), ($1, 'privacy', $3, true), ($1, 'marketing', 'old-1', false)`,
      [a.id, t.env.CUSTOMER_TERMS_VERSION, t.env.CUSTOMER_PRIVACY_VERSION],
    );
    await t.db.query(
      `INSERT INTO customer_vehicles (account_id, plate_digits, plate_letters_ar, plate_letters_en, vehicle_make,
              vehicle_model, vehicle_color, vehicle_type)
       VALUES ($1, '4821', 'ب ح د', 'B J D', 'toyota', 'كامري', 'white', 'sedan')`,
      [a.id],
    );
    const cardToken = 'token_console_saved_card_0001';
    await t.db.query(
      `INSERT INTO customer_payment_methods (account_id, gateway, gateway_token, brand, last4, expires_month, expires_year, is_default)
       VALUES ($1, 'moyasar', $2, 'mada', '4242', 12, 2030, true)`,
      [a.id, cardToken],
    );
    const customer = await t.db.query<{ id: string }>(
      `INSERT INTO customers (org_id, phone_e164, customer_account_id) VALUES ($1, $2, $3) RETURNING id`,
      [ORG, a.phone, a.id],
    );
    const ticket = await createTicket(t, { venue: 'RMS', customerId: customer.rows[0]!.id });
    const paymentId = await payment({ accountId: a.id });

    const res = await get(`/v1/platform/customers/${a.id}`, 'platform_support');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({
      id: a.id,
      display_name: 'خالد الدوسري',
      phone_masked: `05•••••${a.phone.slice(-3)}`,
      status: 'active',
      sessions: { live: 2, total: 2, devices: 2 },
    });
    expect(d.consents.current).toEqual([
      expect.objectContaining({
        kind: 'terms',
        current_version: t.env.CUSTOMER_TERMS_VERSION,
        granted: true,
        up_to_date: true,
      }),
      expect.objectContaining({ kind: 'privacy', granted: true, up_to_date: true }),
      expect.objectContaining({
        kind: 'marketing',
        answered_version: 'old-1',
        granted: false,
        up_to_date: false,
      }),
    ]);
    expect(d.consents.history).toHaveLength(3);
    expect(d.vehicles).toEqual([
      expect.objectContaining({ plate_display: expect.stringContaining('4821'), type: 'sedan' }),
    ]);
    expect(d.visits).toEqual([
      expect.objectContaining({
        ticket_id: ticket.id,
        venue: { id: RMS, name_ar: expect.any(String) },
        open: true,
      }),
    ]);
    expect(Object.keys(d.visits[0]).sort()).toEqual([
      'channel',
      'delivered_at',
      'entitlement',
      'open',
      'org',
      'plate_display',
      'received_at',
      'status',
      'ticket_id',
      'venue',
    ]);
    expect(d.sessions.items.map((s: { push_enabled: boolean }) => s.push_enabled).sort()).toEqual([
      false,
      true,
    ]);
    expect(d.payment_methods).toEqual([expect.objectContaining({ brand: 'mada', last4: '4242' })]);
    expect(d.payments).toEqual([
      expect.objectContaining({ id: paymentId, amount_halalas: 2300, card_last4: '1111' }),
    ]);
    const text = JSON.stringify(res.body);
    for (const secret of [
      a.phone,
      a.phone.slice(4),
      a.access,
      a.refresh,
      sha256Hex(a.access),
      sha256Hex(a.refresh),
      second.access,
      push,
      cardToken,
    ])
      expect(text).not.toContain(secret);
    expect(text).not.toMatch(/access_hash|refresh_hash|token_hash|gateway_token|push_token|code_hash/);
    expect((await platformAudits(a.id)).rows.map((r) => r.action)).toEqual(['customer.view']);
    // an unknown or malformed id answers the same
    for (const id of [randomUUID(), 'not-a-uuid']) {
      const nf = await get(`/v1/platform/customers/${id}`, 'platform_owner');
      expect(nf.status).toBe(404);
      expect(nf.body.error).toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
        details: { resource: 'customer_account' },
      });
    }
  });

  it('suspend refuses the customer’s tokens (reversibly), reactivate restores them; both logs, idempotent, a reason', async () => {
    const a = await account();
    expect((await customerMe(a.access)).status).toBe(200);
    const path = `/v1/platform/customers/${a.id}/suspend`;
    const noReason = await post(path, 'platform_support', { reason: ' ab ' });
    expect(noReason.status).toBe(422);
    expect(noReason.body.error).toMatchObject({
      code: 'REASON_REQUIRED',
      details: { field: 'reason', min_length: 3 },
    });
    const noKey = await post(path, 'platform_support', { reason: 'بلاغ احتيال' }, null);
    expect(noKey.status).toBe(428);
    expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const key = newKey();
    const done = await post(path, 'platform_support', { reason: 'بلاغ احتيال' }, key);
    expect(done.status).toBe(200);
    expect(done.body.data.account).toMatchObject({ id: a.id, status: 'suspended', live_sessions: 1 });
    // the same key replays the answer and writes nothing more
    const replay = await post(path, 'platform_support', { reason: 'بلاغ احتيال' }, key);
    expect(replay.body.data).toEqual(done.body.data);
    // the customer's own token, its refresh and its sign-in are refused while suspended — the session stays alive
    const me = await customerMe(a.access);
    expect(me.status).toBe(403);
    expect(me.body.error.code).toBe('AUTH_ACCOUNT_DISABLED');
    const refreshed = await t
      .http()
      .post('/v1/customer/auth/refresh')
      .send({ refresh_token: a.refresh, device_id: `device-${a.access.split('.')[1]}` });
    expect(refreshed.body.error.code).toBe('AUTH_ACCOUNT_DISABLED');
    const again = await post(path, 'platform_finance', { reason: 'مرة ثانية' });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      details: { current_status: 'suspended', allowed_from: ['active'] },
    });
    const back = await post(`/v1/platform/customers/${a.id}/reactivate`, 'platform_owner', {
      reason: 'انتهى التحقق',
    });
    expect(back.status).toBe(200);
    expect(back.body.data.account.status).toBe('active');
    expect((await customerMe(a.access)).status).toBe(200);

    const pa = (await platformAudits(a.id)).rows;
    expect(
      pa.map((r) => [r.action, r.actor_role, r.reason, r.metadata.from_status, r.metadata.to_status]),
    ).toEqual([
      ['customer.suspend', 'platform_support', 'بلاغ احتيال', 'active', 'suspended'],
      ['customer.reactivate', 'platform_owner', 'انتهى التحقق', 'suspended', 'active'],
    ]);
    const ca = (await customerAudits(a.id)).rows.filter((r) => r.action.startsWith('customer.account.'));
    expect(ca).toEqual([
      expect.objectContaining({
        action: 'customer.account.suspended',
        actor_type: 'system',
        metadata: expect.objectContaining({ system: 'platform', platform_user_id: userIds.platform_support }),
      }),
      expect.objectContaining({ action: 'customer.account.reactivated', actor_type: 'system' }),
    ]);
    // the account view shows the history with who and why
    const view = await get(`/v1/platform/customers/${a.id}`, 'platform_owner');
    expect(view.body.data.history.map((h: { action: string }) => h.action)).toEqual([
      'customer.reactivate',
      'customer.suspend',
    ]);
  });

  it('revoke ends every live session (platform_revoked), drops push tokens; the token answers AUTH_SESSION_REVOKED', async () => {
    const a = await account();
    const other = await session(a.id, 'ExponentPushToken[console-revoke]');
    const res = await post(`/v1/platform/customers/${a.id}/sessions/revoke`, 'platform_finance', {
      reason: 'الجهاز مفقود',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      revoked_sessions: 2,
      account: { status: 'active', live_sessions: 0 },
    });
    const rows = await t.db.query<{ revoked_reason: string; push_token: string | null }>(
      `SELECT revoked_reason, push_token FROM customer_account_sessions WHERE account_id = $1`,
      [a.id],
    );
    expect(rows.rows).toEqual([
      { revoked_reason: 'platform_revoked', push_token: null },
      { revoked_reason: 'platform_revoked', push_token: null },
    ]);
    for (const access of [a.access, other.access]) {
      const me = await customerMe(access);
      expect(me.status).toBe(401);
      expect(me.body.error).toMatchObject({
        code: 'AUTH_SESSION_REVOKED',
        details: { reason: 'platform_revoked' },
      });
    }
    expect((await platformAudits(a.id)).rows).toEqual([
      expect.objectContaining({
        action: 'customer.sessions_revoke',
        reason: 'الجهاز مفقود',
        metadata: expect.objectContaining({ revoked_sessions: 2 }),
      }),
    ]);
    expect((await customerAudits(a.id)).rows.map((r) => r.action)).toContain('customer.sessions.revoked');
  });
});

describe('P-08 payments, refunds, reconciliation and alerts', () => {
  let payer: Account;
  beforeAll(async () => {
    payer = await account('ريم الحربي');
  });

  it('lists the payments newest first, filtered by status, purpose, operator, venue, account and Riyadh days', async () => {
    const other = await account();
    // 00:30 on 27 Oct in Riyadh is 26 Oct 21:30 UTC
    const late = await payment({ accountId: payer.id, createdAt: '2026-10-26T21:30:00.000Z', venue: 'LYL' });
    const failed = await payment({
      accountId: other.id,
      status: 'failed',
      createdAt: '2026-10-26T20:30:00.000Z',
    });
    const res = await get(
      `/v1/platform/payments?from=2026-10-27&to=2026-10-27&account_id=${payer.id}`,
      'platform_finance',
    );
    expect(res.status).toBe(200);
    expect(res.body.data.map((p: { id: string }) => p.id)).toEqual([late]);
    expect(res.body.data[0]).toMatchObject({
      status: 'paid',
      amount_halalas: 2300,
      vat_halalas: 300,
      card_brand: 'visa',
      card_last4: '1111',
      account: { id: payer.id, phone_masked: `05•••••${payer.phone.slice(-3)}` },
      venue: { id: LYL },
      org: { id: ORG },
    });
    expect(JSON.stringify(res.body)).not.toContain(payer.phone.slice(4));
    const day26 = await get(`/v1/platform/payments?to=2026-10-26&status=failed`, 'platform_owner');
    expect(day26.body.data.map((p: { id: string }) => p.id)).toContain(failed);
    expect(day26.body.data.map((p: { id: string }) => p.id)).not.toContain(late);
    const byVenue = await get(
      `/v1/platform/payments?venue_id=${LYL}&org_id=${ORG}&purpose=visit`,
      'platform_owner',
    );
    expect(byVenue.body.data.every((p: { venue: { id: string } }) => p.venue.id === LYL)).toBe(true);
    const backwards = await get(`/v1/platform/payments?from=2026-10-28&to=2026-10-27`, 'platform_owner');
    expect(backwards.status).toBe(422);
    expect(backwards.body.error.code).toBe('VALIDATION_FAILED');
    const page = await get(`/v1/platform/payments?limit=1`, 'platform_owner');
    expect(page.body.meta.next_cursor).toEqual(expect.any(String));
    const next = await get(
      `/v1/platform/payments?limit=1&cursor=${encodeURIComponent(page.body.meta.next_cursor)}`,
      'platform_owner',
    );
    expect(next.body.data[0].id).not.toBe(page.body.data[0].id);
  });

  it('the payment detail: refundable amount, timeline of the sanitized webhook deliveries; refund via P-08', async () => {
    const id = await payment({ accountId: payer.id, amount: 5000 });
    const gid = (
      await t.db.query<{ g: string }>(`SELECT gateway_payment_id AS g FROM online_payments WHERE id = $1`, [
        id,
      ])
    ).rows[0]!.g;
    await t.db.query(
      `INSERT INTO gateway_webhook_events (gateway, event_id, event_type, gateway_payment_id, live, body_sha256, payload,
              processed_at, outcome, online_payment_id)
       VALUES ('moyasar', $1, 'payment_paid', $2, false, $3, $4, $5, 'unchanged', $6)`,
      [
        `evt-${gid}`,
        gid,
        sha256Hex(gid),
        JSON.stringify({
          id: `evt-${gid}`,
          type: 'payment_paid',
          data: { id: gid, status: 'paid', amount: 5000, refunded: 0, ip: '10.1.2.3', description: 'زيارة' },
        }),
        t.clock.now(),
        id,
      ],
    );
    const before = await get(`/v1/platform/payments/${id}`, 'platform_finance');
    expect(before.status).toBe(200);
    expect(before.body.data).toMatchObject({ id, refundable_halalas: 5000, refunds: [], alerts: [] });
    expect(before.body.data.webhook_events).toEqual([
      expect.objectContaining({
        event_type: 'payment_paid',
        outcome: 'unchanged',
        claimed: { status: 'paid', amount_halalas: 5000, refunded_halalas: 0 },
      }),
    ]);
    expect(JSON.stringify(before.body)).not.toContain('10.1.2.3');

    const path = `/v1/platform/payments/${id}/refunds`;
    const missing = await post(path, 'platform_finance', { amount_halalas: 1000 });
    expect(missing.body.error).toMatchObject({ code: 'REASON_REQUIRED' });
    const over = await post(path, 'platform_finance', {
      amount_halalas: 5001,
      reason: 'استرداد أكبر من المدفوع',
    });
    expect(over.status).toBe(409);
    expect(over.body.error).toMatchObject({
      code: 'REFUND_AMOUNT_EXCEEDS_PAID',
      details: { refundable_halalas: 5000 },
    });
    const denied = await post(path, 'platform_support', { amount_halalas: 1000, reason: 'الدعم لا يسترد' });
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    const ok = await post(path, 'platform_owner', { amount_halalas: 1500, reason: 'تأخر التسليم' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.refund).toMatchObject({ amount_halalas: 1500, status: 'requested' });
    const after = await get(`/v1/platform/payments/${id}`, 'platform_owner');
    expect(after.body.data).toMatchObject({ refundable_halalas: 3500, refund_pending_halalas: 1500 });
    expect(after.body.data.refunds).toEqual([
      expect.objectContaining({
        amount_halalas: 1500,
        reason: 'تأخر التسليم',
        status: 'requested',
        issued_by: { id: userIds.platform_owner, full_name: 'حساب platform_owner' },
      }),
    ]);
    const rest = await post(path, 'platform_finance', { amount_halalas: 3501, reason: 'أكثر من المتبقي' });
    expect(rest.body.error).toMatchObject({
      code: 'REFUND_AMOUNT_EXCEEDS_PAID',
      details: { refundable_halalas: 3500 },
    });
    for (const pid of [randomUUID(), 'nope']) {
      const nf = await get(`/v1/platform/payments/${pid}`, 'platform_owner');
      expect(nf.body.error).toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
        details: { resource: 'online_payment' },
      });
    }
  });

  it('reconciliation runs and their mismatches', async () => {
    const id = await payment({ accountId: payer.id });
    const run = await t.db.query<{ id: string }>(
      `INSERT INTO payment_reconciliation_runs (gateway, run_date, status, started_at, finished_at, gateway_count,
              local_count, matched_count, mismatch_count, gateway_paid_halalas, local_paid_halalas, mismatches)
       VALUES ('moyasar', '2026-10-26', 'mismatched', $1, $1, 3, 2, 2, 1, 6900, 4600, $2) RETURNING id`,
      [
        t.clock.now(),
        JSON.stringify([
          {
            kind: 'missing_at_gateway',
            gateway_payment_id: null,
            online_payment_id: id,
            point_status: 'paid',
          },
        ]),
      ],
    );
    await t.db.query(
      `INSERT INTO payment_reconciliation_runs (gateway, run_date, status, started_at, finished_at, failure_reason)
       VALUES ('moyasar', '2026-10-25', 'failed', $1::timestamptz - interval '1 day', $1, 'gateway_timeout')`,
      [t.clock.now()],
    );
    const list = await get(`/v1/platform/reconciliation-runs`, 'platform_finance');
    expect(list.status).toBe(200);
    expect(list.body.data[0]).toMatchObject({
      id: run.rows[0]!.id,
      run_date: '2026-10-26',
      status: 'mismatched',
      mismatch_count: 1,
    });
    const failed = await get(
      `/v1/platform/reconciliation-runs?status=failed&from=2026-10-25&to=2026-10-25`,
      'platform_finance',
    );
    expect(failed.body.data).toEqual([
      expect.objectContaining({ status: 'failed', failure_reason: 'gateway_timeout' }),
    ]);
    const detail = await get(`/v1/platform/reconciliation-runs/${run.rows[0]!.id}`, 'platform_owner');
    expect(detail.body.data.mismatches).toEqual([
      expect.objectContaining({
        kind: 'missing_at_gateway',
        online_payment_id: id,
        point_status: 'paid',
        synced: false,
      }),
    ]);
    const nf = await get(`/v1/platform/reconciliation-runs/${randomUUID()}`, 'platform_owner');
    expect(nf.body.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('alerts: open and resolved lists, resolve with a note (idempotent, audited), a resolved alert stays resolved', async () => {
    const id = await payment({ accountId: payer.id });
    const alert = await t.db.query<{ id: string }>(
      `INSERT INTO platform_alerts (type, severity, dedupe_key, online_payment_id, details)
       VALUES ('payment_mismatch', 'critical', $1, $2, $3) RETURNING id`,
      [`payment_mismatch:${id}`, id, JSON.stringify({ point_status: 'paid', gateway_status: 'failed' })],
    );
    const alertId = alert.rows[0]!.id;
    const open = await get(`/v1/platform/alerts`, 'platform_finance');
    expect(open.body.data.map((a: { id: string }) => a.id)).toContain(alertId);
    const typed = await get(`/v1/platform/alerts?type=payment_unknown`, 'platform_finance');
    expect(typed.body.data.map((a: { id: string }) => a.id)).not.toContain(alertId);
    const detail = await get(`/v1/platform/payments/${id}`, 'platform_finance');
    expect(detail.body.data.alerts).toEqual([expect.objectContaining({ id: alertId, status: 'open' })]);

    const path = `/v1/platform/alerts/${alertId}/resolve`;
    const noNote = await post(path, 'platform_finance', { note: '' });
    expect(noNote.body.error).toMatchObject({ code: 'REASON_REQUIRED', details: { field: 'note' } });
    const key = newKey();
    const done = await post(path, 'platform_finance', { note: 'طابقنا مع لوحة البوابة' }, key);
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({
      id: alertId,
      status: 'resolved',
      resolution_note: 'طابقنا مع لوحة البوابة',
      resolved_by: { id: userIds.platform_finance },
    });
    expect((await post(path, 'platform_finance', { note: 'طابقنا مع لوحة البوابة' }, key)).body.data).toEqual(
      done.body.data,
    );
    const again = await post(path, 'platform_owner', { note: 'مرة ثانية' });
    expect(again.body.error).toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      details: { current_status: 'resolved' },
    });
    const resolved = await get(`/v1/platform/alerts?status=resolved`, 'platform_owner');
    expect(resolved.body.data.map((a: { id: string }) => a.id)).toContain(alertId);
    expect(
      (await get(`/v1/platform/alerts`, 'platform_owner')).body.data.map((a: { id: string }) => a.id),
    ).not.toContain(alertId);
    expect((await platformAudits(alertId)).rows).toEqual([
      expect.objectContaining({
        action: 'platform_alert.resolve',
        reason: 'طابقنا مع لوحة البوابة',
        actor_role: 'platform_finance',
      }),
    ]);
  });
});
