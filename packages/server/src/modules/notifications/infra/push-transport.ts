import webpush from 'web-push';
import type { Env } from '../../../core/config/env.js';
import type { Logger } from '../../../core/logging/logger.js';

/** One Web Push request: the device's subscription, the JSON payload and the 14 §6.2 headers. */
export interface PushSendRequest {
  endpoint: string;
  p256dh: string;
  auth: string;
  /** the JSON text (encrypted aes128gcm by the sender) */
  payload: string;
  ttlSeconds: number;
  urgency: 'high';
  topic: string;
}

export interface PushSendResult {
  /** HTTP status of the push service; null when no response arrived */
  statusCode: number | null;
  /** `Retry-After` of a 429/503, in ms */
  retryAfterMs: number | null;
  /** transport failure without a status */
  error: 'network' | 'timeout' | 'not_configured' | null;
}

/** The port `job.push_send` talks to (05 §4 `web-push`; a recording sender in tests and local dev). */
export interface PushSender {
  readonly driver: 'web-push' | 'memory' | 'disabled';
  send(req: PushSendRequest): Promise<PushSendResult>;
}

export const PUSH_HTTP_TIMEOUT_MS = 10_000;

/** `Retry-After`: delta seconds or an HTTP date. */
export function parsePushRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const s = Number(value);
  if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * Standard Web Push with VAPID (05 §4, 14 §6): the `web-push` library encrypts the payload (aes128gcm,
 * RFC 8291) and signs the VAPID JWT (`generateRequestDetails`); the request itself goes out with `fetch`
 * so it has a hard timeout and reports `Retry-After`. Never called inside a transaction.
 */
export class WebPushSender implements PushSender {
  readonly driver = 'web-push' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly vapid: VapidConfig,
    opts: { timeoutMs?: number; fetch?: typeof fetch } = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? PUSH_HTTP_TIMEOUT_MS;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async send(req: PushSendRequest): Promise<PushSendResult> {
    const details = webpush.generateRequestDetails(
      { endpoint: req.endpoint, keys: { p256dh: req.p256dh, auth: req.auth } },
      req.payload,
      {
        vapidDetails: this.vapid,
        TTL: req.ttlSeconds,
        urgency: req.urgency,
        topic: req.topic,
        contentEncoding: 'aes128gcm',
      },
    );
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(details.headers ?? {})) {
      if (k.toLowerCase() === 'content-length') continue; // fetch computes it from the body
      headers[k] = String(v);
    }
    try {
      const res = await this.fetchImpl(details.endpoint, {
        method: details.method ?? 'POST',
        headers,
        body: details.body ? new Uint8Array(details.body) : null,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      await res.arrayBuffer().catch(() => undefined); // drain the connection
      return {
        statusCode: res.status,
        retryAfterMs: parsePushRetryAfter(res.headers.get('retry-after')),
        error: null,
      };
    } catch (e) {
      const name = (e as Error)?.name;
      return {
        statusCode: null,
        retryAfterMs: null,
        error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
      };
    }
  }
}

export interface RecordedPush extends PushSendRequest {
  at: Date;
  /** the parsed payload (the dev/test sender keeps it to assert the exact JSON) */
  json: unknown;
}

/**
 * Dev/test sender: no network. It records every request with its parsed payload and answers 201, or the
 * results scripted per endpoint (`respond`), so integration tests assert exact payloads and failures.
 */
export class MemoryPushSender implements PushSender {
  readonly driver = 'memory' as const;
  readonly sent: RecordedPush[] = [];
  private readonly scripted = new Map<string, PushSendResult[]>();

  constructor(
    private readonly opts: { logger?: Logger; clock?: { now(): Date }; maxRecords?: number } = {},
  ) {}

  /** Queues results for an endpoint; `{statusCode: 410}` etc. Unscripted sends answer 201. */
  respond(endpoint: string, ...results: Partial<PushSendResult>[]): void {
    const q = this.scripted.get(endpoint) ?? [];
    for (const r of results) q.push({ statusCode: null, retryAfterMs: null, error: null, ...r });
    this.scripted.set(endpoint, q);
  }

  clear(): void {
    this.sent.length = 0;
    this.scripted.clear();
  }

  async send(req: PushSendRequest): Promise<PushSendResult> {
    let json: unknown;
    try {
      json = JSON.parse(req.payload);
    } catch {
      json = null;
    }
    this.sent.push({ ...req, at: this.opts.clock?.now() ?? new Date(), json });
    const max = this.opts.maxRecords ?? 1000;
    if (this.sent.length > max) this.sent.splice(0, this.sent.length - max);
    const kind = (json as { kind?: string } | null)?.kind;
    this.opts.logger?.debug({ kind, ttl_s: req.ttlSeconds }, 'web push (dev sender, not sent)');
    const q = this.scripted.get(req.endpoint);
    const next = q?.shift();
    return next ?? { statusCode: 201, retryAfterMs: null, error: null };
  }
}

/** Staging/production without VAPID keys: nothing can be sent; every attempt fails permanently. */
export class DisabledPushSender implements PushSender {
  readonly driver = 'disabled' as const;
  async send(): Promise<PushSendResult> {
    return { statusCode: null, retryAfterMs: null, error: 'not_configured' };
  }
}

/**
 * 05 §8: the real sender when both VAPID keys are configured (outside tests); the recording dev sender in
 * `test` and in `local` without keys; a disabled sender in staging/production without keys.
 */
export function selectPushDriver(env: Pick<Env, 'APP_ENV' | 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY'>) {
  if (env.APP_ENV === 'test') return 'memory' as const;
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return 'web-push' as const;
  return env.APP_ENV === 'local' ? ('memory' as const) : ('disabled' as const);
}

export function createPushSender(env: Env, logger: Logger, clock?: { now(): Date }): PushSender {
  switch (selectPushDriver(env)) {
    case 'web-push':
      return new WebPushSender({
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
        subject: env.VAPID_SUBJECT,
      });
    case 'memory':
      if (env.APP_ENV === 'local')
        logger.warn('VAPID keys are not set: Web Push uses the dev sender (nothing leaves the process)');
      return new MemoryPushSender({ logger, ...(clock ? { clock } : {}) });
    case 'disabled':
      logger.error('VAPID keys are not set: Web Push is disabled in this environment');
      return new DisabledPushSender();
  }
}
