import pg from 'pg';
import { isOperatorActive, sha256Hex } from '@point/server';
import type { PlatformRole } from '@point/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EVT_R1,
  completeParking,
  newDraft,
  nextSlot,
  nextSpot,
  ok,
  paperTicketInParking,
  startDuty,
  startIntake,
} from './dispatch-fixtures.js';
import { CSRF, SEED_CREDENTIALS, SEED_IDS, createTestApp, newKey, type TestApp } from './harness.js';

const ORG = SEED_IDS.org;
const RMS = SEED_IDS.venues.RMS;
const ROLES: PlatformRole[] = ['platform_owner', 'platform_admin', 'platform_finance', 'platform_support'];

/**
 * V2-005 (docs/v2/02 §4, DEC-486, DEC-487): a suspended or terminated operator starts nothing new — event open,
 * shift open, duty start, ticket intake answer 409 OPERATOR_SUSPENDED — while work already in progress completes and
 * the staff still sign in and read; `/v1/me` carries the status, the staff devices are told to re-read it, the
 * public-listing helper follows it, a staff command and a suspension serialize, and termination is final.
 */
describe('operator suspension on the server (V2-005)', () => {
  let t: TestApp;
  const cookies = {} as Record<PlatformRole, string>;
  const ids = {} as Record<PlatformRole, string>;

  beforeAll(async () => {
    t = await createTestApp();
    for (const [i, role] of ROLES.entries()) {
      const u = await t.db.query<{ id: string }>(
        `INSERT INTO platform_users (phone_e164, full_name, role, secret_hash, must_change_secret, mfa_enabled, mfa_secret_enc)
         VALUES ($1, $2, $3, 'x', false, true, 'x') RETURNING id`,
        [`+96655999000${i}`, `حساب ${role}`, role],
      );
      ids[role] = u.rows[0]!.id;
      const token = `platform-operators-test-session-${role}-0123456789`;
      await t.db.query(
        `INSERT INTO platform_sessions (platform_user_id, token_hash, mfa_verified, created_at, last_seen_at, expires_at)
         VALUES ($1, $2, true, $3, $3, $3::timestamptz + interval '400 days')`,
        [ids[role], sha256Hex(token), t.clock.now()],
      );
      cookies[role] = `${t.env.PLATFORM_SESSION_COOKIE_NAME}=${token}`;
    }
  });
  afterAll(async () => t?.close());

  /** keep the platform sessions alive across the clock jumps below (idle 30 minutes) */
  const touch = () => t.db.query(`UPDATE platform_sessions SET last_seen_at = $1`, [t.clock.now()]);
  const post = async (path: string, role: PlatformRole, body: object = {}, key: string | null = newKey()) => {
    await touch();
    let r = t.http().post(path).set(CSRF).set('Cookie', cookies[role]);
    if (key) r = r.set('Idempotency-Key', key);
    return r.send(body);
  };
  const orgAudit = (orgId: string, action: string) =>
    t.db.query(
      `SELECT actor_type, actor_id, reason, metadata FROM audit_log WHERE org_id = $1 AND action = $2 ORDER BY id`,
      [orgId, action],
    );
  const platformLog = (orgId: string, action: string) =>
    t.db.query(
      `SELECT actor_id, actor_role, reason, metadata FROM platform_audit_log WHERE org_id = $1 AND action = $2 ORDER BY id`,
      [orgId, action],
    );

  it('suspension on the server: no new event, shift, duty or intake; work in progress completes; staff still read', async () => {
    // before the suspension: DRV1 on duty with a draft, DRV3 with a ticket in parking at RMS
    ok(await startDuty(t, 'DRV1'), 201);
    ok(await startDuty(t, 'DRV3'), 201);
    const draft = await newDraft(t, 'DRV1');
    const inParking = await paperTicketInParking(t, 'DRV3');
    const event = ok(
      await t.command('post', `/v1/venues/${RMS}/events`, {
        as: 'SUP-R',
        body: { name_ar: 'حفل بعد التعليق', event_date: '2026-10-30', pricing_mode: 'included' },
      }),
      201,
    );
    const shift = ok(
      await t.command('post', `/v1/venues/${RMS}/shifts`, {
        as: 'SUP-R',
        body: { name: 'وردية الخميس', starts_at: '2026-10-29T15:00:00Z' },
      }),
      201,
    );
    expect(await isOperatorActive(t.db, ORG)).toBe(true);

    // the staff devices are told to re-read /v1/me
    const listener = new pg.Client({ connectionString: t.tdb.url });
    await listener.connect();
    const frames: string[] = [];
    listener.on('notification', (n) => frames.push(n.payload ?? ''));
    await listener.query('LISTEN point_realtime');
    const s = await post(`/v1/platform/operators/${ORG}/suspend`, 'platform_owner', {
      reason: 'مخالفة تشغيلية',
    });
    expect(s.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    await listener.end();
    const syncs = frames.map((f) => JSON.parse(f)).filter((f) => f.message.event === 'sync.required');
    expect(syncs.length).toBeGreaterThan(0);
    expect(syncs[0].message.data).toEqual({ reason: 'operator_status_changed', scope: 'me' });
    expect(syncs.flatMap((f) => f.rooms)).toContain(`user:${SEED_IDS.users.DRV2}`);
    expect(await isOperatorActive(t.db, ORG)).toBe(false);

    const refused = (r: { status: number; body: any }, what: string) => {
      expect(r.status, what).toBe(409);
      expect(r.body.error, what).toMatchObject({
        code: 'OPERATOR_SUSPENDED',
        details: { operator_status: 'suspended' },
      });
    };
    refused(await t.command('post', `/v1/events/${event.id}/open`, { as: 'SUP-R', body: {} }), 'event open');
    refused(await t.command('post', `/v1/shifts/${shift.id}/open`, { as: 'SUP-R', body: {} }), 'shift open');
    refused(await startDuty(t, 'DRV2'), 'duty start');
    refused(await startIntake(t, 'DRV3', { event_id: EVT_R1 }), 'intake');
    // refusals leave nothing behind
    expect((await t.db.query(`SELECT status FROM events WHERE id = $1`, [event.id])).rows[0].status).toBe(
      'draft',
    );
    expect(
      (
        await t.db.query(`SELECT count(*)::int AS n FROM duty_sessions WHERE user_id = $1`, [
          SEED_IDS.users.DRV2,
        ])
      ).rows[0].n,
    ).toBe(0);

    // tickets already in progress complete normally
    const parked = await completeParking(t, 'DRV3', inParking.taskId, {
      parking_spot_id: nextSpot(),
      key_slot_id: nextSlot(),
    });
    expect(parked.status).toBe(200);
    expect(parked.body.data.ticket.status).toBe('parked');
    const patch = await t.command('patch', `/v1/tickets/${draft.ticketId}/intake`, {
      as: 'DRV1',
      body: { expected_version: draft.version, plate: { digits: '4321', letters_ar: 'ب ح د' } },
    });
    expect(patch.status).toBe(200);

    // staff still sign in and read; /v1/me carries the status for the banner
    const c = SEED_CREDENTIALS['SUP-R'];
    const login = await t.http().post('/v1/auth/login').set(CSRF).send({ phone: c.phone, secret: c.secret });
    expect(login.status).toBe(200);
    const me = await t.get('/v1/me', 'SUP-R');
    expect(me.body.data.organization).toEqual({
      id: ORG,
      name_ar: expect.any(String),
      operator_status: 'suspended',
    });
    expect((await t.get(`/v1/venues/${RMS}/events`, 'SUP-R')).status).toBe(200);
    expect((await t.get(`/v1/tickets/${inParking.ticketId}`, 'SUP-R')).status).toBe(200);
    // the duty already open can still end
    expect(
      (await t.command('post', '/v1/me/duty/break', { as: 'DRV3', body: { active: true } })).status,
    ).toBe(200);

    // reactivate: the checks pass again (the shift is refused by its own rule, one open shift per pool)
    const back = await post(`/v1/platform/operators/${ORG}/reactivate`, 'platform_admin');
    expect(back.body.data.operator_status).toBe('active');
    expect((await t.command('post', `/v1/events/${event.id}/open`, { as: 'SUP-R', body: {} })).status).toBe(
      200,
    );
    expect(
      (await t.command('post', `/v1/shifts/${shift.id}/open`, { as: 'SUP-R', body: {} })).body.error.code,
    ).toBe('SHIFT_ALREADY_OPEN');
    expect((await startDuty(t, 'DRV2')).status).toBe(201);
    expect((await t.get('/v1/me', 'SUP-R')).body.data.organization.operator_status).toBe('active');
    expect((await platformLog(ORG, 'operator.reactivate')).rows).toHaveLength(1);
    expect((await orgAudit(ORG, 'operator.reactivate')).rows).toHaveLength(1);
  });

  it('a staff command and a suspension serialize on the organization row', async () => {
    // a staff transaction that passed the check (holding the row FOR SHARE) commits before the suspension does
    const c = await t.db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT operator_status FROM organizations WHERE id = $1 FOR SHARE`, [ORG]);
      let done = false;
      const suspend = post(`/v1/platform/operators/${ORG}/suspend`, 'platform_owner', {
        reason: 'اختبار التسلسل',
      }).then((r) => {
        done = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(done).toBe(false);
      await c.query('COMMIT');
      const r = await suspend;
      expect(r.body.data?.operator_status, JSON.stringify(r.body)).toBe('suspended');
    } finally {
      c.release();
    }
    expect((await post(`/v1/platform/operators/${ORG}/reactivate`, 'platform_owner')).status).toBe(200);
  });
  it('terminated: the same refusals, staff still read, and no command leaves it', async () => {
    const s = await post(`/v1/platform/operators/${ORG}/suspend`, 'platform_owner', {
      reason: 'إنهاء التعاقد',
    });
    expect(s.status).toBe(200);
    const term = await post(`/v1/platform/operators/${ORG}/terminate`, 'platform_owner', {
      reason: 'إنهاء التعاقد',
    });
    expect(term.body.data.operator_status).toBe('terminated');
    const refusedAs = (r: { status: number; body: any }) => {
      expect(r.status).toBe(409);
      expect(r.body.error).toMatchObject({
        code: 'OPERATOR_SUSPENDED',
        details: { operator_status: 'terminated' },
      });
    };
    refusedAs(
      await t.command('post', `/v1/events/${SEED_IDS.events['EVT-L1']}/open`, { as: 'SUP-RL', body: {} }),
    );
    refusedAs(
      await t.command('post', `/v1/shifts/${SEED_IDS.shifts['SHF-L']}/open`, { as: 'SUP-RL', body: {} }),
    );
    refusedAs(await startDuty(t, 'DRV7'));
    refusedAs(await startIntake(t, 'DRV2', { event_id: EVT_R1 }));
    expect((await t.get('/v1/me', 'OWN1')).body.data.organization.operator_status).toBe('terminated');
    expect((await t.get(`/v1/venues/${RMS}/events`, 'SUP-R')).status).toBe(200);
    for (const cmd of ['activate', 'reactivate', 'suspend', 'terminate']) {
      const r = await post(`/v1/platform/operators/${ORG}/${cmd}`, 'platform_owner', {
        reason: 'محاولة أخرى',
      });
      expect(r.body.error, cmd).toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        details: { current_status: 'terminated' },
      });
    }
    // nothing deleted: the operator's rows stay for the retention period
    const kept = await t.db.query(
      `SELECT (SELECT count(*)::int FROM venues WHERE org_id = $1) AS venues,
              (SELECT count(*)::int FROM users WHERE org_id = $1) AS users,
              (SELECT status FROM venues WHERE id = $2) AS rms`,
      [ORG, RMS],
    );
    expect(kept.rows[0]).toMatchObject({ venues: 2, rms: 'active' });
    expect(kept.rows[0].users).toBeGreaterThan(10);
    expect(await isOperatorActive(t.db, ORG)).toBe(false);
    expect((await platformLog(ORG, 'operator.terminate')).rows).toEqual([
      expect.objectContaining({
        reason: 'إنهاء التعاقد',
        metadata: expect.objectContaining({ to_status: 'terminated' }),
      }),
    ]);
    expect((await orgAudit(ORG, 'operator.terminate')).rows).toHaveLength(1);
  });
});
