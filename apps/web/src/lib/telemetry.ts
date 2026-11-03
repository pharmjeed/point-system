import { buildUrl, CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '@/api/client';

/**
 * Client measurements of 15 §8 sent in batches to `POST /v1/telemetry` (15 §9, §13 item 6; DEC-147, DEC-167;
 * contract:F5, decisions:F5):
 *
 * - nothing is queued before sign-in (D-01, S-01 have no session): `startTelemetry` opens the session's
 *   queue, sign-out and the session end close it (`stopTelemetry`);
 * - every event is checked with the shared catalog's `parseTelemetryEvent` (the property allow-list, the
 *   §3 denylist, the PII value scan) before it enters a batch; one that fails is dropped, never sent. The
 *   catalog is a lazy chunk, loaded at the first flush, so the first paint does not carry it;
 * - a batch leaves every 30 s, at 20 queued events, when the page is hidden (`visibilitychange`, `pagehide`)
 *   and when the browser is back online, with `fetch(…, {keepalive: true})` and the CSRF header (DEC-29) —
 *   never `navigator.sendBeacon`, which cannot set it; at most 50 events and under 64 KB per batch;
 * - offline (a network error) the events stay in memory, up to 200, the oldest dropped first; a 429 waits
 *   `retry_after_s`; a batch the server refuses (4xx) is dropped (it would be refused again).
 *
 * The route is not a command (DEC-149): no Idempotency-Key, no audit row.
 */

export type TelemetryName =
  | 'app_started'
  | 'audio_test_completed'
  | 'audio_blocked_detected'
  | 'notification_permission_changed'
  | 'push_subscription_changed'
  | 'push_notification_clicked'
  | 'pwa_installed'
  | 'connection_changed'
  | 'sync_completed'
  | 'offer_card_seen'
  | 'offer_card_removed'
  | 'ui_error_shown'
  | 'page_hidden_during_duty'
  | 'wake_lock_changed'
  | 'form_draft_restored'
  | 'app_update_applied';

export interface TelemetryContext {
  screen?: string | null;
  task_id?: string | null;
  ticket_id?: string | null;
}

interface QueuedEvent extends TelemetryContext {
  name: TelemetryName;
  occurred_at: string;
  seq: number;
  properties: Record<string, unknown>;
}

export const TELEMETRY_FLUSH_MS = 30_000;
export const TELEMETRY_FLUSH_AT = 20;
export const TELEMETRY_MAX_QUEUE = 200;
const MAX_BATCH_EVENTS = 50;
/** Under the server's 64 KB (15 §9.3) and the browser's keepalive body budget. */
const MAX_BATCH_BYTES = 60 * 1024;

export const APP_VERSION = import.meta.env.VITE_APP_VERSION || '0.0.0';

interface Session {
  userId: string;
  deviceId: string | null;
}

let session: Session | null = null;
let queue: QueuedEvent[] = [];
let seq = 0;
let clientSessionId: string | null = null;
let flushing: Promise<void> | null = null;
let retryAfterUntil = 0;
let interval: ReturnType<typeof setInterval> | null = null;
let detach: (() => void) | null = null;
const startedFor = new Set<string>();

type Parse = (raw: unknown) => { ok: boolean };
let parser: Promise<Parse> | null = null;
function loadParser(): Promise<Parse> {
  parser ??= import('@shared/analytics').then((m) => m.parseTelemetryEvent as Parse);
  return parser;
}

function newClientSessionId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** The platform / browser of 15 §8 `app_started` (coarse families only, never the user agent itself). */
export function deviceFamily(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): {
  platform: 'ios' | 'android' | 'desktop' | 'other';
  browser_family: 'safari' | 'chrome' | 'samsung' | 'firefox' | 'edge' | 'other';
  browser_major: number | null;
} {
  const platform = /iPhone|iPad|iPod/i.test(ua)
    ? 'ios'
    : /Android/i.test(ua)
      ? 'android'
      : /Windows|Macintosh|Linux|CrOS/i.test(ua)
        ? 'desktop'
        : 'other';
  const rules: Array<[RegExp, 'samsung' | 'edge' | 'firefox' | 'chrome' | 'safari']> = [
    [/SamsungBrowser\/(\d+)/, 'samsung'],
    [/Edg(?:A|iOS)?\/(\d+)/, 'edge'],
    [/(?:Firefox|FxiOS)\/(\d+)/, 'firefox'],
    [/(?:Chrome|CriOS)\/(\d+)/, 'chrome'],
    [/Version\/(\d+).*Safari\//, 'safari'],
  ];
  for (const [re, family] of rules) {
    const m = re.exec(ua);
    if (m) return { platform, browser_family: family, browser_major: Number(m[1]) };
  }
  return { platform, browser_family: 'other', browser_major: null };
}

function standalone(): boolean {
  try {
    return (
      window.matchMedia?.('(display-mode: standalone)').matches === true ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

const INSTALLED_KEY = 'point.telemetry.pwa_installed';

/**
 * Opens the session's queue (idempotent for the same user and device): `app_started` once per page load and
 * user, `pwa_installed` the first time this browser runs as the installed app.
 */
export function startTelemetry(next: Session): void {
  if (session && session.userId === next.userId && session.deviceId === next.deviceId) return;
  if (session && session.userId !== next.userId) queue = [];
  session = next;
  clientSessionId ??= newClientSessionId();
  attach();
  if (!startedFor.has(next.userId)) {
    startedFor.add(next.userId);
    const family = deviceFamily();
    track('app_started', { display_mode: standalone() ? 'standalone' : 'browser', ...family });
    if (standalone()) {
      let seen: boolean;
      try {
        seen = localStorage.getItem(INSTALLED_KEY) === '1';
        if (!seen) localStorage.setItem(INSTALLED_KEY, '1');
      } catch {
        seen = true; // no storage: never report it on every load
      }
      if (!seen) track('pwa_installed', { platform: family.platform, method: 'detected_standalone' });
    }
  }
}

/** Sign-out / session end: what is queued leaves now (best effort), then nothing more is taken. */
export function stopTelemetry(): void {
  if (!session) return;
  const last = session;
  session = null;
  void (flushing ?? Promise.resolve()).then(() => send(last)); // the session's own events, under its device
  if (interval !== null) clearInterval(interval);
  interval = null;
  detach?.();
  detach = null;
}

function attach(): void {
  if (interval === null) interval = setInterval(() => void flushTelemetry(), TELEMETRY_FLUSH_MS);
  if (detach || typeof window === 'undefined') return;
  const onHide = () => {
    if (document.visibilityState === 'hidden') void flushTelemetry();
  };
  const onPageHide = () => void flushTelemetry();
  const onOnline = () => void flushTelemetry();
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('online', onOnline);
  detach = () => {
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('online', onOnline);
  };
}

/** Drops `null` / `undefined` properties (every 15 §8 property is optional). */
function clean(properties: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(properties)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

/**
 * Queues one 15 §8 measurement (dropped before sign-in). `now` is the device time of the measurement.
 * Returns whether it was queued; the catalog check happens before it enters a batch.
 */
export function track(
  name: TelemetryName,
  properties: Record<string, unknown> = {},
  context: TelemetryContext = {},
  options: { flush?: boolean } = {},
): boolean {
  if (!session) return false;
  seq += 1;
  queue.push({
    name,
    occurred_at: new Date().toISOString(),
    seq,
    ...(context.screen ? { screen: context.screen } : {}),
    ...(context.task_id ? { task_id: context.task_id } : {}),
    ...(context.ticket_id ? { ticket_id: context.ticket_id } : {}),
    properties: clean(properties),
  });
  if (queue.length > TELEMETRY_MAX_QUEUE) queue.splice(0, queue.length - TELEMETRY_MAX_QUEUE);
  if (options.flush || queue.length >= TELEMETRY_FLUSH_AT) void flushTelemetry();
  return true;
}

/** Sends what is queued, in batches; a flush already running is joined. */
export function flushTelemetry(): Promise<void> {
  const owner = session;
  if (!owner) return flushing ?? Promise.resolve();
  flushing ??= send(owner).finally(() => {
    flushing = null;
  });
  return flushing;
}

async function send(owner: Session): Promise<void> {
  const parse = await loadParser().catch(() => null);
  if (!parse) return; // the chunk could not load (offline first visit): kept for the next flush
  while (queue.length && Date.now() >= retryAfterUntil) {
    // another user signed in meanwhile: the queue is theirs now
    if (session && session.userId !== owner.userId) return;
    const deviceId = owner.deviceId;
    // the catalog check before the batch (DEC-167): an event that fails it is dropped
    queue = queue.filter((e) => parse(e).ok);
    const batch: QueuedEvent[] = [];
    let bytes = 0;
    for (const e of queue) {
      const size = JSON.stringify(e).length + 1;
      if (batch.length >= MAX_BATCH_EVENTS || (batch.length && bytes + size > MAX_BATCH_BYTES - 512)) break;
      batch.push(e);
      bytes += size;
    }
    if (!batch.length) return;
    queue = queue.slice(batch.length);
    let response: Response;
    try {
      response = await fetch(buildUrl('/v1/telemetry'), {
        method: 'POST',
        credentials: 'include',
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
        },
        body: JSON.stringify({
          app_version: APP_VERSION,
          device_id: deviceId,
          client_session_id: clientSessionId,
          events: batch,
        }),
      });
    } catch {
      requeue(batch); // offline: kept in memory for the next flush
      return;
    }
    if (response.status === 429) {
      const body = (await response.json().catch(() => null)) as {
        error?: { details?: { retry_after_s?: unknown } };
      } | null;
      const header = Number(response.headers.get('Retry-After'));
      const fromBody = Number(body?.error?.details?.retry_after_s);
      const seconds = Number.isFinite(fromBody) && fromBody > 0 ? fromBody : header > 0 ? header : 60;
      retryAfterUntil = Date.now() + seconds * 1000;
      requeue(batch);
      return;
    }
    if (response.status >= 500) {
      requeue(batch);
      return;
    }
    // 202, or a batch the server refuses (VALIDATION_FAILED, the session gone): sending it again would not help
  }
}

function requeue(batch: QueuedEvent[]): void {
  queue = [...batch, ...queue];
  if (queue.length > TELEMETRY_MAX_QUEUE) queue.splice(0, queue.length - TELEMETRY_MAX_QUEUE);
}

/** Tests: the queue as it stands, and a clean slate. */
export function telemetryQueue(): readonly QueuedEvent[] {
  return queue;
}

export function resetTelemetry(): void {
  if (interval !== null) clearInterval(interval);
  interval = null;
  detach?.();
  detach = null;
  session = null;
  queue = [];
  seq = 0;
  clientSessionId = null;
  flushing = null;
  retryAfterUntil = 0;
  startedFor.clear();
}
