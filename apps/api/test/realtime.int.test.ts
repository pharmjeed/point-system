import { io, type Socket } from 'socket.io-client';
import { publishRealtime } from '@point/server';
import { rooms } from '@point/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN } from './test-env.js';
import { SEED_IDS, createTestApp, type SeedUserKey, type TestApp } from './harness.js';

const U = SEED_IDS.users;

// PNT-064: Socket.IO gateway, protected rooms decided by the server, forced logout.
describe('realtime gateway /ws', () => {
  let t: TestApp;
  let url: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    await t.app.listen(0);
    const addr = t.app.getHttpServer().address();
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await t.close();
  });

  const connect = async (as: SeedUserKey | null, origin = ORIGIN): Promise<Socket> => {
    const s = io(url, {
      path: '/ws',
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { origin, ...(as ? { cookie: await t.sessionFor(as) } : {}) },
    });
    sockets.push(s);
    return s;
  };
  const connected = (s: Socket) =>
    new Promise<void>((resolve, reject) => {
      s.once('connect', () => resolve());
      s.once('connect_error', (e: any) => reject(e));
    });
  const publish = (r: string[], event: string, data: Record<string, unknown> = {}) =>
    t.db.transaction((tx) =>
      publishRealtime(tx, SEED_IDS.org, r, { event, id: globalThis.crypto.randomUUID(), data }),
    );
  const next = (s: Socket, event: string, ms = 1500) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${event}`)), ms);
      s.once(event, (m: any) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  const none = (s: Socket, event: string, ms = 400) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), ms);
      s.once(event, () => {
        clearTimeout(timer);
        reject(new Error(`unexpected ${event}`));
      });
    });

  it('refuses a handshake without a session (AUTH_UNAUTHENTICATED) or from another origin', async () => {
    const anon = await connect(null);
    await expect(connected(anon)).rejects.toMatchObject({ data: { code: 'AUTH_UNAUTHENTICATED' } });
    const evil = await connect('DRV1', 'https://evil.example');
    await expect(connected(evil)).rejects.toBeTruthy();
  });

  it('delivers to the user room with the canon §7 envelope', async () => {
    const s = await connect('DRV1');
    await connected(s);
    const p = next(s, 'sync.required');
    await publish([rooms.user(U.DRV1)], 'sync.required', { reason: 'test' });
    const m = await p;
    expect(m).toMatchObject({ type: 'sync.required', org_id: SEED_IDS.org, payload: { reason: 'test' } });
    expect(m.id).toBeTruthy();
  });

  it('venue rooms are scoped: SUP-R (RMS) does not receive LYL supervisor traffic', async () => {
    const rms = await connect('SUP-R');
    const both = await connect('SUP-RL');
    await Promise.all([connected(rms), connected(both)]);
    const got = next(both, 'alert.raised');
    const quiet = none(rms, 'alert.raised');
    await publish([rooms.venueSupervisors(SEED_IDS.venues.LYL)], 'alert.raised', { type: 'test' });
    await got;
    await quiet;
  });

  it('pool rooms follow the open duty session; a nobody-asked join is impossible', async () => {
    const s = await connect('DRV5');
    await connected(s);
    const quiet = none(s, 'task.claimed');
    await publish([rooms.poolDrivers(SEED_IDS.pools['POOL-R'])], 'task.claimed', { task_id: 'x' });
    await quiet;
    await t.db.query(
      `INSERT INTO duty_sessions (org_id, user_id, shift_id, venue_id, dispatch_pool_id, assignment_id, status, available_since, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'on_duty', now(), now())`,
      [
        SEED_IDS.org,
        U.DRV5,
        SEED_IDS.shifts['SHF-R'],
        SEED_IDS.venues.RMS,
        SEED_IDS.pools['POOL-R'],
        SEED_IDS.assignments.DRV5,
      ],
    );
    const synced = next(s, 'driver.state_changed');
    await publish([rooms.user(U.DRV5)], 'driver.state_changed', { driver_state: 'available' }); // membership re-evaluated
    await synced;
    await new Promise((r) => setTimeout(r, 100));
    const got = next(s, 'task.claimed');
    await publish([rooms.poolDrivers(SEED_IDS.pools['POOL-R'])], 'task.claimed', { task_id: 'y' });
    expect((await got).payload.task_id).toBe('y');
  });

  it('disabling a driver sends session.revoked (reason disabled) and disconnects only revoked sessions', async () => {
    const s = await connect('DRV6');
    await connected(s);
    const revoked = next(s, 'session.revoked');
    const gone = new Promise<void>((r) => s.once('disconnect', () => r()));
    const res = await t.command('post', `/v1/drivers/${U.DRV6}/disable`, {
      as: 'ADM1',
      body: { reason: 'اختبار الإخراج' },
    });
    expect(res.status).toBe(200);
    expect((await revoked).payload.reason).toBe('disabled');
    await gone;
  });

  it('client.heartbeat is acknowledged with the server time', async () => {
    const s = await connect('DRV2');
    await connected(s);
    const ack: any = await s.timeout(2000).emitWithAck('client.heartbeat', {
      visible: true,
      audio_unlocked: true,
      last_event_id: null,
      app_version: 'test',
    });
    expect(ack.data.server_time).toBeTruthy();
    const seen: any = await s
      .timeout(2000)
      .emitWithAck('client.offer_seen', { offer_id: '00000000-0000-4000-8000-000000000999' });
    expect(seen.data.ok).toBe(true);
  });
});

// realtime:RT-6 (07 §4.1 polling fallback): browsers send no Origin on a same-origin GET (Fetch standard), which
// is what the Engine.IO polling handshake is; the server takes Sec-Fetch-Site: same-origin plus a valid session
// instead. A WebSocket upgrade keeps the strict Origin check.
describe('realtime gateway /ws — long-polling handshake without Origin (WS_TRANSPORTS=websocket,polling)', () => {
  let t: TestApp;
  let base: string;

  beforeAll(async () => {
    t = await createTestApp({ env: { WS_TRANSPORTS: 'websocket,polling' } });
    await t.app.listen(0);
    const addr = t.app.getHttpServer().address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });
  afterAll(async () => t.close());

  const handshake = async (headers: Record<string, string>) => {
    const r = await fetch(`${base}/ws/?EIO=4&transport=polling`, { headers });
    return { status: r.status, body: await r.text() };
  };

  it('same-origin fetch metadata + a valid session → 200 with the open packet', async () => {
    const cookie = await t.sessionFor('DRV1');
    const r = await handshake({ cookie, 'sec-fetch-site': 'same-origin' });
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/^0\{"sid":/);
    // the matching Origin keeps working
    expect((await handshake({ cookie, origin: ORIGIN })).status).toBe(200);
  });

  it('no Origin is refused when the request is cross-site, has no fetch metadata, or has no valid session', async () => {
    const cookie = await t.sessionFor('DRV1');
    expect((await handshake({ cookie, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await handshake({ cookie, 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await handshake({ cookie })).status).toBe(403);
    expect((await handshake({ 'sec-fetch-site': 'same-origin' })).status).toBe(403);
    const forged = cookie.replace(/=.*$/, '=not-a-session');
    expect((await handshake({ cookie: forged, 'sec-fetch-site': 'same-origin' })).status).toBe(403);
  });

  it('a mismatching Origin is refused even with same-origin fetch metadata; a WebSocket without Origin is refused', async () => {
    const cookie = await t.sessionFor('DRV1');
    expect(
      (await handshake({ cookie, origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' })).status,
    ).toBe(403);
    const s = io(base, {
      path: '/ws',
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { cookie, 'sec-fetch-site': 'same-origin' },
    });
    try {
      await expect(
        new Promise<void>((resolve, reject) => {
          s.once('connect', () => resolve());
          s.once('connect_error', (e: unknown) => reject(e));
        }),
      ).rejects.toBeTruthy();
    } finally {
      s.close();
    }
  });
});
