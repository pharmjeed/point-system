import type { QueryClient } from '@tanstack/react-query';
import type { RealtimeEngine } from './engine';
import { useOfferLive } from './offerStore';
import { markStale, resetSync, type StaleReason } from './syncStore';

/**
 * One realtime connection per signed-in user and area (PNT-065), shared by every screen of the area: the
 * driver screens D-03 … D-14 and the staff screens mount and unmount their frames on navigation, so the
 * connection is reference-counted and closed a moment after the last screen leaves (or at once on sign-out
 * and session end). The engine, Socket.IO and the zod schemas are a lazy chunk: the first paint does not wait
 * for them.
 */
export type RealtimeArea = 'driver' | 'staff';

export interface RealtimeHandle {
  engine: RealtimeEngine;
  stop(): void;
}

export interface AcquireOptions {
  area: RealtimeArea;
  userId: string;
  qc: QueryClient;
  /** The driver has an open duty: the HTTP heartbeat fallback applies (07 §4.4). */
  hasDuty: () => boolean;
}

interface Current {
  key: string;
  refs: number;
  handle: Promise<RealtimeHandle | null>;
  closeTimer: ReturnType<typeof setTimeout> | null;
}

let current: Current | null = null;
const RELEASE_DELAY_MS = 3000;

async function load(options: AcquireOptions): Promise<RealtimeHandle | null> {
  try {
    const runtime =
      options.area === 'driver' ? await import('./driverRuntime') : await import('./staffRuntime');
    return runtime.startRealtime(options);
  } catch {
    return null; // the chunk could not load (offline first visit): the screens keep polling
  }
}

function close(entry: Current): void {
  if (entry.closeTimer) clearTimeout(entry.closeTimer);
  void entry.handle.then((h) => h?.stop());
}

/** Starts (or joins) the connection of this user and area; the returned function releases it. */
export function acquireRealtime(options: AcquireOptions): () => void {
  const key = `${options.area}:${options.userId}`;
  if (current && current.key !== key) {
    close(current);
    current = null;
    resetSync();
    useOfferLive.getState().reset();
  }
  if (!current) current = { key, refs: 0, handle: load(options), closeTimer: null };
  const entry = current;
  entry.refs += 1;
  if (entry.closeTimer) {
    clearTimeout(entry.closeTimer);
    entry.closeTimer = null;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.refs -= 1;
    if (entry.refs > 0 || current !== entry) return;
    entry.closeTimer = setTimeout(() => {
      if (current === entry && entry.refs === 0) {
        close(entry);
        current = null;
      }
    }, RELEASE_DELAY_MS);
  };
}

/** Sign-out and session end: the connection closes now and the sync state starts over (02 D-15 ج). */
export function stopRealtime(): void {
  if (current) close(current);
  current = null;
  resetSync();
  useOfferLive.getState().reset();
}

function withEngine(run: (engine: RealtimeEngine) => void): boolean {
  if (!current) return false;
  void current.handle.then((h) => {
    if (h && !h.engine.isStopped) run(h.engine);
  });
  return true;
}

/** «مزامنة الآن» and the command errors that ask for a sync (02 §1.9): a full resync before any command. */
export function requestResync(reason: StaleReason = 'manual'): void {
  if (!withEngine((engine) => engine.requestResync(reason))) markStale(reason);
}

/** `client.offer_seen` for a round now on screen (15 §9.4). */
export function reportOfferSeen(offerId: string, receiveLatencyMs?: number): void {
  withEngine((engine) => engine.offerSeen(offerId, receiveLatencyMs));
}

/** A heartbeat now (the audio state changed, the page became visible). */
export function heartbeatNow(): void {
  withEngine((engine) => void engine.beat());
}
