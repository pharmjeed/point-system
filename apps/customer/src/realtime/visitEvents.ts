/**
 * The customer app's live channel (V2-015, DEC-520): Socket.IO on the API's `WS_PATH` (`/ws`), namespace `/customer`,
 * authenticated by `Authorization: Bearer <access token>` on the handshake (React Native's WebSocket sends
 * `extraHeaders`). The server joins the socket to the account's room only and sends `visit.updated` — a minimal
 * projection the screen answers by reading the visit again (the server is the source of truth). Delivery is at most
 * once, so every (re)connection asks the screens to read again as well (`onResync`). Each reconnection takes a fresh
 * access token (the 15-minute token is refreshed by the API client); `session.revoked` stops the channel.
 *
 * Fake mode (development, DEC-482): the in-memory backend's listeners, with a clock loop that moves the demo visit.
 */
import {
  CUSTOMER_REALTIME_NAMESPACE,
  CustomerRealtimeEnvelopeSchema,
  CustomerVisitUpdatedSchema,
  type CustomerVisitUpdated,
} from '@point/shared/customer';
import type { io as ioFn, Socket } from 'socket.io-client';

export interface VisitEventsListener {
  onVisit(e: CustomerVisitUpdated): void;
  /** connected again after a gap: read what is on screen again */
  onResync?(): void;
}

export interface VisitEvents {
  subscribe(listener: VisitEventsListener): () => void;
  close(): void;
}

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

/** The live channel over Socket.IO. `io` is injected (tests); the app passes socket.io-client's. */
export function socketVisitEvents(o: {
  baseUrl: string;
  path?: string;
  accessToken: () => Promise<string>;
  io: typeof ioFn;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): VisitEvents {
  const listeners = new Set<VisitEventsListener>();
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let socket: Socket | null = null;
  let timer: unknown = null;
  let attempt = 0;
  let stopped = true;

  const resync = () => {
    for (const l of listeners) l.onResync?.();
  };

  function schedule() {
    if (stopped || timer !== null) return;
    const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
    attempt++;
    timer = setTimer(() => {
      timer = null;
      void open();
    }, wait);
  }

  async function open() {
    if (stopped) return;
    let token: string;
    try {
      token = await o.accessToken();
    } catch {
      // signed out (or offline before the refresh): the session layer decides; try again later
      return schedule();
    }
    if (stopped) return;
    const origin = o.baseUrl.replace(/\/+$/, '');
    const s = o.io(`${origin}${CUSTOMER_REALTIME_NAMESPACE}`, {
      path: o.path ?? '/ws',
      transports: ['websocket'],
      reconnection: false, // our loop: every attempt carries a fresh access token
      forceNew: true,
      extraHeaders: { Authorization: `Bearer ${token}` },
    });
    socket = s;
    s.on('connect', () => {
      attempt = 0;
      resync();
    });
    s.on('visit.updated', (raw: unknown) => {
      const env = CustomerRealtimeEnvelopeSchema.safeParse(raw);
      const data = env.success ? CustomerVisitUpdatedSchema.safeParse(env.data.payload) : null;
      if (!data?.success) return;
      for (const l of listeners) l.onVisit(data.data);
    });
    s.on('session.revoked', () => {
      stopped = true;
      s.close();
    });
    const lost = () => {
      if (socket !== s) return;
      socket = null;
      s.removeAllListeners();
      s.close();
      schedule();
    };
    s.on('disconnect', lost);
    s.on('connect_error', lost);
  }

  const channel: VisitEvents = {
    subscribe(listener) {
      listeners.add(listener);
      if (stopped && listeners.size === 1) {
        stopped = false;
        attempt = 0;
        void open();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) channel.close();
      };
    },
    close() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      socket?.removeAllListeners();
      socket?.close();
      socket = null;
    },
  };
  return channel;
}

/** Fake mode: the in-memory backend's events for the signed-in account, and a clock loop that moves the visits. */
export function fakeVisitEvents(o: {
  subscribe: (accessToken: string, fn: (e: CustomerVisitUpdated) => void) => () => void;
  tick: () => void;
  accessToken: () => Promise<string>;
  intervalMs?: number;
}): VisitEvents {
  const listeners = new Set<VisitEventsListener>();
  let off: (() => void) | null = null;
  let loop: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    off?.();
    off = null;
    if (loop) clearInterval(loop);
    loop = null;
  };
  const start = async () => {
    const token = await o.accessToken().catch(() => null);
    if (!token || off || listeners.size === 0) return;
    off = o.subscribe(token, (e) => {
      for (const l of listeners) l.onVisit(e);
    });
    loop = setInterval(o.tick, o.intervalMs ?? 2000);
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      void start();
      listener.onResync?.();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    close: stop,
  };
}
