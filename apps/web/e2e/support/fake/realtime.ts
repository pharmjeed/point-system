/**
 * The fake backend's `/ws` (e2e only): a tiny Socket.IO v5 / Engine.IO v4 server spoken over Playwright's
 * `page.routeWebSocket`, so the app's real socket.io-client runs against it (07 §4). It answers the handshake,
 * `client.heartbeat` and `client.offer_seen` with acks, and delivers canon §7 envelopes to the sockets of a
 * user. Off by default: a spec turns it on with `fake.realtime.enable()`; otherwise every connection is
 * refused at once and the app keeps polling (as before PNT-065).
 *
 * With `auto` on (the default once enabled), the hub follows the fake world after every request: for each
 * connected driver it compares the head offer, the current/next task cards and the driver state with what it
 * last delivered and publishes what the API's planners would (`task.offered` / `task.broadcast`,
 * `task.claimed`, `offer.closed`, `task.updated`, `driver.state_changed`) with their aggregate versions.
 */
import type { Page, WebSocketRoute } from '@playwright/test';
import { uuid } from './http';
import type { FakeServer, Session } from './server';
import { SEED_IDS } from './seed';

/** What one driver sees (the parts the API publishes realtime messages for). */
export interface LiveView {
  offer: (Record<string, any> & { offer_id: string; task_id: string; mode: string }) | null;
  tasks: Array<Record<string, any> & { task: { id: string; version: number; status: string; type: string } }>;
  driverState: string;
  poolId: string | null;
  venueId: string | null;
}

interface Conn {
  ws: WebSocketRoute;
  session: Session;
  connected: boolean;
  sid: string;
}

export interface Delivered {
  userId: string;
  type: string;
  frame: Record<string, any>;
  at: number;
}

const OPEN = (sid: string) =>
  `0${JSON.stringify({ sid, upgrades: [], pingInterval: 600_000, pingTimeout: 600_000, maxPayload: 1_000_000 })}`;

export class FakeRealtime {
  enabled = false;
  /** Follow the world and publish what changed (see the file comment). */
  auto = true;
  /** New connections are refused (the server is unreachable). */
  down = false;
  /** Heartbeats are received but never acknowledged (late confirmations: «الاتصال غير مؤكد»). */
  silentAcks = false;
  /** Users whose deliveries are lost (the frames are never sent). */
  readonly muted = new Set<string>();
  readonly heartbeats: Array<{ userId: string | null; payload: any; at: number }> = [];
  readonly offersSeen: Array<{ userId: string | null; payload: any }> = [];
  readonly delivered: Delivered[] = [];
  readonly connections: Conn[] = [];
  private readonly views = new Map<string, LiveView>();

  constructor(private readonly server: FakeServer) {}

  enable(options: { auto?: boolean } = {}): this {
    this.enabled = true;
    if (options.auto !== undefined) this.auto = options.auto;
    return this;
  }

  /** Routes the page's `/ws` (WebSocket and the polling fallback) to this hub. */
  async attach(page: Page, session: Session): Promise<void> {
    await page.routeWebSocket(
      (url) => url.pathname.startsWith('/ws'),
      (ws) => this.accept(ws, session),
    );
    // the long-polling fallback is not offered by this hub (the API default is websocket only)
    await page.route(
      (url) => url.pathname.startsWith('/ws'),
      (route) => route.fulfill({ status: 400, contentType: 'application/json', body: '{"code":0}' }),
    );
  }

  private accept(ws: WebSocketRoute, session: Session): void {
    if (!this.enabled || this.down) {
      ws.close({ code: 1011, reason: 'unavailable' });
      return;
    }
    const conn: Conn = { ws, session, connected: false, sid: uuid() };
    this.connections.push(conn);
    ws.send(OPEN(conn.sid));
    ws.onMessage((message) => this.onMessage(conn, String(message)));
    ws.onClose(() => this.forget(conn));
  }

  private forget(conn: Conn): void {
    const i = this.connections.indexOf(conn);
    if (i >= 0) this.connections.splice(i, 1);
  }

  private onMessage(conn: Conn, message: string): void {
    if (message === '3' || message === '2') {
      if (message === '2') conn.ws.send('3');
      return;
    }
    if (message.startsWith('40')) {
      if (!conn.session.userId) {
        conn.ws.send(
          `44${JSON.stringify({ message: 'AUTH_UNAUTHENTICATED', data: { code: 'AUTH_UNAUTHENTICATED' } })}`,
        );
        return;
      }
      conn.connected = true;
      conn.ws.send(`40${JSON.stringify({ sid: uuid() })}`);
      this.views.set(conn.session.userId, this.viewOf(conn.session.userId));
      return;
    }
    if (message === '41') {
      conn.connected = false;
      return;
    }
    const m = /^42(\d*)(\[.*\])$/s.exec(message);
    if (!m) return;
    const ackId = m[1];
    const [event, payload] = JSON.parse(m[2] as string) as [string, unknown];
    const userId = conn.session.userId;
    const ack = (data: unknown) => {
      if (ackId) conn.ws.send(`43${ackId}${JSON.stringify([data])}`);
    };
    if (event === 'client.heartbeat') {
      this.heartbeats.push({ userId, payload, at: Date.now() });
      if (this.silentAcks) return;
      ack({
        data: { server_time: new Date().toISOString(), connection_state: 'online', sync_required: false },
      });
    } else if (event === 'client.offer_seen') {
      this.offersSeen.push({ userId, payload });
      ack({ data: { ok: true } });
    }
  }

  // ---------------------------------------------------------------- delivery

  /** The canon §7 envelope of a server event (07 §4.2). */
  envelope(
    type: string,
    payload: Record<string, unknown>,
    extra: {
      aggregate?: { type: string; id: string; version: number | null } | null;
      venueId?: string | null;
      poolId?: string | null;
    } = {},
  ): Record<string, any> {
    return {
      id: uuid(),
      type,
      occurred_at: new Date().toISOString(),
      org_id: SEED_IDS.org,
      venue_id: extra.venueId ?? null,
      dispatch_pool_id: extra.poolId ?? null,
      event_id: null,
      aggregate: extra.aggregate ?? null,
      actor: { type: 'system', id: null },
      payload,
    };
  }

  /** Sends a frame to every connected socket of a user (unless muted). */
  sendTo(userId: string, frame: Record<string, any>): number {
    if (this.muted.has(userId)) return 0;
    let n = 0;
    for (const c of this.connections) {
      if (!c.connected || c.session.userId !== userId) continue;
      c.ws.send(`42${JSON.stringify([frame.type, frame])}`);
      n += 1;
    }
    if (n) this.delivered.push({ userId, type: frame.type, frame, at: Date.now() });
    return n;
  }

  /** A spec's explicit event for a seeded user (`sync.required`, `channel.status`, `session.revoked`…). */
  emit(
    userKey: string,
    type: string,
    payload: Record<string, unknown>,
    extra: Parameters<FakeRealtime['envelope']>[2] = {},
  ): Record<string, any> {
    const user = this.server.userByKey(userKey as never);
    const frame = this.envelope(type, payload, extra);
    this.sendTo(user.id, frame);
    return frame;
  }

  /** Closes the sockets of a user (or all): the client sees a dropped connection and reconnects. */
  drop(userKey?: string): void {
    const userId = userKey ? this.server.userByKey(userKey as never).id : null;
    for (const c of [...this.connections]) {
      if (userId && c.session.userId !== userId) continue;
      c.connected = false;
      void c.ws.close({ code: 1006, reason: 'dropped' }).catch(() => undefined);
      this.forget(c);
    }
  }

  /**
   * The server's `socket.disconnect(true)` (realtime-server.ts after `session.revoked` or a failed
   * revalidation): a Socket.IO DISCONNECT packet (`41`). The client sees `io server disconnect`, which
   * Socket.IO never reconnects by itself.
   */
  serverDisconnect(userKey?: string): number {
    const userId = userKey ? this.server.userByKey(userKey as never).id : null;
    let n = 0;
    for (const c of this.connections) {
      if (!c.connected || (userId && c.session.userId !== userId)) continue;
      c.connected = false;
      c.ws.send('41');
      n += 1;
    }
    return n;
  }

  /** A hub without the stateful fake (the static MockApi of the staff specs): explicit events only. */
  static standalone(): FakeRealtime {
    const stub = {
      userByKey: (key: string) => ({ id: key }),
      world: { offers: [], tasks: [], users: [] },
    };
    return new FakeRealtime(stub as unknown as FakeServer).enable({ auto: false });
  }

  connectedUsers(): string[] {
    return [...new Set(this.connections.filter((c) => c.connected).map((c) => c.session.userId))].filter(
      (u): u is string => !!u,
    );
  }

  // ---------------------------------------------------------------- following the world

  private viewOf(userId: string): LiveView {
    return (
      this.server.liveView?.(userId) ?? {
        offer: null,
        tasks: [],
        driverState: 'off_duty',
        poolId: null,
        venueId: null,
      }
    );
  }

  /** Called by the fake after every request: publishes what changed for each connected driver. */
  afterChange(): void {
    if (!this.enabled || !this.auto) return;
    for (const userId of this.connectedUsers()) {
      const before = this.views.get(userId);
      const after = this.viewOf(userId);
      this.views.set(userId, after);
      if (!before) continue;
      this.publishDiff(userId, before, after);
    }
  }

  private publishDiff(userId: string, before: LiveView, after: LiveView): void {
    const w = this.server.world;
    const where = { venueId: after.venueId ?? before.venueId, poolId: after.poolId ?? before.poolId };
    // 1. the head round that left: claimed by someone else, or closed (expired, revoked)
    const gone = before.offer && before.offer.offer_id !== after.offer?.offer_id ? before.offer : null;
    if (gone) {
      const offer = w.offers.find((o) => o.id === gone.offer_id);
      const task = w.tasks.find((k) => k.id === gone.task_id);
      if (offer && offer.status === 'accepted' && offer.accepted_by !== userId && task) {
        const by = w.users.find((u) => u.id === offer.accepted_by);
        this.sendTo(
          userId,
          this.envelope(
            'task.claimed',
            {
              cause: 'task.claimed',
              task_id: task.id,
              offer_ids: [offer.id],
              result: task.status === 'assigned_waiting' ? 'assigned_waiting' : 'accepted',
              claimed_by: by ? { id: by.id, full_name: by.full_name } : null,
            },
            { ...where, aggregate: { type: 'task', id: task.id, version: task.version } },
          ),
        );
      } else if (offer && offer.status !== 'active' && offer.status !== 'accepted') {
        this.sendTo(
          userId,
          this.envelope(
            'offer.closed',
            {
              cause: offer.status === 'expired' ? 'offer.expired' : 'offer.revoked',
              offer_id: offer.id,
              task_id: offer.task_id,
              close_reason: offer.close_reason ?? offer.status,
            },
            { ...where, aggregate: { type: 'task_offer', id: offer.id, version: offer.version + 1 } },
          ),
        );
      }
    }
    // 2. task cards that changed (newer version), appeared or left this driver
    const beforeById = new Map(before.tasks.map((c) => [c.task.id, c]));
    const afterById = new Map(after.tasks.map((c) => [c.task.id, c]));
    for (const [id, card] of afterById) {
      const old = beforeById.get(id);
      if (old && old.task.version >= card.task.version) continue;
      // the API's causes (dispatch/application/realtime.ts): the promotion of the reserved next task, the
      // repark task of a supervisor's cancel after the movement (DEC-30), this driver's claim, a step
      const cause = old
        ? old.task.status === 'assigned_waiting' && card.task.status !== 'assigned_waiting'
          ? 'task.promoted'
          : 'task.started'
        : card.task.type === 'repark'
          ? 'ticket.reparking'
          : 'task.claimed';
      this.sendTo(
        userId,
        this.envelope(
          'task.updated',
          { cause, ...card },
          { ...where, aggregate: { type: 'task', id, version: card.task.version } },
        ),
      );
    }
    for (const [id] of beforeById) {
      if (afterById.has(id)) continue;
      const card = this.server.taskCardOf?.(id, userId);
      if (!card) continue;
      this.sendTo(
        userId,
        this.envelope(
          'task.updated',
          { cause: card.task.status === 'canceled' ? 'task.canceled' : 'task.completed', ...card },
          { ...where, aggregate: { type: 'task', id, version: card.task.version } },
        ),
      );
    }
    // 3. a new head round
    if (after.offer && after.offer.offer_id !== before.offer?.offer_id) {
      const offer = w.offers.find((o) => o.id === after.offer?.offer_id);
      const single = after.offer.mode === 'single';
      this.sendTo(
        userId,
        this.envelope(
          single ? 'task.offered' : 'task.broadcast',
          { cause: single ? 'task.offered' : 'task.broadcast_opened', ...after.offer },
          {
            ...where,
            aggregate: { type: 'task_offer', id: after.offer.offer_id, version: offer?.version ?? 1 },
          },
        ),
      );
    }
    // 4. the driver state (descriptive: no version)
    if (before.driverState !== after.driverState) {
      const u = w.users.find((x) => x.id === userId);
      this.sendTo(
        userId,
        this.envelope(
          'driver.state_changed',
          {
            cause: 'driver.availability_changed',
            driver: { id: userId, full_name: u?.full_name ?? '', employee_code: u?.employee_code ?? '' },
            driver_state: after.driverState,
          },
          { ...where, aggregate: { type: 'user', id: userId, version: null } },
        ),
      );
    }
  }
}
