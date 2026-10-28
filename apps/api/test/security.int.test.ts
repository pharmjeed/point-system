import { createHmac, randomUUID } from 'node:crypto';
import { createSessionCookie } from '@point/server/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF, SEED_CREDENTIALS, SEED_IDS, createTestApp, newKey, type TestApp } from './harness.js';
import { WA_TEST_SECRETS, createWaTestApp, type WaTestApp } from './wa-harness.js';

/**
 * PNT-096 — the automatable rows of 17 §10 that no other suite owns: rate limits per 07 §1.9 class
 * (429 RATE_LIMITED, Retry-After, RateLimit-*), the API security headers, the session cookie of a
 * production configuration (__Host-, Secure, HttpOnly, SameSite, no Domain), session fixation, and a stale
 * but correctly signed webhook replay. Lockout, revocation, CSRF, MFA, IDOR and forged/modified webhooks are
 * covered by auth, skeleton, permission-matrix and wa-webhook tests.
 */

const header = (r: { headers: Record<string, unknown> }, name: string) => r.headers[name.toLowerCase()];

describe('rate limits by IP: auth, unauthenticated requests, webhook; health is free', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({
      env: {
        RATE_LIMIT_ENABLED: 'true',
        RATE_LIMIT_AUTH_PER_MIN: '3',
        RATE_LIMIT_READS_PER_MIN: '2',
        RATE_LIMIT_WEBHOOK_PER_MIN: '2',
      },
    });
  });
  afterAll(async () => t?.close());

  const login = (ip: string) =>
    t
      .http()
      .post('/v1/auth/login')
      .set(CSRF)
      .set('X-Forwarded-For', ip)
      .send({ phone: '+966599999990', secret: '135792' });

  it('auth: the 4th login from one address in a minute is 429 RATE_LIMITED with Retry-After; other addresses are not affected', async () => {
    const first = await login('198.51.100.1');
    expect(first.status).toBe(401); // unknown phone (the limit counts every attempt)
    expect(header(first, 'RateLimit-Limit')).toBe('3');
    expect(header(first, 'RateLimit-Remaining')).toBe('2');
    expect(Number(header(first, 'RateLimit-Reset'))).toBeGreaterThan(0);
    await login('198.51.100.1');
    await login('198.51.100.1');
    const limited = await login('198.51.100.1');
    expect(limited.status).toBe(429);
    expect(limited.body.error).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      details: { retry_after_s: 20 },
    });
    expect(limited.body.error.message_ar).toBeTruthy();
    expect(header(limited, 'Retry-After')).toBe('20');
    expect(header(limited, 'RateLimit-Remaining')).toBe('0');
    expect((await login('198.51.100.2')).status).toBe(401);
    // a token every 60 s / 3 = 20 s
    t.clock.advanceSeconds(20);
    expect((await login('198.51.100.1')).status).toBe(401);
    expect((await login('198.51.100.1')).status).toBe(429);
  });

  it('a successful login is limited like a failed one and the session still works', async () => {
    const c = SEED_CREDENTIALS.DRV3;
    const r = await t
      .http()
      .post('/v1/auth/login')
      .set(CSRF)
      .set('X-Forwarded-For', '198.51.100.9')
      .send({ phone: c.phone, secret: c.secret });
    expect(r.status).toBe(200);
    expect(header(r, 'RateLimit-Remaining')).toBe('2');
  });

  it('without a session cookie a route is limited by address with its class (here read: 2/min)', async () => {
    const me = () => t.http().get('/v1/me').set('X-Forwarded-For', '198.51.100.20');
    expect((await me()).status).toBe(401);
    expect((await me()).status).toBe(401);
    const r = await me();
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('RATE_LIMITED');
  });

  it('IPv6 clients share one bucket per /64', async () => {
    const me = (ip: string) => t.http().get('/v1/me').set('X-Forwarded-For', ip);
    expect((await me('2001:db8:1:2::10')).status).toBe(401);
    expect((await me('2001:db8:1:2:aaaa::11')).status).toBe(401);
    expect((await me('2001:db8:1:2:bbbb:cccc:dddd:12')).status).toBe(429);
    expect((await me('2001:db8:1:3::10')).status).toBe(401);
  });

  it('webhook: the per-address valve answers 429 (Meta retries later); health checks are never limited', async () => {
    const post = () =>
      t
        .http()
        .post('/webhooks/whatsapp')
        .set('X-Forwarded-For', '198.51.100.30')
        .set('Content-Type', 'application/json')
        .send('{}');
    expect((await post()).status).not.toBe(429); // unsigned: refused by the signature check
    expect((await post()).status).not.toBe(429);
    expect((await post()).status).toBe(429);
    for (let i = 0; i < 20; i++) {
      const h = await t.http().get('/health/live').set('X-Forwarded-For', '198.51.100.30');
      expect(h.status).toBe(200);
      expect(header(h, 'RateLimit-Limit')).toBeUndefined();
    }
  });
});

describe('rate limits per user and per device after the session', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({
      env: {
        RATE_LIMIT_ENABLED: 'true',
        RATE_LIMIT_COMMANDS_PER_MIN: '6',
        RATE_LIMIT_ACCEPT_PER_10S: '2',
        RATE_LIMIT_READS_PER_MIN: '2',
        RATE_LIMIT_DEVICE_PER_MIN: '2',
      },
    });
  });
  afterAll(async () => t?.close());

  const cancel = (as: string, key: string) =>
    t.command('post', `/v1/tickets/${randomUUID()}/void`, {
      as,
      key,
      body: { reason: 'security test' },
    });

  it('command: per user; the refused request is not stored with its Idempotency-Key', async () => {
    for (let i = 0; i < 6; i++) {
      const r = await cancel('SUP-R', newKey());
      expect(r.status).not.toBe(429); // a business or validation answer: the guards ran first
      expect(header(r, 'RateLimit-Limit')).toBe('6');
      expect(header(r, 'RateLimit-Remaining')).toBe(String(5 - i));
    }
    const key = newKey();
    const limited = await cancel('SUP-R', key);
    expect(limited.status).toBe(429);
    expect(limited.body.error.details.retry_after_s).toBe(10);
    expect(header(limited, 'Idempotent-Replayed')).toBeUndefined();
    // another user has their own bucket
    expect((await cancel('SUP-RL', newKey())).status).not.toBe(429);
    // after the refill the same key runs the command (a 429 is never replayed, TC-068)
    t.clock.advanceSeconds(10);
    const again = await cancel('SUP-R', key);
    expect(again.status).not.toBe(429);
    expect(header(again, 'Idempotent-Replayed')).toBeUndefined();
    const stored = await t.db.query(`SELECT count(*)::int AS n FROM idempotency_keys WHERE key = $1`, [key]);
    expect(stored.rows[0].n).toBe(1);
  });

  it('accepting offers: 20 within 10 s (here 2) on top of the command class', async () => {
    const accept = () =>
      t.command('post', `/v1/task-offers/${randomUUID()}/accept`, { as: 'DRV1', body: {} });
    expect((await accept()).status).not.toBe(429);
    expect((await accept()).status).not.toBe(429);
    const limited = await accept();
    expect(limited.status).toBe(429);
    expect(header(limited, 'RateLimit-Limit')).toBe('2'); // the accept rule, not the command class (6)
    expect(limited.body.error.details.retry_after_s).toBe(5);
    t.clock.advanceSeconds(5);
    expect((await accept()).status).not.toBe(429);
  });

  it('read: per user', async () => {
    expect((await t.get('/v1/me', 'DRV4')).status).toBe(200);
    const second = await t.get('/v1/me', 'DRV4');
    expect(header(second, 'RateLimit-Remaining')).toBe('0');
    expect((await t.get('/v1/me', 'DRV4')).status).toBe(429);
    expect((await t.get('/v1/me', 'DRV5')).status).toBe(200);
  });

  it('device: per session — a second device of the same user has its own bucket', async () => {
    const a = (await createSessionCookie(t.db, SEED_IDS.users.DRV6, { now: t.clock.now(), hours: 4 })).cookie;
    const b = (await createSessionCookie(t.db, SEED_IDS.users.DRV6, { now: t.clock.now(), hours: 4 })).cookie;
    const beat = (cookie: string) =>
      t.http().post('/v1/me/heartbeat').set(CSRF).set('Cookie', cookie).send({});
    expect((await beat(a)).status).not.toBe(429);
    expect((await beat(a)).status).not.toBe(429);
    expect((await beat(a)).status).toBe(429);
    expect((await beat(b)).status).not.toBe(429);
  });
});

describe('API security headers (05 §14.1)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ seed: false });
  });
  afterAll(async () => t?.close());

  it('every response: HSTS, nosniff, no-referrer, CORP same-site, frame denial, a CSP that allows nothing', async () => {
    for (const path of ['/health/live', '/v1/me']) {
      const r = await t.http().get(path);
      expect(header(r, 'Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');
      expect(header(r, 'X-Content-Type-Options')).toBe('nosniff');
      expect(header(r, 'Referrer-Policy')).toBe('no-referrer');
      expect(header(r, 'Cross-Origin-Resource-Policy')).toBe('same-site');
      expect(header(r, 'X-Frame-Options')).toBe('DENY');
      const csp = String(header(r, 'Content-Security-Policy'));
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(header(r, 'X-Powered-By')).toBeUndefined();
    }
    expect(header(await t.http().get('/v1/me'), 'Cache-Control')).toBe('no-store');
  });
});

describe('session cookie of a production configuration (09 §9.3, 17 §10)', () => {
  let t: TestApp;
  const origin = 'https://app.example.test';
  beforeAll(async () => {
    t = await createTestApp({
      env: {
        APP_ENV: 'production',
        WA_MODE: 'live',
        WA_GRAPH_BASE_URL: 'https://graph.example.test',
        APP_BASE_URL: origin,
        SESSION_COOKIE_NAME: '__Host-point_sid',
        SESSION_COOKIE_SECURE: 'true',
      },
    });
  });
  afterAll(async () => t?.close());

  const login = (cookie?: string) => {
    const c = SEED_CREDENTIALS.DRV2;
    let r = t.http().post('/v1/auth/login').set({ 'X-Requested-With': 'point-web', Origin: origin });
    if (cookie) r = r.set('Cookie', cookie);
    return r.send({ phone: c.phone, secret: c.secret });
  };

  it('__Host-point_sid: HttpOnly, Secure, SameSite=Lax, Path=/, no Domain', async () => {
    const r = await login();
    expect(r.status).toBe(200);
    const set = ([] as string[]).concat(header(r, 'set-cookie') as string[]);
    expect(set).toHaveLength(1);
    const raw = set[0]!;
    expect(raw).toMatch(/^__Host-point_sid=[A-Za-z0-9_-]{43};/);
    expect(raw).toMatch(/; HttpOnly/i);
    expect(raw).toMatch(/; Secure/i);
    expect(raw).toMatch(/; SameSite=Lax/i);
    expect(raw).toMatch(/; Path=\//);
    expect(raw).not.toMatch(/Domain=/i);
  });

  it('session fixation: a planted cookie is never adopted; each login issues a new token', async () => {
    const planted = '__Host-point_sid=attacker-chosen-value-attacker-chosen-value-x';
    const r1 = await login(planted);
    const r2 = await login(planted);
    const token = (r: typeof r1) =>
      ([] as string[]).concat(header(r, 'set-cookie') as string[])[0]!.split(';')[0]!;
    expect(token(r1)).not.toBe(planted);
    expect(token(r1)).not.toBe(token(r2));
    expect((await t.http().get('/v1/me').set('Cookie', planted)).status).toBe(401);
    expect((await t.http().get('/v1/me').set('Cookie', token(r1))).status).toBe(200);
    expect((await t.http().get('/v1/me').set('Cookie', token(r2))).status).toBe(200);
  });

  it('the cookie of another name (local point_sid) is not a session in production', async () => {
    const ok = ([] as string[]).concat(header(await login(), 'set-cookie') as string[])[0]!.split(';')[0]!;
    const value = ok.split('=')[1]!;
    expect((await t.http().get('/v1/me').set('Cookie', `point_sid=${value}`)).status).toBe(401);
  });
});

describe('webhook replay window (12 §6, 17 §10 «إعادة جسم قديم … بلا أثر»)', () => {
  let w: WaTestApp;
  beforeAll(async () => {
    w = await createWaTestApp();
  });
  afterAll(async () => w?.close());

  const sign = (raw: string) =>
    `sha256=${createHmac('sha256', WA_TEST_SECRETS.WA_APP_SECRET).update(raw).digest('hex')}`;
  const envelope = (wamid: string, spacing = '') =>
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'SIM-WABA',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '966500000000', phone_number_id: 'SIM-PHONE' },
                contacts: [{ profile: { name: 'x' }, wa_id: '966551230000' }],
                messages: [
                  {
                    from: '966551230000',
                    id: wamid,
                    timestamp: String(w.ts()),
                    type: 'text',
                    text: { body: 'hi' },
                  },
                ],
              },
            },
          ],
        },
      ],
    }) + spacing;
  const post = (raw: string) =>
    w
      .http()
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(raw))
      .send(raw);
  const count = async (sql: string, params: unknown[]) => Number((await w.db.query(sql, params)).rows[0].n);

  it('a correctly signed delivery replayed days later is acknowledged and changes nothing, even after its raw body was purged', async () => {
    const wamid = `wamid.replay.${Date.now()}`;
    const raw = envelope(wamid);
    expect((await post(raw)).status).toBe(200);
    await w.drain();
    const messages = () =>
      count(`SELECT count(*)::int AS n FROM whatsapp_messages WHERE wa_message_id = $1`, [wamid]);
    const inbound = () => count(`SELECT count(*)::int AS n FROM whatsapp_inbound_events`, []);
    const jobs = () =>
      count(`SELECT count(*)::int AS n FROM outbox_events WHERE type = 'job.wa_process_inbound'`, []);
    expect(await messages()).toBe(1);
    const [inbound0, jobs0] = [await inbound(), await jobs()];

    // Meta redelivers for up to 7 days (12 F-08): the identical body is deduplicated by body_sha256
    w.clock.advanceSeconds(6 * 24 * 3600);
    expect((await post(raw)).status).toBe(200);
    expect(await inbound()).toBe(inbound0);
    expect(await jobs()).toBe(jobs0);

    // retention.wa_raw_days clears raw_body but keeps body_sha256: still a duplicate
    await w.db.query(`UPDATE whatsapp_inbound_events SET raw_body = '' WHERE raw_body LIKE $1`, [
      `%${wamid}%`,
    ]);
    expect((await post(raw)).status).toBe(200);
    expect(await inbound()).toBe(inbound0);

    // the same message in another envelope (new body hash) is stored but processed as a duplicate (wa_message_id)
    expect((await post(envelope(wamid, ' '))).status).toBe(200);
    expect(await inbound()).toBe(inbound0 + 1);
    await w.drain();
    expect(await messages()).toBe(1);
  });
});
