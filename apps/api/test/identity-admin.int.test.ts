import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF, SEED_CREDENTIALS, SEED_IDS, createTestApp, newKey, type TestApp } from './harness.js';

const U = SEED_IDS.users;

// PNT-014 (me, devices, audio test, heartbeat), PNT-015 (drivers), PNT-016 (assignments), PNT-017 (staff & scopes).
describe('identity administration', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  describe('GET /v1/me and devices (PNT-014)', () => {
    it('returns the effective permissions, brand from configuration and heartbeat settings', async () => {
      const r = await t.get('/v1/me', 'SUP-RD');
      expect(r.status).toBe(200);
      expect(r.body.data.user.can_drive).toBe(true);
      // D*: a supervisor with can_drive gains the driving permissions (canon §10)
      for (const p of [
        'duty.self',
        'ticket.intake',
        'offer.accept',
        'task.execute',
        'handover.verify',
        'payment.record',
      ]) {
        expect(r.body.data.permissions).toContain(p);
      }
      expect(r.body.data.brand).toEqual({
        staff_name_ar: 'STAFF_AR',
        staff_name_en: 'POINT',
        customer_name_ar: 'CUSTOMER_AR',
      });
      expect(r.body.data.heartbeat).toEqual({ interval_s: 15, uncertain_after_s: 45, offline_after_s: 120 });
      const sup = await t.get('/v1/me', 'SUP-R');
      expect(sup.body.data.permissions).not.toContain('ticket.intake');
      const drv = await t.get('/v1/me', 'DRV1');
      expect(drv.body.data.active_assignment.venue_id).toBe(SEED_IDS.venues.RMS);
      expect(drv.body.data.driver_state).toBe('off_duty');
    });

    it('validates the closed values and stores a Push subscription only with its three fields', async () => {
      const bad = await t.command('post', '/v1/me/devices', {
        as: 'DRV1',
        key: null,
        body: { platform: 'symbian', display_mode: 'browser', notification_permission: 'default' },
      });
      expect(bad.status).toBe(422);
      expect(bad.body.error.code).toBe('VALIDATION_FAILED');
      const d = await t.command('post', '/v1/me/devices', {
        as: 'DRV1',
        key: null,
        body: { platform: 'android', display_mode: 'standalone', notification_permission: 'default' },
      });
      expect(d.status).toBe(201);
      const id = d.body.data.id;
      const partial = await t.command('put', `/v1/me/devices/${id}`, {
        as: 'DRV1',
        key: null,
        body: { push_subscription: { endpoint: 'https://push.example/abc' } },
      });
      expect(partial.status).toBe(422);
      const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'BPk', auth: 'auth1' } };
      const ok = await t.command('put', `/v1/me/devices/${id}`, {
        as: 'DRV1',
        key: null,
        body: { notification_permission: 'granted', push_subscription: sub },
      });
      expect(ok.status).toBe(200);
      expect(ok.body.data.push_subscribed).toBe(true);
      // the same endpoint registered from another device moves (uq_devices_push_endpoint → upsert)
      const d2 = await t.command('post', '/v1/me/devices', {
        as: 'DRV1',
        key: null,
        body: { platform: 'android', display_mode: 'browser', notification_permission: 'granted' },
      });
      const moved = await t.command('put', `/v1/me/devices/${d2.body.data.id}`, {
        as: 'DRV1',
        key: null,
        body: { push_subscription: sub },
      });
      expect(moved.status).toBe(200);
      const rows = await t.db.query(`SELECT id FROM devices WHERE push_endpoint = $1`, [sub.endpoint]);
      expect(rows.rows.map((r: any) => r.id)).toEqual([d2.body.data.id]);
      // someone else's device is not found
      const foreign = await t.command('put', `/v1/me/devices/${id}`, {
        as: 'DRV2',
        key: null,
        body: { label: 'x' },
      });
      expect(foreign.body.error.code).toBe('RESOURCE_NOT_FOUND');
      const audio = await t.command('post', '/v1/me/audio-test', {
        as: 'DRV1',
        key: null,
        body: { device_id: id, result: 'heard' },
      });
      expect(audio.body.data.audio_test_result).toBe('heard');
    });

    it('heartbeat refreshes the duty session and brings an offline driver back online', async () => {
      const none = await t.command('post', '/v1/me/heartbeat', {
        as: 'DRV2',
        key: null,
        body: { visible: true, audio_unlocked: true, ws_connected: false },
      });
      expect(none.body.data).toMatchObject({ connection_state: null, sync_required: false });
      await t.db.query(
        `INSERT INTO duty_sessions (org_id, user_id, shift_id, venue_id, dispatch_pool_id, assignment_id, status, connection_state, available_since, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'on_duty', 'offline', now(), now())`,
        [
          SEED_IDS.org,
          U.DRV2,
          SEED_IDS.shifts['SHF-R'],
          SEED_IDS.venues.RMS,
          SEED_IDS.pools['POOL-R'],
          SEED_IDS.assignments.DRV2,
        ],
      );
      const r = await t.command('post', '/v1/me/heartbeat', {
        as: 'DRV2',
        key: null,
        body: { visible: true, audio_unlocked: true, ws_connected: false },
      });
      expect(r.body.data).toMatchObject({ connection_state: 'online', sync_required: true });
      const ev = await t.db.query(
        `SELECT count(*)::int AS n FROM outbox_events WHERE type = 'driver.connection_changed'`,
      );
      expect(ev.rows[0].n).toBe(1);
      await t.db.query(
        `UPDATE duty_sessions SET status = 'ended', ended_at = now(), end_reason = 'self', available_since = NULL WHERE user_id = $1`,
        [U.DRV2],
      );
    });
  });

  describe('drivers (PNT-015)', () => {
    let created: any;
    it('creates a permanent account with a temporary PIN and must_change_secret', async () => {
      const r = await t.command('post', '/v1/drivers', {
        as: 'ADM1',
        body: { full_name: 'سائق جديد', phone: '0551112233' },
      });
      expect(r.status).toBe(201);
      created = r.body.data;
      expect(created.temporary_secret).toMatch(/^[0-9]{6}$/);
      expect(created.driver).toMatchObject({
        role: 'driver',
        must_change_secret: true,
        status: 'active',
        employee_code: 'D-0009',
      });
      const login = await t
        .http()
        .post('/v1/auth/login')
        .set(CSRF)
        .send({ phone: '0551112233', secret: created.temporary_secret });
      expect(login.body.data.must_change_secret).toBe(true);
    });

    it('rejects an invalid or duplicate phone and supervisors cannot manage drivers', async () => {
      expect(
        (await t.command('post', '/v1/drivers', { as: 'ADM1', body: { full_name: 'x', phone: '12' } })).body
          .error.code,
      ).toBe('PHONE_INVALID');
      const dup = await t.command('post', '/v1/drivers', {
        as: 'ADM1',
        body: { full_name: 'x', phone: SEED_CREDENTIALS.DRV1.phone },
      });
      expect(dup.body.error.code).toBe('VALIDATION_FAILED');
      expect(dup.body.error.details.fields[0].field).toBe('phone');
      expect(
        (
          await t.command('post', '/v1/drivers', {
            as: 'SUP-R',
            body: { full_name: 'x', phone: '0551112299' },
          })
        ).body.error.code,
      ).toBe('PERMISSION_DENIED');
    });

    it('disable is blocked by custody (CUSTODY_OPEN with items) and needs a reason', async () => {
      await t.db.query(
        `INSERT INTO tickets (id, org_id, venue_id, event_id, dispatch_pool_id, display_number, status, created_by, vehicle_holder_type, vehicle_holder_id)
         VALUES ('00000000-0000-4000-8000-00ff00000001', $1, $2, $3, $4, 900, 'parking', $5, 'driver', $5)`,
        [SEED_IDS.org, SEED_IDS.venues.RMS, SEED_IDS.events['EVT-R1'], SEED_IDS.pools['POOL-R'], U.DRV3],
      );
      const noReason = await t.command('post', `/v1/drivers/${U.DRV3}/disable`, { as: 'ADM1', body: {} });
      expect(noReason.body.error.code).toBe('REASON_REQUIRED');
      const blocked = await t.command('post', `/v1/drivers/${U.DRV3}/disable`, {
        as: 'ADM1',
        body: { reason: 'إيقاف مؤقت' },
      });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('CUSTODY_OPEN');
      expect(blocked.body.error.details.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'vehicle', ticket_id: '00000000-0000-4000-8000-00ff00000001' }),
        ]),
      );
      await t.db.query(
        `UPDATE tickets SET status = 'voided', voided_at = now(), voided_by = $1, void_reason = 'test', vehicle_holder_type = 'customer', vehicle_holder_id = NULL WHERE id = '00000000-0000-4000-8000-00ff00000001'`,
        [U['SUP-R']],
      );
    });

    it('disable revokes sessions (disabled), publishes session.revoked and keeps the record; enable reverses it', async () => {
      const cookie = await t.sessionFor('DRV3');
      const listener = new pg.Client({ connectionString: t.tdb.url });
      await listener.connect();
      const notes: string[] = [];
      listener.on('notification', (n) => n.payload && notes.push(n.payload));
      await listener.query('LISTEN point_realtime');
      try {
        const r = await t.command('post', `/v1/drivers/${U.DRV3}/disable`, {
          as: 'ADM1',
          body: { reason: 'إيقاف مؤقت' },
        });
        expect(r.status).toBe(200);
        expect(r.body.data.status).toBe('disabled');
        await new Promise((res) => setTimeout(res, 100));
        expect(notes.some((n) => n.includes('session.revoked') && n.includes(`user:${U.DRV3}`))).toBe(true);
      } finally {
        await listener.end();
      }
      const after = await t.http().get('/v1/me').set('Cookie', cookie);
      expect(after.body.error).toMatchObject({
        code: 'AUTH_SESSION_REVOKED',
        details: { reason: 'disabled' },
      });
      const login = await t
        .http()
        .post('/v1/auth/login')
        .set(CSRF)
        .send({ phone: SEED_CREDENTIALS.DRV3.phone, secret: SEED_CREDENTIALS.DRV3.secret });
      expect(login.body.error.code).toBe('AUTH_ACCOUNT_DISABLED');
      expect(
        (await t.command('post', `/v1/drivers/${U.DRV3}/disable`, { as: 'ADM1', body: { reason: 'again' } }))
          .body.error.code,
      ).toBe('INVALID_STATE_TRANSITION');
      expect(
        (await t.command('post', `/v1/drivers/${U.DRV3}/reset-secret`, { as: 'ADM1' })).body.error.code,
      ).toBe('DRIVER_DISABLED');
      const history = await t.get(`/v1/drivers/${U.DRV3}`, 'ADM1');
      expect(history.status).toBe(200); // no hard delete
      const en = await t.command('post', `/v1/drivers/${U.DRV3}/enable`, { as: 'ADM1' });
      expect(en.body.data.status).toBe('active');
      expect((await t.command('post', `/v1/drivers/${U.DRV3}/enable`, { as: 'ADM1' })).body.error.code).toBe(
        'INVALID_STATE_TRANSITION',
      );
    });

    it('reset-secret issues a new temporary PIN and revokes sessions (secret_reset)', async () => {
      const cookie = await t.sessionFor('DRV4');
      const r = await t.command('post', `/v1/drivers/${U.DRV4}/reset-secret`, { as: 'ADM1' });
      expect(r.body.data.temporary_secret).toMatch(/^[0-9]{6}$/);
      expect((await t.http().get('/v1/me').set('Cookie', cookie)).body.error.details.reason).toBe(
        'secret_reset',
      );
    });

    it('PATCH needs expected_version (VERSION_CONFLICT on a stale one)', async () => {
      const cur = await t.get(`/v1/drivers/${U.DRV5}`, 'ADM1');
      const v = cur.body.data.user.version;
      const ok = await t.command('patch', `/v1/drivers/${U.DRV5}`, {
        as: 'ADM1',
        body: { expected_version: v, full_name: 'اسم جديد' },
      });
      expect(ok.body.data.full_name).toBe('اسم جديد');
      const stale = await t.command('patch', `/v1/drivers/${U.DRV5}`, {
        as: 'ADM1',
        body: { expected_version: v, full_name: 'آخر' },
      });
      expect(stale.body.error).toMatchObject({
        code: 'VERSION_CONFLICT',
        details: { current_version: v + 1 },
      });
    });

    it('a supervisor lists only the drivers of his venues; LYL is out of scope', async () => {
      const list = await t.get('/v1/drivers?limit=200', 'SUP-R');
      const ids = list.body.data.map((d: any) => d.user.id);
      expect(ids).toEqual(expect.arrayContaining([U.DRV1, U.DRV6]));
      expect(ids).not.toContain(U.DRV7);
      expect(list.body.data[0].user.phone_e164).toBeNull(); // masked for supervisors
      expect((await t.get(`/v1/drivers/${U.DRV7}`, 'SUP-R')).body.error.code).toBe('SCOPE_VENUE_DENIED');
      expect((await t.get(`/v1/drivers?venue_id=${SEED_IDS.venues.LYL}`, 'SUP-R')).body.error.code).toBe(
        'SCOPE_VENUE_DENIED',
      );
      const page = await t.get('/v1/drivers?limit=2', 'ADM1');
      expect(page.body.data).toHaveLength(2);
      expect(page.body.meta.next_cursor).toBeTruthy();
      expect((await t.get('/v1/drivers?cursor=garbage', 'ADM1')).body.error.code).toBe(
        'PAGINATION_CURSOR_INVALID',
      );
    });
  });

  describe('assignments (PNT-016)', () => {
    it('a second active assignment is ASSIGNMENT_CONFLICT; supervisors assign inside their scope only; audited', async () => {
      const conflict = await t.command('post', `/v1/drivers/${U.DRV1}/assignments`, {
        as: 'ADM1',
        body: { venue_id: SEED_IDS.venues.LYL },
      });
      expect(conflict.body.error.code).toBe('ASSIGNMENT_CONFLICT');
      const fresh = await t.command('post', '/v1/drivers', {
        as: 'ADM1',
        body: { full_name: 'سائق بلا تعيين', phone: '0551112244' },
      });
      const id = fresh.body.data.driver.id;
      const out = await t.command('post', `/v1/drivers/${id}/assignments`, {
        as: 'SUP-R',
        body: { venue_id: SEED_IDS.venues.LYL },
      });
      expect(out.body.error.code).toBe('SCOPE_VENUE_DENIED');
      const ok = await t.command('post', `/v1/drivers/${id}/assignments`, {
        as: 'SUP-R',
        body: { venue_id: SEED_IDS.venues.RMS, reason: 'تعيين أول' },
      });
      expect(ok.status).toBe(201);
      expect(ok.body.data).toMatchObject({ status: 'active', venue_id: SEED_IDS.venues.RMS });
      const a = await t.db.query(
        `SELECT count(*)::int AS n FROM audit_log WHERE action = 'driver.assign' AND entity_id = $1`,
        [ok.body.data.id],
      );
      expect(a.rows[0].n).toBe(1);
      const list = await t.get(`/v1/drivers/${id}/assignments`, 'SUP-R');
      expect(list.body.data.assignments).toHaveLength(1);
    });
  });

  describe('staff and scopes (PNT-017)', () => {
    it('an admin cannot create an admin; can_drive is for supervisors only', async () => {
      expect(
        (
          await t.command('post', '/v1/staff', {
            as: 'ADM1',
            body: { full_name: 'مدير', phone: '0551113300', role: 'admin' },
          })
        ).body.error.code,
      ).toBe('PERMISSION_DENIED');
      const cd = await t.command('post', '/v1/staff', {
        as: 'OWN1',
        body: { full_name: 'مدير', phone: '0551113301', role: 'admin', can_drive: true },
      });
      expect(cd.body.error.code).toBe('VALIDATION_FAILED');
      const admin = await t.command('post', '/v1/staff', {
        as: 'OWN1',
        body: { full_name: 'مدير ثانٍ', phone: '0551113302', role: 'admin' },
      });
      expect(admin.status).toBe(201);
      expect(admin.body.data.temporary_secret.length).toBeGreaterThanOrEqual(12);
    });

    it('creates a supervisor with venue scopes; grant and revoke are audited', async () => {
      const r = await t.command('post', '/v1/staff', {
        as: 'ADM1',
        body: {
          full_name: 'مشرف',
          phone: '0551113303',
          role: 'supervisor',
          can_drive: true,
          venue_ids: [SEED_IDS.venues.RMS],
        },
      });
      expect(r.status).toBe(201);
      const id = r.body.data.user.id;
      const g = await t.command('post', `/v1/staff/${id}/scopes`, {
        as: 'ADM1',
        body: { grant_venue_ids: [SEED_IDS.venues.LYL] },
      });
      expect(g.body.data.map((s: any) => s.venue_id).sort()).toEqual(
        [SEED_IDS.venues.RMS, SEED_IDS.venues.LYL].sort(),
      );
      const again = await t.command('post', `/v1/staff/${id}/scopes`, {
        as: 'ADM1',
        body: { grant_venue_ids: [SEED_IDS.venues.LYL] },
      });
      expect(again.body.data).toHaveLength(2); // idempotent grant
      const rv = await t.command('post', `/v1/staff/${id}/scopes`, {
        as: 'ADM1',
        body: { revoke_venue_ids: [SEED_IDS.venues.RMS] },
      });
      expect(rv.body.data.map((s: any) => s.venue_id)).toEqual([SEED_IDS.venues.LYL]);
      const a = await t.db.query(
        `SELECT count(*)::int AS n FROM audit_log WHERE action = 'staff.manage' AND entity_id = $1`,
        [id],
      );
      expect(a.rows[0].n).toBe(4);
      const list = await t.get('/v1/staff', 'ADM1');
      expect(list.body.data.every((x: any) => x.user.role === 'supervisor')).toBe(true);
    });

    it('reset-mfa: owner only, reason required; clears MFA and revokes the sessions (admin)', async () => {
      expect(
        (
          await t.command('post', `/v1/staff/${U.ADM1}/reset-mfa`, {
            as: 'ADM1',
            body: { reason: 'lost phone' },
          })
        ).body.error.code,
      ).toBe('PERMISSION_DENIED');
      expect(
        (await t.command('post', `/v1/staff/${U.ADM1}/reset-mfa`, { as: 'OWN1', body: {} })).body.error.code,
      ).toBe('REASON_REQUIRED');
      const cookie = await t.sessionFor('ADM1');
      const r = await t.command('post', `/v1/staff/${U.ADM1}/reset-mfa`, {
        as: 'OWN1',
        body: { reason: 'فقد الجوال' },
      });
      expect(r.status).toBe(200);
      expect(r.body.data.mfa_enabled).toBe(false);
      expect((await t.http().get('/v1/me').set('Cookie', cookie)).body.error.details.reason).toBe('admin');
      const login = await t
        .http()
        .post('/v1/auth/login')
        .set(CSRF)
        .send({ phone: SEED_CREDENTIALS.ADM1.phone, secret: SEED_CREDENTIALS.ADM1.secret });
      expect(login.body.data.mfa_setup_required).toBe(true);
      // a driver has no MFA to reset
      expect(
        (await t.command('post', `/v1/staff/${U.DRV1}/reset-mfa`, { as: 'OWN1', body: { reason: 'x y z' } }))
          .body.error.code,
      ).toBe('INVALID_STATE_TRANSITION');
    });

    it('disabling a staff member needs a reason (PATCH status)', async () => {
      const cur = await t.get('/v1/staff', 'OWN1');
      const sup = cur.body.data.find((x: any) => x.user.id === U['SUP-RL']).user;
      // ADM1's sessions were revoked by the reset-mfa test above: the owner acts from here on
      const r = await t.command('patch', `/v1/staff/${U['SUP-RL']}`, {
        as: 'OWN1',
        body: { expected_version: sup.version, status: 'disabled' },
      });
      expect(r.body.error.code).toBe('REASON_REQUIRED');
      const ok = await t.command('patch', `/v1/staff/${U['SUP-RL']}`, {
        as: 'OWN1',
        body: { expected_version: sup.version, status: 'disabled', reason: 'انتهاء العقد' },
      });
      expect(ok.body.data.status).toBe('disabled');
    });

    it('commands replay with the same Idempotency-Key', async () => {
      const key = newKey();
      const a = await t.command('post', '/v1/drivers', {
        as: 'OWN1',
        key,
        body: { full_name: 'مكرر', phone: '0551113399' },
      });
      const b = await t.command('post', '/v1/drivers', {
        as: 'OWN1',
        key,
        body: { full_name: 'مكرر', phone: '0551113399' },
      });
      expect(b.headers['idempotent-replayed']).toBe('true');
      expect(b.body.data.driver.id).toBe(a.body.data.driver.id);
    });
  });
});
