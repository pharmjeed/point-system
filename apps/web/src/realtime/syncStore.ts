import { create } from 'zustand';
import type { ConnectionState, WaHealthStatus } from '@/api/types';

/**
 * The sync protocol's state (02 §1.7, 07 §4.5, PNT-065), framework-free so the rules are unit-tested:
 *
 * - **stale**: the data on screen may be behind the server. It starts true (nothing read yet) and turns true
 *   again on (re)connection, return to the foreground, `sync.required`, a heartbeat gap or a frame the client
 *   cannot apply. While stale every command waits (02 §1.6 «الأوامر معطلة حتى تكتمل»).
 * - **generation**: each stale trigger bumps it. A snapshot read (`GET /v1/me/home`, the operations board)
 *   clears `stale` only if it *started* after the last trigger, so a reply already in flight when the trigger
 *   arrived never passes for the fresh state.
 * - **contact**: the client time of the last confirmation from the server (a heartbeat ack, any `/v1` reply).
 *   The connection indicator follows it with the `heartbeat.*` thresholds of the org (07 §4.5): online up to
 *   `uncertain_after_s`, uncertain up to `offline_after_s`, then offline — and offline at once when the
 *   browser says so.
 */
export type SocketStatus = 'off' | 'connecting' | 'connected' | 'down';
export type StaleReason =
  | 'start'
  | 'reconnect'
  | 'foreground'
  | 'online'
  | 'sync_required'
  | 'heartbeat_gap'
  | 'invalid_event'
  | 'manual';

export interface HeartbeatSettings {
  interval_s: number;
  uncertain_after_s: number;
  offline_after_s: number;
}

/** Canon §12 `heartbeat.*` defaults (overridden by `GET /v1/me` `heartbeat`). */
export const HEARTBEAT_DEFAULTS: HeartbeatSettings = {
  interval_s: 15,
  uncertain_after_s: 45,
  offline_after_s: 120,
};

export interface SyncState {
  socket: SocketStatus;
  stale: boolean;
  staleReason: StaleReason | null;
  generation: number;
  /** A full resync is running (the thin «جارٍ المزامنة…» strip). */
  syncing: boolean;
  /** Client time (ms) of the last confirmation from the server. */
  lastContactAt: number | null;
  /** Server time of the last snapshot that cleared `stale` («آخر مزامنة», D-15 أ). */
  lastSyncAt: string | null;
  /** The connection state the server reported in the last heartbeat ack (07 §4.4). */
  serverConnection: ConnectionState | null;
  /** WhatsApp channel health from `channel.status` (newer than the snapshot's `channel_health`). */
  channel: { health: WaHealthStatus; changedAt: string } | null;
  heartbeat: HeartbeatSettings;
}

const INITIAL: SyncState = {
  socket: 'off',
  stale: true,
  staleReason: 'start',
  generation: 0,
  syncing: false,
  lastContactAt: null,
  lastSyncAt: null,
  serverConnection: null,
  channel: null,
  heartbeat: HEARTBEAT_DEFAULTS,
};

export const useSyncStore = create<SyncState>()(() => ({ ...INITIAL }));

const set = (patch: Partial<SyncState>) => useSyncStore.setState(patch);
const get = () => useSyncStore.getState();

/** A trigger that needs a full resync before any command (02 §1.7). Returns the new generation. */
export function markStale(reason: StaleReason): number {
  const generation = get().generation + 1;
  set({ stale: true, staleReason: reason, generation });
  return generation;
}

/** The generation a snapshot read starts in; pass it back to {@link completeSnapshot}. */
export function beginSnapshot(): number {
  return get().generation;
}

/**
 * A snapshot read answered. Clears `stale` when no trigger arrived since it started; returns whether it did.
 * `serverTime` is the snapshot's `server_time` (the «آخر مزامنة» shown in D-15 أ).
 */
export function completeSnapshot(generation: number, serverTime: string | null, now = Date.now()): boolean {
  const s = get();
  const patch: Partial<SyncState> = { lastContactAt: now };
  const fresh = generation === s.generation;
  if (fresh) {
    patch.stale = false;
    patch.staleReason = null;
    if (serverTime) patch.lastSyncAt = serverTime;
  }
  set(patch);
  return fresh;
}

export function setSyncing(syncing: boolean): void {
  if (get().syncing !== syncing) set({ syncing });
}

export function setSocketStatus(socket: SocketStatus): void {
  if (get().socket !== socket) set({ socket });
}

/** Any confirmation from the server (heartbeat ack, `/v1` reply). */
export function noteContact(now = Date.now(), serverConnection?: ConnectionState | null): void {
  set(serverConnection === undefined ? { lastContactAt: now } : { lastContactAt: now, serverConnection });
}

export function setHeartbeatSettings(settings: Partial<HeartbeatSettings> | null | undefined): void {
  const next = { ...HEARTBEAT_DEFAULTS, ...cleanSettings(settings) };
  const current = get().heartbeat;
  if (
    next.interval_s !== current.interval_s ||
    next.uncertain_after_s !== current.uncertain_after_s ||
    next.offline_after_s !== current.offline_after_s
  )
    set({ heartbeat: next });
}

function cleanSettings(s: Partial<HeartbeatSettings> | null | undefined): Partial<HeartbeatSettings> {
  const out: Partial<HeartbeatSettings> = {};
  for (const key of ['interval_s', 'uncertain_after_s', 'offline_after_s'] as const) {
    const v = s?.[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[key] = v;
  }
  return out;
}

export function setChannelHealth(health: WaHealthStatus, changedAt: string): void {
  const current = get().channel;
  // channel.status is not versioned (aggregate.version null): the later change wins
  if (current && Date.parse(current.changedAt) > Date.parse(changedAt)) return;
  set({ channel: { health, changedAt } });
}

/** Sign-out, session end, another user: back to the initial state. */
export function resetSync(): void {
  set({ ...INITIAL, heartbeat: get().heartbeat });
}

/**
 * The connection indicator (02 §1.3, D-15 أ/ب): from the browser's connectivity and the age of the last
 * confirmation from the server. Never changes availability or tasks by itself (07 §4.5).
 */
export function connectionStateAt(
  s: Pick<SyncState, 'lastContactAt' | 'heartbeat'>,
  online: boolean,
  now: number,
): ConnectionState {
  if (!online) return 'offline';
  if (s.lastContactAt === null) return 'online';
  const age = now - s.lastContactAt;
  if (age > s.heartbeat.offline_after_s * 1000) return 'offline';
  if (age > s.heartbeat.uncertain_after_s * 1000) return 'uncertain';
  return 'online';
}
