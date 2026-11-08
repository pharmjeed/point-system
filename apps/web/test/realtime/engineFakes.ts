import type { EngineEnv, Transport, TransportStatus } from '@/realtime/engine';
import { IDS } from './fixtures';

/** A transport the test drives: connection status, frames from the server, acks. */
export class FakeTransport implements Transport {
  connected = false;
  connects = 0;
  readonly acks: Array<{ event: string; payload: unknown }> = [];
  ackReply: (event: string, payload: unknown) => unknown = () => ({
    data: { server_time: '2026-10-29T18:00:00.000Z', connection_state: 'online', sync_required: false },
  });
  private status = new Set<(s: TransportStatus, code?: string) => void>();
  private frames = new Set<(event: string, frame: unknown) => void>();
  connect() {
    this.connects += 1;
  }
  disconnect() {
    this.connected = false;
  }
  onStatus(l: (s: TransportStatus, code?: string) => void) {
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
  /** The server called `socket.disconnect(true)` (`io server disconnect`). */
  close() {
    this.connected = false;
    for (const l of this.status) l('closed');
  }
  refuse(code?: string) {
    for (const l of this.status) l('error', code);
  }
  emit(event: string, frame: unknown) {
    for (const l of this.frames) l(event, frame);
  }
}

/** Timers the test runs by hand (with the delays the engine asked for). */
export class FakeEnv implements EngineEnv {
  t = 1_000_000;
  private visibility = new Set<(v: boolean) => void>();
  private online = new Set<() => void>();
  intervals: Array<() => void> = [];
  timeouts: Array<() => void> = [];
  readonly delays = new Map<() => void, number>();
  now = () => this.t;
  random = () => 0.5;
  setInterval = (fn: () => void) => {
    this.intervals.push(fn);
    return fn;
  };
  clearInterval = (h: unknown) => {
    this.intervals = this.intervals.filter((f) => f !== h);
  };
  setTimeout = (fn: () => void, ms: number) => {
    this.timeouts.push(fn);
    this.delays.set(fn, ms);
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
  /** The delays of the pending timeouts, in order. */
  pending(): number[] {
    return this.timeouts.map((f) => this.delays.get(f) ?? -1);
  }
  /** Runs the pending timeout that was scheduled with `ms`. */
  run(ms: number): void {
    const fn = this.timeouts.find((f) => this.delays.get(f) === ms);
    if (!fn) throw new Error(`no timeout of ${ms} ms (pending: ${this.pending().join(', ')})`);
    this.timeouts = this.timeouts.filter((f) => f !== fn);
    fn();
  }
}

export const flush = () => new Promise((r) => setTimeout(r, 0));

export function envelope(
  type: string,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
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
