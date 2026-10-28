/**
 * HTTP plumbing of the fake backend: envelopes (07 §1.6), errors with the 08 texts, a tiny path router.
 */
import { randomUUID } from 'node:crypto';
import { errorMessagesAr, errorMeta, type ErrorCode } from '../../../src/i18n/errors';

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Raw bytes instead of a JSON body (the fake object storage serving a photo). */
  raw?: Buffer;
  contentType?: string;
}

const meta = (extra: Record<string, unknown> = {}) => ({
  request_id: `req_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
  server_time: new Date().toISOString(),
  ...extra,
});

export const ok = (data: unknown, status = 200): Reply => ({
  status,
  body: status === 204 ? undefined : { data, meta: meta() },
});

/** A list reply: `meta.next_cursor` is always null (the fake serves one page). */
export const page = (data: unknown[]): Reply => ({
  status: 200,
  body: { data, meta: meta({ next_cursor: null }) },
});

export function errorReply(
  code: ErrorCode,
  details: Record<string, unknown> = {},
  options: { status?: number; headers?: Record<string, string> } = {},
): Reply {
  const m = errorMeta[code];
  return {
    status: options.status ?? m.status,
    headers: options.headers,
    body: {
      error: {
        code,
        message: code,
        message_ar: errorMessagesAr[code],
        request_id: `req_e2e_${code}`,
        retryable: m.retryable,
        details,
      },
    },
  };
}

export class HttpError extends Error {
  constructor(readonly reply: Reply) {
    super(`fake http ${reply.status}`);
  }
}

/** Throws the 08 error (the handler's way to answer 4xx). */
export function fail(code: ErrorCode, details: Record<string, unknown> = {}, status?: number): never {
  throw new HttpError(errorReply(code, details, { status }));
}

export function validation(fields: Array<{ field: string; issue: string }>): never {
  fail('VALIDATION_FAILED', { fields });
}

export interface RoutePattern {
  method: string;
  spec: string;
  regex: RegExp;
  keys: string[];
}

/** "GET /v1/venues/:venueId/events" → method + regex with named params. */
export function compile(spec: string): RoutePattern {
  const [method, path] = spec.split(' ') as [string, string];
  const keys: string[] = [];
  const source = path
    .split('/')
    .map((part) => {
      if (part.startsWith(':')) {
        keys.push(part.slice(1));
        return '([^/]+)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { method, spec, regex: new RegExp(`^${source}$`), keys };
}

export function matchRoute(
  pattern: RoutePattern,
  method: string,
  pathname: string,
): Record<string, string> | null {
  if (pattern.method !== method) return null;
  const m = pattern.regex.exec(pathname);
  if (!m) return null;
  return Object.fromEntries(pattern.keys.map((k, i) => [k, decodeURIComponent(m[i + 1] ?? '')]));
}

/** Stable JSON for idempotency fingerprints. */
export function stable(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(norm);
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
    );
  };
  return JSON.stringify(norm(value)) ?? 'undefined';
}

export const nowIso = () => new Date().toISOString();
export const uuid = () => randomUUID();
