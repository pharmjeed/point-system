import { recordServerTime } from '@/lib/serverClock';
import { ApiError, NetworkError } from './errors';
import type { Envelope, ErrorEnvelope, Meta } from './types';

/**
 * Fetch wrapper for /v1 (07 §1):
 * - same origin by default (DEC-29; `VITE_API_BASE_URL` empty), session cookie sent with `credentials: 'include'`;
 * - `X-Requested-With: point-web` on every unsafe method, the login included (07 §1.3, 09 §9.3);
 * - `Idempotency-Key` when the caller passes one (commands: see ./command.ts for key reuse on retry);
 * - success envelope `{data, meta}` → `{data, meta}`; error envelope → `ApiError`; no reply → `NetworkError`;
 * - `meta.server_time` feeds the server clock (02 §1.7).
 * The session token never passes through JavaScript: it lives in the httpOnly cookie only (09 §9.3).
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export const CSRF_HEADER_NAME = 'X-Requested-With';
export const CSRF_HEADER_VALUE = 'point-web';
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
/** 02 §1.8 item 3: a command with no reply within 10 s is treated as "no response". */
export const DEFAULT_TIMEOUT_MS = 10_000;

const UNSAFE_METHODS: ReadonlySet<HttpMethod> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface ApiResult<T> {
  data: T;
  meta: Meta;
  status: number;
}

export interface ApiEvent {
  method: HttpMethod;
  path: string;
  status: number;
}

type ErrorListener = (error: ApiError, event: ApiEvent) => void;
type SuccessListener = (event: ApiEvent & { meta: Meta }) => void;

const errorListeners = new Set<ErrorListener>();
const successListeners = new Set<SuccessListener>();

/** Global hook for session-level codes (AUTH_*): the app subscribes once (src/app/SessionWatcher.tsx). */
export function onApiError(listener: ErrorListener): () => void {
  errorListeners.add(listener);
  return () => errorListeners.delete(listener);
}

/** Every successful reply (used for "last sync" and the connection indicator). */
export function onApiSuccess(listener: SuccessListener): () => void {
  successListeners.add(listener);
  return () => successListeners.delete(listener);
}

function baseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL ?? '';
  return configured.replace(/\/+$/, '');
}

export function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${baseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.round((at - Date.now()) / 1000));
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (!value || typeof value !== 'object') return false;
  const error = (value as { error?: unknown }).error;
  return !!error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string';
}

function emitError(error: ApiError, event: ApiEvent): void {
  for (const listener of errorListeners) {
    try {
      listener(error, event);
    } catch {
      // a listener must never break the request path
    }
  }
}

function emitSuccess(event: ApiEvent & { meta: Meta }): void {
  for (const listener of successListeners) {
    try {
      listener(event);
    } catch {
      // ignore listener failures
    }
  }
}

function statusFallbackCode(status: number): string {
  if (status === 401) return 'AUTH_UNAUTHENTICATED';
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 404) return 'RESOURCE_NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503) return 'SERVICE_UNAVAILABLE';
  if (status === 504) return 'DEPENDENCY_TIMEOUT';
  return 'INTERNAL_ERROR';
}

export async function apiFetch<T>(
  method: HttpMethod,
  path: string,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  if (UNSAFE_METHODS.has(method)) headers[CSRF_HEADER_NAME] = CSRF_HEADER_VALUE;
  if (options.idempotencyKey) headers[IDEMPOTENCY_HEADER] = options.idempotencyKey;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      body,
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (cause) {
    if (options.signal?.aborted && !timedOut) throw cause; // cancelled by the caller (React Query)
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    throw new NetworkError(timedOut ? 'timeout' : offline ? 'offline' : 'network', { cause });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }

  const event: ApiEvent = { method, path, status: response.status };
  const requestIdHeader = response.headers.get('X-Request-Id');
  let parsed: unknown = undefined;
  if (response.status !== 204) {
    const text = await response.text().catch(() => '');
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
  }

  if (!response.ok) {
    const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
    const error = isErrorEnvelope(parsed)
      ? ApiError.fromBody(parsed.error, response.status, retryAfter)
      : new ApiError({
          code: statusFallbackCode(response.status),
          status: response.status,
          requestId: requestIdHeader,
          retryable: response.status >= 500 || response.status === 429,
          retryAfterS: retryAfter,
        });
    emitError(error, event);
    throw error;
  }

  const envelope = (parsed ?? {}) as Partial<Envelope<T>>;
  const meta: Meta = {
    request_id: envelope.meta?.request_id ?? requestIdHeader ?? '',
    server_time: envelope.meta?.server_time ?? new Date().toISOString(),
    ...envelope.meta,
  };
  recordServerTime(envelope.meta?.server_time);
  emitSuccess({ ...event, meta });
  return { data: envelope.data as T, meta, status: response.status };
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'body' | 'idempotencyKey'>) =>
    apiFetch<T>('GET', path, options),
  post: <T>(path: string, options?: RequestOptions) => apiFetch<T>('POST', path, options),
  put: <T>(path: string, options?: RequestOptions) => apiFetch<T>('PUT', path, options),
  patch: <T>(path: string, options?: RequestOptions) => apiFetch<T>('PATCH', path, options),
  delete: <T>(path: string, options?: RequestOptions) => apiFetch<T>('DELETE', path, options),
};
