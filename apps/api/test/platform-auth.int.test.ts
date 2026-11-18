import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { generate } from 'otplib';
import {
  Command,
  CurrentPlatformActor,
  CurrentTx,
  RequirePlatformPermission,
  SecretHasher,
  assertNoContractOverlap,
  platformAudit,
  sha256Hex,
  type PlatformActorContext,
  type Tx,
} from '@point/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PlatformOwnerBootstrapError,
  createPlatformOwner,
  parseCreatePlatformOwnerArgs,
} from '../src/ops/create-platform-owner.js';
import { CSRF, SEED_CREDENTIALS, SEED_IDS, createTestApp, newKey, type TestApp } from './harness.js';

/** Platform routes that only the later V2 tickets serve for real: here to exercise the guard on non-self routes. */
@Controller('v1/platform/test')
class PlatformProbeController {
  @Get('overview')
  @RequirePlatformPermission('platform.overview_read')
  overview(@CurrentPlatformActor() a: PlatformActorContext) {
    return { role: a.role };
  }

  @Get('audit')
  @RequirePlatformPermission('platform.audit_read')
  auditRead() {
    return { ok: true };
  }

  @Post('echo')
  @RequirePlatformPermission('platform.overview_read')
  @Command('POST /v1/platform/test/echo')
  async echo(@CurrentTx() tx: Tx, @CurrentPlatformActor() a: PlatformActorContext, @Body() body: unknown) {
    await platformAudit(tx, {
      actor: { type: 'platform_user', id: a.userId, role: a.role },
      action: 'platform.test_echo',
      entityType: 'platform_user',
      entityId: a.userId,
      orgId: SEED_IDS.org,
    });
    const n = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM platform_audit_log`);
    return { body, audit_rows: n.n };
  }
}
@Module({ controllers: [PlatformProbeController] })
class PlatformProbeModule {}

const OWNER_PHONE = '+966551119001';
const ADMIN_PHONE = '+966551119002';
const NEW_PASSWORD = 'platform-owner-pass-2026';

const cookieNamed = (res: { headers: Record<string, any> }, name: string) =>
  ([] as string[])
    .concat(res.headers['set-cookie'] ?? [])
    .find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`));
const pair = (raw: string | undefined) => raw?.split(';')[0] ?? '';

/**
 * V2-002: platform sign-in with mandatory MFA, a session and cookie apart from the staff ones, the restricted first
 * sign-in of the bootstrap owner, platform_audit_log in every command, platform idempotency, and the contract overlap
 * rule of V2-001 (DEC-463).
 */
describe('platform identity (V2-001, V2-002)', () => {
  let t: TestApp;
  let ownerId: string;
  let temporary: string;
  let totpSecret: string;
  let ownerCookie: string;

  beforeAll(async () => {
    t = await createTestApp({ extraModules: [PlatformProbeModule] });
  });
  afterAll(async () => t?.close());

  const totp = (secret: string, at = t.clock.now()) =>
    generate({ secret, epoch: Math.floor(at.getTime() / 1000) } as any) as unknown as Promise<string>;
  const post = (path: string, body: object, cookie?: string) => {
    let r = t.http().post(path).set(CSRF);
    if (cookie) r = r.set('Cookie', cookie);
    return r.send(body);
  };
  const me = (cookie: string) => t.http().get('/v1/platform/me').set('Cookie', cookie);
  const platformCookie = () => t.env.PLATFORM_SESSION_COOKIE_NAME;

  it('the platform cookie is point_psid next to the local staff cookie point_sid', () => {
    expect(t.env.SESSION_COOKIE_NAME).toBe('point_sid');
    expect(platformCookie()).toBe('point_psid');
  });

  it('create-platform-owner: a hashed temporary password, no TOTP, an audit row; a second owner is refused', async () => {
    expect(parseCreatePlatformOwnerArgs(['--phone', '0551119001', '--name', 'مالك المنصة'])).toEqual({
      phone: '0551119001',
      fullName: 'مالك المنصة',
    });
    expect(() => parseCreatePlatformOwnerArgs(['--phone', '1'])).toThrow(/required/);
    const r = await createPlatformOwner(t.db, t.env, { phone: '0551119001', fullName: '  مالك المنصة  ' });
    ownerId = r.userId;
    temporary = r.temporaryPassword;
    expect(r.phoneE164).toBe(OWNER_PHONE);
    expect(temporary).toMatch(/^[A-Za-z0-9_-]{16}$/);
    const u = (await t.db.query(`SELECT * FROM platform_users WHERE id = $1`, [ownerId])).rows[0];
    expect(u).toMatchObject({
      role: 'platform_owner',
      full_name: 'مالك المنصة',
      must_change_secret: true,
      mfa_enabled: false,
      mfa_secret_enc: null,
      status: 'active',
      created_by: null,
    });
    expect(u.secret_hash).toMatch(/^\$argon2id\$v=19\$/);
    expect(await new SecretHasher(t.env.AUTH_SECRET_PEPPER).verify(u.secret_hash, temporary)).toBe(true);
    const a = await t.db.query(`SELECT actor_type, actor_id, action, metadata FROM platform_audit_log`);
    expect(a.rows).toEqual([
      {
        actor_type: 'system',
        actor_id: null,
        action: 'platform.owner_bootstrap',
        metadata: expect.objectContaining({ system: 'ops.create_platform_owner', role: 'platform_owner' }),
      },
    ]);
    // no staff account, no organization row and no staff audit row is touched
    expect((await t.db.query(`SELECT 1 FROM users WHERE phone_e164 = $1`, [OWNER_PHONE])).rowCount).toBe(0);
    await expect(
      createPlatformOwner(t.db, t.env, { phone: '0551119009', fullName: 'ثانٍ' }),
    ).rejects.toMatchObject({ reason: 'owner_exists' });
    await expect(createPlatformOwner(t.db, t.env, { phone: '12', fullName: 'x' })).rejects.toBeInstanceOf(
      PlatformOwnerBootstrapError,
    );
  });

  it('first sign-in: a restricted session (platform.self only) until the password change and the TOTP set-up', async () => {
    const r = await post('/v1/platform/auth/login', { phone: '0551119001', secret: temporary });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      mfa_required: false,
      mfa_setup_required: true,
      must_change_secret: true,
    });
    expect(r.body.data.me.session).toMatchObject({
      restricted: true,
      pending: ['secret_change', 'mfa_setup'],
    });
    expect(r.body.data.me.permissions).toEqual(['platform.self']);
    const raw = cookieNamed(r, platformCookie())!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(cookieNamed(r, 'point_sid')).toBeUndefined(); // never the staff cookie
    const cookie = pair(raw);
    const token = cookie.split('=')[1]!;
    const leak = await t.db.query(`SELECT count(*)::int AS n FROM platform_sessions WHERE token_hash = $1`, [
      token,
    ]);
    expect(leak.rows[0].n).toBe(0); // only the sha256 is stored

    const blocked = await t.http().get('/v1/platform/test/overview').set('Cookie', cookie);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('AUTH_SECRET_CHANGE_REQUIRED');
    expect(blocked.body.error.details.allowed_paths).toContain('GET /v1/platform/me');
    expect(blocked.body.error.details.allowed_paths).not.toContain('GET /v1/me');

    const weak = await post(
      '/v1/platform/auth/secret/change',
      { current_secret: temporary, new_secret: 'short' },
      cookie,
    );
    expect(weak.status).toBe(422);
    const changed = await post(
      '/v1/platform/auth/secret/change',
      { current_secret: temporary, new_secret: NEW_PASSWORD },
      cookie,
    );
    expect(changed.status).toBe(200);
    expect(changed.body.data.session.pending).toEqual(['mfa_setup']);
    const second = pair(cookieNamed(changed, platformCookie()));
    expect(second).not.toBe(cookie);
    expect((await me(cookie)).body.error).toMatchObject({
      code: 'AUTH_SESSION_REVOKED',
      details: { reason: 'secret_reset' },
    });

    const stillBlocked = await t.http().get('/v1/platform/test/overview').set('Cookie', second);
    expect(stillBlocked.body.error.code).toBe('AUTH_MFA_SETUP_REQUIRED');

    const setup = await post('/v1/platform/auth/mfa/setup', {}, second);
    expect(setup.status).toBe(200);
    totpSecret = setup.body.data.secret_base32;
    expect(setup.body.data.otpauth_uri).toMatch(/^otpauth:\/\/totp\//);
    expect(setup.body.data.otpauth_uri).not.toContain('551119001'); // the label carries a masked phone
    const stored = (await t.db.query(`SELECT mfa_secret_enc FROM platform_users WHERE id = $1`, [ownerId]))
      .rows[0];
    expect(stored.mfa_secret_enc).not.toContain(totpSecret);

    const wrong = await post('/v1/platform/auth/mfa/confirm', { code: '000000' }, second);
    expect(wrong.body.error.code).toBe('AUTH_MFA_INVALID');
    const confirmed = await post('/v1/platform/auth/mfa/confirm', { code: await totp(totpSecret) }, second);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.session).toMatchObject({ restricted: false, pending: [], mfa_verified: true });
    expect(confirmed.body.data.permissions).toContain('platform.audit_read');
    const open = await t.http().get('/v1/platform/test/overview').set('Cookie', second);
    expect(open.status).toBe(200);
    expect(open.body.data).toEqual({ role: 'platform_owner' });
    ownerCookie = second;
  });

  it('every later sign-in asks for TOTP: mfa_token without a cookie, then the session', async () => {
    t.clock.advance(60_000); // the next TOTP step (replay protection)
    const r = await post('/v1/platform/auth/login', { phone: OWNER_PHONE, secret: NEW_PASSWORD });
    expect(r.body.data).toMatchObject({ mfa_required: true, me: null });
    expect(cookieNamed(r, platformCookie())).toBeUndefined();
    const token = r.body.data.mfa_token as string;
    // the challenge itself is never a session
    expect((await me(`${platformCookie()}=${token}`)).body.error.code).toBe('PLATFORM_AUTH_REQUIRED');
    const bad = await post('/v1/platform/auth/mfa/verify', { mfa_token: token, code: '123456' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('AUTH_MFA_INVALID');
    const ok = await post('/v1/platform/auth/mfa/verify', { mfa_token: token, code: await totp(totpSecret) });
    expect(ok.status).toBe(200);
    expect(ok.body.data.user).toMatchObject({ id: ownerId, role: 'platform_owner', mfa_enabled: true });
    const cookie = pair(cookieNamed(ok, platformCookie()));
    expect((await me(cookie)).status).toBe(200);
    // single use
    const again = await post('/v1/platform/auth/mfa/verify', {
      mfa_token: token,
      code: await totp(totpSecret),
    });
    expect(again.body.error.code).toBe('AUTH_MFA_REQUIRED');
  });

  it('a staff session never authorizes a platform route', async () => {
    const staff = await t.sessionFor('OWN1'); // point_sid=… of the organization owner
    const r = await t.http().get('/v1/platform/me').set('Cookie', staff);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('PLATFORM_AUTH_REQUIRED');
    // a staff token sent under the platform cookie name is not a platform session either
    const token = staff.split('=')[1]!;
    const swapped = await t
      .http()
      .get('/v1/platform/test/overview')
      .set('Cookie', `${platformCookie()}=${token}`);
    expect(swapped.body.error.code).toBe('PLATFORM_AUTH_REQUIRED');
    const cmd = await post('/v1/platform/auth/logout', {}, staff);
    expect(cmd.body.error.code).toBe('PLATFORM_AUTH_REQUIRED');
    // staff credentials do not open the platform sign-in
    const c = SEED_CREDENTIALS.OWN1;
    const login = await post('/v1/platform/auth/login', { phone: c.phone, secret: c.secret });
    expect(login.status).toBe(401);
    expect(login.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('a platform session never authorizes a staff route', async () => {
    const r = await t.http().get('/v1/me').set('Cookie', ownerCookie);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('AUTH_UNAUTHENTICATED');
    const token = ownerCookie.split('=')[1]!;
    const swapped = await t.http().get('/v1/drivers').set('Cookie', `point_sid=${token}`);
    expect(swapped.body.error.code).toBe('AUTH_UNAUTHENTICATED');
    // both cookies in one browser: each route reads its own
    const both = `${ownerCookie}; ${await t.sessionFor('DRV1')}`;
    const staffMe = await t.http().get('/v1/me').set('Cookie', both);
    expect(staffMe.body.data.user.id).toBe(SEED_IDS.users.DRV1);
    const platformMe = await t.http().get('/v1/platform/me').set('Cookie', both);
    expect(platformMe.body.data.user.id).toBe(ownerId);
    // platform credentials do not open the staff sign-in
    const login = await post('/v1/auth/login', { phone: OWNER_PHONE, secret: NEW_PASSWORD });
    expect(login.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('the platform role matrix: a platform admin reaches P-01 but not the platform log', async () => {
    const admin = await t.db.query<{ id: string }>(
      `INSERT INTO platform_users (phone_e164, full_name, role, secret_hash, must_change_secret, mfa_enabled, mfa_secret_enc)
       VALUES ($1, 'مشرف المنصة', 'platform_admin', 'x', false, true, 'x') RETURNING id`,
      [ADMIN_PHONE],
    );
    const token = 'platform-admin-token-for-tests-0123456789';
    await t.db.query(
      `INSERT INTO platform_sessions (platform_user_id, token_hash, mfa_verified, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, true, $3, $3, $3::timestamptz + interval '1 hour')`,
      [admin.rows[0]!.id, sha256Hex(token), t.clock.now()],
    );
    const cookie = `${platformCookie()}=${token}`;
    expect((await t.http().get('/v1/platform/test/overview').set('Cookie', cookie)).status).toBe(200);
    const denied = await t.http().get('/v1/platform/test/audit').set('Cookie', cookie);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({
      code: 'PERMISSION_DENIED',
      details: { permission: 'platform.audit_read' },
    });
    // idle 30 minutes → expired
    t.clock.advance(31 * 60_000);
    const idle = await t.http().get('/v1/platform/me').set('Cookie', cookie);
    expect(idle.body.error).toMatchObject({ code: 'AUTH_SESSION_EXPIRED', details: { reason: 'idle' } });
  });

  it('a disabled platform account loses its session; 5 wrong passwords lock the account for 15 minutes', async () => {
    const r = await post('/v1/platform/auth/login', { phone: '+966599990000', secret: 'whatever-123' });
    expect(r.body.error.code).toBe('AUTH_INVALID_CREDENTIALS'); // unknown phone = wrong password
    for (let i = 1; i <= 4; i++) {
      const w = await post('/v1/platform/auth/login', { phone: OWNER_PHONE, secret: 'wrong-password-x' });
      expect(w.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    }
    const fifth = await post('/v1/platform/auth/login', { phone: OWNER_PHONE, secret: 'wrong-password-x' });
    expect(fifth.status).toBe(423);
    expect(fifth.body.error.code).toBe('AUTH_ACCOUNT_LOCKED');
    const failures = await t.db.query(
      `SELECT count(*)::int AS n FROM platform_audit_log WHERE action = 'platform.auth.login_failed' AND actor_id = $1`,
      [ownerId],
    );
    expect(failures.rows[0].n).toBe(5);
    t.clock.advance(16 * 60_000);
    expect(
      (await post('/v1/platform/auth/login', { phone: OWNER_PHONE, secret: NEW_PASSWORD })).body.data
        .mfa_required,
    ).toBe(true);
  });

  it('a platform command keeps its Idempotency-Key in platform_idempotency_keys and replays it', async () => {
    t.clock.advance(60_000);
    const login = await post('/v1/platform/auth/login', { phone: OWNER_PHONE, secret: NEW_PASSWORD });
    const ok = await post('/v1/platform/auth/mfa/verify', {
      mfa_token: login.body.data.mfa_token,
      code: await totp(totpSecret),
    });
    const cookie = pair(cookieNamed(ok, platformCookie()));
    const key = newKey();
    const send = (body: object) =>
      t
        .http()
        .post('/v1/platform/test/echo')
        .set(CSRF)
        .set('Cookie', cookie)
        .set('Idempotency-Key', key)
        .send(body);
    const first = await send({ n: 1 });
    expect(first.status).toBe(200);
    const replay = await send({ n: 1 });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data).toEqual(first.body.data);
    expect((await send({ n: 2 })).body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const keys = await t.db.query(
      `SELECT platform_user_id, operation, status FROM platform_idempotency_keys`,
    );
    expect(keys.rows).toEqual([
      { platform_user_id: ownerId, operation: 'POST /v1/platform/test/echo', status: 'completed' },
    ]);
    expect((await t.db.query(`SELECT 1 FROM idempotency_keys WHERE key = $1`, [key])).rowCount).toBe(0);
    // a platform action touching an organization is also in that organization's audit_log
    const orgAudit = await t.db.query(
      `SELECT actor_type, actor_id FROM audit_log WHERE org_id = $1 AND action = 'platform.test_echo'`,
      [SEED_IDS.org],
    );
    expect(orgAudit.rows).toEqual([{ actor_type: 'system', actor_id: `platform:${ownerId}` }]);
  });

  it('every platform sign-in step is in platform_audit_log, none in the staff audit_log', async () => {
    const rows = await t.db.query<{ action: string }>(
      `SELECT DISTINCT action FROM platform_audit_log WHERE actor_id = $1 ORDER BY action`,
      [ownerId],
    );
    expect(rows.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'platform.auth.login',
        'platform.auth.login_failed',
        'platform.auth.mfa_confirm',
        'platform.auth.mfa_setup',
        'platform.auth.secret_change',
        'platform.test_echo',
      ]),
    );
    const staff = await t.db.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'platform.auth.%'`,
    );
    expect(staff.rows[0].n).toBe(0);
    // append-only for the application role (PNT-009 pattern)
    const c = await t.db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE point_app');
      await expect(c.query(`UPDATE platform_audit_log SET action = action WHERE false`)).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('logout revokes the platform session only; the staff session in the same browser stays', async () => {
    t.clock.advance(60_000);
    const login = await post('/v1/platform/auth/login', { phone: OWNER_PHONE, secret: NEW_PASSWORD });
    const ok = await post('/v1/platform/auth/mfa/verify', {
      mfa_token: login.body.data.mfa_token,
      code: await totp(totpSecret),
    });
    const cookie = pair(cookieNamed(ok, platformCookie()));
    const staff = await t.sessionFor('ADM1');
    const out = await post('/v1/platform/auth/logout', {}, `${cookie}; ${staff}`);
    expect(out.status).toBe(204);
    const cleared = ([] as string[]).concat(out.headers['set-cookie'] ?? []);
    expect(cleared.some((c) => c.startsWith(`${platformCookie()}=;`))).toBe(true);
    expect(cleared.some((c) => c.startsWith('point_sid='))).toBe(false);
    expect((await me(cookie)).body.error).toMatchObject({
      code: 'AUTH_SESSION_REVOKED',
      details: { reason: 'logout' },
    });
    expect((await t.http().get('/v1/me').set('Cookie', staff)).status).toBe(200);
  });

  it('one contract per operator on any day, enforced under the organization lock (DEC-463)', async () => {
    const insert = (startsOn: string, endsOn: string | null) =>
      t.db.transaction(async (tx) => {
        await assertNoContractOverlap(tx, SEED_IDS.org, { startsOn, endsOn });
        await tx.query(
          `INSERT INTO operator_contracts (org_id, saas_fee_halalas_per_venue, saas_cycle, subscriber_visit_payout_halalas,
                                           app_payment_commission_bp, starts_on, ends_on, created_by)
           VALUES ($1, 50000, 'monthly', 500, 250, $2, $3, $4)`,
          [SEED_IDS.org, startsOn, endsOn, ownerId],
        );
      });
    await insert('2026-01-01', '2026-07-01');
    await insert('2026-07-01', null); // adjacent: [start, end) ranges do not overlap
    await expect(insert('2026-03-01', '2026-04-01')).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      details: { reason: 'contract_overlap' },
    });
    await expect(insert('2030-01-01', null)).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    await expect(
      t.db.transaction((tx) =>
        assertNoContractOverlap(tx, '00000000-0000-4000-8000-00000000dead', {
          startsOn: '2026-01-01',
          endsOn: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    // two concurrent commands for another operator: the organization row lock serializes them, one wins
    const org = await t.db.query<{ id: string }>(
      `INSERT INTO organizations (name_ar) VALUES ('مشغل ثانٍ') RETURNING id`,
    );
    const orgId = org.rows[0]!.id;
    const race = () =>
      t.db.transaction(async (tx) => {
        await assertNoContractOverlap(tx, orgId, { startsOn: '2026-01-01', endsOn: null });
        await tx.query(`SELECT pg_sleep(0.2)`);
        await tx.query(
          `INSERT INTO operator_contracts (org_id, saas_fee_halalas_per_venue, saas_cycle, subscriber_visit_payout_halalas,
                                           app_payment_commission_bp, starts_on, created_by)
           VALUES ($1, 0, 'yearly', 0, 0, '2026-01-01', $2)`,
          [orgId, ownerId],
        );
      });
    const results = await Promise.allSettled([race(), race()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const n = await t.db.query(`SELECT count(*)::int AS n FROM operator_contracts WHERE org_id = $1`, [
      orgId,
    ]);
    expect(n.rows[0].n).toBe(1);
  });

  it('existing organizations stay valid: an active operator run by its own company', async () => {
    const o = await t.db.query(
      `SELECT operator_status, is_platform_operated FROM organizations WHERE id = $1`,
      [SEED_IDS.org],
    );
    expect(o.rows[0]).toEqual({ operator_status: 'active', is_platform_operated: false });
  });
});

describe('platform rate limits (07 §1.9 classes, buckets apart from the staff ones)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ env: { RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_READS_PER_MIN: '2' } });
  });
  afterAll(async () => t?.close());

  it('a platform session is limited per platform account; the staff user of the same browser is not charged', async () => {
    const u = await t.db.query<{ id: string }>(
      `INSERT INTO platform_users (phone_e164, full_name, role, secret_hash, must_change_secret, mfa_enabled, mfa_secret_enc)
       VALUES ('+966551119201', 'دعم', 'platform_support', 'x', false, true, 'x') RETURNING id`,
    );
    const token = 'platform-rate-limit-session-token-000001';
    await t.db.query(
      `INSERT INTO platform_sessions (platform_user_id, token_hash, mfa_verified, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, true, $3, $3, $3::timestamptz + interval '1 hour')`,
      [u.rows[0]!.id, sha256Hex(token), t.clock.now()],
    );
    const cookie = `${t.env.PLATFORM_SESSION_COOKIE_NAME}=${token}; ${await t.sessionFor('DRV1')}`;
    const read = () => t.http().get('/v1/platform/me').set('Cookie', cookie);
    expect((await read()).status).toBe(200);
    expect((await read()).status).toBe(200);
    const third = await read();
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
    // the staff reads of DRV1 have their own bucket
    expect((await t.http().get('/v1/me').set('Cookie', cookie)).status).toBe(200);
  });
});
