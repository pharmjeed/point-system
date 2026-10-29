import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { queryKeys } from '@/api/queryClient';
import type { Me } from '@/api/types';
import { hasOpenDuty } from '@/app/paths';
import { useOnline } from '@/hooks/useOnline';
import { acquireRealtime, type RealtimeArea } from './manager';
import { connectionStateAt, setHeartbeatSettings, useSyncStore } from './syncStore';

/**
 * Starts (or joins) the realtime connection of the signed-in user for an area (driver frame, staff frame) and
 * keeps the org's heartbeat thresholds from `GET /v1/me` (07 §4.5).
 */
export function useRealtime(area: RealtimeArea, me: Me): void {
  const qc = useQueryClient();
  const heartbeat = me.heartbeat;
  useEffect(() => {
    setHeartbeatSettings(heartbeat);
  }, [heartbeat]);
  const userId = me.user.id;
  useEffect(
    () =>
      acquireRealtime({
        area,
        userId,
        qc,
        hasDuty: () => {
          const current = qc.getQueryData<Me>(queryKeys.me);
          return !!current && hasOpenDuty(current);
        },
      }),
    [area, userId, qc],
  );
}

/** Re-renders every `ms` (the connection indicator follows the age of the last contact). */
export function useTicker(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** 02 §1.3 / D-15 أ-ب: online, uncertain (late confirmations) or offline. */
export function useConnectionState() {
  const online = useOnline();
  const lastContactAt = useSyncStore((s) => s.lastContactAt);
  const heartbeat = useSyncStore((s) => s.heartbeat);
  const now = useTicker(2000);
  return connectionStateAt({ lastContactAt, heartbeat }, online, now);
}

/**
 * Whether a command may be sent now (02 §1.6, §1.7; PNT-065 acceptance 2): never while offline, and never
 * while the data is stale — until the full resync after a reconnection, a return to the foreground or a
 * `sync.required` has completed. The server checks every command anyway.
 */
export function useCommandGate(): { ready: boolean; offline: boolean; stale: boolean } {
  const connection = useConnectionState();
  const stale = useSyncStore((s) => s.stale);
  const offline = connection === 'offline';
  return { ready: !offline && !stale, offline, stale };
}
