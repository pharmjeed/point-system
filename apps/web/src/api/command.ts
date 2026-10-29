import { ApiError, NetworkError } from './errors';

/**
 * Operational commands and `Idempotency-Key` (02 §1.8, 03 §3.1, 07 §1.4, 08 §8.2):
 * - one key per user intent, generated at the first press;
 * - a retry of the same intent (no reply, or a retryable error) reuses the same key and the same body;
 * - a new key only when the inputs change, or after a definitive answer (2xx or a deterministic 4xx —
 *   the server stored that answer under the key, so resending it would only replay it).
 */

/** UUIDv4 (07 §1.4 prefers v4). Falls back to getRandomValues where randomUUID is missing (http on LAN). */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable fingerprint of a command's inputs (key order independent) to detect "inputs changed". */
export function fingerprint(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalise = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) return v.map(normalise);
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, normalise((v as Record<string, unknown>)[k])]),
    );
  };
  return JSON.stringify(normalise(value)) ?? 'undefined';
}

/** Automatic retries with the SAME key: 1 s, 3 s, 7 s (08 §3 `auto-retry`, §8.2). */
export const NETWORK_RETRY_DELAYS_MS = [1000, 3000, 7000] as const;

/**
 * How long to wait before resending the same command with the same key, or null to stop and surface the
 * error. `attempt` counts retries already made (0 for the first failure).
 */
export function retryDelayFor(error: unknown, attempt: number): number | null {
  if (error instanceof NetworkError) return NETWORK_RETRY_DELAYS_MS[attempt] ?? null;
  if (!(error instanceof ApiError)) return null;
  const afterHeader = error.retryAfterS != null ? error.retryAfterS * 1000 : null;
  switch (error.code) {
    case 'IDEMPOTENCY_IN_PROGRESS': // 02 §1.9: wait (2 s or Retry-After), then the same key
      return attempt < 3 ? (afterHeader ?? 2000) : null;
    case 'INTERNAL_ERROR': // 08 §4.15: once with the same key, then show the error with request_id
      return attempt < 1 ? 1000 : null;
    case 'SERVICE_UNAVAILABLE':
    case 'DEPENDENCY_TIMEOUT':
      return attempt < 3 ? (afterHeader ?? NETWORK_RETRY_DELAYS_MS[attempt] ?? null) : null;
    default:
      return null; // RATE_LIMITED and every business error: show it, the user decides (08 §4.15)
  }
}

/** Whether the outcome of the last attempt is unknown/transient, so the next press must keep the key. */
export function keepsKey(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  return error instanceof ApiError && (error.retryable || error.code === 'IDEMPOTENCY_IN_PROGRESS');
}

export interface CommandRunOptions {
  retryDelays?: (error: unknown, attempt: number) => number | null;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** An unfinished intent: its Idempotency-Key and the fingerprint of the body it was made for. */
export interface CommandIntent {
  key: string;
  print: string;
}

/**
 * Remembers the key of an unfinished intent across presses (one instance per command button / form).
 * Framework-free so it is unit-tested; `useCommand` wraps it for React. The intake commands keep their
 * intent across a reload (02 §1.8 item 1: «وفي IndexedDB لأوامر الاستلام»; PNT-071): `onIntent` reports
 * every change and `restore` resumes a saved one, so the same body is sent again with the same key.
 */
export class CommandSession<TInput> {
  private pending: CommandIntent | null = null;
  private inFlight: Promise<unknown> | null = null;

  constructor(private readonly hooks: { onIntent?: (intent: CommandIntent | null) => void } = {}) {}

  private setPending(next: CommandIntent | null): void {
    const changed = this.pending?.key !== next?.key;
    this.pending = next;
    if (changed) this.hooks.onIntent?.(next);
  }

  /** The unfinished intent, if any (what the next press with the same body resends). */
  get intent(): CommandIntent | null {
    return this.pending;
  }

  /** Resumes an intent saved before a reload (not reported back through `onIntent`). */
  restore(intent: CommandIntent | null): void {
    this.pending = intent;
  }

  /** The key for this input: the unfinished intent's key when the inputs are unchanged, else a new one. */
  keyFor(input: TInput): string {
    const print = fingerprint(input);
    if (this.pending && this.pending.print === print) return this.pending.key;
    const key = newIdempotencyKey();
    this.setPending({ key, print });
    return key;
  }

  get busy(): boolean {
    return this.inFlight !== null;
  }

  /**
   * Sends the command; concurrent calls while one is in flight return the same promise (double-submit
   * guard). Transient failures are retried with the same key; the final error is thrown.
   */
  run<TResult>(
    input: TInput,
    send: (input: TInput, key: string) => Promise<TResult>,
    options: CommandRunOptions = {},
  ): Promise<TResult> {
    if (this.inFlight) return this.inFlight as Promise<TResult>;
    const key = this.keyFor(input);
    const delays = options.retryDelays ?? retryDelayFor;
    const sleep = options.sleep ?? defaultSleep;
    const attemptLoop = async (): Promise<TResult> => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const result = await send(input, key);
          this.setPending(null); // definitive success: the next intent gets a new key
          return result;
        } catch (error) {
          const delay = options.signal?.aborted ? null : delays(error, attempt);
          if (delay === null) {
            if (!keepsKey(error)) this.setPending(null); // definitive answer stored under this key
            throw error;
          }
          await sleep(delay);
        }
      }
    };
    const promise = attemptLoop().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = promise;
    return promise;
  }

  /** Forget the unfinished intent (e.g. the user edited the form or left the screen). */
  reset(): void {
    this.setPending(null);
  }
}
