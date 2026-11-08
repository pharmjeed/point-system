import { testAdminUrl } from '@point/db/testing';
import pg from 'pg';
import { io } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realtimeOf } from '../src/bootstrap.js';
import { SEED_IDS, createTestApp, newKey, type TestApp } from './harness.js';
import { ORIGIN } from './test-env.js';

/**
 * PNT-098, 17 §12 «انقطاع قاعدة البيانات»: while the database cannot be reached the API answers
 * SERVICE_UNAVAILABLE (503 + Retry-After) everywhere — reads, commands, the readiness probe, the socket
 * handshake — never INTERNAL_ERROR and never a sign-out; nothing is kept for an Idempotency-Key, so the same
 * request succeeds once the database is back. The cut is real: the test database stops accepting connections
 * and every backend of it is terminated (what a stopped container does to the pool).
 */
describe('database outage — SERVICE_UNAVAILABLE, then recovery with the same key', () => {
  let t: TestApp;
  let admin: pg.Client;
  let url: string;

  beforeAll(async () => {
    t = await createTestApp();
    admin = new pg.Client({ connectionString: testAdminUrl() });
    await admin.connect();
    await t.app.listen(0);
    const addr = t.app.getHttpServer().address();
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });
  afterAll(async () => {
    await restore();
    await admin.end();
    await t.close();
  });

  const cut = async () => {
    await admin.query(`ALTER DATABASE ${t.tdb.name} ALLOW_CONNECTIONS false`);
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [t.tdb.name],
    );
  };
  const restore = () => admin.query(`ALTER DATABASE ${t.tdb.name} ALLOW_CONNECTIONS true`);
  const handshake = async () => {
    const s = io(url, {
      path: '/ws',
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { origin: ORIGIN, cookie: await t.sessionFor('DRV1') },
    });
    try {
      return await new Promise<{ ok: true } | { ok: false; code: string }>((resolve) => {
        s.once('connect', () => resolve({ ok: true }));
        s.once('connect_error', (e: any) => resolve({ ok: false, code: e?.data?.code }));
      });
    } finally {
      s.close();
    }
  };

  it('reads, commands, readiness and the socket answer SERVICE_UNAVAILABLE; the same key succeeds after recovery', async () => {
    // sessions and a warm pool before the cut
    expect((await t.get('/v1/me', 'DRV1')).status).toBe(200);
    expect(await handshake()).toEqual({ ok: true });

    await cut();
    const me = await t.get('/v1/me', 'DRV1');
    expect(me.status).toBe(503);
    expect(me.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(me.headers['retry-after']).toBe('2');

    const key = newKey();
    const start = await t.command('post', '/v1/me/duty/start', { as: 'DRV1', key, body: {} });
    expect(start.status).toBe(503);
    expect(start.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(start.headers['retry-after']).toBeTruthy();

    expect((await t.http().get('/health/ready')).status).toBe(503);
    expect((await t.http().get('/health/live')).status).toBe(200);
    // the device keeps its session: an unreachable database is not AUTH_UNAUTHENTICATED
    expect(await handshake()).toEqual({ ok: false, code: 'SERVICE_UNAVAILABLE' });

    await restore();
    expect((await t.http().get('/health/ready')).status).toBe(200);
    // nothing was kept for the key during the outage: the retry runs the command, it is not a replay
    const again = await t.command('post', '/v1/me/duty/start', { as: 'DRV1', key, body: {} });
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBeUndefined();
    const duty = await t.db.query(
      `SELECT count(*)::int AS n FROM duty_sessions WHERE user_id = $1 AND status <> 'ended'`,
      [SEED_IDS.users.DRV1],
    );
    expect(duty.rows[0].n).toBe(1);
    // and a replay of that key now answers the stored response
    const replay = await t.command('post', '/v1/me/duty/start', { as: 'DRV1', key, body: {} });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(await handshake()).toEqual({ ok: true });
  });

  it('a connected socket keeps its session through the outage: the heartbeat acks SERVICE_UNAVAILABLE, no session.revoked', async () => {
    const s = io(url, {
      path: '/ws',
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { origin: ORIGIN, cookie: await t.sessionFor('DRV2') },
    });
    const events: { ev: string; payload?: unknown }[] = [];
    s.onAny((ev: string, payload: unknown) => events.push({ ev, payload }));
    s.on('disconnect', (reason) => events.push({ ev: 'disconnect', payload: reason }));
    const beat = () =>
      s
        .timeout(10_000)
        .emitWithAck('client.heartbeat', { visible: true, audio_unlocked: true })
        .catch((e: Error) => ({ transport: e.message }));
    try {
      await new Promise<void>((resolve, reject) => {
        s.once('connect', () => resolve());
        s.once('connect_error', reject);
      });
      expect(await beat()).toMatchObject({ data: { server_time: expect.any(String) } });

      await cut();
      expect(await beat()).toEqual({ error: { code: 'SERVICE_UNAVAILABLE' } });
      // the 60 s re-check of every socket cannot decide either: the socket is kept as it is
      const sweep = await realtimeOf(t.app)!.revalidateAll();
      expect(sweep.undecided).toBeGreaterThanOrEqual(1);
      expect(s.connected).toBe(true);
      expect(events.map((e) => e.ev)).not.toContain('session.revoked');
      expect(events.map((e) => e.ev)).not.toContain('disconnect');

      await restore();
      expect(await beat()).toMatchObject({ data: { server_time: expect.any(String) } });
      expect((await realtimeOf(t.app)!.revalidateAll()).undecided).toBe(0);
      expect(s.connected).toBe(true);
      expect(events.map((e) => e.ev)).not.toContain('session.revoked');
    } finally {
      s.close();
    }
  });

  it('a revoked session is still revoked on its socket once the database answers (AUTH_* only)', async () => {
    const cookie = await t.sessionFor('DRV3');
    const s = io(url, {
      path: '/ws',
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { origin: ORIGIN, cookie },
    });
    const revoked = new Promise<unknown>((resolve) => s.once('session.revoked', resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        s.once('connect', () => resolve());
        s.once('connect_error', reject);
      });
      await t.db.query(
        `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'admin' WHERE user_id = $1 AND revoked_at IS NULL`,
        [SEED_IDS.users.DRV3],
      );
      await realtimeOf(t.app)!.revalidateAll();
      expect(await revoked).toMatchObject({ type: 'session.revoked', payload: { reason: 'admin' } });
    } finally {
      s.close();
    }
  });

  it('terminated backends alone (no refusal) cost at most the requests in flight: the pool reconnects', async () => {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [t.tdb.name],
    );
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await t.get('/v1/me', 'DRV1')).status);
    // idle clients were dropped by the pool; at worst the first request met a dead one and answered 503
    expect(statuses.every((s) => s === 200 || s === 503)).toBe(true);
    expect(statuses.at(-1)).toBe(200);
  });
});
