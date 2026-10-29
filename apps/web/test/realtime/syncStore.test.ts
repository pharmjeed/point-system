import { afterEach, describe, expect, it } from 'vitest';
import {
  beginSnapshot,
  completeSnapshot,
  connectionStateAt,
  HEARTBEAT_DEFAULTS,
  markStale,
  resetSync,
  setChannelHealth,
  setHeartbeatSettings,
  useSyncStore,
} from '@/realtime/syncStore';

afterEach(() => resetSync());

describe('stale flag and snapshot generations (02 §1.7, PNT-065)', () => {
  it('starts stale; a snapshot started in the current generation clears it', () => {
    expect(useSyncStore.getState().stale).toBe(true);
    const gen = beginSnapshot();
    expect(completeSnapshot(gen, '2026-10-29T18:00:00.000Z')).toBe(true);
    expect(useSyncStore.getState()).toMatchObject({ stale: false, lastSyncAt: '2026-10-29T18:00:00.000Z' });
  });

  it('a snapshot that started before the last trigger never passes for the fresh state', () => {
    const before = beginSnapshot();
    completeSnapshot(before, '2026-10-29T18:00:00.000Z');
    const inFlight = beginSnapshot(); // e.g. a poll already on the wire
    markStale('reconnect'); // the trigger arrives while it travels
    expect(completeSnapshot(inFlight, '2026-10-29T18:00:05.000Z')).toBe(false);
    expect(useSyncStore.getState()).toMatchObject({ stale: true, staleReason: 'reconnect' });
    expect(useSyncStore.getState().lastSyncAt).toBe('2026-10-29T18:00:00.000Z');
    const fresh = beginSnapshot();
    expect(completeSnapshot(fresh, '2026-10-29T18:00:06.000Z')).toBe(true);
    expect(useSyncStore.getState()).toMatchObject({ stale: false, lastSyncAt: '2026-10-29T18:00:06.000Z' });
  });

  it('every completed read is a contact, fresh or not', () => {
    const gen = beginSnapshot();
    markStale('foreground');
    completeSnapshot(gen, null, 1234);
    expect(useSyncStore.getState().lastContactAt).toBe(1234);
  });
});

describe('connection indicator (02 §1.3, D-15 أ/ب, 07 §4.5)', () => {
  const s = (lastContactAt: number | null) => ({ lastContactAt, heartbeat: HEARTBEAT_DEFAULTS });

  it('offline at once when the browser says so', () => {
    expect(connectionStateAt(s(1000), false, 1000)).toBe('offline');
  });

  it('online until uncertain_after_s, uncertain until offline_after_s, then offline', () => {
    const t0 = 1_000_000;
    expect(connectionStateAt(s(t0), true, t0 + 45_000)).toBe('online');
    expect(connectionStateAt(s(t0), true, t0 + 45_001)).toBe('uncertain');
    expect(connectionStateAt(s(t0), true, t0 + 120_000)).toBe('uncertain');
    expect(connectionStateAt(s(t0), true, t0 + 120_001)).toBe('offline');
  });

  it('follows the org thresholds from GET /v1/me', () => {
    setHeartbeatSettings({ interval_s: 10, uncertain_after_s: 30, offline_after_s: 60 });
    const { heartbeat } = useSyncStore.getState();
    expect(heartbeat).toEqual({ interval_s: 10, uncertain_after_s: 30, offline_after_s: 60 });
    expect(connectionStateAt({ lastContactAt: 0, heartbeat }, true, 31_000)).toBe('uncertain');
    setHeartbeatSettings({ interval_s: -1 } as never);
    expect(useSyncStore.getState().heartbeat).toEqual(HEARTBEAT_DEFAULTS);
  });
});

describe('channel.status', () => {
  it('a later change wins; an older one is ignored (not versioned)', () => {
    setChannelHealth('down', '2026-10-29T18:00:10.000Z');
    setChannelHealth('healthy', '2026-10-29T18:00:05.000Z');
    expect(useSyncStore.getState().channel).toEqual({
      health: 'down',
      changedAt: '2026-10-29T18:00:10.000Z',
    });
    setChannelHealth('healthy', '2026-10-29T18:01:00.000Z');
    expect(useSyncStore.getState().channel?.health).toBe('healthy');
  });
});
