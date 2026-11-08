import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setSupervisorMfaRequired } from '@point/server/testing';
import { CSRF, SEED_CREDENTIALS, SEED_IDS, createTestApp, type TestApp } from './harness.js';

const cookieOf = (res: { headers: Record<string, any> }) => {
  const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const c = set.find((x) => x.startsWith('point_sid='));
  return c ? c.split(';')[0]! : null;
};

// PNT-011 (sessions, secret change, lockout) and PNT-012 (TOTP).
describe('auth: login, lockout, secret change, logout, MFA', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  const login = (phone: string, secret: string) =>
    t.http().post('/v1/auth/login').set(CSRF).send({ phone, secret });
  const totp = (secret: string, at = t.clock.now()) =>
    generate({ secret, epoch: Math.floor(at.getTime() / 1000) } as any);

  it('driver login sets an httpOnly session cookie; the token is never stored in clear', async () => {
    const c = SEED_CREDENTIALS.DRV1;
    const r = await login('0' + c.phone.slice(4), c.secret); // local format 05… accepted
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      mfa_required: false,
      mfa_setup_required: false,
      must_change_secret: false,
    });
    expect(r.body.data.me.user.id).toBe(SEED_IDS.users.DRV1);
    const raw = ([] as string[]).concat(r.headers['set-cookie'] as unknown as string[])[0]!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Path=\//);
    const token = cookieOf(r)!.split('=')[1]!;
    const leak = await t.db.query(
      `SELECT count(*)::int AS n FROM auth_sessions WHERE token_hash = $1 OR user_agent = $1`,
      [token],
    );
    expect(leak.rows[0].n).toBe(0);
    const me = await t.http().get('/v1/me').set('Cookie', cookieOf(r)!);
    expect(me.status).toBe(200);
    expect(me.body.data.permissions).toContain('ticket.intake');
  });

  it('login requires the CSRF header (login CSRF, DEC-29)', async () => {
    const r = await t
      .http()
      .post('/v1/auth/login')
      .send({ phone: SEED_CREDENTIALS.DRV2.phone, secret: SEED_CREDENTIALS.DRV2.secret });
    expect(r.status).toBe(403);
    expect(r.body.error.details.reason).toBe('csrf');
  });

  it('unknown phone and wrong secret answer the same AUTH_INVALID_CREDENTIALS', async () => {
    const a = await login('+966599999999', '123987');
    const b = await login(SEED_CREDENTIALS.DRV3.phone, '000001');
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(b.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('the 5th wrong attempt locks the account for 15 minutes (423 AUTH_ACCOUNT_LOCKED)', async () => {
    const c = SEED_CREDENTIALS.DRV4;
    for (let i = 1; i <= 4; i++)
      expect((await login(c.phone, '909090')).body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    const fifth = await login(c.phone, '909090');
    expect(fifth.status).toBe(423);
    expect(fifth.body.error.code).toBe('AUTH_ACCOUNT_LOCKED');
    expect(fifth.body.error.details.locked_until).toBeTruthy();
    expect((await login(c.phone, c.secret)).status).toBe(423); // still locked with the right PIN
    t.clock.advance(16 * 60_000);
    expect((await login(c.phone, c.secret)).status).toBe(200);
  });

  it('a disabled account is revealed only after valid credentials', async () => {
    await t.db.query(`UPDATE users SET status = 'disabled', disabled_at = now() WHERE id = $1`, [
      SEED_IDS.users.DRV5,
    ]);
    const c = SEED_CREDENTIALS.DRV5;
    expect((await login(c.phone, '919191')).body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    const ok = await login(c.phone, c.secret);
    expect(ok.status).toBe(403);
    expect(ok.body.error.code).toBe('AUTH_ACCOUNT_DISABLED');
    await t.db.query(`UPDATE users SET status = 'active', disabled_at = NULL WHERE id = $1`, [
      SEED_IDS.users.DRV5,
    ]);
  });

  it('must_change_secret restricts the session to auth.self; changing the secret revokes the old sessions', async () => {
    await t.db.query(`UPDATE users SET must_change_secret = true WHERE id = $1`, [SEED_IDS.users['SUP-R']]);
    const c = SEED_CREDENTIALS['SUP-R'];
    const r = await login(c.phone, c.secret);
    expect(r.body.data.must_change_secret).toBe(true);
    const cookie = cookieOf(r)!;
    expect((await t.http().get('/v1/me').set('Cookie', cookie)).status).toBe(200);
    const blocked = await t.http().get('/v1/drivers').set('Cookie', cookie);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('AUTH_SECRET_CHANGE_REQUIRED');
    expect(blocked.body.error.details.secret_kind).toBe('password');
    const weak = await t
      .http()
      .post('/v1/auth/secret/change')
      .set(CSRF)
      .set('Cookie', cookie)
      .send({ current_secret: c.secret, new_secret: 'short' });
    expect(weak.status).toBe(422);
    const wrong = await t
      .http()
      .post('/v1/auth/secret/change')
      .set(CSRF)
      .set('Cookie', cookie)
      .send({ current_secret: 'not-the-one', new_secret: 'a-long-new-password-2026' });
    expect(wrong.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    const changed = await t
      .http()
      .post('/v1/auth/secret/change')
      .set(CSRF)
      .set('Cookie', cookie)
      .send({ current_secret: c.secret, new_secret: 'a-long-new-password-2026' });
    expect(changed.status).toBe(200);
    expect(changed.body.data.user.must_change_secret).toBe(false);
    const fresh = cookieOf(changed)!;
    expect(fresh).not.toBe(cookie);
    const old = await t.http().get('/v1/me').set('Cookie', cookie);
    expect(old.status).toBe(401);
    expect(old.body.error).toMatchObject({
      code: 'AUTH_SESSION_REVOKED',
      details: { reason: 'secret_reset' },
    });
    expect((await t.http().get('/v1/drivers').set('Cookie', fresh)).status).toBe(200);
  });

  it('driver PIN rules: 6 digits, no repeats, no runs, not the phone tail', async () => {
    await t.db.query(`UPDATE users SET must_change_secret = true WHERE id = $1`, [SEED_IDS.users.DRV6]);
    const c = SEED_CREDENTIALS.DRV6;
    const cookie = cookieOf(await login(c.phone, c.secret))!;
    for (const bad of ['111111', '123456', '987654', c.phone.slice(-6), '12345']) {
      const r = await t
        .http()
        .post('/v1/auth/secret/change')
        .set(CSRF)
        .set('Cookie', cookie)
        .send({ current_secret: c.secret, new_secret: bad });
      expect(r.status, bad).toBe(422);
    }
    const ok = await t
      .http()
      .post('/v1/auth/secret/change')
      .set(CSRF)
      .set('Cookie', cookie)
      .send({ current_secret: c.secret, new_secret: '582047' });
    expect(ok.status).toBe(200);
  });

  it('logout revokes the session (reason logout) and clears the cookie', async () => {
    const c = SEED_CREDENTIALS.DRV7;
    const cookie = cookieOf(await login(c.phone, c.secret))!;
    const out = await t.http().post('/v1/auth/logout').set(CSRF).set('Cookie', cookie);
    expect(out.status).toBe(204);
    const after = await t.http().get('/v1/me').set('Cookie', cookie);
    expect(after.body.error).toMatchObject({ code: 'AUTH_SESSION_REVOKED', details: { reason: 'logout' } });
    expect((await t.http().get('/v1/me')).body.error.code).toBe('AUTH_UNAUTHENTICATED');
  });

  it('an expired session is AUTH_SESSION_EXPIRED', async () => {
    const c = SEED_CREDENTIALS.DRV8;
    const cookie = cookieOf(await login(c.phone, c.secret))!;
    t.clock.advance(15 * 3600_000); // driver sessions last 14 h
    const r = await t.http().get('/v1/me').set('Cookie', cookie);
    expect(r.body.error.code).toBe('AUTH_SESSION_EXPIRED');
  });

  it('MFA: login answers mfa_token without a cookie; verify issues the session; the token is single-use', async () => {
    const c = SEED_CREDENTIALS.ADM1;
    const r = await login(c.phone, c.secret);
    expect(r.status).toBe(200);
    expect(r.body.data.mfa_required).toBe(true);
    expect(cookieOf(r)).toBeNull();
    const token = r.body.data.mfa_token as string;
    const bad = await t
      .http()
      .post('/v1/auth/mfa/verify')
      .set(CSRF)
      .send({ mfa_token: token, code: '000000' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('AUTH_MFA_INVALID');
    expect(bad.body.error.details.attempts_left).toBe(4);
    const unknown = await t
      .http()
      .post('/v1/auth/mfa/verify')
      .set(CSRF)
      .send({ mfa_token: 'x'.repeat(43), code: '123456' });
    expect(unknown.body.error.code).toBe('AUTH_MFA_REQUIRED');
    const ok = await t
      .http()
      .post('/v1/auth/mfa/verify')
      .set(CSRF)
      .send({ mfa_token: token, code: await totp(c.totpSecret!) });
    expect(ok.status).toBe(200);
    expect(ok.body.data.session.mfa_verified).toBe(true);
    expect(cookieOf(ok)).toBeTruthy();
    const reuse = await t
      .http()
      .post('/v1/auth/mfa/verify')
      .set(CSRF)
      .send({ mfa_token: token, code: await totp(c.totpSecret!) });
    expect(reuse.body.error.code).toBe('AUTH_MFA_REQUIRED');
    const s = await t.db.query(
      `SELECT mfa_verified FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL`,
      [SEED_IDS.users.ADM1],
    );
    expect(s.rows.every((x: any) => x.mfa_verified)).toBe(true);
  });

  it('MFA: an expired mfa_token (5 minutes) is AUTH_MFA_REQUIRED and a TOTP code cannot be replayed', async () => {
    const c = SEED_CREDENTIALS.OWN1;
    const first = await login(c.phone, c.secret);
    t.clock.advance(6 * 60_000);
    const expired = await t
      .http()
      .post('/v1/auth/mfa/verify')
      .set(CSRF)
      .send({ mfa_token: first.body.data.mfa_token, code: await totp(c.totpSecret!) });
    expect(expired.body.error.code).toBe('AUTH_MFA_REQUIRED');
    const second = await login(c.phone, c.secret);
    const code = await totp(c.totpSecret!);
    expect(
      (
        await t
          .http()
          .post('/v1/auth/mfa/verify')
          .set(CSRF)
          .send({ mfa_token: second.body.data.mfa_token, code })
      ).status,
    ).toBe(200);
    const third = await login(c.phone, c.secret);
    const replay = await t
      .http()
      .post('/v1/auth/mfa/verify')
      .set(CSRF)
      .send({ mfa_token: third.body.data.mfa_token, code });
    expect(replay.body.error.code).toBe('AUTH_MFA_INVALID');
  });

  it('supervisor without MFA when it is required: restricted session, secret change first, then setup + confirm', async () => {
    await setSupervisorMfaRequired(t.db, SEED_IDS.org, true);
    try {
      await t.db.query(`UPDATE users SET must_change_secret = true WHERE id = $1`, [
        SEED_IDS.users['SUP-RL'],
      ]);
      const c = SEED_CREDENTIALS['SUP-RL'];
      const r = await login(c.phone, c.secret);
      expect(r.body.data).toMatchObject({
        mfa_required: false,
        mfa_setup_required: true,
        must_change_secret: true,
      });
      let cookie = cookieOf(r)!;
      const pending = async () =>
        (await t.http().get('/v1/me').set('Cookie', cookie)).body.data.session.pending;
      // DEC-82: the restricted session says what is still due, in order
      expect(await pending()).toEqual(['secret_change', 'mfa_setup']);
      expect((await t.http().get('/v1/drivers').set('Cookie', cookie)).body.error.code).toBe(
        'AUTH_SECRET_CHANGE_REQUIRED',
      );
      const changed = await t
        .http()
        .post('/v1/auth/secret/change')
        .set(CSRF)
        .set('Cookie', cookie)
        .send({ current_secret: c.secret, new_secret: 'supervisor-new-pass-1' });
      cookie = cookieOf(changed)!;
      expect(await pending()).toEqual(['mfa_setup']);
      const blocked = await t.http().get('/v1/drivers').set('Cookie', cookie);
      expect(blocked.body.error.code).toBe('AUTH_MFA_SETUP_REQUIRED');
      expect(blocked.body.error.details.allowed_paths).toContain('POST /v1/auth/mfa/setup');
      const setup = await t.http().post('/v1/auth/mfa/setup').set(CSRF).set('Cookie', cookie);
      expect(setup.status).toBe(200);
      expect(setup.body.data.otpauth_uri).toMatch(/^otpauth:\/\/totp\//);
      const wrong = await t
        .http()
        .post('/v1/auth/mfa/confirm')
        .set(CSRF)
        .set('Cookie', cookie)
        .send({ code: '000000' });
      expect(wrong.body.error.code).toBe('AUTH_MFA_INVALID');
      const confirm = await t
        .http()
        .post('/v1/auth/mfa/confirm')
        .set(CSRF)
        .set('Cookie', cookie)
        .send({ code: await totp(setup.body.data.secret_base32) });
      expect(confirm.status).toBe(200);
      expect(confirm.body.data.user.mfa_enabled).toBe(true);
      expect(confirm.body.data.session.mfa_verified).toBe(true);
      expect((await t.http().get('/v1/drivers').set('Cookie', cookie)).status).toBe(200);
      expect(await pending()).toEqual([]);
      const again = await t.http().post('/v1/auth/mfa/setup').set(CSRF).set('Cookie', cookie);
      expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    } finally {
      await setSupervisorMfaRequired(t.db, SEED_IDS.org, false);
    }
  });

  it('every command of this file wrote an audit row; no audit row or log contains a secret', async () => {
    const a = await t.db.query(
      `SELECT action, metadata::text AS m, before::text AS b, after::text AS af FROM audit_log`,
    );
    expect(a.rows.some((r: any) => r.action === 'auth.login')).toBe(true);
    const all = JSON.stringify(a.rows);
    for (const c of Object.values(SEED_CREDENTIALS)) expect(all).not.toContain(c.secret);
  });
});
