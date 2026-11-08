import { recordServerTime } from '@/lib/serverClock';
import { track } from '@/lib/telemetry';
import {
  parseHeartbeatAck,
  parseServerEvent,
  type HeartbeatAck,
  type HeartbeatBody,
  type ServerEvent,
} from './protocol';
import {
  beginSnapshot,
  completeSnapshot,
  markStale,
  noteContact,
  setSocketStatus,
  setSyncing,
  useSyncStore,
  type StaleReason,
} from './syncStore';

/**
 * The sync protocol of 07 §4.5 / 11 §9.4 / 02 §1.7 (PNT-065), independent of React and of Socket.IO:
 *
 * - every (re)connection, return to the foreground, `online`, `sync.required`, a heartbeat that says
 *   `sync_required`, any confirmation from the server after a gap longer than `heartbeat.uncertain_after_s`,
 *   and every frame that fails its schema → a **full resync** before any command (`requestResync`); resyncs
 *   never overlap, a trigger during one runs another right after; only the server's state counts as a sync
 *   (a 5xx or a rate limit keeps the data stale and is tried again);
 * - frames are delivered at most once and in best-effort order: a duplicate `id` is dropped, and so is an
 *   update whose `aggregate.version` is not newer than the last one applied for that aggregate (a
 *   `ticket.updated` only when strictly older: the same version may carry a message or code state);
 * - `client.heartbeat` every `heartbeat.interval_s` with `{visible, audio_unlocked, last_event_id,
 *   app_version}`; without a socket the HTTP fallback `POST /v1/me/heartbeat` (drivers) with
 *   `ws_connected: false`; the ack's `server_time` corrects the countdown clock;
 * - `client.offer_seen` once per offer round shown on screen (15 §9.4);
 * - Socket.IO reconnects a dropped transport by itself, but not a connection the server closed
 *   (`io server disconnect`, after `session.revoked` or a failed revalidation) nor a refused handshake: the
 *   app checks the session over HTTP and the engine connects again after a backoff (a session that ended
 *   stops the engine first);
 * - `stop()` (sign-out, session end) aborts the resync in flight: nothing it read is written afterwards.
 */
export type TransportStatus =
  /** The socket is connected (the handshake was accepted). */
  | 'connected'
  /** The transport dropped: Socket.IO reconnects by itself. */
  | 'disconnected'
  /** The server closed the connection (`io server disconnect`): no automatic reconnection. */
  | 'closed'
  /** The handshake was refused (`connect_error`; `code` from its `data`). */
  | 'error';

export interface Transport {
  connect(): void;
  disconnect(): void;
  readonly connected: boolean;
  onStatus(listener: (status: TransportStatus, code?: string) => void): () => void;
  onFrame(listener: (event: string, frame: unknown) => void): () => void;
  ack(event: string, payload: unknown, timeoutMs: number): Promise<unknown>;
}

export interface EngineHooks {
  /**
   * Reads the area's snapshot(s) again; `ok` when the server's state was read (02 §1.7 «مزامنة كاملة»).
   * `signal` aborts when the engine stops: nothing may be written into the caches after that.
   */
  resync(reason: StaleReason, signal: AbortSignal): Promise<{ ok: boolean; serverTime?: string | null }>;
  onEvent(event: ServerEvent): void;
  heartbeatBody(): Omit<HeartbeatBody, 'last_event_id'>;
  /** `POST /v1/me/heartbeat` while the socket is down (drivers on duty); null = not this user. */
  httpHeartbeat?: (body: HeartbeatBody & { ws_connected: false }) => Promise<HeartbeatAck | null>;
  /**
   * The server closed the socket or refused its handshake: the app checks the session over HTTP
   * (`GET /v1/me` → D-15 ج when it ended). `code` is the refusal's code (AUTH_* …) or `closed`.
   */
  checkSession?: (code: string) => void;
  /**
   * 15 §9.4: a round shown while the socket is down is reported in a `POST /v1/telemetry` batch
   * (`offer_card_seen`, `via: sync`); the server fills `offer_recipients.seen_at` only while it is empty, so
   * the two paths never count it twice (drivers only).
   */
  httpOfferSeen?: (offerId: string, receiveLatencyMs?: number) => void;
}

export interface EngineEnv {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Subscribes to visibility changes; returns the unsubscribe. */
  onVisibility(listener: (visible: boolean) => void): () => void;
  onOnline(listener: () => void): () => void;
  /** 0 ≤ x < 1: the jitter of the reconnection backoff. */
  random?: () => number;
}

export const browserEnv: EngineEnv = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  onVisibility: (listener) => {
    const handler = () => listener(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  },
  onOnline: (listener) => {
    window.addEventListener('online', listener);
    return () => window.removeEventListener('online', listener);
  },
  random: () => Math.random(),
};

const ACK_TIMEOUT_MS = 10_000;
const MAX_SEEN = 500;
/** A failed resync is tried again after this delay while nothing else triggers one. */
export const RESYNC_RETRY_MS = 5000;

/** The engine's resync triggers as the 15 §8 `sync_completed.sync_reason`. */
const SYNC_REASON: Record<StaleReason, 'startup' | 'reconnect' | 'visibility' | 'sync_required' | 'manual'> =
  {
    start: 'startup',
    reconnect: 'reconnect',
    online: 'reconnect',
    heartbeat_gap: 'reconnect',
    foreground: 'visibility',
    sync_required: 'sync_required',
    invalid_event: 'sync_required',
    manual: 'manual',
  };
/** A refused AUTH_* handshake is tried again after this delay (when the session is still valid). */
export const AUTH_RETRY_MS = 15_000;
/** Backoff of a reconnection Socket.IO will not make by itself: 1 s doubling to 15 s, ±50 % jitter. */
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 15_000;

export class RealtimeEngine {
  private readonly unsubscribe: Array<() => void> = [];
  private readonly seen = new Set<string>();
  private readonly versions = new Map<string, number>();
  private readonly offersSeen = new Set<string>();
  /** Client time the data became stale (the first trigger since the last completed sync). */
  private staleSince: number | null = null;
  private heartbeatTimer: unknown = null;
  private heartbeatEvery = 0;
  private retryTimer: unknown = null;
  private reconnectTimer: unknown = null;
  private reconnectAttempt = 0;
  private resyncRunning = false;
  private resyncAgain: StaleReason | null = null;
  private lastEventId: string | null = null;
  private stopped = true;
  private abort = new AbortController();

  constructor(
    private readonly transport: Transport,
    private readonly hooks: EngineHooks,
    private readonly env: EngineEnv = browserEnv,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.abort = new AbortController();
    setSocketStatus('connecting');
    this.unsubscribe.push(
      this.transport.onStatus((status, code) => this.onStatus(status, code)),
      this.transport.onFrame((event, frame) => this.onFrame(event, frame)),
      this.env.onVisibility((visible) => {
        if (visible) this.requestResync('foreground');
        void this.beat();
      }),
      this.env.onOnline(() => {
        this.requestResync('online');
        if (!this.transport.connected) this.transport.connect();
      }),
      useSyncStore.subscribe((s, prev) => {
        if (s.heartbeat.interval_s !== prev.heartbeat.interval_s) this.scheduleHeartbeat();
        // 07 §4.5: a confirmation after a silence longer than uncertain_after_s (heartbeat ack, any /v1
        // reply) means the data on screen may be behind: a full resync before any command
        if (
          prev.lastContactAt !== null &&
          s.lastContactAt !== null &&
          s.lastContactAt - prev.lastContactAt > s.heartbeat.uncertain_after_s * 1000
        )
          this.requestResync('heartbeat_gap');
      }),
    );
    this.scheduleHeartbeat();
    this.transport.connect();
    // the first snapshot of this page (also when the socket never connects)
    this.requestResync('start');
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    for (const off of this.unsubscribe.splice(0)) off();
    if (this.heartbeatTimer !== null) this.env.clearInterval(this.heartbeatTimer);
    if (this.retryTimer !== null) this.env.clearTimeout(this.retryTimer);
    if (this.reconnectTimer !== null) this.env.clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.retryTimer = null;
    this.reconnectTimer = null;
    this.transport.disconnect();
    setSocketStatus('off');
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Marks the data stale and reads the snapshot again (runs one resync at a time). */
  requestResync(reason: StaleReason): void {
    if (this.stopped) return;
    this.staleSince ??= this.env.now();
    markStale(reason);
    if (this.resyncRunning) {
      this.resyncAgain = reason;
      return;
    }
    void this.runResync(reason);
  }

  private async runResync(first: StaleReason): Promise<void> {
    this.resyncRunning = true;
    setSyncing(true);
    const signal = this.abort.signal;
    let reason: StaleReason | null = first;
    let failed = false;
    try {
      while (reason && !this.stopped) {
        this.resyncAgain = null;
        const generation = beginSnapshot();
        const startedAt = this.env.now();
        const current = reason;
        let result: { ok: boolean; serverTime?: string | null };
        try {
          result = await this.hooks.resync(reason, signal);
        } catch {
          result = { ok: false };
        }
        // stopped while reading (sign-out, session end, another user): the answer belongs to nobody
        if (this.stopped || signal.aborted) return;
        if (result.ok) {
          const now = this.env.now();
          if (completeSnapshot(generation, result.serverTime ?? null, now)) {
            // 15 §8 sync_completed: the reason, how long the read took and how long the data was stale
            track('sync_completed', {
              sync_reason: SYNC_REASON[current],
              duration_ms: Math.max(0, now - startedAt),
              stale_ms: this.staleSince !== null ? Math.max(0, now - this.staleSince) : null,
            });
            this.staleSince = null;
          }
        }
        failed = !result.ok;
        reason = this.resyncAgain;
      }
    } finally {
      this.resyncRunning = false;
      if (!this.stopped) setSyncing(false);
    }
    if (failed && !this.stopped) {
      if (this.retryTimer !== null) this.env.clearTimeout(this.retryTimer);
      this.retryTimer = this.env.setTimeout(() => {
        this.retryTimer = null;
        if (useSyncStore.getState().stale)
          this.requestResync(useSyncStore.getState().staleReason ?? 'manual');
      }, RESYNC_RETRY_MS);
    }
  }

  private onStatus(status: TransportStatus, code?: string): void {
    if (this.stopped) return;
    if (status === 'connected') {
      this.reconnectAttempt = 0;
      if (this.reconnectTimer !== null) this.env.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      setSocketStatus('connected');
      noteContact(this.env.now());
      this.requestResync('reconnect');
      void this.beat();
      return;
    }
    setSocketStatus('down');
    if (status === 'closed') {
      // `io server disconnect`: Socket.IO stays down until told otherwise; a revoked session ends the
      // engine through `GET /v1/me` before the backoff runs out
      this.hooks.checkSession?.('closed');
      this.scheduleReconnect();
    } else if (status === 'error') {
      // a refused handshake is not retried by Socket.IO either (a dropped transport is: connect() no-ops)
      const auth = !!code && code.startsWith('AUTH_');
      if (auth) this.hooks.checkSession?.(code);
      this.scheduleReconnect(auth ? AUTH_RETRY_MS : undefined);
    }
  }

  /** Connects again after `ms` (or the backoff); one timer at a time, none once stopped. */
  private scheduleReconnect(ms?: number): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const jitter = 0.5 + (this.env.random ?? Math.random)();
    const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.env.setTimeout(
      () => {
        this.reconnectTimer = null;
        if (!this.stopped && !this.transport.connected) this.transport.connect();
      },
      ms ?? Math.round(backoff * jitter),
    );
  }

  /** One frame from the server: schema, duplicate and version checks, then the area's handler. */
  onFrame(type: string, frame: unknown): void {
    if (this.stopped) return;
    const parsed = parseServerEvent(type, frame);
    if (!parsed.ok) {
      if (parsed.id && this.seen.has(parsed.id)) return;
      // a frame the client cannot apply: never guess, read the snapshot again (11 §9.4)
      if (parsed.reason === 'invalid') this.requestResync('invalid_event');
      return;
    }
    const event = parsed.event;
    if (this.seen.has(event.id)) return;
    this.remember(event.id);
    this.lastEventId = event.id;
    noteContact(this.env.now());
    const aggregate = event.aggregate;
    if (aggregate && aggregate.version !== null) {
      const key = `${aggregate.type}:${aggregate.id}`;
      const known = this.versions.get(key);
      // 07 §4.5: an update not newer than the last one applied is dropped — except a `ticket.updated` at the
      // version already applied: its causes (a W-01/W-05 delivery state, a wrong code, a resend, a lock, an
      // incident) never write the tickets row, so it carries the same version with new message / code state;
      // applying the same summary again is idempotent, and a repeated frame is already dropped by its id
      // (DEC-PROPOSED-1 of int-web)
      const sameAllowed = event.type === 'ticket.updated';
      if (known !== undefined && (aggregate.version < known || (aggregate.version === known && !sameAllowed)))
        return;
      this.versions.set(key, aggregate.version);
      if (this.versions.size > MAX_SEEN) {
        const first = this.versions.keys().next().value;
        if (first !== undefined) this.versions.delete(first);
      }
    }
    if (event.type === 'sync.required') {
      this.hooks.onEvent(event);
      this.requestResync('sync_required');
      return;
    }
    this.hooks.onEvent(event);
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > MAX_SEEN) {
      const first = this.seen.values().next().value;
      if (first !== undefined) this.seen.delete(first);
    }
  }

  private scheduleHeartbeat(): void {
    const every = useSyncStore.getState().heartbeat.interval_s * 1000;
    if (this.heartbeatTimer !== null && every === this.heartbeatEvery) return;
    if (this.heartbeatTimer !== null) this.env.clearInterval(this.heartbeatTimer);
    this.heartbeatEvery = every;
    this.heartbeatTimer = this.env.setInterval(() => void this.beat(), every);
  }

  /** `client.heartbeat` (or the HTTP fallback); the ack confirms the connection and may ask for a sync. */
  async beat(): Promise<void> {
    if (this.stopped) return;
    const body: HeartbeatBody = { ...this.hooks.heartbeatBody(), last_event_id: this.lastEventId };
    let ack: HeartbeatAck | null = null;
    try {
      if (this.transport.connected) {
        ack = parseHeartbeatAck(await this.transport.ack('client.heartbeat', body, ACK_TIMEOUT_MS));
      } else if (this.hooks.httpHeartbeat) {
        ack = await this.hooks.httpHeartbeat({ ...body, ws_connected: false });
      }
    } catch {
      ack = null; // no answer: the indicator degrades with the age of the last contact
    }
    if (!ack || this.stopped) return;
    const now = this.env.now();
    // a confirmation after a gap asks for a resync by itself (the store subscription in start())
    noteContact(now, ack.connection_state);
    recordServerTime(ack.server_time, now);
    if (ack.sync_required) this.requestResync('sync_required');
  }

  /** `client.offer_seen` once per round actually shown (15 §9.4); best effort. */
  offerSeen(offerId: string, receiveLatencyMs?: number): void {
    if (this.stopped || this.offersSeen.has(offerId)) return;
    const latency = receiveLatencyMs !== undefined ? Math.round(receiveLatencyMs) : undefined;
    if (!this.transport.connected) {
      // the socket is down (or not up yet): the telemetry batch carries it, and retries it (contract:F5)
      if (!this.hooks.httpOfferSeen) return;
      this.offersSeen.add(offerId);
      this.hooks.httpOfferSeen(offerId, latency);
      return;
    }
    this.offersSeen.add(offerId);
    const payload =
      latency !== undefined && latency >= 0
        ? { offer_id: offerId, receive_latency_ms: latency }
        : { offer_id: offerId };
    void this.transport.ack('client.offer_seen', payload, ACK_TIMEOUT_MS).catch(() => {
      this.offersSeen.delete(offerId); // try again when the card is shown next time
    });
  }
}
