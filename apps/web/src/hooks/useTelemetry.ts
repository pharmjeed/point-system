import { useEffect, useRef } from 'react';
import type { DriverHome, Me } from '@/api/types';
import { useAudioStore } from '@/stores/audio';
import { startTelemetry, track } from '@/lib/telemetry';
import { useWakeLockStore } from '@/lib/wakeLock';
import { useConnectionState } from '@/realtime/hooks';
import { useSyncStore } from '@/realtime/syncStore';

/**
 * The 15 §8 measurements every signed-in frame (driver and staff) takes (decisions:F5): it opens the
 * telemetry queue for the session's user and device (`app_started`), and reports the connection state
 * changes (`connection_changed`), the Screen Wake Lock (`wake_lock_changed`) and a sound the browser refused
 * (`audio_blocked_detected`). Sign-out and the session end close the queue (`stopTelemetry`).
 */
export function useTelemetry(me: Me): void {
  const userId = me.user.id;
  const deviceId = me.session.device_id ?? null;
  useEffect(() => {
    startTelemetry({ userId, deviceId });
  }, [userId, deviceId]);

  const state = useConnectionState();
  const last = useRef<{ state: typeof state; offlineSince: number | null } | null>(null);
  useEffect(() => {
    const prev = last.current;
    const now = Date.now();
    if (!prev) {
      last.current = { state, offlineSince: state === 'online' ? null : now };
      return;
    }
    if (prev.state === state) return;
    const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const cause =
      state === 'online'
        ? 'recovered'
        : browserOffline
          ? 'navigator_offline'
          : useSyncStore.getState().socket !== 'connected'
            ? 'ws_disconnect'
            : 'heartbeat_timeout';
    track('connection_changed', {
      from: prev.state,
      to: state,
      cause,
      offline_ms: state === 'online' && prev.offlineSince !== null ? now - prev.offlineSince : null,
    });
    last.current = {
      state,
      offlineSince: state === 'online' ? null : (prev.offlineSince ?? now),
    };
  }, [state]);

  useEffect(
    () =>
      useWakeLockStore.subscribe((s, prev) => {
        if (s.status === prev.status) return;
        if (s.status === 'active') track('wake_lock_changed', { supported: true, state: 'acquired' });
        else if (s.status === 'failed') track('wake_lock_changed', { supported: true, state: 'failed' });
        else if (s.status === 'unsupported') track('wake_lock_changed', { supported: false });
        else if (prev.status === 'active') track('wake_lock_changed', { supported: true, state: 'released' });
      }),
    [],
  );

  useEffect(
    () =>
      useAudioStore.subscribe((s, prev) => {
        if (s.status === 'blocked' && prev.status !== 'blocked')
          track('audio_blocked_detected', { recovered_by_tap: false });
      }),
    [],
  );
}

/**
 * 15 §8 `page_hidden_during_duty`: when the page comes back after being hidden during a duty — how long,
 * and whether a task or an open request was in hand (the risk of missed alerts).
 */
export function usePageHiddenTelemetry(onDuty: boolean, home: DriverHome | undefined): void {
  const homeRef = useRef(home);
  homeRef.current = home;
  useEffect(() => {
    if (!onDuty || typeof document === 'undefined') return;
    let hiddenAt: number | null = document.visibilityState === 'hidden' ? Date.now() : null;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt ??= Date.now();
        return;
      }
      if (hiddenAt === null) return;
      const h = homeRef.current;
      track('page_hidden_during_duty', {
        hidden_ms: Date.now() - hiddenAt,
        had_active_task: !!h?.current_task,
        had_open_offer: !!h?.offer,
      });
      hiddenAt = null;
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [onDuty]);
}
