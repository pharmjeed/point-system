import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF, SEED_CREDENTIALS, SEED_IDS, createTestApp, type TestApp } from './harness.js';

const cookieOf = (res: { headers: Record<string, any> }) => {
  const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const c = set.find((x) => x.startsWith('point_sid='));
  return c ? c.split(';')[0]! : null;
};

/**
 * `Me.session.device_id` (docs/progress/notes/s5-web.md DEC-PROPOSED-1): the devices row a sign-in linked
 * (09 §9.5) is named in GET /v1/me, so the web app can record the D-03 audio test and the Web Push
 * subscription on the device of its own session (PNT-066, PNT-072).
 */
describe('GET /v1/me names the session device', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  it('device_id = auth_sessions.device_id; audio test and push subscription land on it', async () => {
    const c = SEED_CREDENTIALS.DRV1;
    const login = await t.http().post('/v1/auth/login').set(CSRF).send({ phone: c.phone, secret: c.secret });
    expect(login.status).toBe(200);
    const cookie = cookieOf(login)!;
    const me = await t.http().get('/v1/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    const deviceId: string = me.body.data.session.device_id;
    const row = await t.db.query<{ device_id: string; user_id: string }>(
      `SELECT s.device_id, d.user_id FROM auth_sessions s JOIN devices d ON d.id = s.device_id
        WHERE s.user_id = $1 AND s.revoked_at IS NULL ORDER BY s.created_at DESC LIMIT 1`,
      [SEED_IDS.users.DRV1],
    );
    expect(deviceId).toBe(row.rows[0]!.device_id);
    expect(row.rows[0]!.user_id).toBe(SEED_IDS.users.DRV1);

    const audio = await t
      .http()
      .post('/v1/me/audio-test')
      .set(CSRF)
      .set('Cookie', cookie)
      .send({ device_id: deviceId, result: 'heard' });
    expect(audio.status).toBe(200);
    expect(audio.body.data).toMatchObject({ id: deviceId, audio_test_result: 'heard' });

    const put = await t
      .http()
      .put(`/v1/me/devices/${deviceId}`)
      .set(CSRF)
      .set('Cookie', cookie)
      .send({
        notification_permission: 'granted',
        display_mode: 'standalone',
        push_subscription: {
          endpoint: 'https://push.example.test/send/abc',
          keys: { p256dh: 'BPk1aWl0ZXN0LWtleS1wMjU2ZGg', auth: 'dGVzdC1hdXRo' },
        },
      });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ id: deviceId, push_subscribed: true });

    const home = await t.http().get('/v1/me/home').set('Cookie', cookie);
    expect(home.status).toBe(200);
    expect(home.body.data.checks).toMatchObject({
      audio_tested: true,
      push_enabled: true,
      pwa_installed: true,
    });
  });

  it('a session without a linked device answers null', async () => {
    const me = await t.get('/v1/me', 'DRV2'); // harness session inserted without a device
    expect(me.status).toBe(200);
    expect(me.body.data.session).toHaveProperty('device_id', null);
  });
});
