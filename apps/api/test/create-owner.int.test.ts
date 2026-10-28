import { generate } from 'otplib';
import { SecretHasher } from '@point/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OwnerBootstrapError,
  createOwner,
  parseCreateOwnerArgs,
  type CreateOwnerResult,
} from '../src/ops/create-owner.js';
import { CSRF, createTestApp, type TestApp } from './harness.js';

/**
 * The installation tool that creates the first owner (09 §2, §9.1, §10 rule 4; docs/DEPLOYMENT.md): same
 * argon2id + AUTH_SECRET_PEPPER as the server, a temporary password that must be changed, MFA set up at the
 * first sign-in, refused when an owner already exists.
 */
describe('create-owner', () => {
  let t: TestApp;
  let created: CreateOwnerResult;
  beforeAll(async () => {
    t = await createTestApp({ seed: false });
  });
  afterAll(async () => t?.close());

  const cookieOf = (r: { headers: Record<string, unknown> }) =>
    ([] as string[])
      .concat((r.headers['set-cookie'] as string[]) ?? [])
      .find((c) => c.startsWith('point_sid='))
      ?.split(';')[0];

  it('creates the organization, the owner and its org scope, with an audit row and no secret in clear', async () => {
    const r = await createOwner(t.db, t.env, {
      phone: '0551110001',
      fullName: '  مالك التثبيت  ',
      orgNameAr: 'مؤسسة التجربة',
      orgNameEn: 'Trial Org',
    });
    created = r;
    expect(r).toMatchObject({ orgCreated: true, employeeCode: 'O-0001', phoneE164: '+966551110001' });
    expect(r.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{16}$/);

    const user = (await t.db.query(`SELECT * FROM users WHERE id = $1`, [r.userId])).rows[0];
    expect(user).toMatchObject({
      org_id: r.orgId,
      role: 'owner',
      full_name: 'مالك التثبيت',
      secret_kind: 'password',
      must_change_secret: true,
      mfa_enabled: false,
      mfa_secret_enc: null,
      status: 'active',
      created_by: null,
    });
    // argon2id with the 09 §9.1 parameters (19 MiB, 2 iterations, parallelism 1)
    expect(user.secret_hash).toMatch(/^\$argon2id\$v=19\$/);
    expect(user.secret_hash.split('$')[3]!.split(',').sort()).toEqual(['m=19456', 'p=1', 't=2']);
    expect(user.secret_hash).not.toContain(r.temporaryPassword);
    // the server's hasher (same pepper) verifies it; another pepper does not
    expect(
      await new SecretHasher(t.env.AUTH_SECRET_PEPPER).verify(user.secret_hash, r.temporaryPassword),
    ).toBe(true);
    expect(
      await new SecretHasher(Buffer.from('another pepper of 32 bytes......').toString('base64')).verify(
        user.secret_hash,
        r.temporaryPassword,
      ),
    ).toBe(false);

    const org = (
      await t.db.query(`SELECT name_ar, name_en, settings FROM organizations WHERE id = $1`, [r.orgId])
    ).rows[0];
    expect(org).toEqual({ name_ar: 'مؤسسة التجربة', name_en: 'Trial Org', settings: {} });
    const scopes = await t.db.query(
      `SELECT scope_type, venue_id, revoked_at FROM role_scopes WHERE user_id = $1`,
      [r.userId],
    );
    expect(scopes.rows).toEqual([{ scope_type: 'org', venue_id: null, revoked_at: null }]);
    const a = await t.db.query(
      `SELECT actor_type, actor_id, action, entity_id, after FROM audit_log WHERE org_id = $1`,
      [r.orgId],
    );
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]).toMatchObject({
      actor_type: 'system',
      actor_id: 'ops.create_owner',
      action: 'owner.bootstrap',
      entity_id: r.userId,
      after: { command: 'create', role: 'owner', organization_created: true, mfa_setup_required: true },
    });
    expect(JSON.stringify(a.rows)).not.toContain(r.temporaryPassword);
  });

  it('the first sign-in with the printed password: restricted session → change it → set up MFA → full owner session', async () => {
    const temp = created.temporaryPassword;
    const login = await t.http().post('/v1/auth/login').set(CSRF).send({ phone: '0551110001', secret: temp });
    expect(login.status).toBe(200);
    expect(login.body.data).toMatchObject({
      mfa_required: false,
      mfa_setup_required: true,
      must_change_secret: true,
    });
    let cookie = cookieOf(login)!;
    const me = async () => (await t.http().get('/v1/me').set('Cookie', cookie)).body.data;
    expect((await me()).session.pending).toEqual(['secret_change', 'mfa_setup']);
    const venues = () => t.http().get('/v1/venues').set('Cookie', cookie);
    expect((await venues()).body.error.code).toBe('AUTH_SECRET_CHANGE_REQUIRED');

    const changed = await t
      .http()
      .post('/v1/auth/secret/change')
      .set(CSRF)
      .set('Cookie', cookie)
      .send({ current_secret: temp, new_secret: 'owner-chosen-passphrase-2026' });
    expect(changed.status).toBe(200);
    cookie = cookieOf(changed)!;
    expect((await venues()).body.error.code).toBe('AUTH_MFA_SETUP_REQUIRED');

    const setup = await t.http().post('/v1/auth/mfa/setup').set(CSRF).set('Cookie', cookie);
    expect(setup.status).toBe(200);
    const code = await generate({
      secret: setup.body.data.secret_base32,
      epoch: Math.floor(t.clock.now().getTime() / 1000),
    } as any);
    const confirm = await t
      .http()
      .post('/v1/auth/mfa/confirm')
      .set(CSRF)
      .set('Cookie', cookie)
      .send({ code });
    expect(confirm.status).toBe(200);
    expect(confirm.body.data.user).toMatchObject({ role: 'owner', mfa_enabled: true });
    const full = await me();
    expect(full.session.pending).toEqual([]);
    expect(full.permissions).toEqual(
      expect.arrayContaining(['org.settings_manage', 'staff.manage', 'venue.manage']),
    );
    expect((await venues()).status).toBe(200);
  });

  it('refuses a second owner, an ambiguous organization, an invalid phone and a missing organization name', async () => {
    const refusal = async (p: Promise<unknown>) => {
      try {
        await p;
        return null;
      } catch (e) {
        expect(e).toBeInstanceOf(OwnerBootstrapError);
        return (e as OwnerBootstrapError).reason;
      }
    };
    expect(await refusal(createOwner(t.db, t.env, { phone: '0551110002', fullName: 'x' }))).toBe(
      'owner_exists',
    );
    expect(await refusal(createOwner(t.db, t.env, { phone: 'not-a-phone', fullName: 'x' }))).toBe(
      'phone_invalid',
    );
    expect(await refusal(createOwner(t.db, t.env, { phone: '0551110002', fullName: '  ' }))).toBe(
      'name_required',
    );
    expect(
      await refusal(createOwner(t.db, t.env, { phone: '0551110002', fullName: 'x', orgId: 'nope' })),
    ).toBe('org_not_found');
    await t.db.query(`INSERT INTO organizations (name_ar) VALUES ('مؤسسة ثانية')`);
    expect(await refusal(createOwner(t.db, t.env, { phone: '0551110002', fullName: 'x' }))).toBe(
      'org_ambiguous',
    );
    const second = (await t.db.query(`SELECT id FROM organizations WHERE name_ar = 'مؤسسة ثانية'`)).rows[0]
      .id;
    const r = await createOwner(t.db, t.env, { phone: '0551110002', fullName: 'مالك ثان', orgId: second });
    expect(r).toMatchObject({ orgId: second, orgCreated: false, employeeCode: 'O-0001' });
    // nothing else was written by the refused attempts
    expect((await t.db.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n).toBe(2);
  });

  it('a fresh database without an organization needs --org-name-ar', async () => {
    const empty = await createTestApp({ seed: false });
    try {
      await expect(
        createOwner(empty.db, empty.env, { phone: '0551110003', fullName: 'x' }),
      ).rejects.toMatchObject({
        reason: 'org_name_required',
      });
    } finally {
      await empty.close();
    }
  });

  it('command-line options', () => {
    expect(
      parseCreateOwnerArgs([
        '--phone',
        '+966551110004',
        '--name',
        'المالك',
        '--org-name-ar',
        'مؤسسة',
        '--org-name-en',
        'Org',
      ]),
    ).toEqual({ phone: '+966551110004', fullName: 'المالك', orgNameAr: 'مؤسسة', orgNameEn: 'Org' });
    expect(
      parseCreateOwnerArgs([
        '--phone=0551110004',
        '--name=x',
        '--org-id=00000000-0000-4000-8000-000000000001',
      ]),
    ).toEqual({
      phone: '0551110004',
      fullName: 'x',
      orgId: '00000000-0000-4000-8000-000000000001',
    });
    expect(() => parseCreateOwnerArgs(['--phone', '0551110004'])).toThrow(/--name/);
    expect(() => parseCreateOwnerArgs(['--phone', '1', '--name', 'x', '--password', 'y'])).toThrow();
  });
});
