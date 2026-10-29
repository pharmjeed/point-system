import type { OutboxDispatcher } from '@point/server';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createS2App, ok, one, startDuty, U } from './dispatch-fixtures.js';
import { dutyId, s4Worker } from './dispatch-s4-fixtures.js';
import { newKey, type TestApp } from './harness.js';
import { ORIGIN } from './test-env.js';

const BODY = { visible: true, audio_unlocked: true, ws_connected: false };

/**
 * The heartbeat of identity-access (canon §7.3: `client.heartbeat` and its HTTP fallback `POST /v1/me/heartbeat`).
 * 06 ERD duty_sessions: «النبضة لا تزيد `version`» — the connection state is descriptive (10 §2.7), so a driver who
 * comes back online keeps his duty session version, exactly as job.heartbeat_sweep changes it the other way. Canon §9
 * marks the route «—» (not idempotent): an Idempotency-Key is accepted and ignored.
 */
describe('heartbeat — descriptive refresh: never versioned, Idempotency-Key ignored', () => {
  let t: TestApp;
  let worker: OutboxDispatcher;
  let url: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    t = await createS2App();
    worker = s4Worker(t);
    await t.app.listen(0);
    const addr = t.app.getHttpServer().address();
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    ok(await startDuty(t, 'DRV1'), 201);
    ok(await startDuty(t, 'DRV2'), 201);
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await t.close();
  });

  const session = (id: string) =>
    one<{ version: number; connection_state: string; last_heartbeat_at: Date; available_since: Date | null }>(
      t.db,
      `SELECT version, connection_state, last_heartbeat_at, available_since FROM duty_sessions WHERE id = $1`,
      [id],
    );
  const changes = async (id: string) =>
    (
      await t.db.query<{ aggregate_version: number; payload: any }>(
        `SELECT aggregate_version, payload FROM outbox_events
          WHERE type = 'driver.connection_changed' AND aggregate_id = $1 ORDER BY seq`,
        [id],
      )
    ).rows.map((r) => ({
      version: r.aggregate_version,
      from: r.payload.payload.from,
      to: r.payload.payload.to,
    }));
  /** Silence beyond heartbeat.offline_after_s (120 s): the real job.heartbeat_sweep marks both drivers offline. */
  const silence = async () => {
    t.clock.advanceSeconds(125);
    await worker.drain();
  };

  it('POST /v1/me/heartbeat brings an offline driver back online without bumping duty_sessions.version', async () => {
    const id = await dutyId(t, 'DRV1');
    const v0 = (await session(id)).version;
    await silence();
    const offline = await session(id);
    expect(offline).toMatchObject({ connection_state: 'offline', version: v0 });

    const r = await t.command('post', '/v1/me/heartbeat', { as: 'DRV1', key: null, body: BODY });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ connection_state: 'online', sync_required: true });
    const online = await session(id);
    expect(online.connection_state).toBe('online');
    expect(online.version).toBe(v0); // 06 ERD: the heartbeat never changes the aggregate version
    expect(online.available_since).toEqual(offline.available_since); // availability untouched
    expect(new Date(online.last_heartbeat_at).toISOString()).toBe(t.clock.now().toISOString());
    // one change event per transition (the sweep jumps straight to offline after 125 s), all carrying the
    // unchanged aggregate version
    expect(await changes(id)).toEqual([
      { version: v0, from: 'online', to: 'offline' },
      { version: v0, from: 'offline', to: 'online' },
    ]);

    // already online: no event, nothing versioned
    t.clock.advanceSeconds(15);
    const again = await t.command('post', '/v1/me/heartbeat', { as: 'DRV1', key: null, body: BODY });
    expect(again.body.data).toMatchObject({ connection_state: 'online', sync_required: false });
    expect((await session(id)).version).toBe(v0);
    expect(await changes(id)).toHaveLength(2);
  });

  it('client.heartbeat over the socket does the same (no version bump coming back online)', async () => {
    const id = await dutyId(t, 'DRV2');
    const v0 = (await session(id)).version;
    // DRV2 has been silent since its duty start (the previous test moved the clock): offline by the sweep
    await silence();
    expect(await session(id)).toMatchObject({ connection_state: 'offline', version: v0 });

    const s = io(url, {
      path: '/ws',
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { origin: ORIGIN, cookie: await t.sessionFor('DRV2') },
    });
    sockets.push(s);
    await new Promise<void>((resolve, reject) => {
      s.once('connect', () => resolve());
      s.once('connect_error', (e) => reject(e));
    });
    const ack: any = await s.timeout(3000).emitWithAck('client.heartbeat', {
      visible: true,
      audio_unlocked: true,
      last_event_id: null,
      app_version: 'test',
    });
    expect(ack.data).toMatchObject({ connection_state: 'online', sync_required: true });
    expect(await session(id)).toMatchObject({ connection_state: 'online', version: v0 });
    expect((await changes(id)).at(-1)).toEqual({ version: v0, from: 'offline', to: 'online' });
  });

  it('POST /v1/me/heartbeat with an Idempotency-Key answers 200 and ignores the key (canon §9 «—»)', async () => {
    const id = await dutyId(t, 'DRV1');
    const v0 = (await session(id)).version;
    await silence();
    const key = newKey();
    const first = await t.command('post', '/v1/me/heartbeat', { as: 'DRV1', key, body: BODY });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ connection_state: 'online', sync_required: true });
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    // the key is never stored, so a repeat is a fresh heartbeat (fresh server_time), not a replay
    expect(
      (await t.db.query(`SELECT count(*)::int AS n FROM idempotency_keys WHERE key = $1`, [key])).rows[0].n,
    ).toBe(0);
    t.clock.advanceSeconds(20);
    const second = await t.command('post', '/v1/me/heartbeat', { as: 'DRV1', key, body: BODY });
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBeUndefined();
    expect(second.body.meta.replayed).toBeFalsy();
    expect(second.body.data).toMatchObject({
      server_time: t.clock.now().toISOString(),
      connection_state: 'online',
      sync_required: false,
    });
    // even a malformed key is ignored rather than refused
    const odd = await t.command('post', '/v1/me/heartbeat', { as: 'DRV1', key: 'short', body: BODY });
    expect(odd.status).toBe(200);
    expect((await session(id)).version).toBe(v0);
    // the body is still validated
    const bad = await t.command('post', '/v1/me/heartbeat', { as: 'DRV1', key, body: { visible: 'yes' } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('a ✓ command still requires its key (the exemption is per route)', async () => {
    const r = await t.command('post', '/v1/me/duty/break', { as: 'DRV2', key: null, body: { active: true } });
    expect(r.status).toBe(428);
    expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(U.DRV2).toBeTruthy();
  });
});
