import { recordServerTime } from '@/lib/serverClock';
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
 *   `sync_required` or comes after a gap, and every frame that fails its schema → a **full resync** before any
 *   command (`requestResync`); resyncs never overlap, a trigger during one runs another right after;
 * - frames are delivered at most once and in best-effort order: a duplicate `id` is dropped, and so is an
 *   update whose `aggregate.version` is not newer than the last one applied for that aggregate;
 * - `client.heartbeat` every `heartbeat.interval_s` with `{visible, audio_unlocked, last_event_id,
 *   app_version}`; without a socket the HTTP fallback `POST /v1/me/heartbeat` (drivers) with
 *   `ws_connected: false`; the ack's `server_time` corrects the countdown clock;
 * - `client.offer_seen` once per offer round shown on screen (15 §9.4).
 */
export interface Transport {
  connect(): void;
  disconnect(): void;
  readonly connected: boolean;
  /** `connected`, `disconnected`, or `error` (the handshake was refused: `code` from `connect_error.data`). */
  onStatus(listener: (status: 'connected' | 'disconnected' | 'error', code?: string) => void): () => void;
  onFrame(listener: (event: string, frame: unknown) => void): () => void;
  ack(event: string, payload: unknown, timeoutMs: number): Promise<unknown>;
}

export interface EngineHooks {
  /** Reads the area's snapshot(s) again; true when it succeeded (02 §1.7 «مزامنة كاملة»). */
  resync(reason: StaleReason): Promise<{ ok: boolean; serverTime?: string | null }>;
  onEvent(event: ServerEvent): void;
  heartbeatBody(): Omit<HeartbeatBody, 'last_event_id'>;
  /** `POST /v1/me/heartbeat` while the socket is down (drivers on duty); null = not this user. */
  httpHeartbeat?: (body: HeartbeatBody & { ws_connected: false }) => Promise<HeartbeatAck | null>;
  /** The handshake was refused with an AUTH_* code: the app checks the session over HTTP. */
  onAuthError?: (code: string) => void;
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
};

const ACK_TIMEOUT_MS = 10_000;
const MAX_SEEN = 500;
/** A failed resync is tried again after this delay while nothing else triggers one. */
export const RESYNC_RETRY_MS = 5000;

export class RealtimeEngine {
  private readonly unsubscribe: Array<() => void> = [];
  private readonly seen = new Set<string>();
  private readonly versions = new Map<string, number>();
  private readonly offersSeen = new Set<string>();
  private heartbeatTimer: unknown = null;
  private heartbeatEvery = 0;
  private retryTimer: unknown = null;
  private resyncRunning = false;
  private resyncAgain: StaleReason | null = null;
  private lastEventId: string | null = null;
  private stopped = true;

  constructor(
    private readonly transport: Transport,
    private readonly hooks: EngineHooks,
    private readonly env: EngineEnv = browserEnv,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
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
    for (const off of this.unsubscribe.splice(0)) off();
    if (this.heartbeatTimer !== null) this.env.clearInterval(this.heartbeatTimer);
    if (this.retryTimer !== null) this.env.clearTimeout(this.retryTimer);
    this.heartbeatTimer = null;
    this.retryTimer = null;
    this.transport.disconnect();
    setSocketStatus('off');
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Marks the data stale and reads the snapshot again (runs one resync at a time). */
  requestResync(reason: StaleReason): void {
    if (this.stopped) return;
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
    let reason: StaleReason | null = first;
    let failed = false;
    try {
      while (reason && !this.stopped) {
        this.resyncAgain = null;
        const generation = beginSnapshot();
        let result: { ok: boolean; serverTime?: string | null };
        try {
          result = await this.hooks.resync(reason);
        } catch {
          result = { ok: false };
        }
        if (result.ok) completeSnapshot(generation, result.serverTime ?? null, this.env.now());
        failed = !result.ok;
        reason = this.resyncAgain;
      }
    } finally {
      this.resyncRunning = false;
      setSyncing(false);
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

  private onStatus(status: 'connected' | 'disconnected' | 'error', code?: string): void {
    if (this.stopped) return;
    if (status === 'connected') {
      setSocketStatus('connected');
      noteContact(this.env.now());
      this.requestResync('reconnect');
      void this.beat();
      return;
    }
    setSocketStatus('down');
    if (status === 'error' && code && code.startsWith('AUTH_')) this.hooks.onAuthError?.(code);
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
      if (known !== undefined && aggregate.version <= known) return; // 07 §4.5
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
    const { lastContactAt, heartbeat } = useSyncStore.getState();
    const now = this.env.now();
    const gap = lastContactAt !== null && now - lastContactAt > heartbeat.uncertain_after_s * 1000;
    noteContact(now, ack.connection_state);
    recordServerTime(ack.server_time, now);
    if (ack.sync_required || gap) this.requestResync(gap ? 'heartbeat_gap' : 'sync_required');
  }

  /** `client.offer_seen` once per round actually shown (15 §9.4); best effort. */
  offerSeen(offerId: string, receiveLatencyMs?: number): void {
    if (this.stopped || this.offersSeen.has(offerId) || !this.transport.connected) return;
    this.offersSeen.add(offerId);
    const payload =
      receiveLatencyMs !== undefined && receiveLatencyMs >= 0
        ? { offer_id: offerId, receive_latency_ms: Math.round(receiveLatencyMs) }
        : { offer_id: offerId };
    void this.transport.ack('client.offer_seen', payload, ACK_TIMEOUT_MS).catch(() => {
      this.offersSeen.delete(offerId); // try again when the card is shown next time
    });
  }
}
