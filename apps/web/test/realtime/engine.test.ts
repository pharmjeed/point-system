import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_RETRY_MS, RealtimeEngine, type EngineHooks } from '@/realtime/engine';
import { parseServerEvent } from '@/realtime/protocol';
import { noteContact, resetSync, useSyncStore } from '@/realtime/syncStore';
import { clockOffsetMs, recordServerTime } from '@/lib/serverClock';
import { envelope, FakeEnv, FakeTransport, flush } from './engineFakes';
import { IDS } from './fixtures';

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

  it('ticket.updated at the version already applied is delivered (message / code state); older ones drop', async () => {
    // contract:F4, decisions:F3, realtime:RT-1: a W-01/W-05 delivery state, a wrong code, a resend or an
    // incident never write the tickets row, so their ticket.updated carries the version already applied
    engine.start();
    await finishResync();
    const ticket = (version: number, extra: Record<string, unknown> = {}) =>
      envelope(
        'ticket.updated',
        {
          id: IDS.ticketA,
          display_number: 12,
          event_id: IDS.event,
          venue_id: IDS.venue,
          status: 'ready',
          channel: 'whatsapp',
          plate: {
            country: 'SA',
            digits: '1234',
            letters_ar: 'ب ح د',
            letters_en: 'B J D',
            display: '1234 ب ح د',
          },
          wa_link_status: 'linked',
          payment_status: 'not_required',
          version,
          cause: 'ticket.ready',
          ...extra,
        },
        { aggregate: { type: 'ticket', id: IDS.ticketA, version } },
      );
    transport.emit('ticket.updated', ticket(5));
    const delivered = ticket(5, {
      cause: 'wa.message_status_changed',
      message: { id: IDS.offerA, purpose: 'W-05', status: 'delivered', status_rank: 2 },
    });
    expect(parseServerEvent('ticket.updated', delivered).ok).toBe(true);
    transport.emit('ticket.updated', delivered);
    transport.emit('ticket.updated', delivered); // the same frame again: dropped by id
    transport.emit('ticket.updated', ticket(5, { cause: 'handover.code_issued' }));
    transport.emit('ticket.updated', ticket(4, { cause: 'ticket.retrieval_requested' })); // strictly older
    expect(events.map((e) => (e as unknown as { payload: { cause: string } }).payload.cause)).toEqual([
      'ticket.ready',
      'wa.message_status_changed',
      'handover.code_issued',
    ]);
    transport.emit('ticket.updated', ticket(6, { cause: 'ticket.retrieval_requested' }));
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

  it('while the socket is down, a round on screen goes through the HTTP telemetry fallback; never twice (15 §9.4, contract:F5)', async () => {
    const httpOfferSeen = vi.fn();
    engine.stop();
    engine = new RealtimeEngine(transport, { ...hooks, httpOfferSeen }, env);
    engine.start(); // the card rendered from the HTTP snapshot before the handshake
    engine.offerSeen(IDS.offerA, 812.6);
    engine.offerSeen(IDS.offerA, 900);
    expect(httpOfferSeen.mock.calls).toEqual([[IDS.offerA, 813]]);
    transport.up();
    engine.offerSeen(IDS.offerA, 950); // the same round once connected: already reported
    await flush();
    expect(transport.acks.filter((a) => a.event === 'client.offer_seen')).toEqual([]);
    engine.offerSeen(IDS.offerB, 100); // a new round with the socket up: the WebSocket path
    await flush();
    expect(transport.acks.filter((a) => a.event === 'client.offer_seen')).toHaveLength(1);
    expect(httpOfferSeen).toHaveBeenCalledTimes(1);
  });

  it('a completed resync is measured as sync_completed (15 §8)', async () => {
    const telemetry = await import('@/lib/telemetry');
    telemetry.resetTelemetry();
    telemetry.startTelemetry({ userId: 'u-engine', deviceId: null });
    engine.start();
    env.t += 1200;
    await finishResync();
    const synced = telemetry.telemetryQueue().filter((e) => e.name === 'sync_completed');
    expect(synced).toHaveLength(1);
    expect(synced[0]?.properties).toMatchObject({ sync_reason: 'startup', duration_ms: 1200 });
    telemetry.resetTelemetry();
  });

  it('a refused handshake (AUTH_*) is handed to the app to check the session, then tried again', async () => {
    const checkSession = vi.fn();
    engine.stop();
    engine = new RealtimeEngine(transport, { ...hooks, checkSession }, env);
    engine.start();
    await finishResync();
    const connects = transport.connects;
    transport.refuse('AUTH_SESSION_REVOKED');
    expect(checkSession).toHaveBeenCalledWith('AUTH_SESSION_REVOKED');
    expect(useSyncStore.getState().socket).toBe('down');
    // Socket.IO never retries a refused handshake: the engine does, once the session check had its chance
    expect(env.pending()).toContain(AUTH_RETRY_MS);
    env.run(AUTH_RETRY_MS);
    expect(transport.connects).toBe(connects + 1);
  });

  it('a socket the server closed (`io server disconnect`) is checked and connected again after a backoff', async () => {
    const checkSession = vi.fn();
    engine.stop();
    engine = new RealtimeEngine(transport, { ...hooks, checkSession }, env);
    engine.start();
    await finishResync();
    transport.up();
    await finishResync();
    const connects = transport.connects;
    transport.close(); // after session.revoked or a failed revalidation (realtime-server.ts)
    expect(checkSession).toHaveBeenCalledWith('closed');
    expect(useSyncStore.getState().socket).toBe('down');
    expect(env.pending()).toEqual([1000]); // 1 s × jitter (0.5 + 0.5)
    transport.close(); // one timer at a time
    expect(env.pending()).toEqual([1000]);
    env.run(1000);
    expect(transport.connects).toBe(connects + 1);
    // still refused or closed: the backoff doubles, and a connection resets it
    transport.close();
    expect(env.pending()).toEqual([2000]);
    env.run(2000);
    transport.up();
    await finishResync();
    transport.close();
    expect(env.pending()).toEqual([1000]);
  });

  it('a session that ended stops the engine: no reconnection is attempted', async () => {
    engine.start();
    await finishResync();
    transport.close();
    expect(env.pending()).toEqual([1000]);
    engine.stop(); // RootLayout → D-15 ج → stopRealtime()
    expect(env.pending()).toEqual([]);
  });

  it('a dropped transport is left to Socket.IO (no extra timer)', async () => {
    engine.start();
    await finishResync();
    transport.up();
    await finishResync();
    transport.down();
    expect(env.pending()).toEqual([]);
  });

  it('a resync still reading when the engine stops writes nothing (sign-out, session end)', async () => {
    let signal: AbortSignal | null = null;
    engine.stop();
    engine = new RealtimeEngine(
      transport,
      {
        ...hooks,
        resync: (reason, s) => {
          signal = s;
          resyncs.push(reason);
          return new Promise((resolve) => resolveResync.push(resolve));
        },
      },
      env,
    );
    engine.start();
    engine.stop();
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    resetSync(); // stopRealtime() resets the sync state for the next user
    await finishResync(true); // the late answer of the previous session
    expect(useSyncStore.getState()).toMatchObject({ stale: true, lastSyncAt: null, syncing: false });
    expect(env.pending()).toEqual([]);
  });

  it('any confirmation after a silence longer than uncertain_after_s asks for a resync (07 §4.5)', async () => {
    engine.start();
    await finishResync();
    expect(useSyncStore.getState().stale).toBe(false);
    env.t += 30_000;
    noteContact(env.t); // within the threshold: nothing
    expect(useSyncStore.getState().stale).toBe(false);
    env.t += 50_000;
    noteContact(env.t); // e.g. a `/v1` reply after 50 s without any
    expect(useSyncStore.getState()).toMatchObject({ stale: true, staleReason: 'heartbeat_gap' });
    expect(resyncs.at(-1)).toBe('heartbeat_gap');
  });

  it('stop closes everything and ignores late frames', () => {
    engine.start();
    engine.stop();
    transport.emit('sync.required', envelope('sync.required', { reason: 'late' }));
    expect(events).toEqual([]);
    expect(useSyncStore.getState().socket).toBe('off');
  });
});
