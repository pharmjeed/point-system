import {
  createLogger,
  dispatchJobs,
  emitEvent,
  MemoryPushSender,
  notificationsJobs,
  OutboxDispatcher,
  PushRuntime,
  type DomainEventInput,
  type RecordedPush,
} from '@point/server';
import { createSessionCookie } from '@point/server/testing';
import pg from 'pg';
import request from 'supertest';
import { createS2App, ok, U } from './dispatch-fixtures.js';
import { CSRF } from './test-env.js';
import type { TestApp } from './harness.js';

export const silent = createLogger({ level: 'silent' });

export interface PushDevice {
  deviceId: string;
  endpoint: string;
  cookie: string;
  sessionId: string;
}

/** One relayed publication as the API instances receive it from `point_realtime` (DEC-48). */
export interface Note {
  org_id: string;
  rooms: string[];
  message: {
    event: string;
    id: string;
    data: Record<string, any>;
    aggregate?: { type: string; id: string; version: number | null };
    occurred_at: string;
    venue_id?: string | null;
    dispatch_pool_id?: string | null;
    event_id?: string | null;
    actor?: { type: string; id: string | null };
  };
}

export interface PushTestApp extends TestApp {
  push: MemoryPushSender;
  rt: PushRuntime;
  dispatcher: OutboxDispatcher;
  /** Runs every due outbox row (domain events and jobs) until nothing is due. */
  drain(): Promise<number>;
  /** Moves the clock and drains. */
  advance(seconds: number): Promise<void>;
  /** A device of `user` with a granted permission and a Push subscription, on a session of its own. */
  device(
    user: string,
    opts?: { permission?: 'granted' | 'denied' | 'default'; subscribe?: boolean },
  ): Promise<PushDevice>;
  /** Pushes recorded by the dev/test sender for an endpoint (payloads parsed). */
  sentTo(endpoint: string): RecordedPush[];
  /** Emits domain events in one transaction (planners run before COMMIT, as in a command). */
  emit(...events: DomainEventInput[]): Promise<void>;
  notes: Note[];
  /** Publications relayed since the last `clearNotes()`, after a short settle. */
  published(event?: string): Promise<Note[]>;
  clearNotes(): void;
}

let endpointSeq = 0;

/**
 * Web Push + realtime harness (PNT-072, PNT-064 planners): the S2 app, the worker's OutboxDispatcher with the
 * real `job.push_send` (dev/test sender, no network), the dispatch timers, and a LISTEN client on
 * `point_realtime` that records every committed publication.
 */
export async function createPushTestApp(): Promise<PushTestApp> {
  const t = await createS2App();
  const push = new MemoryPushSender({ clock: t.clock });
  const rt = new PushRuntime({ env: t.env, sender: push, logger: silent });
  const dispatcher = new OutboxDispatcher(t.db, t.clock, silent, {
    workerId: 'push-test-worker',
    batchSize: 50,
    concurrency: 1,
  });
  for (const h of [...notificationsJobs({ push: rt }), ...dispatchJobs()]) dispatcher.register(h);

  const notes: Note[] = [];
  const listener = new pg.Client({ connectionString: t.tdb.url });
  await listener.connect();
  listener.on('notification', (n) => {
    if (n.channel === 'point_realtime' && n.payload) notes.push(JSON.parse(n.payload));
  });
  await listener.query('LISTEN point_realtime');

  const w: PushTestApp = {
    ...t,
    push,
    rt,
    dispatcher,
    drain: () => dispatcher.drain(200),
    async advance(seconds) {
      t.clock.advanceSeconds(seconds);
      await dispatcher.drain(200);
    },
    async device(user, opts = {}) {
      const userId = (U as Record<string, string>)[user] ?? user;
      const s = await createSessionCookie(t.db, userId, { now: t.clock.now(), hours: 48 });
      const reg = await request(t.app.getHttpServer())
        .post('/v1/me/devices')
        .set(CSRF)
        .set('Cookie', s.cookie)
        .send({
          platform: 'android',
          display_mode: 'standalone',
          notification_permission: opts.permission ?? 'granted',
        });
      const deviceId = ok(reg as never, 201).id as string;
      const endpoint = `https://push.test/${user}/${++endpointSeq}`;
      if (opts.subscribe ?? true) {
        const upd = await request(t.app.getHttpServer())
          .put(`/v1/me/devices/${deviceId}`)
          .set(CSRF)
          .set('Cookie', s.cookie)
          .send({
            push_subscription: { endpoint, keys: { p256dh: 'BTestP256dhKey', auth: 'testAuthSecret' } },
          });
        ok(upd as never);
      }
      return { deviceId, endpoint, cookie: s.cookie, sessionId: s.sessionId };
    },
    sentTo: (endpoint) => push.sent.filter((p) => p.endpoint === endpoint),
    async emit(...events) {
      await t.db.transaction(async (tx) => {
        for (const e of events) await emitEvent(tx, e);
      });
    },
    notes,
    async published(event) {
      await new Promise((r) => setTimeout(r, 80));
      return event ? notes.filter((n) => n.message.event === event) : [...notes];
    },
    clearNotes: () => {
      notes.length = 0;
    },
    async close() {
      await listener.end().catch(() => {});
      await t.close();
    },
  };
  return w;
}

/** The push notifications of a device, oldest first. */
export async function pushRows(t: TestApp, deviceId: string) {
  return (
    await t.db.query(
      `SELECT id, purpose, status, skipped_reason, dedupe_key, task_id, ticket_id, venue_id, attempts, last_error_code,
              recipient_user_id
         FROM notifications WHERE channel = 'push' AND recipient_device_id = $1 ORDER BY created_at, id`,
      [deviceId],
    )
  ).rows;
}
