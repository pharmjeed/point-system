// V2 pieces of the ops harness (V2-051, DEC-563): the payment simulator as a process, customer accounts and their
// Bearer sessions, a customer client of /v1/customer/* (every exchange recorded in httpLog like the staff client),
// platform sessions, a plan of a listed venue, the link of a parked ticket to an account. Direct SQL is used only for
// what the platform's own screens would have set up (sessions, profiles, plans, contracts), never for a command the
// run measures.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { httpLog, routeOf } from './api.mjs';
import { io } from './deps.mjs';

export const PAYMENT_SIMULATOR = 'tools/payment-simulator/dist/main.js';
/** test-mode keys of the simulator (it refuses anything else); random per run would buy nothing: it is local */
export const PAY_SECRET_KEY = 'sk_test_point_simulator_secret';
export const PAY_PUBLISHABLE_KEY = 'pk_test_point_simulator_publishable';
export const CARD_VERSION = '2026-11-01';
export const CARDS = {
  success: '4111111111111111',
  threeDs: '4000000000000002',
  declined: '4201320000311101',
};

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const token = (kind, sid) => `${kind}.${sid}.${randomBytes(32).toString('base64url')}`;

/** The api/worker variables of the V2 integrations on the simulators (merged into serverEnv's overrides). */
export function v2ServerEnv(o) {
  return {
    MOYASAR_MODE: 'simulator',
    MOYASAR_BASE_URL: `http://127.0.0.1:${o.ports.pay}`,
    MOYASAR_SECRET_KEY: PAY_SECRET_KEY,
    MOYASAR_WEBHOOK_SECRET: o.webhookSecret,
    MOYASAR_HTTP_TIMEOUT_MS: '5000',
    EINVOICE_MODE: 'simulator',
    EINVOICE_WEBHOOK_SECRET: o.einvoiceSecret ?? randomBytes(16).toString('hex'),
    CUSTOMER_PUSH_MODE: 'simulator',
  };
}

/** The payment simulator's environment: posts its events to the api's webhook with the run's shared secret. */
export function paymentSimulatorEnv(o) {
  return {
    NODE_ENV: 'development',
    APP_ENV: 'local',
    PORT: String(o.ports.pay),
    HOST: '127.0.0.1',
    WEBHOOK_URL: `http://127.0.0.1:${o.ports.api}/webhooks/payments/moyasar`,
    WEBHOOK_SECRET: o.webhookSecret,
    SECRET_KEY: PAY_SECRET_KEY,
    PUBLISHABLE_KEY: PAY_PUBLISHABLE_KEY,
    WEBHOOK_RETRIES: String(o.retries ?? 3),
  };
}

/** A customer account with one Bearer session (what a verified sign-in leaves), for runs that do not measure it. */
export async function customerAccount(q, { phone, now = new Date(), name = 'عميل' }) {
  const id = (
    await q.query(`INSERT INTO customer_accounts (phone_e164, display_name) VALUES ($1, $2) RETURNING id`, [
      phone,
      name,
    ])
  ).rows[0].id;
  const sid = randomUUID();
  const access = token('pca', sid);
  const refresh = token('pcr', sid);
  await q.query(
    `INSERT INTO customer_account_sessions (id, account_id, device_id, platform, refresh_hash, access_hash,
            access_expires_at, refresh_expires_at, created_at)
     VALUES ($1, $2, $3, 'android', $4, $5, $6::timestamptz + interval '30 days', $6::timestamptz + interval '60 days', $6)`,
    [sid, id, `harness-device-${sid}`, sha256(refresh), sha256(access), now],
  );
  return { id, phone, access, refresh, sessionId: sid };
}

/** A platform account of `role` with an MFA-verified session (P-01's sign-in is tested on its own). */
export async function platformSession(q, { role = 'platform_owner', phone, cookieName, now = new Date() }) {
  const u = await q.query(
    `INSERT INTO platform_users (phone_e164, full_name, role, secret_hash, must_change_secret, mfa_enabled, mfa_secret_enc)
     VALUES ($1, $2, $3, 'x', false, true, 'x') RETURNING id`,
    [phone, `حساب ${role}`, role],
  );
  const tok = `harness-platform-${randomBytes(24).toString('hex')}`;
  await q.query(
    `INSERT INTO platform_sessions (platform_user_id, token_hash, mfa_verified, created_at, last_seen_at, expires_at)
     VALUES ($1, $2, true, $3, $3, $3::timestamptz + interval '2 days')`,
    [u.rows[0].id, sha256(tok), now],
  );
  return { userId: u.rows[0].id, cookie: `${cookieName}=${tok}` };
}

/** A listed recurring venue (P-04 approved, subscriptions on) and a one-vehicle monthly plan (P-05). */
export async function listedVenueWithPlan(q, { venueId, orgId, approver, monthly = 30_000 }) {
  await q.query(
    `INSERT INTO venue_public_profiles (venue_id, org_id, status, category, subscriptions_enabled, pay_per_visit_halalas,
                                        approved_by, approved_at)
     VALUES ($1, $2, 'approved', 'office', true, 2300, $3, now())
     ON CONFLICT (venue_id) DO UPDATE SET status = 'approved', category = 'office', subscriptions_enabled = true`,
    [venueId, orgId, approver],
  );
  const p = await q.query(
    `INSERT INTO subscription_plans (org_id, venue_id, name_ar, vehicles_included, monthly_price_halalas, created_by)
     VALUES ($1, $2, 'سيارة واحدة', 1, $3, $4) RETURNING id`,
    [orgId, venueId, monthly, approver],
  );
  return p.rows[0].id;
}

/** The operator's customer row of a parked WhatsApp ticket now names the account (DEC-504's link), its fee due. */
export async function linkTicket(q, { ticketId, accountId, feeHalalas = 2300 }) {
  await q.query(
    `UPDATE customers SET customer_account_id = $2 WHERE id = (SELECT customer_id FROM tickets WHERE id = $1)`,
    [ticketId, accountId],
  );
  await q.query(
    `UPDATE tickets SET payment_status = 'due', fee_halalas = $2, entitlement = 'none' WHERE id = $1`,
    [ticketId, feeHalalas],
  );
}

/** A customer app's client of /v1/customer/*: the Bearer token, an Idempotency-Key on every write. */
export class CustomerClient {
  constructor(base, account, o = {}) {
    this.base = base;
    this.account = account;
    this.label = o.label ?? 'customer';
  }

  async request(method, path, { body, key, timeoutMs = 30_000, auth = true } = {}) {
    const headers = { Accept: 'application/json' };
    if (auth && this.account?.access) headers.Authorization = `Bearer ${this.account.access}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const idempotencyKey = key === true ? `c-${randomUUID()}` : key || undefined;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const started = performance.now();
    const rec = {
      at: Date.now(),
      client: this.label,
      route: routeOf(method, path),
      status: 0,
      code: null,
      ms: 0,
      error: null,
    };
    try {
      const res = await fetch(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      rec.ms = performance.now() - started;
      rec.status = res.status;
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      rec.code = json?.error?.code ?? null;
      httpLog.push(rec);
      return {
        status: res.status,
        ok: res.ok,
        data: json?.data,
        error: json?.error ?? null,
        key: idempotencyKey,
        ms: rec.ms,
      };
    } catch (e) {
      rec.ms = performance.now() - started;
      rec.error = e?.cause?.code ?? e?.name ?? 'network';
      httpLog.push(rec);
      return {
        status: 0,
        ok: false,
        data: null,
        error: { code: rec.error },
        key: idempotencyKey,
        ms: rec.ms,
      };
    }
  }

  get(path) {
    return this.request('GET', path);
  }

  /** A write with a fresh key, retried with the same key on 503/429/network (07 §1.4). */
  async command(method, path, body = {}, { retries = 3, key = true } = {}) {
    const k = key === true ? `c-${randomUUID()}` : key;
    let r;
    for (let attempt = 0; attempt <= retries; attempt++) {
      r = await this.request(method, path, { body, key: k });
      if (!(
        r.status === 0 ||
        r.status === 503 ||
        r.status === 429 ||
        r.error?.code === 'IDEMPOTENCY_IN_PROGRESS'
      ))
        return r;
      await sleep(Math.min(3000, 300 * 2 ** attempt));
    }
    return r;
  }

  /** C-02 → C-03 through the real routes: the code read from the WhatsApp simulator (what the customer sees). */
  async signIn(phone, waSim, { device = `harness-${randomUUID()}`, templateName }) {
    const r = await this.request('POST', '/v1/customer/auth/otp', {
      body: { phone_e164: phone, device_id: device, platform: 'android', locale: 'ar' },
      auth: false,
    });
    if (r.status !== 200) throw new Error(`${this.label}: otp ${r.status} ${r.error?.code}`);
    const requestedAt = Date.now();
    const digits = phone.replace(/\D/g, '');
    let code = null;
    for (let i = 0; i < 200 && !code; i++) {
      const listed = await waSim.listMessages({ to: phone });
      if (!Array.isArray(listed))
        throw new Error(`simulator messages: ${JSON.stringify(listed)?.slice(0, 200)}`);
      const msgs = listed.filter((m) => m.templateName === templateName);
      const last = msgs.sort((x, y) => x.seq - y.seq).at(-1);
      if (last && (last.waId ?? last.to?.replace(/\D/g, '')) === digits) code = last.bodyParams?.[0] ?? null;
      if (!code) await sleep(100);
    }
    if (!code) throw new Error(`${this.label}: no sign-in code reached the simulator`);
    const deliveredMs = Date.now() - requestedAt;
    const v = await this.request('POST', '/v1/customer/auth/verify', {
      body: { phone_e164: phone, code, device_id: device, platform: 'android' },
      auth: false,
    });
    if (v.status !== 200) throw new Error(`${this.label}: verify ${v.status} ${v.error?.code}`);
    this.account = {
      id: v.data.account.id,
      phone,
      access: v.data.access_token,
      refresh: v.data.refresh_token,
    };
    return { code, deliveredMs, ...this.account };
  }

  /** Socket.IO on the customer namespace with the access token (DEC-520). */
  socket() {
    return io(`${this.base}/customer`, {
      path: '/ws',
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 500,
      forceNew: true,
      extraHeaders: { authorization: `Bearer ${this.account.access}` },
    });
  }
}

/** A device-side tokenization of a test card at the simulator (the publishable key; the server never sees it). */
export async function tokenize(payBase, number) {
  const res = await fetch(`${payBase}/v1/tokens`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`${PAY_PUBLISHABLE_KEY}:`).toString('base64')}`,
    },
    body: JSON.stringify({ name: 'TEST CARD', number, cvc: '123', month: '12', year: '2030' }),
  });
  if (!res.ok) throw new Error(`tokenize ${res.status}`);
  return (await res.json()).id;
}

/** The control API of the payment simulator (`/_sim/*`). */
export function paySim(payBase) {
  const call = async (method, path, body) => {
    const res = await fetch(`${payBase}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`payment simulator ${method} ${path}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  return {
    payment: (id) => call('GET', `/_sim/payments/${encodeURIComponent(id)}`),
    payments: () => call('GET', '/_sim/payments'),
    complete3ds: (id, outcome = 'success') =>
      call('POST', `/_sim/payments/${encodeURIComponent(id)}/3ds`, { outcome }),
    deliveries: () => call('GET', '/_sim/webhooks'),
    flush: () => call('POST', '/_sim/webhooks/flush', {}),
    replay: (eventId) => call('POST', '/_sim/webhooks/replay', { event_id: eventId }),
    configure: (patch) => call('PATCH', '/_sim/config', patch),
  };
}

/** A full Saudi mobile number in any common written form (canon rule 8: never in a log line). */
export const FULL_PHONE = /(\+|\b)9665[0-9]{8}\b|\b05[0-9]{8}\b/;

/**
 * Scans log text for full phone numbers and for the given secrets (sign-in and handover codes): a secret counts
 * when it stands alone as a number inside a quoted string, after ISO timestamps are removed (a 4-digit code would
 * otherwise match a year). Returns the counts and a masked sample.
 */
export function scanLogText(text, secrets) {
  const lines = text.split('\n').filter(Boolean);
  const phones = lines.filter((l) => FULL_PHONE.test(l));
  const cleaned = lines.map((l) => l.replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/g, ''));
  let secretHits = 0;
  for (const s of secrets) {
    const re = new RegExp(`"[^"]*(?<![0-9A-Za-z])${s}(?![0-9A-Za-z])[^"]*"`);
    if (cleaned.some((l) => re.test(l))) secretHits++;
  }
  return {
    lines: lines.length,
    fullPhones: phones.length,
    phoneSample: phones.slice(0, 2).map((l) => l.replace(/[0-9]{6}/g, '######').slice(0, 160)),
    secretsChecked: secrets.size ?? secrets.length,
    secretHits,
  };
}
