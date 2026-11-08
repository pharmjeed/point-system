import { createHash } from 'node:crypto';
import { SEED_CREDENTIALS, SEED_IDS } from '@point/db/seed';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF, createTestApp, newKey, type TestApp } from './harness.js';

const cookieOf = (res: { headers: Record<string, any> }) => {
  const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const c = set.find((x) => x.startsWith('point_sid='));
  return c ? c.split(';')[0]! : null;
};

const DEFAULTS = {
  security: {
    supervisor_mfa_required: false, // the harness turns supervisor MFA off for the seeded org
    driver_session_hours: 14,
    staff_session_hours: 12,
    max_login_attempts: 5,
    admin_idle_minutes: 30,
    reveal_phone_per_hour: 20,
  },
  heartbeat: { interval_s: 15, uncertain_after_s: 45, offline_after_s: 120 },
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** PNT-091 (org-settings half): GET/PUT /v1/admin/org-settings — owner only (DEC-39), canon §12 bounds. */
describe('organization settings', () => {
  let t: TestApp;
  let listener: pg.Client;
  const notes: { rooms: string[]; message: { event: string; data: Record<string, unknown> } }[] = [];
  beforeAll(async () => {
    t = await createTestApp();
    listener = new pg.Client({ connectionString: t.tdb.url });
    await listener.connect();
    listener.on('notification', (n) => {
      if (n.channel === 'point_realtime' && n.payload) notes.push(JSON.parse(n.payload));
    });
    await listener.query('LISTEN point_realtime');
  });
  afterAll(async () => {
    await listener.end();
    await t.close();
  });

  const put = (body: unknown, key = newKey()) =>
    t.command('put', '/v1/admin/org-settings', { as: 'OWN1', body, key });
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it('admin and supervisors are refused (PERMISSION_DENIED); the owner reads the editable settings', async () => {
    for (const who of ['ADM1', 'SUP-R', 'SUP-RD', 'DRV1'] as const) {
      expect((await t.get('/v1/admin/org-settings', who)).body.error.code).toBe('PERMISSION_DENIED');
      expect(
        (await t.command('put', '/v1/admin/org-settings', { as: who, body: DEFAULTS })).body.error.code,
      ).toBe('PERMISSION_DENIED');
    }
    const r = await t.get('/v1/admin/org-settings', 'OWN1');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject(DEFAULTS);
    expect(r.body.data.security).not.toHaveProperty('pin_length');
    expect(typeof r.body.data.updated_at).toBe('string');
  });

  it('rejects out-of-bounds values, unknown keys (pin_length included), missing keys and a bad heartbeat order', async () => {
    const cases: [string, (b: any) => void, string][] = [
      [
        'session hours below 1',
        (b) => (b.security.driver_session_hours = 0),
        'security.driver_session_hours',
      ],
      [
        'max_login_attempts below 3',
        (b) => (b.security.max_login_attempts = 2),
        'security.max_login_attempts',
      ],
      ['pin_length is fixed', (b) => (b.security.pin_length = 8), 'security.pin_length'],
      ['unknown section', (b) => (b.retention = { photos_days: 1 }), 'retention'],
      ['missing key', (b) => delete b.heartbeat.offline_after_s, 'heartbeat.offline_after_s'],
      ['interval ≥ uncertain', (b) => (b.heartbeat.interval_s = 50), 'heartbeat'],
      ['uncertain ≥ offline', (b) => (b.heartbeat.uncertain_after_s = 130), 'heartbeat'],
    ];
    for (const [name, mutate, field] of cases) {
      const body = clone(DEFAULTS);
      mutate(body);
      const r = await put(body);
      expect(r.status, name).toBe(422);
      expect(r.body.error.code, name).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(r.body.error.details.fields), name).toContain(field);
    }
  });

  it('a new session length applies to new sign-ins only; the change is audited before/after', async () => {
    const c = SEED_CREDENTIALS.DRV1;
    const before = await t.http().post('/v1/auth/login').set(CSRF).send({ phone: c.phone, secret: c.secret });
    expect(before.status).toBe(200);
    const oldCookie = cookieOf(before)!;
    // the session row of a sign-in, found by its cookie token (stored as sha256 hex only)
    const expiryOf = async (cookie: string) =>
      (
        await t.db.query<{ expires_at: Date }>(`SELECT expires_at FROM auth_sessions WHERE token_hash = $1`, [
          createHash('sha256').update(cookie.split('=')[1]!).digest('hex'),
        ])
      ).rows[0]!.expires_at.getTime();
    const now = t.clock.now().getTime();
    expect(await expiryOf(oldCookie)).toBe(now + 14 * 3600_000);

    const body = clone(DEFAULTS);
    body.security.driver_session_hours = 2;
    const r = await put(body);
    expect(r.status).toBe(200);
    expect(r.body.data.security.driver_session_hours).toBe(2);
    expect(r.body.data.updated_at).toBe(t.clock.now().toISOString());

    // the existing session keeps its expiry and still works
    expect(await expiryOf(oldCookie)).toBe(now + 14 * 3600_000);
    expect((await t.http().get('/v1/me').set('Cookie', oldCookie)).status).toBe(200);

    t.clock.advance(1000);
    const after = await t.http().post('/v1/auth/login').set(CSRF).send({ phone: c.phone, secret: c.secret });
    expect(after.status).toBe(200);
    expect(await expiryOf(cookieOf(after)!)).toBe(t.clock.now().getTime() + 2 * 3600_000);

    const audit = await t.db.query(
      `SELECT action, entity_type, before, after FROM audit_log WHERE action = 'org.settings_manage' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0]).toMatchObject({
      action: 'org.settings_manage',
      entity_type: 'organization',
      before: { security: { driver_session_hours: 14 } },
      after: { security: { driver_session_hours: 2 } },
    });
  });

  it('other sections and the fixed pin_length are kept', async () => {
    const stored = (await t.db.query(`SELECT settings FROM organizations WHERE id = $1`, [SEED_IDS.org]))
      .rows[0].settings;
    expect(stored.security.pin_length).toBe(6);
    expect(stored.retention).toBeDefined();
    expect(stored.ops).toBeDefined();
  });

  it('a heartbeat change asks every active user to resync (sync.required); a security-only change does not', async () => {
    notes.length = 0;
    const security = clone(DEFAULTS);
    security.security.driver_session_hours = 3;
    expect((await put(security)).status).toBe(200);
    await settle();
    expect(notes.filter((n) => n.message.event === 'sync.required')).toEqual([]);

    const hb = clone(security);
    hb.heartbeat = { interval_s: 10, uncertain_after_s: 40, offline_after_s: 100 };
    const r = await put(hb);
    expect(r.status).toBe(200);
    expect(r.body.data.heartbeat).toEqual(hb.heartbeat);
    await settle();
    const sync = notes.filter((n) => n.message.event === 'sync.required');
    const targeted = sync.flatMap((n) => n.rooms);
    expect(targeted).toContain(`user:${SEED_IDS.users.DRV1}`);
    expect(targeted).toContain(`user:${SEED_IDS.users['SUP-R']}`);
    expect(sync[0]!.message.data).toMatchObject({ reason: 'settings_changed' });
    // devices read the new timings from /v1/me
    const me = await t.get('/v1/me', 'DRV2');
    expect(me.body.data.heartbeat).toEqual(hb.heartbeat);
  });

  it('the same body again is a no-op (no version bump, audited as noop); a retried key replays', async () => {
    const current = (await t.get('/v1/admin/org-settings', 'OWN1')).body.data;
    notes.length = 0;
    t.clock.advance(5000);
    const key = newKey();
    const r = await put({ security: current.security, heartbeat: current.heartbeat }, key);
    expect(r.status).toBe(200);
    expect(r.body.data.updated_at).toBe(current.updated_at);
    await settle();
    expect(notes.filter((n) => n.message.event === 'sync.required')).toEqual([]);
    const audit = await t.db.query(
      `SELECT metadata FROM audit_log WHERE action = 'org.settings_manage' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0].metadata).toMatchObject({ noop: true, command: 'PUT /v1/admin/org-settings' });
    const replay = await put({ security: current.security, heartbeat: current.heartbeat }, key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data).toEqual(r.body.data);
  });

  it('accepts updated_at echoed from GET and ignores it', async () => {
    const current = (await t.get('/v1/admin/org-settings', 'OWN1')).body.data;
    const r = await put({ ...current, updated_at: '2020-01-01T00:00:00.000Z' });
    expect(r.status).toBe(200);
    expect(r.body.data.updated_at).toBe(current.updated_at);
  });
});
