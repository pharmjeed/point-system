import type { Server as HttpServer } from 'node:http';
import pg from 'pg';
import { Server, type Socket } from 'socket.io';
import { rooms as roomNames } from '@point/shared';
import type { ActorContext } from '../core/actor-context/actor-context.js';
import { loadActor } from '../core/actor-context/actor-loader.js';
import type { Clock } from '../core/clock/clock.js';
import type { Env } from '../core/config/env.js';
import type { Database } from '../core/db/database.js';
import type { Tx } from '../core/db/tx.js';
import { asAppError } from '../core/errors/app-error.js';
import { dbUnavailableError } from '../core/errors/pg-constraint-map.js';
import type { Logger } from '../core/logging/logger.js';
import { metrics } from '../core/metrics/metrics.js';
import { REALTIME_NOTIFY_CHANNEL, type RealtimeMessage } from '../core/realtime/realtime-publisher.js';

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
      allowRequest: (req, cb) => cb(null, req.headers.origin === this.origin),
    });
    this.io = io;
    io.use(async (socket, next) => {
      try {
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
    io.on('connection', (socket) => this.onConnection(socket));
    await this.listen();
    this.timer = setInterval(() => void this.revalidateAll(), this.deps.revalidateEveryMs ?? 60_000);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.listener?.end().catch(() => {});
    this.listener = null;
    await new Promise<void>((r) => (this.io ? this.io.close(() => r()) : r()));
    this.io = null;
  }

  private onConnection(socket: Socket) {
    const data = socket.data as SocketData;
    this.applyRooms(socket, roomsFor(data.actor));
    metrics.wsConnections.inc({ venue: data.actor.venueId ?? 'none' });
    socket.on('disconnect', () => metrics.wsConnections.dec({ venue: data.actor.venueId ?? 'none' }));

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
      } catch {
        ack?.({ error: { code: 'INTERNAL_ERROR' } });
      }
    });
  }

  private applyRooms(socket: Socket, next: Set<string>) {
    const data = socket.data as SocketData;
    for (const r of data.rooms) if (!next.has(r)) void socket.leave(r);
    for (const r of next) if (!data.rooms.has(r)) void socket.join(r);
    data.rooms = next;
  }

  /** Re-checks the socket's session; an invalid one gets session.revoked (with the reason) and is disconnected. */
  private async revalidate(socket: Socket): Promise<ActorContext | null> {
    const data = socket.data as SocketData;
    try {
      const actor = await loadActor(this.deps.db, data.token, this.deps.clock.now());
      data.actor = actor;
      this.applyRooms(socket, roomsFor(actor));
      return actor;
    } catch (e) {
      const err = asAppError(e);
      const reason =
        (err?.details?.reason as string | undefined) ??
        (err?.code === 'AUTH_SESSION_EXPIRED' ? 'expired_cleanup' : 'admin');
      socket.emit(
        'session.revoked',
        this.envelope(data.actor.orgId, { event: 'session.revoked', id: cryptoRandomId(), data: { reason } }),
      );
      socket.disconnect(true);
      return null;
    }
  }

  private async revalidateAll() {
    if (!this.io) return;
    for (const socket of this.io.of('/').sockets.values()) await this.revalidate(socket);
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
      try {
        const c = new pg.Client({ connectionString: this.deps.db.config.connectionString });
        await c.connect();
        await c.query(`LISTEN ${REALTIME_NOTIFY_CHANNEL}`);
        c.on('notification', (n) => {
          if (n.payload) void this.relay(n.payload);
        });
        c.on('error', (err) => {
          this.deps.logger.warn({ err: err.message }, 'realtime listener error; reconnecting');
          this.listener = null;
          setTimeout(() => void connect(), 1000);
        });
        this.listener = c;
      } catch (err) {
        this.deps.logger.warn({ err: (err as Error).message }, 'realtime listener unavailable; retrying');
        setTimeout(() => void connect(), 2000);
      }
    };
    await connect();
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
    const userRooms = rooms.filter((r) => r.startsWith('user:'));
    if (message.event === 'session.revoked') {
      // only the sockets whose session is actually revoked get it (a logout on one device keeps the others)
      for (const r of userRooms)
        for (const s of await this.io.in(r).fetchSockets()) {
          const local = this.io.of('/').sockets.get(s.id);
          if (local) await this.revalidate(local);
        }
      return;
    }
    this.io.to(rooms).emit(message.event, this.envelope(parsed.org_id, message));
    // membership may have changed (duty start/end, scope change): re-evaluate the users concerned
    if (message.event === 'sync.required' || message.event === 'driver.state_changed') {
      for (const r of userRooms)
        for (const s of await this.io.in(r).fetchSockets()) {
          const local = this.io.of('/').sockets.get(s.id);
          if (local) await this.revalidate(local);
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
