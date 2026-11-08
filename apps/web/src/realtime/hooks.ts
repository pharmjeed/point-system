import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { queryKeys } from '@/api/queryClient';
import type { ConnectionState, Me } from '@/api/types';
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

export interface CommandGate {
  /** A command may be sent now. */
  ready: boolean;
  /** The connection is lost (D-15 أ). */
  offline: boolean;
  /** No confirmation from the server for longer than `heartbeat.uncertain_after_s` (D-15 ب). */
  uncertain: boolean;
  /** The data on screen waits for its full resync (02 §1.6 «إعادة المزامنة»). */
  stale: boolean;
  /**
   * Offline or uncertain: no confirmed connection. 03 §4.4 «عند uncertain/offline … تُعطَّل أزرار القبول
   * والتسليم مع نص «يتطلب اتصالًا»», 07 §4.5 «بلا اتصال مؤكد … يُعطّل القبول والتسليم حتى المزامنة»: the cards
   * dim and the buttons say why.
   */
  unconfirmed: boolean;
}

/**
 * Whether a command may be sent now (02 §1.6, §1.7, 03 §4.4; PNT-065 acceptance 2): never without a confirmed
 * connection (offline or uncertain), and never while the data is stale — until the full resync after a
 * reconnection, a return to the foreground, a `sync.required` or a silence has completed. The server checks
 * every command anyway.
 */
export function commandGate(connection: ConnectionState, stale: boolean): CommandGate {
  const offline = connection === 'offline';
  const uncertain = connection === 'uncertain';
  const unconfirmed = offline || uncertain;
  return { ready: !unconfirmed && !stale, offline, uncertain, stale, unconfirmed };
}

export function useCommandGate(): CommandGate {
  const connection = useConnectionState();
  const stale = useSyncStore((s) => s.stale);
  return commandGate(connection, stale);
}
