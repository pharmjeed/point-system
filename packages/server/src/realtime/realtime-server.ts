import type { IncomingMessage, Server as HttpServer } from 'node:http';
import pg from 'pg';
import { Server, type Socket } from 'socket.io';
import { rooms as roomNames } from '@point/shared';
import { CUSTOMER_REALTIME_NAMESPACE, customerRoom } from '@point/shared/customer';
import type { ActorContext } from '../core/actor-context/actor-context.js';
import { loadActor } from '../core/actor-context/actor-loader.js';
import {
  bearerToken,
  checkCustomerSocketSession,
  customerTokenSession,
  loadCustomerActor,
  type CustomerActorContext,
} from '../core/actor-context/customer-actor.js';
import type { Clock } from '../core/clock/clock.js';
import type { Env } from '../core/config/env.js';
import type { Database } from '../core/db/database.js';
import type { Tx } from '../core/db/tx.js';
import { asAppError } from '../core/errors/app-error.js';
import { dbUnavailableError } from '../core/errors/pg-constraint-map.js';
import type { Logger } from '../core/logging/logger.js';
import { metrics } from '../core/metrics/metrics.js';
import { REALTIME_NOTIFY_CHANNEL, type RealtimeMessage } from '../core/realtime/realtime-publisher.js';

/** Socket events that publish an offer or an assignment (07 §4.3), timed into point_dispatch_publish_seconds. */
const DISPATCH_PUBLISH_EVENTS: ReadonlySet<string> = new Set([
  'task.offered',
  'task.broadcast',
  'task.claimed',
]);
/** `task.updated` causes that are an assignment: the winner's copy of a claim (DEC-220) and a reassignment. */
const ASSIGNMENT_CAUSES: ReadonlySet<string> = new Set(['task.claimed', 'task.reassigned']);
/** A session's new socket within this long of losing its previous one is a reconnection. */
export const RECONNECT_WINDOW_MS = 10 * 60_000;
const RECONNECT_TRACKED_SESSIONS = 10_000;

export interface HeartbeatPayload {
  visible: boolean;
  audio_unlocked: boolean;
  last_event_id?: string | null;
  app_version?: string;
}

/** `client.offer_seen` (07 §4: `{offer_id}`; `receive_latency_ms` optional, 15 §9.4). */
export interface OfferSeenPayload {
  offer_id?: string;
  receive_latency_ms?: number;
}

export interface RealtimeDeps {
  db: Database;
  clock: Clock;
  env: Env;
  logger: Logger;
  /** runs the heartbeat inside a transaction (identity's MeService.heartbeat) */
  heartbeat?: (
    tx: Tx,
    actor: ActorContext,
    body: HeartbeatPayload & { ws_connected: boolean },
  ) => Promise<unknown>;
  /**
   * records `client.offer_seen` inside a transaction: `seen_at` + the `offer_card_seen` analytics row
   * (audit-monitoring's TelemetryIngest.recordOfferSeen, 15 §9.4); without it only `seen_at` is filled
   */
  offerSeen?: (tx: Tx, actor: ActorContext, payload: OfferSeenPayload) => Promise<unknown>;
  revalidateEveryMs?: number;
}

interface SocketData {
  token: string;
  actor: ActorContext;
  rooms: Set<string>;
}

/** A socket of the customer namespace (V2-015, DEC-520): the account's session, one room. */
interface CustomerSocketData {
  customer: CustomerActorContext;
}

/** Rooms of the customer namespace start with this; nothing else is ever emitted there. */
const CUSTOMER_ROOM_PREFIX = customerRoom('');

/**
 * The customer app's handshake (DEC-520): a native client (no Origin, or its own) carrying a customer access token
 * as `Authorization: Bearer pca.…`. A web page cannot put that header on a WebSocket, and a cross-site request with
 * it still needs the token itself — a header, never an ambient credential — so the origin rule of the staff app
 * (CSWSH, 09 §7) has nothing to protect here (the same reasoning as DEC-497 for the HTTP routes).
 */
function customerHandshake(req: IncomingMessage): boolean {
  return customerTokenSession('access', bearerToken(req.headers.authorization)) !== null;
}

/** Rooms are decided by the server only (canon §7.3, 09 §7, 11 §9.1). */
export function roomsFor(a: ActorContext): Set<string> {
  const out = new Set<string>([roomNames.user(a.userId)]);
  if (a.duty) out.add(roomNames.poolDrivers(a.duty.poolId));
  if (a.role === 'supervisor' || a.role === 'admin' || a.role === 'owner') {
    for (const v of a.venueIds) out.add(roomNames.venueSupervisors(v));
  }
  if (a.role === 'admin' || a.role === 'owner') out.add(roomNames.orgAdmins(a.orgId));
  return out;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Socket.IO on /ws (07 §4, 04 §7). Every api instance LISTENs on point_realtime and relays what committed
 * transactions published (DEC-48) to its local sockets. Delivery is at-most-once; clients resync with a
 * snapshot (11 §9.4). Sessions are re-validated every 60 s and whenever a message concerns their user.
 */
export class RealtimeServer {
  io: Server | null = null;
  private listener: pg.Client | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly origin: string;
  /** session id → when its last socket disconnected (point_ws_reconnects_total) */
  private readonly disconnectedAt = new Map<string, number>();

  constructor(private readonly deps: RealtimeDeps) {
    this.origin = new URL(deps.env.APP_BASE_URL).origin;
  }

  async attach(http: HttpServer): Promise<void> {
    const transports = this.deps.env.WS_TRANSPORTS.split(',').map((s) => s.trim()) as (
      'websocket' | 'polling'
    )[];
    const io = new Server(http, {
      path: this.deps.env.WS_PATH,
      transports,
      serveClient: false,
      cors: { origin: this.origin, credentials: true },
      allowRequest: (req, cb) => cb(null, this.allowHandshake(req)),
    });
    this.io = io;
    io.use(async (socket, next) => {
      try {
        // a customer token never opens the staff namespace, even with a staff cookie beside it (DEC-497)
        if (socket.handshake.headers.authorization) return next(authError('AUTH_UNAUTHENTICATED'));
        const token = parseCookies(socket.handshake.headers.cookie)[this.deps.env.SESSION_COOKIE_NAME];
        const actor = await loadActor(this.deps.db, token, this.deps.clock.now());
        if (actor.mustChangeSecret) return next(authError('AUTH_SECRET_CHANGE_REQUIRED'));
        if (actor.mfaSetupRequired) return next(authError('AUTH_MFA_SETUP_REQUIRED'));
        (socket.data as SocketData) = { token: token!, actor, rooms: new Set() };
        next();
      } catch (e) {
        // an unreachable database is not a bad session: the client keeps it and retries (17 §12)
        next(authError(asAppError(e)?.code ?? dbUnavailableError(e)?.code ?? 'AUTH_UNAUTHENTICATED'));
      }
    });
    io.on('connection', (socket) => {
      this.countReconnect(socket);
      this.onConnection(socket);
    });
    this.attachCustomerNamespace(io);
    await this.listen();
    this.timer = setInterval(() => void this.revalidateAll(), this.deps.revalidateEveryMs ?? 60_000);
    this.timer.unref();
  }

  /**
   * The Engine.IO handshake check (09 §7 rule 2, 07 §4.1): it runs for a request that opens a new Engine.IO
   * session (no `sid`). A request with an Origin must carry APP_BASE_URL's. Browsers omit Origin on a same-origin
   * GET (Fetch standard), which is what the long-polling handshake is, so a request without Origin is taken only
   * when the browser marks it `Sec-Fetch-Site: same-origin` (a page cannot forge fetch metadata; a cross-site
   * request always carries Origin). A new WebSocket connection always carries Origin in a browser, so one without
   * it is refused. The upgrade of an established polling session to WebSocket carries the session's `sid` and is
   * bound to it (engine.io checks the sid, not this hook); only the same-origin page that opened it can read it.
   * The session itself is not checked here: the `io.use` middleware validates it on the same handshake and answers
   * with the canon connect_error code (AUTH_* or SERVICE_UNAVAILABLE, DEC-370), which a bare 403 here would lose.
   */
  private allowHandshake(req: IncomingMessage): boolean {
    if (customerHandshake(req)) return true;
    const origin = req.headers.origin;
    if (origin !== undefined) return origin === this.origin;
    if ((req.headers.upgrade ?? '').toLowerCase() === 'websocket') return false;
    return req.headers['sec-fetch-site'] === 'same-origin';
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.listener?.end().catch(() => {});
    this.listener = null;
    await new Promise<void>((r) => (this.io ? this.io.close(() => r()) : r()));
    this.io = null;
  }

  /**
   * `point_ws_reconnects_total` (05 §12.2): a session that opens a socket again within RECONNECT_WINDOW_MS of losing
   * its previous one on this process (Socket.IO's automatic reconnection, the PWA back from the background). A
   * reconnection that lands on another api instance is that instance's first connection, not counted.
   */
  private countReconnect(socket: Socket): void {
    const data = socket.data as SocketData;
    const now = this.deps.clock.now().getTime();
    const left = this.disconnectedAt.get(data.actor.sessionId);
    if (left !== undefined && now - left <= RECONNECT_WINDOW_MS) metrics.wsReconnects.inc();
    this.disconnectedAt.delete(data.actor.sessionId);
    socket.on('disconnect', () => {
      const at = this.deps.clock.now().getTime();
      if (this.disconnectedAt.size >= RECONNECT_TRACKED_SESSIONS)
        for (const [sid, t] of this.disconnectedAt)
          if (at - t > RECONNECT_WINDOW_MS || this.disconnectedAt.size >= RECONNECT_TRACKED_SESSIONS)
            this.disconnectedAt.delete(sid);
      this.disconnectedAt.set(data.actor.sessionId, at);
    });
  }

  private onConnection(socket: Socket) {
    const data = socket.data as SocketData;
    this.applyRooms(socket, roomsFor(data.actor));
    // the label of the connection, kept: revalidate() replaces data.actor (assignment, scope) while it lives, and the
    // decrement must hit the series the increment did, or the gauge drifts (+1 on one venue, −1 on another)
    const venue = data.actor.venueId ?? 'none';
    metrics.wsConnections.inc({ venue });
    socket.on('disconnect', () => metrics.wsConnections.dec({ venue }));

    socket.on('client.heartbeat', async (payload: HeartbeatPayload, ack?: (r: unknown) => void) => {
      try {
        const actor = await this.revalidate(socket);
        if (!actor) return;
        const result = this.deps.heartbeat
          ? await this.deps.db.transaction((tx) =>
              this.deps.heartbeat!(tx, actor, {
                ...(payload ?? { visible: true, audio_unlocked: false }),
                ws_connected: true,
              }),
            )
          : {
              server_time: this.deps.clock.now().toISOString(),
              connection_state: null,
              sync_required: false,
            };
        ack?.({ data: result });
      } catch (e) {
        ack?.({ error: { code: asAppError(e)?.code ?? dbUnavailableError(e)?.code ?? 'INTERNAL_ERROR' } });
      }
    });

    socket.on('client.offer_seen', async (payload: OfferSeenPayload, ack?: (r: unknown) => void) => {
      try {
        if (payload?.offer_id && /^[0-9a-f-]{36}$/i.test(payload.offer_id)) {
          const record = this.deps.offerSeen;
          if (record) await this.deps.db.transaction((tx) => record(tx, data.actor, payload));
          else
            await this.deps.db.query(
              `UPDATE offer_recipients SET seen_at = COALESCE(seen_at, $3) WHERE offer_id = $1 AND user_id = $2`,
              [payload.offer_id, data.actor.userId, this.deps.clock.now()],
            );
        }
        ack?.({ data: { ok: true } });
      } catch (e) {
        ack?.({ error: { code: dbUnavailableError(e)?.code ?? 'INTERNAL_ERROR' } });
      }
    });
  }

  /**
   * The customer namespace `/customer` (V2-015, DEC-520): authenticated by the customer access token of the handshake
   * header only (no cookie is read; staff and platform sessions never open it), the socket joins its account's room
   * and nothing else; `visit.updated` and `subscription.updated` reach it with a customer envelope (no organization,
   * venue or staff ids). The session — not the 15-minute access token — is re-checked every minute: a revoked
   * session, an expired refresh lifetime or a deleted account gets `session.revoked` and is disconnected. Delivery is
   * at most once: the app reads the visit again on every (re)connection, as the staff app resyncs (11 §9.4).
   */
  private attachCustomerNamespace(io: Server): void {
    const nsp = io.of(CUSTOMER_REALTIME_NAMESPACE);
    nsp.use(async (socket, next) => {
      try {
        const customer = await loadCustomerActor(
          this.deps.db,
          socket.handshake.headers.authorization,
          this.deps.clock.now(),
        );
        (socket.data as CustomerSocketData) = { customer };
        next();
      } catch (e) {
        next(authError(asAppError(e)?.code ?? dbUnavailableError(e)?.code ?? 'AUTH_UNAUTHENTICATED'));
      }
    });
    nsp.on('connection', (socket) => {
      const { customer } = socket.data as CustomerSocketData;
      void socket.join(customerRoom(customer.accountId));
      metrics.wsConnections.inc({ venue: 'customer' });
      socket.on('disconnect', () => metrics.wsConnections.dec({ venue: 'customer' }));
    });
  }

  /** Re-checks one customer socket's session (see attachCustomerNamespace); undecided on a database failure. */
  private async revalidateCustomer(socket: Socket): Promise<boolean> {
    const { customer } = socket.data as CustomerSocketData;
    try {
      await checkCustomerSocketSession(this.deps.db, customer.sessionId, this.deps.clock.now());
      return true;
    } catch (e) {
      const err = asAppError(e);
      if (!err || !(err.code.startsWith('AUTH_') || err.code === 'ACCOUNT_DELETED')) return false;
      socket.emit('session.revoked', {
        id: cryptoRandomId(),
        type: 'session.revoked',
        occurred_at: this.deps.clock.now().toISOString(),
        payload: { reason: (err.details?.reason as string | undefined) ?? err.code.toLowerCase() },
      });
      socket.disconnect(true);
      return true;
    }
  }

  private applyRooms(socket: Socket, next: Set<string>) {
    const data = socket.data as SocketData;
    for (const r of data.rooms) if (!next.has(r)) void socket.leave(r);
    for (const r of next) if (!data.rooms.has(r)) void socket.join(r);
    data.rooms = next;
  }

  /**
   * Re-checks the socket's session. Only a verdict on the session itself (an AUTH_* rejection of loadActor:
   * unknown, expired, revoked, disabled) sends session.revoked with its reason and disconnects (07 §4). Any other
   * failure — the database unreachable (17 §12), a fault — says nothing about the session: it is thrown to the
   * caller and the socket keeps its session and rooms, so the client retries instead of signing out.
   */
  private async revalidate(socket: Socket): Promise<ActorContext | null> {
    const data = socket.data as SocketData;
    let actor: ActorContext;
    try {
      actor = await loadActor(this.deps.db, data.token, this.deps.clock.now());
    } catch (e) {
      const err = asAppError(e);
      if (!err?.code.startsWith('AUTH_')) throw e;
      const reason =
        (err.details?.reason as string | undefined) ??
        (err.code === 'AUTH_SESSION_EXPIRED' ? 'expired_cleanup' : 'admin');
      socket.emit(
        'session.revoked',
        this.envelope(data.actor.orgId, { event: 'session.revoked', id: cryptoRandomId(), data: { reason } }),
      );
      socket.disconnect(true);
      return null;
    }
    data.actor = actor;
    this.applyRooms(socket, roomsFor(actor));
    return actor;
  }

  /** A revalidation that could not decide (database unreachable): the socket stays as it is until the next one. */
  private async revalidateQuietly(socket: Socket): Promise<boolean> {
    try {
      await this.revalidate(socket);
      return true;
    } catch {
      return false;
    }
  }

  /** Every 60 s (and on demand in tests): re-checks each connected socket's session. */
  async revalidateAll(): Promise<{ checked: number; undecided: number }> {
    if (!this.io) return { checked: 0, undecided: 0 };
    let checked = 0;
    let undecided = 0;
    for (const socket of this.io.of('/').sockets.values()) {
      checked++;
      if (!(await this.revalidateQuietly(socket))) undecided++;
    }
    for (const socket of this.io.of(CUSTOMER_REALTIME_NAMESPACE).sockets.values()) {
      checked++;
      if (!(await this.revalidateCustomer(socket))) undecided++;
    }
    if (undecided)
      this.deps.logger.warn(
        { sockets: checked, undecided },
        'socket sessions could not be re-checked (database unavailable?); they are kept',
      );
    return { checked, undecided };
  }

  private envelope(orgId: string, m: RealtimeMessage) {
    return {
      id: m.id,
      type: m.event,
      occurred_at: m.occurred_at ?? this.deps.clock.now().toISOString(),
      org_id: orgId,
      venue_id: m.venue_id ?? null,
      dispatch_pool_id: m.dispatch_pool_id ?? null,
      event_id: m.event_id ?? null,
      aggregate: m.aggregate ?? null,
      actor: m.actor ?? { type: 'system', id: null },
      payload: m.data,
    };
  }

  private async listen() {
    const connect = async () => {
      if (this.closed) return;
      // bounded like the pool (DEC-PROPOSED-8): a database that does not answer must not hold the attach
      const c = new pg.Client(this.deps.db.listenClientConfig('realtime'));
      let ready = false;
      c.on('error', (err) => {
        if (!ready) return; // reported by connect/LISTEN below
        this.deps.logger.warn({ err: err.message }, 'realtime listener error; reconnecting');
        this.listener = null;
        setTimeout(() => void connect(), 1000);
      });
      try {
        await c.connect();
        await c.query(`LISTEN ${REALTIME_NOTIFY_CHANNEL}`);
      } catch (err) {
        void c.end().catch(() => {});
        this.deps.logger.warn({ err: (err as Error).message }, 'realtime listener unavailable; retrying');
        setTimeout(() => void connect(), 2000);
        return;
      }
      ready = true;
      c.on('notification', (n) => {
        if (n.payload) void this.relay(n.payload).catch(() => {});
      });
      this.listener = c;
    };
    await connect();
  }

  /**
   * `point_dispatch_publish_seconds` (05 §12.2; the second technical target of 15 §10, p95 < 3 s): from the producing
   * transaction to the socket emit of an offer (`task.offered`, `task.broadcast`) or an assignment (`task.claimed`, and
   * `task.updated` caused by a claim or a reassignment). The start is the transaction's clock instant (`occurred_at`),
   * so the transaction itself is included: an upper bound of «commit → publish».
   */
  private observeDispatchPublish(message: RealtimeMessage): void {
    const cause = typeof message.data?.cause === 'string' ? message.data.cause : null;
    const dispatch =
      DISPATCH_PUBLISH_EVENTS.has(message.event) ||
      (message.event === 'task.updated' && cause !== null && ASSIGNMENT_CAUSES.has(cause));
    if (!dispatch || !message.occurred_at) return;
    const at = Date.parse(message.occurred_at);
    if (Number.isNaN(at)) return;
    metrics.dispatchPublish.observe(Math.max(0, this.deps.clock.now().getTime() - at) / 1000);
  }

  /** Relays one committed publication to the local sockets of its rooms. */
  async relay(raw: string): Promise<void> {
    if (!this.io) return;
    let parsed: { org_id: string; rooms: string[]; message: RealtimeMessage };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const { rooms, message } = parsed;
    if (!Array.isArray(rooms) || !message?.event) return;
    // the customer namespace (DEC-520): its own rooms, its own envelope; never mixed with a staff publication
    const customerRooms = rooms.filter((r) => typeof r === 'string' && r.startsWith(CUSTOMER_ROOM_PREFIX));
    if (customerRooms.length) {
      this.io
        .of(CUSTOMER_REALTIME_NAMESPACE)
        .to(customerRooms)
        .emit(message.event, {
          id: message.id,
          type: message.event,
          occurred_at: message.occurred_at ?? this.deps.clock.now().toISOString(),
          payload: message.data,
        });
      if (customerRooms.length === rooms.length) return;
    }
    const staffRooms = rooms.filter((r) => !customerRooms.includes(r));
    const userRooms = staffRooms.filter((r) => r.startsWith('user:'));
    if (message.event === 'session.revoked') {
      // only the sockets whose session is actually revoked get it (a logout on one device keeps the others)
      for (const r of userRooms)
        for (const s of await this.io.in(r).fetchSockets()) {
          const local = this.io.of('/').sockets.get(s.id);
          if (local) await this.revalidateQuietly(local);
        }
      return;
    }
    this.io.to(staffRooms).emit(message.event, this.envelope(parsed.org_id, message));
    this.observeDispatchPublish(message);
    // membership may have changed (duty start/end, scope change): re-evaluate the users concerned
    if (message.event === 'sync.required' || message.event === 'driver.state_changed') {
      for (const r of userRooms)
        for (const s of await this.io.in(r).fetchSockets()) {
          const local = this.io.of('/').sockets.get(s.id);
          if (local) await this.revalidateQuietly(local);
        }
    }
  }
}

function authError(code: string): Error & { data: { code: string } } {
  const e = new Error(code) as Error & { data: { code: string } };
  e.data = { code };
  return e;
}

function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID();
}
