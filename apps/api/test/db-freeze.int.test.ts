import { testAdminUrl } from '@point/db/testing';
import { READY_TIMEOUT_MS, READ_TIMEOUT_MARGIN_MS } from '@point/server';
import { startFreezeProxy, type FreezeProxy } from '@point/server/testing';
import pg from 'pg';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_IDS, createTestApp, newKey, type TestApp } from './harness.js';
import { ORIGIN } from './test-env.js';

const STATEMENT_TIMEOUT_MS = 1000;
const READ_TIMEOUT_MS = STATEMENT_TIMEOUT_MS + READ_TIMEOUT_MARGIN_MS; // 3 s
const CONNECT_TIMEOUT_MS = 1000;
/** apps/web/src/api/client.ts DEFAULT_TIMEOUT_MS: a later answer is an unknown outcome to the PWA (08 §8.1) */
const PWA_TIMEOUT_MS = 10_000;
const SLACK_MS = 2000;

const timed = async <T>(p: Promise<T>) => {
  const started = performance.now();
  const value = await p;
  return { value, ms: performance.now() - started };
};

/**
 * PNT-098, 17 §12 «انقطاع قاعدة البيانات 60 ثانية — إيقاف الحاوية مؤقتًا» read as a paused container: the
 * database accepts connections and bytes and answers nothing (startFreezeProxy). Through the real routes a read,
 * a command, the readiness probe and the socket heartbeat answer SERVICE_UNAVAILABLE within the PWA's 10 s —
 * the bounded waits of DEC-PROPOSED-8 — the socket keeps its session (no session.revoked), and after the thaw
 * the same Idempotency-Key runs the command once.
 */
describe('a paused database — SERVICE_UNAVAILABLE in bounded time, then recovery', () => {
  let t: TestApp;
  let proxy: FreezeProxy;
  let url: string;
  let socket: Socket;
  const events: { ev: string; payload?: unknown }[] = [];

  beforeAll(async () => {
    const admin = new URL(testAdminUrl());
    proxy = await startFreezeProxy({ host: admin.hostname, port: Number(admin.port || 5432) });
    t = await createTestApp({
      dbConfig: (u) => ({
        connectionString: proxy.via(u),
        statementTimeoutMs: STATEMENT_TIMEOUT_MS,
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
      }),
    });
    t.db.onIdleError = () => {};
    await t.app.listen(0);
    const addr = t.app.getHttpServer().address();
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });
  afterAll(async () => {
    proxy.thaw();
    socket?.close();
    await t.close();
    await proxy.stop();
  });

  const heartbeat = () =>
    socket
      .timeout(PWA_TIMEOUT_MS)
      .emitWithAck('client.heartbeat', { visible: true, audio_unlocked: true, last_event_id: null })
      .catch((e: Error) => ({ transport: e.message })) as Promise<
      { data?: unknown; error?: { code: string } } | { transport: string }
    >;

  it('reads, commands, readiness and the heartbeat answer 503 within the PWA timeout; the same key succeeds after the thaw', async () => {
    // sessions, a warm pool and a connected socket before the pause
    expect((await t.get('/v1/me', 'DRV1')).status).toBe(200);
    socket = io(url, {
      path: '/ws',
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { origin: ORIGIN, cookie: await t.sessionFor('DRV1') },
    });
    socket.onAny((ev: string, payload: unknown) => events.push({ ev, payload }));
    socket.on('disconnect', (reason) => events.push({ ev: 'disconnect', payload: reason }));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    expect('data' in (await heartbeat())).toBe(true);

    proxy.freeze();
    const key = newKey();
    const [me, ready, start, beat] = await Promise.all([
      timed(t.get('/v1/me', 'DRV1')),
      timed(t.http().get('/health/ready')),
      timed(t.command('post', '/v1/me/duty/start', { as: 'DRV1', key, body: {} })),
      timed(heartbeat()),
    ]);
    expect(me.value.status).toBe(503);
    expect(me.value.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(me.value.headers['retry-after']).toBe('2');
    expect(me.ms).toBeLessThan(READ_TIMEOUT_MS + SLACK_MS);
    expect(ready.value.status).toBe(503);
    expect(ready.ms).toBeLessThan(READY_TIMEOUT_MS + SLACK_MS);
    expect(start.value.status).toBe(503);
    expect(start.value.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(start.ms).toBeLessThan(PWA_TIMEOUT_MS);
    // the device keeps its session and its socket: an unreachable database is not a revocation
    expect(beat.value).toEqual({ error: { code: 'SERVICE_UNAVAILABLE' } });
    expect(beat.ms).toBeLessThan(PWA_TIMEOUT_MS);
    expect(socket.connected).toBe(true);
    expect(events.map((e) => e.ev)).not.toContain('session.revoked');
    expect((await t.http().get('/health/live')).status).toBe(200);

    proxy.thaw();
    await expect
      .poll(async () => (await t.http().get('/health/ready')).status, { timeout: 10_000 })
      .toBe(200);
    // nothing was kept for the key while paused: the retry runs the command once, then replays it
    const again = await t.command('post', '/v1/me/duty/start', { as: 'DRV1', key, body: {} });
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBeUndefined();
    const replay = await t.command('post', '/v1/me/duty/start', { as: 'DRV1', key, body: {} });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const direct = new pg.Client({ connectionString: t.tdb.url });
    await direct.connect();
    try {
      const duty = await direct.query(
        `SELECT count(*)::int AS n FROM duty_sessions WHERE user_id = $1 AND status <> 'ended'`,
        [SEED_IDS.users.DRV1],
      );
      expect(duty.rows[0].n).toBe(1);
    } finally {
      await direct.end();
    }
    expect('data' in (await heartbeat())).toBe(true);
    expect(socket.connected).toBe(true);
    expect(events.map((e) => e.ev)).not.toContain('session.revoked');
  });
});
