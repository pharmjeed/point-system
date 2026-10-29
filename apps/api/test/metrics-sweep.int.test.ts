import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { io, type Socket } from 'socket.io-client';
import { metrics, publishRealtime } from '@point/server';
import { rooms } from '@point/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDuty } from './dispatch-fixtures.js';
import { CSRF, ORIGIN } from './test-env.js';
import { SEED_IDS, createTestApp, type SeedUserKey, type TestApp } from './harness.js';
import { realtimeOf } from '../src/bootstrap.js';

type Sample = { labels: Record<string, unknown>; value: number; metricName?: string };
type Readable = { get(): Promise<{ values: Sample[] }> };

/** `_count` / `_sum` of a histogram (all label sets matching `labels`), or the value of a counter. */
const read = async (
  m: Readable,
  suffix: '_count' | '_sum' | '' = '_count',
  labels: Record<string, string> = {},
) =>
  (await m.get()).values
    .filter((v) => (suffix ? v.metricName?.endsWith(suffix) : true))
    .filter((v) => Object.entries(labels).every(([k, x]) => v.labels[k] === x))
    .reduce((s, v) => s + v.value, 0);

const until = async (check: () => Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/**
 * Server sweep (05 §12.2): the metrics that were registered but never set are now populated by the running api —
 * `point_http_request_duration_seconds`, `point_db_lock_wait_seconds`, `point_dispatch_pool_lock_wait_seconds`,
 * `point_dispatch_publish_seconds`, `point_ws_reconnects_total`.
 */
describe('05 §12.2 metrics populated by the api', () => {
  let t: TestApp;
  let url: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    await t.app.listen(0, '127.0.0.1');
    const addr = t.app.getHttpServer().address();
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await t.close();
  });

  it('point_http_request_duration_seconds{route,status}: the route template and the status, never an id', async () => {
    expect((await t.get('/v1/me', 'DRV1')).status).toBe(200);
    const id = randomUUID();
    expect((await t.get(`/v1/tickets/${id}`, 'SUP-R')).status).toBe(404);
    expect((await t.http().get(`/v1/no-such-route/${id}`)).status).toBe(404);
    expect((await t.http().post('/v1/me/duty/start').send({})).status).toBe(403); // no CSRF header
    expect(await read(metrics.httpDuration, '_count', { route: 'GET /v1/me', status: '200' })).toBe(1);
    expect(
      await read(metrics.httpDuration, '_count', { route: 'GET /v1/tickets/{ticketId}', status: '404' }),
    ).toBe(1);
    expect(await read(metrics.httpDuration, '_count', { route: 'unmatched', status: '404' })).toBe(1);
    expect(
      await read(metrics.httpDuration, '_count', { route: 'POST /v1/me/duty/start', status: '403' }),
    ).toBe(1);
    const routes = (await metrics.httpDuration.get()).values.map((v) => String(v.labels.route));
    expect(routes.filter((r) => /[0-9a-f]{8}-[0-9a-f]{4}/.test(r))).toEqual([]);
  });

  it('a request the client gave up on is timed once, as status aborted (Node emits no finish then)', async () => {
    const route = 'POST /v1/me/duty/start';
    const aborted = () => read(metrics.httpDuration, '_count', { route, status: 'aborted' });
    const before = await aborted();
    const holder = new pg.Client({ connectionString: t.db.config.connectionString });
    await holder.connect();
    await holder.query('BEGIN');
    try {
      // every pool row is held: the duty start waits at L1 (lock_timeout 3 s) while the client gives up after 200 ms
      await holder.query(`SELECT 1 FROM dispatch_pools FOR UPDATE`);
      await expect(
        t
          .http()
          .post('/v1/me/duty/start')
          .set(CSRF)
          .set('Cookie', await t.sessionFor('DRV2'))
          .set('Idempotency-Key', randomUUID())
          .send({})
          .timeout(200),
      ).rejects.toThrow(/Timeout/);
      await until(async () => (await aborted()) === before + 1);
      const sum = await read(metrics.httpDuration, '_sum', { route, status: 'aborted' });
      expect(sum).toBeGreaterThan(0.15);
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    // the command then commits and answers into the closed socket: still one observation
    await new Promise((r) => setTimeout(r, 300));
    expect(await aborted()).toBe(before + 1);
  });

  it('point_db_lock_wait_seconds and point_dispatch_pool_lock_wait_seconds: the canonical locks of a command are timed', async () => {
    const locks = await read(metrics.dbLockWait);
    const pool = await read(metrics.dispatchPoolLockWait);
    const r = await startDuty(t, 'DRV1');
    expect(r.status).toBe(201);
    expect(await read(metrics.dispatchPoolLockWait)).toBeGreaterThan(pool); // L1 of the duty start
    expect(await read(metrics.dbLockWait)).toBeGreaterThan(locks);
    expect(await read(metrics.dbLockWait)).toBeGreaterThanOrEqual(
      locks + ((await read(metrics.dispatchPoolLockWait)) - pool),
    ); // every pool lock is a lock
  });

  it('point_dispatch_publish_seconds: offers and assignments, from the producing transaction to the socket emit', async () => {
    const before = await read(metrics.dispatchPublish);
    const sumBefore = await read(metrics.dispatchPublish, '_sum');
    const occurred = new Date(t.clock.now().getTime() - 1200).toISOString(); // 1.2 s before the relay
    const room = [rooms.user(SEED_IDS.users.DRV3)];
    const msg = (event: string, data: Record<string, unknown> = {}) => ({
      event,
      id: randomUUID(),
      data: { cause: event, ...data },
      occurred_at: occurred,
    });
    await t.db.transaction(async (tx) => {
      await publishRealtime(tx, SEED_IDS.org, room, msg('ticket.updated')); // not dispatch
      await publishRealtime(tx, SEED_IDS.org, room, msg('task.updated', { cause: 'task.promoted' })); // not an assignment
      await publishRealtime(tx, SEED_IDS.org, room, msg('task.offered'));
      await publishRealtime(tx, SEED_IDS.org, room, msg('task.broadcast'));
      await publishRealtime(tx, SEED_IDS.org, room, msg('task.updated', { cause: 'task.claimed' }));
      await publishRealtime(tx, SEED_IDS.org, room, msg('task.claimed'));
    });
    await until(async () => (await read(metrics.dispatchPublish)) >= before + 4);
    await new Promise((r) => setTimeout(r, 150)); // nothing else arrives
    expect(await read(metrics.dispatchPublish)).toBe(before + 4);
    expect((await read(metrics.dispatchPublish, '_sum')) - sumBefore).toBeCloseTo(4 * 1.2, 5);
  });

  it('point_ws_reconnects_total: the same session back within 10 minutes of losing its socket', async () => {
    const connect = async (as: SeedUserKey) => {
      const s = io(url, {
        path: '/ws',
        transports: ['websocket'],
        reconnection: false,
        extraHeaders: { origin: ORIGIN, cookie: await t.sessionFor(as) },
      });
      sockets.push(s);
      await new Promise<void>((resolve, reject) => {
        s.once('connect', () => resolve());
        s.once('connect_error', (e) => reject(e));
      });
      return s;
    };
    const close = async (s: Socket) => {
      const open = await read(metrics.wsConnections, '');
      s.close();
      await until(async () => (await read(metrics.wsConnections, '')) < open); // the server saw it go
    };
    const start = await read(metrics.wsReconnects, '');
    const first = await connect('SUP-R');
    expect(await read(metrics.wsReconnects, '')).toBe(start); // a first connection
    await close(first);
    t.clock.advanceSeconds(30);
    const again = await connect('SUP-R');
    expect(await read(metrics.wsReconnects, '')).toBe(start + 1);
    await connect('SUP-RL'); // another session's first connection
    expect(await read(metrics.wsReconnects, '')).toBe(start + 1);
    await close(again);
    t.clock.advanceSeconds(11 * 60); // beyond RECONNECT_WINDOW_MS: a new visit, not a reconnection
    await connect('SUP-R');
    expect(await read(metrics.wsReconnects, '')).toBe(start + 1);
  });

  it('point_ws_connections{venue}: a connection is counted down on the label it was counted up with', async () => {
    const at = (venue: string) => read(metrics.wsConnections, '', { venue }).then((n) => n);
    const s = io(url, {
      path: '/ws',
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { origin: ORIGIN, cookie: await t.sessionFor('DRV5') },
    });
    sockets.push(s);
    await new Promise<void>((resolve, reject) => {
      s.once('connect', () => resolve());
      s.once('connect_error', (e) => reject(e));
    });
    const server = realtimeOf(t.app)!;
    const live = [...server.io!.of('/').sockets.values()].find(
      (x) => x.data?.actor?.userId === SEED_IDS.users.DRV5,
    )!;
    const venue = (live.data.actor.venueId as string | null) ?? 'none';
    const counted = await at(venue);
    expect(counted).toBeGreaterThanOrEqual(1);
    // the actor is re-read while the socket lives (assignment or scope changed): another venue now
    live.data.actor = { ...live.data.actor, venueId: '00000000-0000-4000-8000-00000000beef' };
    s.close();
    await until(async () => (await at(venue)) === counted - 1);
    expect(await at('00000000-0000-4000-8000-00000000beef')).toBe(0); // no −1 series elsewhere
  });
});
