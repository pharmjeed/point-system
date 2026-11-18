import { SecretHasher, sha256Hex } from '@point/server';
import type { PlatformRole } from '@point/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ok } from './dispatch-fixtures.js';
import { CSRF, SEED_CREDENTIALS, SEED_IDS, createTestApp, newKey, type TestApp } from './harness.js';

const ORG = SEED_IDS.org;
const ROLES: PlatformRole[] = ['platform_owner', 'platform_admin', 'platform_finance', 'platform_support'];
const MANAGERS: PlatformRole[] = ['platform_owner', 'platform_admin'];
const OUTSIDERS: PlatformRole[] = ['platform_finance', 'platform_support'];
const PHONE_DIGITS = /9665\d{8}|05\d{8}/;

const NEW_OPERATOR = {
  name_ar: 'مشغل الشمال',
  name_en: 'North Valet',
  legal_name: 'شركة الشمال لصف السيارات',
  cr_number: '1010123456',
  vat_number: '300000000000003',
  operator_status: 'trial',
  owner: { full_name: 'مالك الشمال', phone: '0551230001' },
};

/**
 * V2-003 (P-01 … P-03, DEC-485) and the lifecycle commands of P-03 (DEC-486): the platform console routes per
 * platform role, a staff session refused, idempotency replays (the owner's temporary password never stored), audit
 * rows in platform_audit_log and the operator's audit_log. The suspension's effects on the staff commands are
 * operator-suspension.int.test.ts (V2-005).
 */
describe('platform console — operators, contracts, lifecycle commands (V2-003)', () => {
  let t: TestApp;
  const cookies = {} as Record<PlatformRole, string>;
  const ids = {} as Record<PlatformRole, string>;
  let createdOrg: string;
  let createdOwner: string;
  let ownerPassword: string;

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
  const get = async (path: string, role: PlatformRole) => {
    await touch();
    return t.http().get(path).set('Cookie', cookies[role]);
  };
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

  // --------------------------------------------------------------------------------------------- P-01

  it('P-01 overview: counts only, for every platform role; a staff session is refused', async () => {
    for (const role of ROLES) {
      const r = await get('/v1/platform/overview', role);
      expect(r.status, role).toBe(200);
      expect(r.body.data).toMatchObject({
        operators: { total: 1, by_status: { active: 1, trial: 0, suspended: 0, terminated: 0, invited: 0 } },
        venues: { total: 2, active: 2 },
        drivers_on_duty: 0,
        tickets_today: expect.any(Number),
        day: '2026-10-27',
      });
    }
    const staff = await t
      .http()
      .get('/v1/platform/overview')
      .set('Cookie', await t.sessionFor('OWN1'));
    expect(staff.status).toBe(401);
    expect(staff.body.error.code).toBe('PLATFORM_AUTH_REQUIRED');
    expect((await t.http().get('/v1/platform/overview')).body.error.code).toBe('PLATFORM_AUTH_REQUIRED');
  });

  // --------------------------------------------------------------------------------------------- P-02 / P-03 reads

  it('P-02 / P-03 reads: owner and admin only; finance and support get PERMISSION_DENIED', async () => {
    for (const role of MANAGERS) {
      const list = await get('/v1/platform/operators', role);
      expect(list.status).toBe(200);
      expect(list.body.data.items).toEqual([
        expect.objectContaining({
          id: ORG,
          operator_status: 'active',
          venues_count: 2,
          active_venues_count: 2,
          current_contract: null,
        }),
      ]);
      const detail = await get(`/v1/platform/operators/${ORG}`, role);
      expect(detail.status).toBe(200);
      expect(detail.body.data.venues.map((v: { code: string }) => v.code)).toEqual(['LYL', 'RMS']);
      expect(detail.body.data.owner).toMatchObject({
        id: SEED_IDS.users.OWN1,
        phone_masked: expect.stringContaining('•'),
      });
    }
    for (const role of OUTSIDERS) {
      for (const path of [
        '/v1/platform/operators',
        `/v1/platform/operators/${ORG}`,
        `/v1/platform/operators/${ORG}/users`,
        `/v1/platform/operators/${ORG}/contracts`,
      ]) {
        const r = await get(path, role);
        expect(r.status, `${role} ${path}`).toBe(403);
        expect(r.body.error).toMatchObject({
          code: 'PERMISSION_DENIED',
          details: { permission: 'platform.operator_read' },
        });
      }
    }
    expect((await get('/v1/platform/operators?status=bogus', 'platform_owner')).body.error.code).toBe(
      'VALIDATION_FAILED',
    );
    expect((await get('/v1/platform/operators?status=suspended', 'platform_owner')).body.data.items).toEqual(
      [],
    );
    for (const id of ['00000000-0000-4000-8000-00000000dead', 'not-a-uuid']) {
      const r = await get(`/v1/platform/operators/${id}`, 'platform_owner');
      expect(r.status).toBe(404);
      expect(r.body.error).toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
        details: { resource: 'organization' },
      });
    }
  });

  it('P-03 users: the operator staff read-only with masked phones (never a full number)', async () => {
    const r = await get(`/v1/platform/operators/${ORG}/users`, 'platform_admin');
    expect(r.status).toBe(200);
    const items = r.body.data.items as { role: string; employee_code: string; phone_masked: string }[];
    expect(items.length).toBeGreaterThan(10);
    expect(items[0]).toMatchObject({ role: 'owner' });
    expect(JSON.stringify(r.body)).not.toMatch(PHONE_DIGITS);
    expect(JSON.stringify(r.body)).not.toContain('secret');
    // no staff command under /v1/platform: the platform cannot change the operator's users
    expect((await post(`/v1/platform/operators/${ORG}/users`, 'platform_owner')).status).toBe(404);
  });

  // --------------------------------------------------------------------------------------------- P-02 create

  it('create operator: the organization and its first owner; the temporary password once, never stored', async () => {
    const key = newKey();
    const r = await post('/v1/platform/operators', 'platform_admin', NEW_OPERATOR, key);
    expect(r.status).toBe(201);
    const d = r.body.data;
    expect(d.operator).toMatchObject({
      name_ar: 'مشغل الشمال',
      legal_name: 'شركة الشمال لصف السيارات',
      cr_number: '1010123456',
      vat_number: '300000000000003',
      operator_status: 'trial',
      is_platform_operated: false,
      venues_count: 0,
      staff_count: 1,
    });
    expect(d.owner).toMatchObject({
      full_name: 'مالك الشمال',
      employee_code: 'O-0001',
      phone_masked: '05•••••001',
    });
    expect(d.temporary_password).toMatch(/^[A-Za-z0-9_-]{16}$/);
    createdOrg = d.operator.id;
    createdOwner = d.owner.id;
    ownerPassword = d.temporary_password;

    const u = (await t.db.query(`SELECT * FROM users WHERE id = $1`, [createdOwner])).rows[0];
    expect(u).toMatchObject({
      org_id: createdOrg,
      role: 'owner',
      phone_e164: '+966551230001',
      must_change_secret: true,
      mfa_enabled: false,
      status: 'active',
    });
    expect(await new SecretHasher(t.env.AUTH_SECRET_PEPPER).verify(u.secret_hash, ownerPassword)).toBe(true);
    const scope = await t.db.query(
      `SELECT scope_type FROM role_scopes WHERE user_id = $1 AND revoked_at IS NULL`,
      [createdOwner],
    );
    expect(scope.rows).toEqual([{ scope_type: 'org' }]);

    // the password is nowhere at rest: not in the stored response, the platform log or the operator's audit_log
    const stored = await t.db.query(
      `SELECT response_body::text AS body FROM platform_idempotency_keys WHERE key = $1`,
      [key],
    );
    expect(stored.rows[0].body).not.toContain(ownerPassword);
    const logs = await t.db.query(
      `SELECT (SELECT string_agg(metadata::text || coalesce(reason, ''), ' ') FROM platform_audit_log) AS p,
              (SELECT string_agg(coalesce(after::text, '') || coalesce(metadata::text, ''), ' ') FROM audit_log) AS a`,
    );
    expect(logs.rows[0].p).not.toContain(ownerPassword);
    expect(logs.rows[0].a).not.toContain(ownerPassword);

    // replay: the same answer without the password
    const replay = await post('/v1/platform/operators', 'platform_admin', NEW_OPERATOR, key);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data).toEqual({ ...d, temporary_password: null });
    expect(
      (await t.db.query(`SELECT count(*)::int AS n FROM organizations WHERE name_ar = 'مشغل الشمال'`)).rows[0]
        .n,
    ).toBe(1);

    // both logs, by the platform account
    for (const action of ['operator.create', 'owner.bootstrap']) {
      expect((await platformLog(createdOrg, action)).rows).toEqual([
        expect.objectContaining({ actor_id: ids.platform_admin, actor_role: 'platform_admin' }),
      ]);
      expect((await orgAudit(createdOrg, action)).rows).toEqual([
        expect.objectContaining({ actor_type: 'system', actor_id: `platform:${ids.platform_admin}` }),
      ]);
    }
    expect((await platformLog(createdOrg, 'operator.create')).rows[0].metadata).toMatchObject({
      from_status: null,
      to_status: 'trial',
    });

    // the owner signs in with it: a restricted first session (change the password, then MFA), like create-owner
    const login = await t
      .http()
      .post('/v1/auth/login')
      .set(CSRF)
      .send({ phone: '0551230001', secret: ownerPassword });
    expect(login.status).toBe(200);
    expect(login.body.data).toMatchObject({ must_change_secret: true, mfa_setup_required: true });
  });

  it('create operator: refusals (phone of another operator, invalid input, role, key)', async () => {
    const other = await post('/v1/platform/operators', 'platform_owner', {
      ...NEW_OPERATOR,
      name_ar: 'مشغل ثالث',
      owner: { full_name: 'مالك', phone: SEED_CREDENTIALS.OWN1.phone },
    });
    expect(other.status).toBe(422);
    expect(other.body.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: {
        fields: [expect.objectContaining({ field: 'owner.phone', issue: 'in_use_by_another_operator' })],
      },
    });
    const invalid = await post('/v1/platform/operators', 'platform_owner', {
      ...NEW_OPERATOR,
      owner: { full_name: 'مالك', phone: '12' },
    });
    expect(invalid.body.error.code).toBe('PHONE_INVALID');
    const shape = await post('/v1/platform/operators', 'platform_owner', {
      ...NEW_OPERATOR,
      cr_number: '123',
      vat_number: '100000000000001',
      operator_status: 'suspended',
    });
    expect(shape.status).toBe(422);
    expect(shape.body.error.details.fields.map((f: { field: string }) => f.field).sort()).toEqual([
      'cr_number',
      'operator_status',
      'vat_number',
    ]);
    for (const role of OUTSIDERS) {
      const r = await post('/v1/platform/operators', role, NEW_OPERATOR);
      expect(r.status).toBe(403);
      expect(r.body.error.details.permission).toBe('platform.operator_manage');
    }
    const noKey = await post('/v1/platform/operators', 'platform_owner', NEW_OPERATOR, null);
    expect(noKey.status).toBe(428);
    expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const staff = await t.command('post', '/v1/platform/operators', { as: 'OWN1', body: NEW_OPERATOR });
    expect(staff.body.error.code).toBe('PLATFORM_AUTH_REQUIRED');
    expect((await t.db.query(`SELECT count(*)::int AS n FROM organizations`)).rows[0].n).toBe(2); // nothing else was created
  });

  it("the owner's temporary password again, only before the first sign-in; never replayed", async () => {
    // the owner above signed in once (password step): reissue is refused
    const signedIn = await post(
      `/v1/platform/operators/${createdOrg}/owner/temporary-password`,
      'platform_owner',
    );
    expect(signedIn.status).toBe(409);
    expect(signedIn.body.error.details).toMatchObject({ reason: 'owner_signed_in' });

    const fresh = ok(
      await post('/v1/platform/operators', 'platform_owner', {
        ...NEW_OPERATOR,
        name_ar: 'مشغل الجنوب',
        cr_number: null,
        vat_number: null,
        operator_status: 'active',
        owner: { full_name: 'مالك الجنوب', phone: '0551230002' },
      }),
      201,
    );
    const detail = (await get(`/v1/platform/operators/${fresh.operator.id}`, 'platform_owner')).body.data;
    expect(detail.owner).toMatchObject({ temporary_password_reissuable: true, employee_code: 'O-0001' });
    const key = newKey();
    const path = `/v1/platform/operators/${fresh.operator.id}/owner/temporary-password`;
    const r = await post(path, 'platform_admin', {}, key);
    expect(r.status).toBe(200);
    expect(r.body.data.temporary_password).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(r.body.data.temporary_password).not.toBe(fresh.temporary_password);
    const replay = await post(path, 'platform_admin', {}, key);
    expect(replay.body.data).toEqual({ user_id: fresh.owner.id, temporary_password: null });
    const u = (await t.db.query(`SELECT secret_hash FROM users WHERE id = $1`, [fresh.owner.id])).rows[0];
    const hasher = new SecretHasher(t.env.AUTH_SECRET_PEPPER);
    expect(await hasher.verify(u.secret_hash, r.body.data.temporary_password)).toBe(true);
    expect(await hasher.verify(u.secret_hash, fresh.temporary_password)).toBe(false);
    expect((await orgAudit(fresh.operator.id, 'owner.temporary_password_reissue')).rows).toHaveLength(1);
    expect((await post(path, 'platform_finance')).status).toBe(403);
  });

  // --------------------------------------------------------------------------------------------- contracts

  it('contracts: create (no overlap), history, end (only earlier, never retroactive); never edited or deleted', async () => {
    const base = {
      saas_fee_halalas_per_venue: 50000,
      saas_cycle: 'monthly',
      subscriber_visit_payout_halalas: 500,
      app_payment_commission_bp: 250,
    };
    const path = `/v1/platform/operators/${ORG}/contracts`;
    const first = await post(path, 'platform_admin', {
      ...base,
      starts_on: '2026-10-01',
      ends_on: '2027-01-01',
    });
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({
      org_id: ORG,
      starts_on: '2026-10-01',
      ends_on: '2027-01-01',
      state: 'current',
      created_by: { id: ids.platform_admin, full_name: 'حساب platform_admin' },
    });
    const overlap = await post(path, 'platform_owner', { ...base, starts_on: '2026-12-01' });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.details).toMatchObject({
      reason: 'contract_overlap',
      entity_id: first.body.data.id,
    });
    const next = await post(path, 'platform_owner', {
      ...base,
      saas_cycle: 'yearly',
      starts_on: '2027-01-01',
    });
    expect(next.status).toBe(201);
    expect(next.body.data.state).toBe('upcoming');
    const bad = await post(path, 'platform_owner', {
      ...base,
      starts_on: '2028-01-01',
      ends_on: '2027-01-01',
    });
    expect(bad.body.error.details.fields[0]).toMatchObject({ field: 'ends_on' });
    expect((await post(path, 'platform_support', { ...base, starts_on: '2030-01-01' })).status).toBe(403);

    const history = await get(path, 'platform_owner');
    expect(history.body.data.items.map((c: { starts_on: string }) => c.starts_on)).toEqual([
      '2027-01-01',
      '2026-10-01',
    ]);
    const list = await get('/v1/platform/operators', 'platform_owner');
    expect(list.body.data.items.find((o: { id: string }) => o.id === ORG).current_contract.id).toBe(
      first.body.data.id,
    );

    const end = (id: string, ends_on: string, key?: string) =>
      post(`${path}/${id}/end`, 'platform_admin', { ends_on, reason: 'إعادة التفاوض' }, key ?? newKey());
    const past = await end(first.body.data.id, '2026-10-20');
    expect(past.body.error.details.fields).toEqual([
      expect.objectContaining({ field: 'ends_on', issue: 'in_the_past' }),
    ]);
    const later = await end(first.body.data.id, '2027-02-01');
    expect(later.body.error.details.fields[0].issue).toBe('not_earlier_than_current_end');
    const key = newKey();
    const ended = await end(first.body.data.id, '2026-11-15', key);
    expect(ended.status).toBe(200);
    expect(ended.body.data).toMatchObject({ ends_on: '2026-11-15', state: 'current' });
    expect((await end(first.body.data.id, '2026-11-15', key)).headers['idempotent-replayed']).toBe('true');
    expect((await platformLog(ORG, 'operator_contract.end')).rows).toEqual([
      expect.objectContaining({
        reason: 'إعادة التفاوض',
        metadata: expect.objectContaining({ ends_on_before: '2027-01-01', ends_on_after: '2026-11-15' }),
      }),
    ]);
    expect((await orgAudit(ORG, 'operator_contract.create')).rows).toHaveLength(2);
    expect((await orgAudit(ORG, 'operator_contract.end')).rows).toHaveLength(1);
    const unknown = await end('00000000-0000-4000-8000-00000000dead', '2026-12-01');
    expect(unknown.body.error).toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
      details: { resource: 'operator_contract' },
    });
    // another operator's contract through this operator's path: not found
    const foreign = await post(
      `/v1/platform/operators/${createdOrg}/contracts/${first.body.data.id}/end`,
      'platform_owner',
      { ends_on: '2026-12-01' },
    );
    expect(foreign.status).toBe(404);

    // three weeks later the contract has ended: no further change
    t.clock.advance(20 * 24 * 3600_000);
    const done = await end(first.body.data.id, '2026-11-30');
    expect(done.status).toBe(409);
    expect(done.body.error.details).toMatchObject({ reason: 'contract_ended' });
    t.clock.advance(-20 * 24 * 3600_000);
    expect(
      (await t.db.query(`SELECT count(*)::int AS n FROM operator_contracts WHERE org_id = $1`, [ORG])).rows[0]
        .n,
    ).toBe(2);
  });

  // --------------------------------------------------------------------------------------------- V2-005

  it('the lifecycle: transitions per 02 §4, a reason for suspend and terminate, both logs, replays', async () => {
    // createdOrg is a trial operator: trial → active (activate), and the refused moves
    const p = (cmd: string) => `/v1/platform/operators/${createdOrg}/${cmd}`;
    const reactivateTrial = await post(p('reactivate'), 'platform_owner');
    expect(reactivateTrial.status).toBe(409);
    expect(reactivateTrial.body.error.details).toMatchObject({
      entity_type: 'organization',
      current_status: 'trial',
      allowed_from: ['suspended'],
    });
    expect((await post(p('terminate'), 'platform_owner', { reason: 'إنهاء مبكر' })).status).toBe(409);
    expect(ok(await post(p('activate'), 'platform_admin', { reason: 'انتهت التجربة' })).operator_status).toBe(
      'active',
    );
    expect((await post(p('activate'), 'platform_admin')).status).toBe(409);

    for (const reason of [undefined, '', '  a ']) {
      const r = await post(p('suspend'), 'platform_owner', reason === undefined ? {} : { reason });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('REASON_REQUIRED');
    }
    for (const role of OUTSIDERS)
      expect((await post(p('suspend'), role, { reason: 'تأخر الدفع' })).status).toBe(403);
    const staff = await t.command('post', p('suspend'), { as: 'OWN1', body: { reason: 'تأخر الدفع' } });
    expect(staff.body.error.code).toBe('PLATFORM_AUTH_REQUIRED');

    const key = newKey();
    const s = await post(p('suspend'), 'platform_admin', { reason: 'تأخر دفع اشتراك النظام' }, key);
    expect(s.status).toBe(200);
    expect(s.body.data.operator_status).toBe('suspended');
    const again = await post(p('suspend'), 'platform_admin', { reason: 'تأخر دفع اشتراك النظام' }, key);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect((await platformLog(createdOrg, 'operator.suspend')).rows).toEqual([
      expect.objectContaining({
        actor_id: ids.platform_admin,
        reason: 'تأخر دفع اشتراك النظام',
        metadata: expect.objectContaining({ from_status: 'active', to_status: 'suspended' }),
      }),
    ]);
    expect((await orgAudit(createdOrg, 'operator.suspend')).rows).toEqual([
      expect.objectContaining({ actor_type: 'system', reason: 'تأخر دفع اشتراك النظام' }),
    ]);

    const history = (await get(`/v1/platform/operators/${createdOrg}`, 'platform_owner')).body.data
      .status_history;
    expect(history.map((h: { action: string }) => h.action)).toEqual([
      'operator.suspend',
      'operator.activate',
      'operator.create',
    ]);
    expect(history[0]).toMatchObject({
      from_status: 'active',
      to_status: 'suspended',
      reason: 'تأخر دفع اشتراك النظام',
      actor: { id: ids.platform_admin },
    });

    // terminate: from suspended only, final — no command leaves it, nothing is deleted
    const term = await post(p('terminate'), 'platform_owner', { reason: 'إنهاء العقد' });
    expect(term.body.data.operator_status).toBe('terminated');
    for (const cmd of ['activate', 'reactivate', 'suspend', 'terminate']) {
      const r = await post(p(cmd), 'platform_owner', { reason: 'محاولة أخرى' });
      expect(r.status, cmd).toBe(409);
      expect(r.body.error).toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        details: { current_status: 'terminated' },
      });
    }
    const contract = await post(`/v1/platform/operators/${createdOrg}/contracts`, 'platform_owner', {
      saas_fee_halalas_per_venue: 0,
      saas_cycle: 'monthly',
      subscriber_visit_payout_halalas: 0,
      app_payment_commission_bp: 0,
      starts_on: '2027-01-01',
    });
    expect(contract.body.error.details).toMatchObject({ reason: 'operator_terminated' });
    const kept = await t.db.query(
      `SELECT (SELECT count(*)::int FROM organizations WHERE id = $1) AS orgs,
              (SELECT count(*)::int FROM users WHERE org_id = $1) AS users`,
      [createdOrg],
    );
    expect(kept.rows[0]).toEqual({ orgs: 1, users: 1 });
    // the terminated operator's owner can still sign in and read (records kept)
    expect((await t.get('/v1/me', createdOwner)).status).toBe(200);
  });
});
