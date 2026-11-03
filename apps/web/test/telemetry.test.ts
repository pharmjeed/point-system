import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTelemetryEvent, TELEMETRY_LIMITS, TelemetryBatchSchema } from '@shared/analytics';
import { recordServerTime } from '@/lib/serverClock';
import {
  deviceFamily,
  flushTelemetry,
  resetTelemetry,
  startTelemetry,
  stopTelemetry,
  telemetryQueue,
  TELEMETRY_FLUSH_AT,
  TELEMETRY_MAX_QUEUE,
  track,
} from '@/lib/telemetry';

const DEVICE = '5a0d6c8e-2a51-4a3e-9c1f-6f0a1b2c3d4e';
const OFFER = '0193b6f2-0000-7000-8000-0000000000f1';

type Call = {
  url: string;
  init: RequestInit;
  body: { events: Array<Record<string, unknown>> } & Record<string, unknown>;
};

function server(...statuses: Array<number | 'network'>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const status = statuses.length > 1 ? statuses.shift()! : (statuses[0] ?? 202);
    if (status === 'network') throw new TypeError('Failed to fetch');
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    return new Response(
      status === 429
        ? JSON.stringify({ error: { code: 'RATE_LIMITED', details: { retry_after_s: 30 } } })
        : null,
      { status, headers: { 'Content-Type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetch);
  return { calls, fetch };
}

beforeEach(() => resetTelemetry());
afterEach(() => {
  resetTelemetry();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('client telemetry (15 §8/§9, DEC-167; contract:F5, decisions:F5)', () => {
  it('queues nothing before sign-in (D-01, S-01 have no session)', async () => {
    const { calls } = server(202);
    expect(track('audio_test_completed', { result: 'heard' })).toBe(false);
    await flushTelemetry();
    expect(calls).toHaveLength(0);
  });

  it('posts the batch with keepalive, the CSRF header and the device; every event passes the shared catalog', async () => {
    const { calls } = server(202);
    startTelemetry({ userId: 'u1', deviceId: DEVICE });
    track(
      'audio_test_completed',
      { result: 'heard', audio_api: 'web_audio', context: 'duty_start' },
      { screen: 'D-03' },
    );
    track('offer_card_seen', { offer_id: OFFER, via: 'sync', mode: 'single', receive_latency_ms: -120 });
    await flushTelemetry();
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe('/v1/telemetry');
    expect(call!.init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'include' });
    expect(new Headers(call!.init.headers).get('X-Requested-With')).toBe('point-web');
    expect(new Headers(call!.init.headers).get('Idempotency-Key')).toBeNull(); // not a command (DEC-149)
    expect(TelemetryBatchSchema.safeParse(call!.body).success).toBe(true);
    expect(call!.body.device_id).toBe(DEVICE);
    expect(call!.body.events.map((e) => e.name)).toEqual([
      'app_started',
      'audio_test_completed',
      'offer_card_seen',
    ]);
    for (const e of call!.body.events) expect(parseTelemetryEvent(e).ok, String(e.name)).toBe(true);
    const seqs = call!.body.events.map((e) => e.seq as number);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(telemetryQueue()).toHaveLength(0);
  });

  it('an event outside the allow-list (unknown property, a phone, Arabic text) never leaves the device', async () => {
    const { calls } = server(202);
    startTelemetry({ userId: 'u1', deviceId: DEVICE });
    track('audio_test_completed', { result: 'heard', phone: '0551234567' });
    track('ui_error_shown', { error_code: 'VERSION_CONFLICT', screen: 'S-03', presentation: 'toast' });
    track('wake_lock_changed', { supported: true, state: 'نشط' });
    await flushTelemetry();
    expect(calls[0]!.body.events.map((e) => e.name)).toEqual(['app_started', 'ui_error_shown']);
  });

  it('leaves at 20 queued events, and in batches of at most 50', async () => {
    const { calls } = server(202);
    startTelemetry({ userId: 'u1', deviceId: null });
    for (let i = 1; i < TELEMETRY_FLUSH_AT - 1; i += 1)
      track('wake_lock_changed', { supported: true, state: 'acquired' });
    await Promise.resolve();
    expect(calls).toHaveLength(0);
    track('wake_lock_changed', { supported: true, state: 'released' }); // the 20th
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body.events).toHaveLength(TELEMETRY_FLUSH_AT);
    await flushTelemetry();
    // 120 more while offline-free: 50 + 50 + 20
    calls.length = 0;
    for (let i = 0; i < 120; i += 1) track('wake_lock_changed', { supported: true, state: 'acquired' });
    await flushTelemetry();
    await flushTelemetry();
    expect(calls.map((c) => c.body.events.length).reduce((a, b) => a + b, 0)).toBe(120);
    expect(Math.max(...calls.map((c) => c.body.events.length))).toBeLessThanOrEqual(50);
  });

  it('offline: kept in memory (at most 200, the oldest dropped) and sent at the next flush', async () => {
    const net = server('network', 202);
    startTelemetry({ userId: 'u1', deviceId: DEVICE });
    track('connection_changed', { from: 'online', to: 'offline', cause: 'navigator_offline' });
    await flushTelemetry();
    expect(telemetryQueue().map((e) => e.name)).toEqual(['app_started', 'connection_changed']);
    await flushTelemetry();
    expect(net.calls[0]!.body.events.map((e) => e.name)).toEqual(['app_started', 'connection_changed']);
    resetTelemetry();
    server('network');
    startTelemetry({ userId: 'u2', deviceId: DEVICE });
    for (let i = 0; i < 260; i += 1)
      track('wake_lock_changed', { supported: true, state: 'acquired' }, {}, {});
    await flushTelemetry();
    expect(telemetryQueue()).toHaveLength(TELEMETRY_MAX_QUEUE);
    expect(telemetryQueue()[0]!.name).toBe('wake_lock_changed'); // app_started was the oldest
  });

  it('a 429 waits retry_after_s before the next batch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { calls } = server(429, 202);
    startTelemetry({ userId: 'u1', deviceId: DEVICE });
    await flushTelemetry();
    expect(calls).toHaveLength(1);
    await flushTelemetry();
    expect(calls).toHaveLength(1); // still waiting
    vi.setSystemTime(Date.now() + 31_000);
    await flushTelemetry();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.events.map((e) => e.name)).toEqual(['app_started']);
  });

  it('sign-out takes nothing more and sends nothing under the ended session', async () => {
    const { calls } = server(202);
    startTelemetry({ userId: 'u1', deviceId: DEVICE });
    stopTelemetry();
    await flushTelemetry();
    expect(calls).toHaveLength(0); // the server session is gone: a send could only meet a 401
    expect(track('wake_lock_changed', { supported: true, state: 'released' })).toBe(false);
    // the same user signs in again: what was left leaves under their new session
    startTelemetry({ userId: 'u1', deviceId: DEVICE });
    await flushTelemetry();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.events.map((e) => e.name)).toEqual(['app_started']);
  });

  it('int-web review: a shared phone — what user A left queued never leaves under user B', async () => {
    const DEVICE_B = '6a0d6c8e-2a51-4a3e-9c1f-6f0a1b2c3d4f';
    const net = server('network', 202);
    startTelemetry({ userId: 'uA', deviceId: DEVICE });
    track('wake_lock_changed', { supported: true, state: 'acquired' });
    track('audio_test_completed', { result: 'heard', audio_api: 'web_audio', context: 'duty_start' });
    await flushTelemetry(); // offline: kept
    expect(telemetryQueue()).toHaveLength(3);
    stopTelemetry();
    startTelemetry({ userId: 'uB', deviceId: DEVICE_B });
    await flushTelemetry();
    expect(net.calls).toHaveLength(1);
    const [batch] = net.calls;
    expect(batch!.body.device_id).toBe(DEVICE_B);
    expect(batch!.body.events.map((e) => e.name)).toEqual(['app_started']);
    expect(batch!.body.events[0]!.seq).toBe(1); // a fresh sequence for B
  });

  it('int-web review: a batch of user A failing after B signed in is never put back into B’s queue', async () => {
    let release!: () => void;
    const calls: Call[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (calls.push({ url, init, body }) === 1) {
          await new Promise<void>((r) => (release = r));
          throw new TypeError('Failed to fetch');
        }
        return new Response(null, { status: 202 });
      }),
    );
    startTelemetry({ userId: 'uA', deviceId: DEVICE });
    track('wake_lock_changed', { supported: true, state: 'acquired' });
    const inFlight = flushTelemetry();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    stopTelemetry();
    startTelemetry({ userId: 'uB', deviceId: null });
    release();
    await inFlight;
    expect(telemetryQueue().map((e) => e.name)).toEqual(['app_started']); // B's own only
    await flushTelemetry();
    expect(calls[1]!.body.events.map((e) => e.name)).toEqual(['app_started']);
    expect(calls[1]!.body.device_id).toBeNull();
  });

  it('a 401 (the session ended under the batch) keeps it for the same user, never another', async () => {
    const { calls } = server(401, 202);
    startTelemetry({ userId: 'u1', deviceId: DEVICE });
    track('wake_lock_changed', { supported: true, state: 'acquired' });
    await flushTelemetry();
    expect(calls).toHaveLength(1);
    expect(telemetryQueue().map((e) => e.name)).toEqual(['app_started', 'wake_lock_changed']);
    stopTelemetry();
    startTelemetry({ userId: 'u1', deviceId: DEVICE });
    await flushTelemetry();
    expect(calls[1]!.body.events.map((e) => e.name)).toEqual(['app_started', 'wake_lock_changed']);
  });

  it('int-web review: occurred_at is on server time — a phone 10 minutes fast stays inside the server window', async () => {
    const { calls } = server(202);
    const deviceNow = Date.now();
    recordServerTime(new Date(deviceNow - 10 * 60_000).toISOString(), deviceNow); // the server is 10 min behind
    startTelemetry({ userId: 'u1', deviceId: DEVICE });
    track('offer_card_seen', { offer_id: OFFER, via: 'sync', mode: 'single' }, {}, { flush: true });
    await flushTelemetry();
    const seen = calls[0]!.body.events.find((e) => e.name === 'offer_card_seen')!;
    const delta = Date.parse(String(seen.occurred_at)) - (Date.now() - 10 * 60_000); // vs the server's now
    expect(Math.abs(delta)).toBeLessThan(5_000);
    expect(delta).toBeLessThanOrEqual(TELEMETRY_LIMITS.futureWindowMs);
    recordServerTime(new Date().toISOString());
  });

  it('app_started carries coarse device families only', () => {
    expect(
      deviceFamily(
        'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
      ),
    ).toEqual({ platform: 'android', browser_family: 'chrome', browser_major: 131 });
    expect(
      deviceFamily(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
      ),
    ).toEqual({ platform: 'ios', browser_family: 'safari', browser_major: 18 });
  });
});
