import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeEngine, type EngineEnv, type EngineHooks, type Transport } from '@/realtime/engine';
import { resetSync, useSyncStore } from '@/realtime/syncStore';
import { clockOffsetMs, recordServerTime } from '@/lib/serverClock';
import { IDS } from './fixtures';

/** A transport the test drives: connection status, frames from the server, acks. */
class FakeTransport implements Transport {
  connected = false;
  connects = 0;
  readonly acks: Array<{ event: string; payload: unknown }> = [];
  ackReply: (event: string, payload: unknown) => unknown = () => ({
    data: { server_time: '2026-10-29T18:00:00.000Z', connection_state: 'online', sync_required: false },
  });
  private status = new Set<(s: 'connected' | 'disconnected' | 'error', code?: string) => void>();
  private frames = new Set<(event: string, frame: unknown) => void>();
  connect() {
    this.connects += 1;
  }
  disconnect() {
    this.connected = false;
  }
  onStatus(l: (s: 'connected' | 'disconnected' | 'error', code?: string) => void) {
    this.status.add(l);
    return () => this.status.delete(l);
  }
  onFrame(l: (event: string, frame: unknown) => void) {
    this.frames.add(l);
    return () => this.frames.delete(l);
  }
  async ack(event: string, payload: unknown) {
    this.acks.push({ event, payload });
    return this.ackReply(event, payload);
  }
  up() {
    this.connected = true;
    for (const l of this.status) l('connected');
  }
  down() {
    this.connected = false;
    for (const l of this.status) l('disconnected');
  }
  refuse(code: string) {
    for (const l of this.status) l('error', code);
  }
  emit(event: string, frame: unknown) {
    for (const l of this.frames) l(event, frame);
  }
}

class FakeEnv implements EngineEnv {
  t = 1_000_000;
  private visibility = new Set<(v: boolean) => void>();
  private online = new Set<() => void>();
  intervals: Array<() => void> = [];
  timeouts: Array<() => void> = [];
  now = () => this.t;
  setInterval = (fn: () => void) => {
    this.intervals.push(fn);
    return fn;
  };
  clearInterval = (h: unknown) => {
    this.intervals = this.intervals.filter((f) => f !== h);
  };
  setTimeout = (fn: () => void) => {
    this.timeouts.push(fn);
    return fn;
  };
  clearTimeout = (h: unknown) => {
    this.timeouts = this.timeouts.filter((f) => f !== h);
  };
  onVisibility = (l: (v: boolean) => void) => {
    this.visibility.add(l);
    return () => this.visibility.delete(l);
  };
  onOnline = (l: () => void) => {
    this.online.add(l);
    return () => this.online.delete(l);
  };
  setVisible(v: boolean) {
    for (const l of this.visibility) l(v);
  }
  goOnline() {
    for (const l of this.online) l();
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function envelope(type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id: globalThis.crypto.randomUUID(),
    type,
    occurred_at: '2026-10-29T18:00:00.000Z',
    org_id: IDS.org,
    venue_id: IDS.venue,
    dispatch_pool_id: null,
    event_id: null,
    aggregate: null,
    actor: { type: 'system', id: null },
    payload,
    ...extra,
  };
}

describe('RealtimeEngine (07 §4.5, 11 §9.4, PNT-065)', () => {
  let transport: FakeTransport;
  let env: FakeEnv;
  let resyncs: string[];
  let events: Array<{ type: string }>;
  let resolveResync: Array<(r: { ok: boolean; serverTime?: string }) => void>;
  let engine: RealtimeEngine;
  let hooks: EngineHooks;

  beforeEach(() => {
    resetSync();
    transport = new FakeTransport();
    env = new FakeEnv();
    resyncs = [];
    events = [];
    resolveResync = [];
    hooks = {
      resync: (reason) => {
        resyncs.push(reason);
        return new Promise((resolve) => resolveResync.push(resolve));
      },
      onEvent: (e) => events.push(e),
      heartbeatBody: () => ({ visible: true, audio_unlocked: false, app_version: 'test' }),
    };
    engine = new RealtimeEngine(transport, hooks, env);
  });
  afterEach(() => {
    engine.stop();
    resetSync();
  });

  const finishResync = async (ok = true) => {
    resolveResync.shift()?.({ ok, serverTime: '2026-10-29T18:00:01.000Z' });
    await flush();
  };

  it('reads the snapshot at start and again at every (re)connection; commands wait until it completes', async () => {
    engine.start();
    expect(resyncs).toEqual(['start']);
    expect(useSyncStore.getState()).toMatchObject({ stale: true, socket: 'connecting' });
    await finishResync();
    expect(useSyncStore.getState().stale).toBe(false);
    transport.up();
    expect(useSyncStore.getState()).toMatchObject({
      socket: 'connected',
      stale: true,
      staleReason: 'reconnect',
    });
    expect(resyncs).toEqual(['start', 'reconnect']);
    await finishResync();
    expect(useSyncStore.getState().stale).toBe(false);
    transport.down();
    expect(useSyncStore.getState().socket).toBe('down');
  });

  it('a trigger during a resync runs another one; only the last clears stale', async () => {
    engine.start();
    env.setVisible(true); // back to the foreground while the start resync travels
    expect(resyncs).toEqual(['start']);
    await finishResync();
    expect(resyncs).toEqual(['start', 'foreground']);
    expect(useSyncStore.getState().stale).toBe(true); // the first read started before the trigger
    await finishResync();
    expect(useSyncStore.getState().stale).toBe(false);
  });

  it('online and sync.required trigger a full resync', async () => {
    engine.start();
    await finishResync();
    env.goOnline();
    expect(resyncs.at(-1)).toBe('online');
    await finishResync();
    transport.emit('sync.required', envelope('sync.required', { reason: 'test', scope: 'home' }));
    expect(resyncs.at(-1)).toBe('sync_required');
    expect(events.map((e) => e.type)).toEqual(['sync.required']);
  });

  it('a failed resync keeps the data stale and is tried again', async () => {
    engine.start();
    await finishResync(false);
    expect(useSyncStore.getState().stale).toBe(true);
    expect(env.timeouts).toHaveLength(1);
    env.timeouts.shift()?.();
    expect(resyncs).toEqual(['start', 'start']);
    await finishResync();
    expect(useSyncStore.getState().stale).toBe(false);
  });

  it('drops duplicates and updates whose aggregate version is not newer (07 §4.5)', async () => {
    engine.start();
    await finishResync();
    const agg = (version: number | null) => ({ aggregate: { type: 'task_offer', id: IDS.offerA, version } });
    const closed = { offer_id: IDS.offerA, task_id: IDS.taskA, close_reason: 'expired' };
    const v2 = envelope('offer.closed', closed, agg(2));
    transport.emit('offer.closed', v2);
    transport.emit('offer.closed', v2); // same id
    transport.emit('offer.closed', envelope('offer.closed', closed, agg(2))); // same version
    transport.emit('offer.closed', envelope('offer.closed', closed, agg(1))); // older
    expect(events).toHaveLength(1);
    transport.emit('offer.closed', envelope('offer.closed', closed, agg(3)));
    expect(events).toHaveLength(2);
    // descriptive frames (version null) always pass
    transport.emit(
      'offer.reminder',
      envelope('offer.reminder', { offer_id: IDS.offerA, task_id: IDS.taskA }),
    );
    transport.emit(
      'offer.reminder',
      envelope('offer.reminder', { offer_id: IDS.offerA, task_id: IDS.taskA }),
    );
    expect(events).toHaveLength(4);
  });

  it('a frame that fails its schema is never applied: a full resync instead', async () => {
    engine.start();
    await finishResync();
    // ticket.updated is strict (09 §5.1): a phone in the payload fails the contract
    transport.emit(
      'ticket.updated',
      envelope('ticket.updated', { id: IDS.ticketA, customer_phone: '+966500000000' }),
    );
    expect(events).toEqual([]);
    expect(resyncs.at(-1)).toBe('invalid_event');
    // an event name outside canon §7.3 is ignored
    transport.emit('task.unknown', envelope('task.unknown', {}));
    expect(resyncs.filter((r) => r === 'invalid_event')).toHaveLength(1);
  });

  it('heartbeats over the socket carry the canon fields; the ack corrects the clock and may ask for a sync', async () => {
    recordServerTime('2026-10-29T18:00:00.000Z', Date.parse('2026-10-29T18:00:00.000Z'));
    engine.start();
    await finishResync();
    transport.up();
    await flush();
    await finishResync();
    expect(transport.acks.at(-1)).toEqual({
      event: 'client.heartbeat',
      payload: { visible: true, audio_unlocked: false, app_version: 'test', last_event_id: null },
    });
    transport.ackReply = () => ({
      data: {
        server_time: new Date(env.t + 4000).toISOString(),
        connection_state: 'online',
        sync_required: true,
      },
    });
    await engine.beat();
    expect(clockOffsetMs()).toBe(4000);
    expect(useSyncStore.getState().serverConnection).toBe('online');
    expect(resyncs.at(-1)).toBe('sync_required');
    // the interval timer sends the next one
    expect(env.intervals).toHaveLength(1);
  });

  it('a heartbeat after a gap longer than uncertain_after_s asks for a resync', async () => {
    engine.start();
    await finishResync();
    transport.up();
    await flush();
    await finishResync();
    env.t += 46_000;
    await engine.beat();
    expect(resyncs.at(-1)).toBe('heartbeat_gap');
  });

  it('without a socket the HTTP fallback is used (drivers on duty), with ws_connected false', async () => {
    const http = vi.fn(async () => ({
      server_time: '2026-10-29T18:00:00.000Z',
      connection_state: 'online' as const,
      sync_required: false,
    }));
    engine.stop();
    engine = new RealtimeEngine(transport, { ...hooks, httpHeartbeat: http }, env);
    engine.start();
    await engine.beat();
    expect(http).toHaveBeenCalledWith({
      visible: true,
      audio_unlocked: false,
      app_version: 'test',
      last_event_id: null,
      ws_connected: false,
    });
    expect(transport.acks).toEqual([]);
  });

  it('client.offer_seen is sent once per round', async () => {
    engine.start();
    transport.up();
    engine.offerSeen(IDS.offerA, 420.4);
    engine.offerSeen(IDS.offerA, 500);
    await flush();
    const seen = transport.acks.filter((a) => a.event === 'client.offer_seen');
    expect(seen).toEqual([
      { event: 'client.offer_seen', payload: { offer_id: IDS.offerA, receive_latency_ms: 420 } },
    ]);
  });

  it('a refused handshake (AUTH_*) is handed to the app to check the session over HTTP', () => {
    const onAuthError = vi.fn();
    engine.stop();
    engine = new RealtimeEngine(transport, { ...hooks, onAuthError }, env);
    engine.start();
    transport.refuse('AUTH_SESSION_REVOKED');
    expect(onAuthError).toHaveBeenCalledWith('AUTH_SESSION_REVOKED');
    expect(useSyncStore.getState().socket).toBe('down');
  });

  it('stop closes everything and ignores late frames', () => {
    engine.start();
    engine.stop();
    transport.emit('sync.required', envelope('sync.required', { reason: 'late' }));
    expect(events).toEqual([]);
    expect(useSyncStore.getState().socket).toBe('off');
  });
});
